import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv, AuthUser } from '../env.js';
import { audit, requireUser, SESSION_COOKIE, sha256Hex } from '../lib/auth.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';

const SESSION_DAYS = 90;
const CHALLENGE_TTL_MS = 5 * 60_000;
const INVITE_DAYS = 7;
const RP_NAME = 'REI';

// ---------- helpers ----------

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** Human-friendly invite code: 12 chars, no ambiguous symbols, grouped as XXXX-XXXX-XXXX. */
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const raw = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}
const normCode = (s: string) => s.trim().toUpperCase().replaceAll(/[\s-]/g, '');

function rp(c: Context<AppEnv>) {
  const origin = c.env.WEBAUTHN_ORIGIN ?? new URL(c.req.url).origin;
  return { origin, rpID: new URL(origin).hostname };
}

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { res: Response.json({ error: 'validation', issues: parsed.error.issues }, { status: 422 }) });
  return parsed.data;
}

async function userCount(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM users').first<number>('n')) ?? 0;
}

async function startSession(c: Context<AppEnv>, userId: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await c.env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, user_agent) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(await sha256Hex(token), userId, expires.toISOString(), nowIso(), c.req.header('User-Agent')?.slice(0, 200) ?? null)
    .run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires });
}

interface ChallengeRow { id: string; challenge: string; user_id: string | null; purpose: 'register' | 'login'; expires_at: string; data: string | null }

/** Loads and deletes a challenge (single use). */
async function takeChallenge(db: D1Database, id: string, purpose: ChallengeRow['purpose']): Promise<ChallengeRow> {
  const row = await db.prepare('SELECT * FROM auth_challenges WHERE id = ?1 AND purpose = ?2').bind(id, purpose).first<ChallengeRow>();
  if (row) await db.prepare('DELETE FROM auth_challenges WHERE id = ?1').bind(id).run();
  // opportunistic cleanup of stale challenges
  await db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(nowIso()).run();
  if (!row || row.expires_at < nowIso()) throw new HTTPException(400, { message: 'challenge expired, try again' });
  return row;
}

interface RegisterData { userId: string; displayName: string; role: AuthUser['role']; inviteId: string | null; bootstrap: boolean; addDevice: boolean }

async function registrationOptions(c: Context<AppEnv>, data: RegisterData, exclude: Array<{ id: string; transports?: string[] }>) {
  const { rpID } = rp(c);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: data.displayName,
    userDisplayName: data.displayName,
    userID: new Uint8Array(new TextEncoder().encode(data.userId)),
    attestationType: 'none',
    excludeCredentials: exclude,
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = ulid();
  await c.env.DB.prepare('INSERT INTO auth_challenges (id, challenge, user_id, purpose, expires_at, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(challengeId, options.challenge, data.userId, 'register', new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(), JSON.stringify(data))
    .run();
  return { challengeId, options };
}

// ---------- routes ----------

export const auth = new Hono<AppEnv>();

/** Current user (or null) and whether the very first account still has to be created. */
auth.get('/me', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  let user: AuthUser | null = null;
  if (token) {
    const row = await c.env.DB.prepare(
      'SELECT u.id, u.role, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1 AND s.expires_at > ?2',
    )
      .bind(await sha256Hex(token), nowIso())
      .first<{ id: string; role: AuthUser['role']; display_name: string }>();
    if (row) user = { id: row.id, role: row.role, displayName: row.display_name };
  }
  return c.json({ user, needsBootstrap: (await userCount(c.env.DB)) === 0, bootstrapEnabled: Boolean(c.env.BOOTSTRAP_CODE) });
});

/** Step 1 of creating an account: with the bootstrap code (first owner) or an invite code. */
auth.post('/register/options', async (c) => {
  const { code, displayName } = await body(c, z.object({ code: z.string().min(4).max(100), displayName: z.string().trim().min(1).max(60) }));
  const codeHash = await sha256Hex(normCode(code));
  let data: RegisterData;

  if ((await userCount(c.env.DB)) === 0) {
    if (!c.env.BOOTSTRAP_CODE) throw new HTTPException(403, { message: 'bootstrap is not configured' });
    if (codeHash !== (await sha256Hex(normCode(c.env.BOOTSTRAP_CODE)))) throw new HTTPException(403, { message: 'invalid code' });
    data = { userId: ulid(), displayName, role: 'owner', inviteId: null, bootstrap: true, addDevice: false };
  } else {
    const inv = await c.env.DB.prepare('SELECT id, role FROM invites WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2')
      .bind(codeHash, nowIso())
      .first<{ id: string; role: 'admin' | 'user' }>();
    if (!inv) throw new HTTPException(403, { message: 'invalid or expired invite' });
    data = { userId: ulid(), displayName, role: inv.role, inviteId: inv.id, bootstrap: false, addDevice: false };
  }
  return c.json(await registrationOptions(c, data, []));
});

