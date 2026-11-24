import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { audit } from '../lib/auth.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';

const latLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const ring = z.array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])).min(3);
const polygon = z.array(ring).min(1);

export const profileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    countries: z.array(z.string().length(2).toUpperCase()).default([]),
    regions: z.array(z.string()).default([]),
    cities: z.array(z.string()).default([]),
    geo: z
      .object({
        circles: z.array(z.object({ center: latLng, radiusM: z.number().positive().max(500_000) })).optional(),
        polygons: z.array(polygon).optional(),
        exclude: z.array(polygon).optional(),
      })
      .default({}),
    typeCodes: z.array(z.string()).default([]),
    priceMin: z.number().int().nonnegative().nullable().default(null),
    priceMax: z.number().int().positive().nullable().default(null),
    areaMin: z.number().nonnegative().nullable().default(null),
    areaMax: z.number().positive().nullable().default(null),
    targetNetYield: z.number().min(0).max(1).nullable().default(null),
    condition: z.array(z.enum(['new', 'renovated', 'good', 'to_renovate', 'ruin'])).default([]),
    extra: z.record(z.string(), z.unknown()).default({}),
    strategy: z.enum(['income', 'growth', 'value_add', 'mixed']).default('income'),
    refreshMin: z.number().int().min(60).max(10_080).default(720),
    notify: z
      .object({
        minScore: z.number().min(0).max(100).optional(),
        minNetYield: z.number().min(0).max(1).optional(),
        priceDropPct: z.number().min(0).max(1).optional(),
        events: z.array(z.string()).optional(),
      })
      .default({}),
    isActive: z.boolean().default(true),
  })
  .refine((p) => p.priceMin === null || p.priceMax === null || p.priceMin <= p.priceMax, { message: 'priceMin > priceMax', path: ['priceMin'] })
  .refine((p) => p.areaMin === null || p.areaMax === null || p.areaMin <= p.areaMax, { message: 'areaMin > areaMax', path: ['areaMin'] });

export type SearchProfileInput = z.infer<typeof profileSchema>;

interface ProfileRow {
  id: string; user_id: string; name: string; countries: string; regions: string; cities: string; geo: string;
  type_codes: string; price_min: number | null; price_max: number | null; area_min: number | null; area_max: number | null;
  target_net_yield: number | null; condition: string; extra: string; strategy: string; refresh_min: number;
  notify: string; is_active: number; created_at: string; updated_at: string;
}

const toApi = (r: ProfileRow) => ({
  id: r.id,
  name: r.name,
  countries: parseJson(r.countries, []),
  regions: parseJson(r.regions, []),
  cities: parseJson(r.cities, []),
  geo: parseJson(r.geo, {}),
  typeCodes: parseJson(r.type_codes, []),
  priceMin: r.price_min,
  priceMax: r.price_max,
  areaMin: r.area_min,
  areaMax: r.area_max,
  targetNetYield: r.target_net_yield,
  condition: parseJson(r.condition, []),
  extra: parseJson(r.extra, {}),
  strategy: r.strategy,
  refreshMin: r.refresh_min,
  notify: parseJson(r.notify, {}),
  isActive: r.is_active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function parseBody(c: { req: { json: () => Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON' });
  }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(422, { res: Response.json({ error: 'validation', issues: parsed.error.issues }, { status: 422 }) });
  }
  return parsed.data;
}

/** Checks referenced codes exist so a profile never points at unknown countries/regions/types. */
async function checkReferences(db: D1Database, p: SearchProfileInput) {
  const missing: string[] = [];
  const check = async (table: string, col: string, values: string[]) => {
    if (values.length === 0) return;
    const ph = values.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await db.prepare(`SELECT ${col} AS v FROM ${table} WHERE ${col} IN (${ph})`).bind(...values).all<{ v: string }>();
    const found = new Set(results.map((r) => r.v));
    for (const v of values) if (!found.has(v)) missing.push(`${table}:${v}`);
  };
  await check('countries', 'code', p.countries);
  await check('regions', 'id', p.regions);
  await check('cities', 'id', p.cities);
  await check('property_types', 'code', p.typeCodes);
  if (missing.length) throw new HTTPException(422, { res: Response.json({ error: 'unknown_references', missing }, { status: 422 }) });
}

const cols = (p: SearchProfileInput) => [
  p.name, JSON.stringify(p.countries), JSON.stringify(p.regions), JSON.stringify(p.cities), JSON.stringify(p.geo),
  JSON.stringify(p.typeCodes), p.priceMin, p.priceMax, p.areaMin, p.areaMax, p.targetNetYield, JSON.stringify(p.condition),
  JSON.stringify(p.extra), p.strategy, p.refreshMin, JSON.stringify(p.notify), p.isActive ? 1 : 0,
];

export const profiles = new Hono<AppEnv>();

profiles.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM search_profiles WHERE user_id = ?1 ORDER BY created_at').bind(c.get('user').id).all<ProfileRow>();
  return c.json(results.map(toApi));
});

profiles.get('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM search_profiles WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), c.get('user').id).first<ProfileRow>();
  if (!row) throw new HTTPException(404, { message: 'not found' });
  return c.json(toApi(row));
});

profiles.post('/', async (c) => {
  const p = await parseBody(c);
  await checkReferences(c.env.DB, p);
  const id = ulid();
  const now = nowIso();
  const user = c.get('user');
  await c.env.DB.prepare(
    `INSERT INTO search_profiles (id, user_id, name, countries, regions, cities, geo, type_codes, price_min, price_max, area_min, area_max,
       target_net_yield, condition, extra, strategy, refresh_min, notify, is_active, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
  )
    .bind(id, user.id, ...cols(p), now, now)
    .run();
  await audit(c.env.DB, { userId: user.id, action: 'create', entity: 'search_profile', entityId: id }, ulid());
  const row = await c.env.DB.prepare('SELECT * FROM search_profiles WHERE id = ?1').bind(id).first<ProfileRow>();
  return c.json(toApi(row!), 201);
});

profiles.put('/:id', async (c) => {
  const p = await parseBody(c);
  await checkReferences(c.env.DB, p);
  const user = c.get('user');
  const id = c.req.param('id');
  const res = await c.env.DB.prepare(
    `UPDATE search_profiles SET name=?3, countries=?4, regions=?5, cities=?6, geo=?7, type_codes=?8, price_min=?9, price_max=?10,
       area_min=?11, area_max=?12, target_net_yield=?13, condition=?14, extra=?15, strategy=?16, refresh_min=?17, notify=?18,
       is_active=?19, updated_at=?20
     WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(id, user.id, ...cols(p), nowIso())
    .run();
  if (!res.meta.changes) throw new HTTPException(404, { message: 'not found' });
  await audit(c.env.DB, { userId: user.id, action: 'update', entity: 'search_profile', entityId: id }, ulid());
  const row = await c.env.DB.prepare('SELECT * FROM search_profiles WHERE id = ?1').bind(id).first<ProfileRow>();
  return c.json(toApi(row!));
});

profiles.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const res = await c.env.DB.prepare('DELETE FROM search_profiles WHERE id = ?1 AND user_id = ?2').bind(id, user.id).run();
  if (!res.meta.changes) throw new HTTPException(404, { message: 'not found' });
  await audit(c.env.DB, { userId: user.id, action: 'delete', entity: 'search_profile', entityId: id }, ulid());
  return c.body(null, 204);
});
