import { marketStats, TYPES, trailingPerformance } from '@rei/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { runAnalyst } from '../ingest/analyst.js';
import { vapidKeys } from '../lib/push.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';

// ---------- AI analyst ----------
export const analyst = new Hono<AppEnv>();
analyst.get('/:id', async (c) => {
  const row = await c.env.DB.prepare("SELECT output, created_at, model FROM ai_analyses WHERE property_id = ?1 AND module = 'deal' ORDER BY created_at DESC LIMIT 1").bind(c.req.param('id')).first<{ output: string; created_at: string; model: string }>();
  return c.json(row ? { ...parseJson<object>(row.output, {}), at: row.created_at, model: row.model } : null);
});
analyst.post('/:id', async (c) => {
  const force = c.req.query('force') === '1';
  const r = await runAnalyst(c.env, fetch, c.req.param('id'), force);
  if (!r.ok) {
    const msg = { no_key: 'ИИ не подключён: нет ключа Gemini.', budget: 'Дневной лимит ИИ исчерпан, попробуйте завтра.', not_found: 'Объект не найден.', ai_failed: 'ИИ не ответил, попробуйте ещё раз.' }[r.error ?? 'ai_failed'];
    return c.json({ error: msg }, r.error === 'not_found' ? 404 : 503);
  }
  return c.json(r.analysis);
});

// ---------- push ----------
export const push = new Hono<AppEnv>();
push.get('/key', async (c) => c.json({ publicKey: (await vapidKeys(c.env, new URL(c.req.url).origin)).publicKey }));
push.post('/subscribe', async (c) => {
  const sub = z.object({ endpoint: z.string().url(), keys: z.record(z.string(), z.string()).default({}) }).parse(await c.req.json().catch(() => ({})));
  await c.env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, endpoint, keys, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(endpoint) DO UPDATE SET user_id = ?2')
    .bind(ulid(), c.get('user').id, sub.endpoint, JSON.stringify(sub.keys), nowIso()).run();
  return c.json({ ok: true });
});
push.post('/unsubscribe', async (c) => {
  const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json().catch(() => ({})));
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2').bind(endpoint, c.get('user').id).run();
  return c.json({ ok: true });
});

