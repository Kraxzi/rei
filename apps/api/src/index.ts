import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env.js';
import { requireUser } from './lib/auth.js';
import { auth } from './routes/auth.js';
import { calc } from './routes/calc.js';
import { profiles } from './routes/profiles.js';
import { reference } from './routes/reference.js';
import { sources } from './routes/sources.js';
import { notifications, properties } from './routes/properties.js';
import { depsFor } from './sources/deps.js';
import { handleJob, requestDiscovery, type Job } from './sources/discovery.js';
import { discoveryRegions } from './routes/profiles.js';
import { parseJson } from './lib/util.js';

export const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM property_types').first<{ n: number }>();
  return c.json({ ok: true, env: c.env.ENVIRONMENT, propertyTypes: db?.n ?? 0, time: new Date().toISOString() });
});

app.route('/api/auth', auth);
app.use('/api/*', requireUser);
app.route('/api/ref', reference);
app.route('/api/profiles', profiles);
app.route('/api/calc', calc);
app.route('/api/sources', sources);
app.route('/api/properties', properties);
app.route('/api/notifications', notifications);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    if (err.res) return err.res;
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

export default {
  fetch: app.fetch,
  /** Hourly: make sure every active search profile has fresh agency discovery (no-op when recent). */
  async scheduled(_event, env) {
    const deps = depsFor(env);
    // 1) agency discovery for regions of active searches (no-op when recent)
    const { results } = await env.DB.prepare('SELECT regions FROM search_profiles WHERE is_active = 1').all<{ regions: string }>();
    const regions = results.flatMap((r) => discoveryRegions(parseJson<string[]>(r.regions, [])));
    if (regions.length) await requestDiscovery(env, deps, regions, null);
    // 2) scans of approved sources that are due
    const { results: due } = await env.DB.prepare(
      `SELECT s.id FROM sources s LEFT JOIN source_crawl_state c ON c.source_id = s.id
       WHERE s.is_active = 1 AND s.access_status IN ('official_api','partner_feed','authorized_account','approved_public')
         AND (c.last_scan_at IS NULL OR c.last_scan_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || s.scan_interval_min || ' minutes'))
       ORDER BY c.last_scan_at LIMIT 10`,
    ).all<{ id: string }>();
    // 3) opportunities agent: periodic re-analysis of offers (market moves even when the listing doesn't)
    const { results: stale } = await env.DB.prepare(
      `SELECT p.id FROM properties p WHERE p.merged_into IS NULL AND p.is_test = 0
         AND EXISTS (SELECT 1 FROM listings l WHERE l.property_id = p.id AND l.status != 'removed' AND l.deal_type = 'sale')
         AND (p.analyzed_at IS NULL OR p.analyzed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'))
       ORDER BY p.analyzed_at LIMIT 30`,
    ).all<{ id: string }>();
    await deps.enqueue([
      ...due.map((d) => ({ type: 'scan' as const, sourceId: d.id })),
      ...stale.map((p) => ({ type: 'analyze' as const, propertyId: p.id })),
    ]);
  },
  async queue(batch, env) {
    const deps = depsFor(env);
    for (const msg of batch.messages) {
      try {
        await handleJob(env, deps, msg.body);
        msg.ack();
      } catch (e) {
        console.error('job failed', msg.body, e);
        msg.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<AppEnv['Bindings'], Job>;
