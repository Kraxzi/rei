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
    const { results } = await env.DB.prepare('SELECT regions FROM search_profiles WHERE is_active = 1').all<{ regions: string }>();
    const regions = results.flatMap((r) => discoveryRegions(parseJson<string[]>(r.regions, [])));
    if (regions.length) await requestDiscovery(env, depsFor(env), regions, null);
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