// ---------- portfolio ----------
export const portfolio = new Hono<AppEnv>();
async function myPortfolio(db: D1Database, userId: string): Promise<string> {
  const id = await db.prepare('SELECT id FROM portfolios WHERE user_id = ?1 LIMIT 1').bind(userId).first<string>('id');
  if (id) return id;
  const nid = ulid();
  await db.prepare("INSERT INTO portfolios (id, user_id, name, base_currency) VALUES (?1, ?2, 'Мой портфель', 'EUR')").bind(nid, userId).run();
  return nid;
}
portfolio.get('/', async (c) => {
  const pid = await myPortfolio(c.env.DB, c.get('user').id);
  const { results: assets } = await c.env.DB.prepare('SELECT * FROM portfolio_assets WHERE portfolio_id = ?1 ORDER BY created_at').bind(pid).all<Record<string, unknown>>();
  const today = nowIso();
  const out: Array<Record<string, unknown> & { performance: ReturnType<typeof trailingPerformance> }> = [];
  for (const a of assets) {
    const [inc, exp] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT id, period_start, period_end, amount, tenant, note FROM rental_income WHERE asset_id = ?1 ORDER BY period_start DESC').bind(a.id),
      c.env.DB.prepare('SELECT id, date, category, amount, note FROM expenses WHERE asset_id = ?1 ORDER BY date DESC').bind(a.id),
    ]);
    const income = inc!.results as Array<{ period_end: string; amount: number }>;
    const expenses = exp!.results as Array<{ date: string; amount: number }>;
    const perf = trailingPerformance(income.map((i) => ({ date: i.period_end, amount: i.amount })), expenses.map((e) => ({ date: e.date, amount: e.amount })),
      (a.total_cost as number | null) ?? (a.purchase_price as number | null), a.expected_noi as number | null, today, a.purchase_date as string | null);
    out.push({ ...a, income: inc!.results, expenses: exp!.results, performance: perf });
  }
  const totals = out.reduce((t, a) => ({ cost: t.cost + Number(a.total_cost ?? a.purchase_price ?? 0), net: t.net + a.performance.net, expectedNoi: t.expectedNoi + Number(a.expected_noi ?? 0) }), { cost: 0, net: 0, expectedNoi: 0 });
  return c.json({ assets: out, totals });
});
const cents = (e: number) => Math.round(e * 100);
portfolio.post('/assets', async (c) => {
  const b = z.object({ name: z.string().trim().min(1).max(120), propertyId: z.string().optional(), purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), purchasePriceEuro: z.number().positive(), totalCostEuro: z.number().positive().optional(), expectedNoiEuro: z.number().optional() })
    .parse(await c.req.json().catch(() => ({})));
  const pid = await myPortfolio(c.env.DB, c.get('user').id);
  const id = ulid();
  await c.env.DB.prepare('INSERT INTO portfolio_assets (id, portfolio_id, property_id, name, purchase_date, purchase_price, currency, total_cost, expected_noi, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(id, pid, b.propertyId ?? null, b.name, b.purchaseDate, cents(b.purchasePriceEuro), 'EUR', b.totalCostEuro ? cents(b.totalCostEuro) : null, b.expectedNoiEuro !== undefined ? cents(b.expectedNoiEuro) : null, nowIso()).run();
  return c.json({ id }, 201);
});
async function ownAsset(c: { env: AppEnv['Bindings']; get: (k: 'user') => { id: string } }, assetId: string) {
  const ok = await c.env.DB.prepare('SELECT a.id FROM portfolio_assets a JOIN portfolios p ON p.id = a.portfolio_id WHERE a.id = ?1 AND p.user_id = ?2').bind(assetId, c.get('user').id).first('id');
  if (!ok) throw new HTTPException(404, { message: 'not found' });
}
portfolio.delete('/assets/:id', async (c) => {
  await ownAsset(c, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM portfolio_assets WHERE id = ?1').bind(c.req.param('id')).run();
  return c.body(null, 204);
});
portfolio.post('/assets/:id/income', async (c) => {
  await ownAsset(c, c.req.param('id'));
  const b = z.object({ periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amountEuro: z.number().positive(), tenant: z.string().max(100).optional(), note: z.string().max(300).optional() }).parse(await c.req.json().catch(() => ({})));
  await c.env.DB.prepare("INSERT INTO rental_income (id, asset_id, period_start, period_end, amount, currency, tenant, note) VALUES (?1, ?2, ?3, ?4, ?5, 'EUR', ?6, ?7)")
    .bind(ulid(), c.req.param('id'), b.periodStart, b.periodEnd, cents(b.amountEuro), b.tenant ?? null, b.note ?? null).run();
  return c.json({ ok: true }, 201);
});
portfolio.post('/assets/:id/expenses', async (c) => {
  await ownAsset(c, c.req.param('id'));
  const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), category: z.string().min(1).max(60), amountEuro: z.number().positive(), note: z.string().max(300).optional() }).parse(await c.req.json().catch(() => ({})));
  await c.env.DB.prepare("INSERT INTO expenses (id, asset_id, date, category, amount, currency, note) VALUES (?1, ?2, ?3, ?4, ?5, 'EUR', ?6)")
    .bind(ulid(), c.req.param('id'), b.date, b.category, cents(b.amountEuro), b.note ?? null).run();
  return c.json({ ok: true }, 201);
});
portfolio.delete('/entries/:kind/:id', async (c) => {
  const table = c.req.param('kind') === 'income' ? 'rental_income' : 'expenses';
  const row = await c.env.DB.prepare(`SELECT asset_id FROM ${table} WHERE id = ?1`).bind(c.req.param('id')).first<string>('asset_id');
  if (!row) throw new HTTPException(404, { message: 'not found' });
  await ownAsset(c, row);
  await c.env.DB.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(c.req.param('id')).run();
  return c.body(null, 204);
});