/** Add another passkey (new phone, second device) to the logged-in account. */
auth.post('/passkeys/options', requireUser, async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?1').bind(user.id).all<{ id: string; transports: string }>();
  const data: RegisterData = { userId: user.id, displayName: user.displayName, role: user.role, inviteId: null, bootstrap: false, addDevice: true };
  return c.json(await registrationOptions(c, data, results.map((p) => ({ id: p.id, transports: parseJson(p.transports, []) }))));
});

/** Step 2: verify the authenticator response, create user (or add device), start a session. */
auth.post('/register/verify', async (c) => {
  const { challengeId, response, name } = await body(
    c,
    z.object({ challengeId: z.string(), response: z.custom<RegistrationResponseJSON>((v) => typeof v === 'object' && v !== null), name: z.string().max(60).optional() }),
  );
  const ch = await takeChallenge(c.env.DB, challengeId, 'register');
  const data = parseJson<RegisterData | null>(ch.data, null);
  if (!data) throw new HTTPException(400, { message: 'bad challenge' });
  const { origin, rpID } = rp(c);

  let verification;
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch (e) {
    throw new HTTPException(400, { message: `passkey verification failed: ${(e as Error).message}` });
  }
  if (!verification.verified) throw new HTTPException(400, { message: 'passkey verification failed' });
  const cred = verification.registrationInfo.credential;
  const now = nowIso();

  if (data.addDevice) {
    // the session must still belong to the user the challenge was issued for
    const token = getCookie(c, SESSION_COOKIE);
    const s = token ? await c.env.DB.prepare('SELECT user_id FROM sessions WHERE id = ?1 AND expires_at > ?2').bind(await sha256Hex(token), now).first<string>('user_id') : null;
    if (s !== data.userId) throw new HTTPException(401, { message: 'unauthorized' });
  } else if (data.bootstrap) {
    if ((await userCount(c.env.DB)) > 0) throw new HTTPException(409, { message: 'owner already exists' });
  } else if (data.inviteId) {
    const valid = await c.env.DB.prepare('SELECT 1 AS ok FROM invites WHERE id = ?1 AND used_at IS NULL AND expires_at > ?2').bind(data.inviteId, now).first('ok');
    if (!valid) throw new HTTPException(409, { message: 'invite already used or expired' });
  }

  const stmts: D1PreparedStatement[] = [];
  if (!data.addDevice) {
    stmts.push(c.env.DB.prepare('INSERT INTO users (id, display_name, role, created_at) VALUES (?1, ?2, ?3, ?4)').bind(data.userId, data.displayName, data.role, now));
  }
  stmts.push(
    c.env.DB.prepare('INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(
      cred.id, data.userId, b64url(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), name ?? null, now,
    ),
  );
  if (data.inviteId) {
    stmts.push(c.env.DB.prepare('UPDATE invites SET used_at = ?2, used_by = ?3 WHERE id = ?1 AND used_at IS NULL').bind(data.inviteId, now, data.userId));
  }
  await c.env.DB.batch(stmts);
  if (data.inviteId) {
    const ok = await c.env.DB.prepare('SELECT used_by FROM invites WHERE id = ?1').bind(data.inviteId).first<string>('used_by');
    if (ok !== data.userId) {
      // invite was consumed concurrently: roll back the new account
      await c.env.DB.batch([
        c.env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?1').bind(data.userId),
        c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(data.userId),
      ]);
      throw new HTTPException(409, { message: 'invite already used' });
    }
  }

  await audit(c.env.DB, { userId: data.userId, action: data.addDevice ? 'passkey_add' : 'register', entity: 'user', entityId: data.userId, details: { role: data.role } }, ulid());
  if (!data.addDevice) await startSession(c, data.userId);
  return c.json({ ok: true, user: { id: data.userId, displayName: data.displayName, role: data.role } });
});

