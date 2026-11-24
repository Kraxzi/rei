import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real authenticators can't run in unit tests: the cryptographic verification is delegated to
// @simplewebauthn/server (itself well tested); here we test our flow, codes, sessions and invariants.
vi.mock('@simplewebauthn/server', async (orig) => ({
  ...(await orig<typeof import('@simplewebauthn/server')>()),
  verifyRegistrationResponse: vi.fn(async ({ response }: { response: { id: string; fail?: boolean } }) =>
    response.fail
      ? { verified: false }
      : { verified: true, registrationInfo: { credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] } } },
  ),
  verifyAuthenticationResponse: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 7 } })),
}));

const { app } = await import('../src/index.js');
const { createTestD1, createTestQueue } = await import('./d1-shim.js');
import type { Env } from '../src/env.js';

let env: Env;

/** Minimal cookie jar per "browser". */
function browser() {
  let cookie = '';
  return {
    async call(path: string, init: { method?: string; body?: unknown } = {}) {
      const headers = new Headers();
      if (cookie) headers.set('Cookie', cookie);
      if (init.body !== undefined) headers.set('Content-Type', 'application/json');
      const res = await app.request(path, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
      const set = res.headers.get('Set-Cookie');
      if (set) {
        const [pair] = set.split(';');
        cookie = /=$/.test(pair!) || /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(set) ? '' : pair!;
      }
      return res;
    },
    get hasCookie() {
      return cookie !== '';
    },
  };
}

async function register(b: ReturnType<typeof browser>, code: string, name: string, credId: string) {
  const opt = await b.call('/api/auth/register/options', { method: 'POST', body: { code, displayName: name } });
  if (opt.status !== 200) return opt;
  const { challengeId, options } = (await opt.json()) as { challengeId: string; options: { challenge: string; rp: { id: string } } };
  expect(options.challenge).toBeTruthy();
  return b.call('/api/auth/register/verify', { method: 'POST', body: { challengeId, response: { id: credId } } });
}

beforeEach(() => {
  env = { DB: createTestD1(), ENVIRONMENT: 'test', BOOTSTRAP_CODE: 'START-1234', JOBS: createTestQueue().queue };
});

describe('passkey auth', () => {
  it('first owner is created only with the bootstrap code', async () => {
    const b = browser();
    expect(await (await b.call('/api/auth/me')).json()).toMatchObject({ user: null, needsBootstrap: true, bootstrapEnabled: true });
    expect((await register(b, 'WRONG-CODE', 'Батя', 'cred-1')).status).toBe(403);
    const ok = await register(b, ' start1234 ', 'Батя', 'cred-1'); // case/dash/space-insensitive
    expect(ok.status).toBe(200);
    expect(b.hasCookie).toBe(true);
    expect(await (await b.call('/api/auth/me')).json()).toMatchObject({ user: { displayName: 'Батя', role: 'owner' }, needsBootstrap: false });
    // bootstrap code no longer works once an owner exists
    expect((await register(browser(), 'START-1234', 'Чужой', 'cred-x')).status).toBe(403);
  });

  it('bootstrap disabled when no code is configured', async () => {
    delete env.BOOTSTRAP_CODE;
    expect((await register(browser(), 'anything', 'X', 'c')).status).toBe(403);
  });

  it('challenges are single-use and failed verification creates nothing', async () => {
    const b = browser();
    const opt = (await (await b.call('/api/auth/register/options', { method: 'POST', body: { code: 'START-1234', displayName: 'A' } })).json()) as { challengeId: string };
    expect((await b.call('/api/auth/register/verify', { method: 'POST', body: { challengeId: opt.challengeId, response: { id: 'c1', fail: true } } })).status).toBe(400);
    expect((await b.call('/api/auth/register/verify', { method: 'POST', body: { challengeId: opt.challengeId, response: { id: 'c1' } } })).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });

  it('invites: one-time, role, only for admins', async () => {
    const owner = browser();
    await register(owner, 'START-1234', 'Батя', 'cred-owner');
    const inv = await owner.call('/api/auth/invites', { method: 'POST', body: { role: 'admin', note: 'Костя' } });
    expect(inv.status).toBe(201);
    const { code } = (await inv.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const kostya = browser();
    expect((await register(kostya, code, 'Костя', 'cred-k')).status).toBe(200);
    expect(await (await kostya.call('/api/auth/me')).json()).toMatchObject({ user: { role: 'admin' } });
    expect((await register(browser(), code, 'Ещё раз', 'cred-z')).status).toBe(403);

    const list = (await (await owner.call('/api/auth/invites')).json()) as Array<{ used_by_name: string }>;
    expect(list[0]!.used_by_name).toBe('Костя');

    // admin cannot mint admins; a plain user cannot invite at all
    expect((await kostya.call('/api/auth/invites', { method: 'POST', body: { role: 'admin' } })).status).toBe(403);
    const userInv = (await (await kostya.call('/api/auth/invites', { method: 'POST', body: { role: 'user' } })).json()) as { code: string };
    const plain = browser();
    await register(plain, userInv.code, 'Гость', 'cred-g');
    expect((await plain.call('/api/auth/invites', { method: 'POST', body: {} })).status).toBe(403);
  });

  it('expired invites are rejected', async () => {
    const owner = browser();
    await register(owner, 'START-1234', 'Батя', 'cred-owner');
    const { code } = (await (await owner.call('/api/auth/invites', { method: 'POST', body: {} })).json()) as { code: string };
    await env.DB.prepare("UPDATE invites SET expires_at = '2000-01-01T00:00:00Z'").run();
    expect((await register(browser(), code, 'X', 'c')).status).toBe(403);
  });

  it('login with a stored passkey, counter updated, unknown passkey rejected', async () => {
    await register(browser(), 'START-1234', 'Батя', 'cred-owner');
    const phone = browser();
    const opt = (await (await phone.call('/api/auth/login/options', { method: 'POST' })).json()) as { challengeId: string; options: { allowCredentials?: unknown[] } };
    expect(opt.options.allowCredentials ?? []).toEqual([]); // discoverable credential
    const res = await phone.call('/api/auth/login/verify', { method: 'POST', body: { challengeId: opt.challengeId, response: { id: 'cred-owner' } } });
    expect(res.status).toBe(200);
    expect(phone.hasCookie).toBe(true);
    expect(await env.DB.prepare("SELECT counter FROM passkeys WHERE id = 'cred-owner'").first('counter')).toBe(7);
    expect((await phone.call('/api/profiles')).status).toBe(200);

    const opt2 = (await (await phone.call('/api/auth/login/options', { method: 'POST' })).json()) as { challengeId: string };
    expect((await browser().call('/api/auth/login/verify', { method: 'POST', body: { challengeId: opt2.challengeId, response: { id: 'nope' } } })).status).toBe(401);
  });

  it('add a second device; cannot delete the last passkey; logout ends session', async () => {
    const b = browser();
    await register(b, 'START-1234', 'Батя', 'cred-1');
    const opt = (await (await b.call('/api/auth/passkeys/options', { method: 'POST' })).json()) as { challengeId: string; options: { excludeCredentials: Array<{ id: string }> } };
    expect(opt.options.excludeCredentials.map((e) => e.id)).toEqual(['cred-1']);
    expect((await b.call('/api/auth/register/verify', { method: 'POST', body: { challengeId: opt.challengeId, response: { id: 'cred-2' }, name: 'Планшет' } })).status).toBe(200);
    const keys = (await (await b.call('/api/auth/passkeys')).json()) as Array<{ id: string; name: string | null }>;
    expect(keys.map((k) => k.id)).toEqual(['cred-1', 'cred-2']);

    expect((await b.call('/api/auth/passkeys/cred-2', { method: 'DELETE' })).status).toBe(204);
    expect((await b.call('/api/auth/passkeys/cred-1', { method: 'DELETE' })).status).toBe(409);

    await b.call('/api/auth/logout', { method: 'POST' });
    expect(b.hasCookie).toBe(false);
    expect((await b.call('/api/profiles')).status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first('n')).toBe(0);
  });

  it('add-device challenge cannot be completed by another session', async () => {
    const owner = browser();
    await register(owner, 'START-1234', 'Батя', 'cred-1');
    const opt = (await (await owner.call('/api/auth/passkeys/options', { method: 'POST' })).json()) as { challengeId: string };
    expect((await browser().call('/api/auth/register/verify', { method: 'POST', body: { challengeId: opt.challengeId, response: { id: 'evil' } } })).status).toBe(401);
  });

  it('audit log records auth events', async () => {
    await register(browser(), 'START-1234', 'Батя', 'cred-1');
    const { results } = await env.DB.prepare('SELECT action FROM audit_logs').all<{ action: string }>();
    expect(results.map((r) => r.action)).toContain('register');
  });
});