// ---------- market analytics ----------
export const market = new Hono<AppEnv>();
/**
 * Per city × property type: asking-price statistics from collected offers. Comparable methodology for every row:
 * medians of €/m² (or € per unit for parking/storage), gross yield = median rent × 12 / median price.
 */
market.get('/', async (c) => {
  const region = c.req.query('region');
  const { results } = await c.env.DB.prepare(
    `SELECT COALESCE(ci.name, '—') AS city, p.type_code, l.deal_type, l.price, p.area_m2
     FROM listings l JOIN properties p ON p.id = l.property_id LEFT JOIN cities ci ON ci.id = p.city_id LEFT JOIN regions r ON r.id = p.region_id
     WHERE l.status != 'removed' AND l.price > 0 AND p.is_test = 0 AND p.merged_into IS NULL ${region ? 'AND (p.region_id = ?1 OR r.parent_id = ?1)' : ''}
     LIMIT 20000`,
  ).bind(...(region ? [region] : [])).all<{ city: string; type_code: string; deal_type: string | null; price: number; area_m2: number | null }>();
  const perUnit = (code: string) => ['parking', 'specialized'].includes(TYPES.find((t) => t.code === code)?.category ?? '');
  const groups = new Map<string, { city: string; typeCode: string; sale: Array<{ price: number; areaM2: number | null }>; rent: Array<{ price: number; areaM2: number | null }> }>();
  for (const r of results) {
    const k = `${r.city}|${r.type_code}`;
    if (!groups.has(k)) groups.set(k, { city: r.city, typeCode: r.type_code, sale: [], rent: [] });
    (r.deal_type === 'rent' ? groups.get(k)!.rent : groups.get(k)!.sale).push({ price: r.price, areaM2: r.area_m2 });
  }
  const rows = [...groups.values()].map((g) => {
    const basis = perUnit(g.typeCode) ? 'per_unit' : 'per_m2';
    const s = marketStats(g.sale, basis);
    const r = marketStats(g.rent, basis);
    return {
      city: g.city, typeCode: g.typeCode, typeName: TYPES.find((t) => t.code === g.typeCode)?.name.ru ?? g.typeCode, basis,
      saleCount: g.sale.length, saleMedian: s.median, rentCount: g.rent.length, rentMedian: r.median,
      grossYield: s.median && r.median && s.n >= 3 && r.n >= 3 ? (r.median * 12) / s.median : null,
    };
  }).sort((a, b) => b.saleCount - a.saleCount);
  const { marketGrowth } = await import('../ingest/market.js');
  const it = await marketGrowth(c.env, 'IT');
  return c.json({ rows, note: 'Цены предложений (объявлений), не сделок. Медианы; доходность — валовая.', hpi: { country: 'IT', ...it } });
});

// ---------- tax profile (applies to automatic analysis of every offer) ----------
export const settings = new Hono<AppEnv>();
const taxProfileSchema = z.object({
  buyer: z.enum(['individual', 'company']),
  firstHome: z.boolean(),
  rentalRegime: z.enum(['long_ordinary', 'long_concordato', 'short_first', 'short_second', 'irpef']),
});
settings.get('/tax', async (c) => {
  const { taxProfile } = await import('../ingest/analyze.js');
  return c.json({ profile: await taxProfile(c.env), canEdit: ['owner', 'admin'].includes(c.get('user').role) });
});
settings.put('/tax', async (c) => {
  if (!['owner', 'admin'].includes(c.get('user').role)) throw new HTTPException(403, { message: 'forbidden' });
  const parsed = taxProfileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'validation', issues: parsed.error.issues }, 422);
  await c.env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('tax_profile', ?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(JSON.stringify(parsed.data), nowIso()).run();
  // stored analyses used the old profile: let the hourly agent recompute them
  await c.env.DB.prepare('UPDATE properties SET analyzed_at = NULL WHERE merged_into IS NULL').run();
  return c.json({ profile: parsed.data });
});
