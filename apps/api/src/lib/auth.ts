import { createMiddleware } from 'hono/factory';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv, AuthUser } from '../env.js';
import { nowIso } from './util.js';

export const SESSION_COOKIE = 'rei_session';

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolves the current user from the session cookie (session id = SHA-256 of the cookie token).
 * In local development (DEV_AUTH=1, never in production) an `X-Dev-User: <user id>` header is accepted.
 * Passkey registration/login endpoints that create sessions are implemented in stage 1.5.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  let user: AuthUser | null = null;

  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.role, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?1 AND s.expires_at > ?2`,
    )
      .bind(await sha256Hex(token), nowIso())
      .first<{ id: string; role: AuthUser['role']; display_name: string }>();
    if (row) user = { id: row.id, role: row.role, displayName: row.display_name };
  }

  if (!user && c.env.DEV_AUTH === '1' && c.env.ENVIRONMENT !== 'production') {
    const devId = c.req.header('X-Dev-User');
    if (devId) {
      const row = await c.env.DB.prepare('SELECT id, role, display_name FROM users WHERE id = ?1')
        .bind(devId)
        .first<{ id: string; role: AuthUser['role']; display_name: string }>();
      if (row) user = { id: row.id, role: row.role, displayName: row.display_name };
    }
  }

  if (!user) throw new HTTPException(401, { message: 'unauthorized' });
  c.set('user', user);
  await next();
});

export async function audit(
  db: D1Database,
  e: { userId?: string; action: string; entity: string; entityId?: string; details?: unknown },
  id: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_logs (id, user_id, action, entity, entity_id, details, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, e.userId ?? null, e.action, e.entity, e.entityId ?? null, e.details === undefined ? null : JSON.stringify(e.details), nowIso())
    .run();
}
