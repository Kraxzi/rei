import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { audit } from '../lib/auth.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';
import { requestDiscovery } from '../sources/discovery.js';
import { depsFor } from '../sources/deps.js';

export const sources = new Hono<AppEnv>();

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!['owner', 'admin'].includes(c.get('user').role)) throw new HTTPException(403, { message: 'forbidden' });
  await next();
};

interface SourceRow {
  id: string; name: string; base_url: string; city: string | null; region_id: string | null; region_name: string | null;
  verdict: string | null; decision: string | null; access_status: string; connector: string; audit: string | null; audited_at: string | null;
}

/** Per-region overview: discovery status and how many agencies are waiting for a decision. */
sources.get('/summary', async (c) => {
  const { results: disc } = await c.env.DB.prepare(
    `SELECT d.region_id, r.name AS region_name, d.status, d.found, d.without_website, d.excluded, d.error, d.created_at, d.finished_at
     FROM region_discoveries d JOIN regions r ON r.id = d.region_id
     WHERE d.created_at = (SELECT MAX(created_at) FROM region_discoveries x WHERE x.region_id = d.region_id)
     ORDER BY d.created_at DESC`,
  ).all();
  const { results: counts } = await c.env.DB.prepare(
    `SELECT region_id,
       SUM(CASE WHEN verdict = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN verdict = 'suitable' AND decision IS NULL THEN 1 ELSE 0 END) AS suitable,
       SUM(CASE WHEN verdict = 'review' AND decision IS NULL THEN 1 ELSE 0 END) AS review,
       SUM(CASE WHEN verdict = 'rejected' THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved,
       SUM(CASE WHEN decision = 'declined' THEN 1 ELSE 0 END) AS declined
     FROM sources WHERE kind IN ('agency','auction','public','bank') GROUP BY region_id`,
  ).all<Record<string, number | string>>();
  const byRegion = Object.fromEntries(counts.map((r) => [r.region_id, r]));
  return c.json(disc.map((d) => ({ ...d, counts: byRegion[d.region_id as string] ?? null })));
});

sources.get('/', async (c) => {
  const region = c.req.query('region');
  const national = c.req.query('national') === '1';
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.name, s.base_url, s.city, s.region_id, r.name AS region_name, s.verdict, s.decision, s.access_status, s.connector, s.audit, s.audited_at
     FROM sources s LEFT JOIN regions r ON r.id = s.region_id
     WHERE s.kind IN ('agency','auction','public','bank') ${national ? 'AND s.region_id IS NULL' : region ? 'AND s.region_id = ?1' : ''}
     ORDER BY CASE s.verdict WHEN 'suitable' THEN 0 WHEN 'review' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, s.name
     LIMIT 500`,
  )
    .bind(...(region && !national ? [region] : []))
    .all<SourceRow>();
  return c.json(
    results.map((s) => {
      const a = parseJson<{ reasons?: string[]; signals?: { platform?: string | null; title?: string | null } | null; terms?: { summary?: string } | null } | null>(s.audit, null);
      return {
        id: s.id, name: s.name, url: s.base_url, city: s.city, regionId: s.region_id, regionName: s.region_name,
        verdict: s.verdict, decision: s.decision, accessStatus: s.access_status, platform: a?.signals?.platform ?? null,
        reasons: a?.reasons ?? [], terms: a?.terms?.summary ?? null, auditedAt: s.audited_at,
      };
    }),
  );
});

/** Manual (re)start of discovery for a region. */
sources.post('/discover', requireAdmin, async (c) => {
  const { regionId } = z.object({ regionId: z.string() }).parse(await c.req.json().catch(() => ({})));
  const ids = await requestDiscovery(c.env, depsFor(c.env), [regionId], c.get('user').id);
  return c.json({ started: ids.length > 0 });
});

const decide = async (c: Context<AppEnv>, ids: string[], decision: 'approved' | 'declined') => {
  if (ids.length === 0) return 0;
  const user = c.get('user');
  const now = nowIso();
  let changed = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const ph = chunk.map((_, k) => `?${k + 4}`).join(',');
    // rejected sources can never be approved: the audit found a hard stop (robots, anti-bot, terms)
    const res = await c.env.DB.prepare(
      decision === 'approved'
        ? `UPDATE sources SET decision = 'approved', access_status = 'approved_public', is_active = 1, approved_by = ?1, approved_at = ?2
           WHERE kind IN ('agency','auction','public','bank') AND verdict IN ('suitable','review') AND ?3 = ?3 AND id IN (${ph})`
        : `UPDATE sources SET decision = 'declined', access_status = 'not_connected', is_active = 0, approved_by = ?1, approved_at = ?2
           WHERE kind IN ('agency','auction','public','bank') AND ?3 = ?3 AND id IN (${ph})`,
    )
      .bind(user.id, now, decision, ...chunk)
      .run();
    changed += res.meta.changes ?? 0;
  }
  await audit(c.env.DB, { userId: user.id, action: `source_${decision}`, entity: 'source', details: { ids, changed } }, ulid());
  return changed;
};

sources.post('/approve', requireAdmin, async (c) => {
  const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(await c.req.json().catch(() => ({})));
  return c.json({ approved: await decide(c, ids, 'approved') });
});

sources.post('/decline', requireAdmin, async (c) => {
  const { ids } = z.object({ ids: z.array(z.string()).min(1).max(500) }).parse(await c.req.json().catch(() => ({})));
  return c.json({ declined: await decide(c, ids, 'declined') });
});

/** One tap: connect every agency of the region whose audit found nothing questionable. */
sources.post('/approve-suitable', requireAdmin, async (c) => {
  const { regionId } = z.object({ regionId: z.string() }).parse(await c.req.json().catch(() => ({})));
  const { results } = await c.env.DB.prepare("SELECT id FROM sources WHERE kind IN ('agency','auction','public','bank') AND region_id = ?1 AND verdict = 'suitable' AND decision IS NULL")
    .bind(regionId)
    .all<{ id: string }>();
  return c.json({ approved: await decide(c, results.map((r) => r.id), 'approved') });
});