auth.post('/login/options', async (c) => {
  const { rpID } = rp(c);
  // discoverable credentials: no allowCredentials, the phone offers the stored passkey
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  const challengeId = ulid();
  await c.env.DB.prepare('INSERT INTO auth_challenges (id, challenge, purpose, expires_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(challengeId, options.challenge, 'login', new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
    .run();
  return c.json({ challengeId, options });
});

auth.post('/login/verify', async (c) => {
  const { challengeId, response } = await body(
    c,
    z.object({ challengeId: z.string(), response: z.custom<AuthenticationResponseJSON>((v) => typeof v === 'object' && v !== null && typeof (v as { id?: unknown }).id === 'string') }),
  );
  const ch = await takeChallenge(c.env.DB, challengeId, 'login');
  const pk = await c.env.DB.prepare('SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?1')
    .bind(response.id)
    .first<{ id: string; user_id: string; public_key: string; counter: number; transports: string }>();
  if (!pk) throw new HTTPException(401, { message: 'unknown passkey' });
  const { origin, rpID } = rp(c);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: pk.id, publicKey: fromB64url(pk.public_key), counter: pk.counter, transports: parseJson(pk.transports, []) },
    });
  } catch (e) {
    throw new HTTPException(401, { message: `passkey verification failed: ${(e as Error).message}` });
  }
  if (!verification.verified) throw new HTTPException(401, { message: 'passkey verification failed' });

  await c.env.DB.prepare('UPDATE passkeys SET counter = ?2, last_used_at = ?3 WHERE id = ?1').bind(pk.id, verification.authenticationInfo.newCounter, nowIso()).run();
  await startSession(c, pk.user_id);
  await audit(c.env.DB, { userId: pk.user_id, action: 'login', entity: 'user', entityId: pk.user_id }, ulid());
  const u = await c.env.DB.prepare('SELECT id, display_name, role FROM users WHERE id = ?1').bind(pk.user_id).first<{ id: string; display_name: string; role: string }>();
  return c.json({ ok: true, user: { id: u!.id, displayName: u!.display_name, role: u!.role } });
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(await sha256Hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});

// ---------- devices & invites (logged in) ----------

auth.get('/passkeys', requireUser, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at')
    .bind(c.get('user').id)
    .all();
  return c.json(results);
});

auth.delete('/passkeys/:id', requireUser, async (c) => {
  const user = c.get('user');
  const n = (await c.env.DB.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?1').bind(user.id).first<number>('n')) ?? 0;
  if (n <= 1) throw new HTTPException(409, { message: 'cannot remove the last passkey' });
  const res = await c.env.DB.prepare('DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), user.id).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: 'not found' });
  await audit(c.env.DB, { userId: user.id, action: 'passkey_remove', entity: 'passkey', entityId: c.req.param('id') }, ulid());
  return c.body(null, 204);
});

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!['owner', 'admin'].includes(c.get('user').role)) throw new HTTPException(403, { message: 'forbidden' });
  await next();
};

auth.post('/invites', requireUser, requireAdmin, async (c) => {
  const { role, note } = await body(c, z.object({ role: z.enum(['admin', 'user']).default('user'), note: z.string().max(100).optional() }));
  if (role === 'admin' && c.get('user').role !== 'owner') throw new HTTPException(403, { message: 'only the owner can invite admins' });
  const code = inviteCode();
  const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000).toISOString();
  await c.env.DB.prepare('INSERT INTO invites (id, created_by, role, note, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(await sha256Hex(normCode(code)), c.get('user').id, role, note ?? null, expires, nowIso())
    .run();
  await audit(c.env.DB, { userId: c.get('user').id, action: 'invite_create', entity: 'invite', details: { role, note } }, ulid());
  // the plain code is returned once and never stored
  return c.json({ code, role, expiresAt: expires }, 201);
});

auth.get('/invites', requireUser, requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT i.role, i.note, i.expires_at, i.used_at, u.display_name AS used_by_name, i.created_at
     FROM invites i LEFT JOIN users u ON u.id = i.used_by WHERE i.created_by = ?1 ORDER BY i.created_at DESC LIMIT 50`,
  )
    .bind(c.get('user').id)
    .all();
  return c.json(results);
});
