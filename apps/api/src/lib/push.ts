import type { Env } from '../env.js';
import { nowIso } from './util.js';

/**
 * Web Push without payload ("tickle"): we only wake the service worker, which then fetches the newest
 * notification over our authenticated API. No payload means no message encryption is needed — only VAPID.
 * The VAPID key pair is generated once and kept in app_settings.
 */

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

interface Vapid { publicKey: string; privateJwk: JsonWebKey; subject: string }

export async function vapidKeys(env: Env, subjectIfNew: string): Promise<Vapid> {
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").first<string>('value');
  if (row) return JSON.parse(row) as Vapid;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const v: Vapid = {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
    subject: subjectIfNew,
  };
  await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('vapid', ?1, ?2)").bind(JSON.stringify(v), nowIso()).run();
  return JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").first<string>('value'))!) as Vapid;
}

async function vapidJwt(v: Vapid, audience: string): Promise<string> {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: v.subject })}`;
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

/** Wakes every subscribed device of the given users. Dead subscriptions (404/410) are removed. */
export async function pushPing(env: Env, userIds: string[], fetcher: typeof fetch = fetch): Promise<number> {
  if (!userIds.length) return 0;
  const vapidRow = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").first<string>('value');
  if (!vapidRow) return 0;
  const v = JSON.parse(vapidRow) as Vapid;
  const ph = userIds.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(`SELECT id, endpoint FROM push_subscriptions WHERE user_id IN (${ph})`).bind(...userIds).all<{ id: string; endpoint: string }>();
  let sent = 0;
  for (const s of results) {
    try {
      const res = await fetcher(s.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${await vapidJwt(v, new URL(s.endpoint).origin)}, k=${v.publicKey}`, 'Content-Length': '0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404 || res.status === 410) await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(s.id).run();
      else if (res.ok) sent++;
    } catch { /* device offline etc. — next notification will try again */ }
  }
  return sent;
}
