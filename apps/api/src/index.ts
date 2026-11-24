import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env.js';
import { requireUser } from './lib/auth.js';
import { calc } from './routes/calc.js';
import { profiles } from './routes/profiles.js';
import { reference } from './routes/reference.js';

export const app = new Hono<AppEnv>();

app.use('*', secureHeaders());

app.get('/api/health', async (c) => {
  const db = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM property_types').first<{ n: number }>();
  return c.json({ ok: true, env: c.env.ENVIRONMENT, propertyTypes: db?.n ?? 0, time: new Date().toISOString() });
});

app.use('/api/*', requireUser);
app.route('/api/ref', reference);
app.route('/api/profiles', profiles);
app.route('/api/calc', calc);

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
} satisfies ExportedHandler<AppEnv['Bindings']>;
