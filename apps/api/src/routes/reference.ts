import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { parseJson } from '../lib/util.js';

/** Read-only reference data: countries, regions, cities, property taxonomy (from D1 — the source of truth). */
export const reference = new Hono<AppEnv>();

reference.get('/countries', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT code, name, currency, languages FROM countries WHERE is_active = 1 ORDER BY code').all<{
    code: string; name: string; currency: string; languages: string;
  }>();
  return c.json(results.map((r) => ({ code: r.code, name: parseJson(r.name, {}), currency: r.currency, languages: parseJson(r.languages, []) })));
});

reference.get('/countries/:code/regions', async (c) => {
  const parent = c.req.query('parent');
  const stmt = parent
    ? c.env.DB.prepare('SELECT id, code, name, level, parent_id FROM regions WHERE country_code = ?1 AND parent_id = ?2 ORDER BY name').bind(c.req.param('code').toUpperCase(), parent)
    : c.env.DB.prepare("SELECT id, code, name, level, parent_id FROM regions WHERE country_code = ?1 AND level = 'region' ORDER BY name").bind(c.req.param('code').toUpperCase());
  const { results } = await stmt.all();
  return c.json(results);
});

reference.get('/regions/:id/cities', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, official_code, postal_codes, lat, lng FROM cities WHERE region_id = ?1 ORDER BY name')
    .bind(c.req.param('id'))
    .all<{ id: string; name: string; official_code: string | null; postal_codes: string; lat: number | null; lng: number | null }>();
  return c.json(results.map((r) => ({ ...r, postal_codes: parseJson(r.postal_codes, []) })));
});

reference.get('/taxonomy', async (c) => {
  const [cats, types, fields] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM property_categories ORDER BY sort'),
    c.env.DB.prepare('SELECT * FROM property_types WHERE is_active = 1 ORDER BY sort'),
    c.env.DB.prepare('SELECT key, def FROM field_definitions'),
  ]);
  const fieldMap = Object.fromEntries((fields!.results as Array<{ key: string; def: string }>).map((f) => [f.key, parseJson(f.def, {})]));
  const typeRows = types!.results as Array<Record<string, string | number>>;
  return c.json({
    fields: fieldMap,
    categories: (cats!.results as Array<Record<string, string | number>>).map((cat) => ({
      code: cat.code,
      name: parseJson(cat.name as string, {}),
      fields: parseJson(cat.fields as string, []),
      required: parseJson(cat.required as string, []),
      filters: parseJson(cat.filters as string, []),
      scoringProfile: cat.scoring_profile,
      typicalRisks: parseJson(cat.typical_risks as string, []),
      legalChecks: parseJson(cat.legal_checks as string, []),
      types: typeRows
        .filter((t) => t.category_code === cat.code)
        .map((t) => ({
          code: t.code,
          name: parseJson(t.name as string, {}),
          financialModels: parseJson(t.financial_models as string, []),
          extraFields: parseJson(t.extra_fields as string, []),
          required: parseJson(t.required as string, []),
        })),
    })),
  });
});
