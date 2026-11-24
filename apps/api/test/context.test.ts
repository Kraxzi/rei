import { geohashEncode } from '@rei/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { app } from '../src/index.js';
import { analyzePropertyById, runLocation } from '../src/ingest/analyze.js';
import { runHpi } from '../src/ingest/market.js';
import { sha256Hex } from '../src/lib/auth.js';
import type { QueuedJob } from '../src/sources/discovery.js';
import { createTestD1, createTestQueue } from './d1-shim.js';

let env: Env;
const TOKEN = 't';
async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, { method: init.method ?? 'GET', headers: { Cookie: `rei_session=${TOKEN}`, 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);
}

const EUROSTAT = {
  id: ['freq', 'purchase', 'unit', 'geo', 'time'],
  dimension: { time: { category: { index: { '2022': 0, '2023': 1, '2024': 2, '2025': 3 } } } },
  value: { '0': 3.8, '1': 1.3, '2': 2.6, '3': 4.0 },
};
const OVERPASS = { elements: [
  ...Array.from({ length: 6 }, () => ({ tags: { shop: 'supermarket' } })),
  { tags: { railway: 'station' } }, { tags: { natural: 'beach' } }, { tags: { amenity: 'school' } }, { tags: { amenity: 'pharmacy' } },
] };
const fakeFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('eurostat')) return Response.json(EUROSTAT);
  if (url.includes('overpass') || url.includes('kumi') || url.includes('coffee')) return Response.json(OVERPASS);
  return new Response('nope', { status: 404 });
}) as typeof fetch;

beforeEach(async () => {
  env = { DB: createTestD1(), ENVIRONMENT: 'test', JOBS: createTestQueue().queue };
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('u1', 'Owner', 'owner', ?1), ('u2', 'User', 'user', ?1)").bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)').bind(await sha256Hex(TOKEN), 'u1', new Date(Date.now() + 3600_000).toISOString(), now).run();
});

describe('Italian taxes in the calculator', () => {
  const body = {
    model: 'residential_long_term',
    modelInput: { monthlyRent: 80_000 },
    acquisition: { price: 20_000_000 },
    operating: { insurance: 30_000, maintenance: 50_000 },
  };

  it('second home from a private seller: registro on cadastral value, IMU, cedolare 21 %', async () => {
    const r = await call('/api/calc', { method: 'POST', body: { ...body, tax: { country: 'IT', typeCode: 'apartment', rendita: 90_000 } } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { tax: { purchase: { total: number; applied: boolean }; imu: { amount: number }; rental: { rate: number }; sources: unknown[] }; scenarios: Array<{ scenario: string; yearOne: { incomeTax: number; cashFlowAfterTax: number; cashFlow: number; statement: { egi: number } } }> };
    // Agenzia Entrate example: rendita 900 € → registro 10 206 € + 50 + 50
    expect(j.tax.purchase.total).toBe(1_030_600);
    expect(j.tax.purchase.applied).toBe(true);
    // IMU: 900 × 1.05 × 160 × 1.06 % = 1 602.72 €
    expect(j.tax.imu.amount).toBe(160_272);
    expect(j.tax.rental.rate).toBe(0.21);
    expect(j.tax.sources.length).toBeGreaterThan(0);
    const base = j.scenarios.find((s) => s.scenario === 'base')!;
    expect(base.yearOne.incomeTax).toBe(Math.round(base.yearOne.statement.egi * 0.21));
    expect(base.yearOne.cashFlowAfterTax).toBe(base.yearOne.cashFlow - base.yearOne.incomeTax);
  });

  it('explicit user amounts win; first home → 2 % and no IMU', async () => {
    const j = (await (await call('/api/calc', { method: 'POST', body: { ...body, acquisition: { price: 20_000_000, purchaseTaxAmount: 100 }, operating: { holdingTax: 5 }, tax: { country: 'IT', typeCode: 'apartment', firstHome: true, rendita: 90_000 } } })).json()) as { tax: { purchase: { total: number; applied: boolean }; imu: { amount: number; applied: boolean } } };
    expect(j.tax.purchase.applied).toBe(false);
    expect(j.tax.purchase.total).toBe(207_900 + 10_000);
    expect(j.tax.imu).toMatchObject({ amount: 0, applied: false });
  });

  it('without rendita warns about IMU; ordinary IRPEF is not guessed', async () => {
    const j = (await (await call('/api/calc', { method: 'POST', body: { ...body, tax: { country: 'IT', typeCode: 'apartment', rentalRegime: 'irpef' } } })).json()) as { tax: { warnings: string[]; rental: { rate: number | null } }; scenarios: Array<{ yearOne: { incomeTax: number } }> };
    expect(j.tax.rental.rate).toBeNull();
    expect(j.scenarios[0]!.yearOne.incomeTax).toBe(0);
    expect(j.tax.warnings.some((w) => w.includes('IMU'))).toBe(true);
    expect(j.tax.warnings.some((w) => w.includes('IRPEF'))).toBe(true);
  });
});

describe('tax profile setting', () => {
  it('owner edits, user only reads; change schedules re-analysis', async () => {
    expect(await (await call('/api/settings/tax')).json()).toMatchObject({ profile: { buyer: 'individual', firstHome: false, rentalRegime: 'long_ordinary' }, canEdit: true });
    const r = await call('/api/settings/tax', { method: 'PUT', body: { buyer: 'individual', firstHome: false, rentalRegime: 'short_first' } });
    expect(r.status).toBe(200);
    expect(await (await call('/api/settings/tax')).json()).toMatchObject({ profile: { rentalRegime: 'short_first' } });
    await env.DB.prepare("UPDATE sessions SET user_id = 'u2'").run();
    expect((await call('/api/settings/tax', { method: 'PUT', body: { buyer: 'company', firstHome: false, rentalRegime: 'irpef' } })).status).toBe(403);
  });
});

describe('growth and location context', () => {
  it('Eurostat HPI is stored and shown on the market page', async () => {
    await runHpi(env, { fetch: fakeFetch }, 'IT');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM market_indicators WHERE source = 'eurostat'").first('n')).toBe(4);
    await runHpi(env, { fetch: fakeFetch }, 'IT'); // idempotent
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM market_indicators WHERE source = 'eurostat'").first('n')).toBe(4);
    const m = (await (await call('/api/market')).json()) as { hpi: { growth: { value: number; basis: string } } };
    expect(m.hpi.growth.basis).toBe('2023–2025');
    expect(m.hpi.growth.value).toBeCloseTo((1.3 + 2.6 + 4.0) / 300, 6);
  });

  it('POIs are fetched per cell in a queued job and feed the analysis', async () => {
    const items = [1, 2, 3, 4, 5].map((i) => ({ url: `https://example.test/flat-${i}`, priceEuro: 150_000 + i * 10_000, areaM2: 60 + i, typeCode: 'apartment', city: 'Imperia', lat: 43.889, lng: 8.039 }))
      .concat([1, 2, 3].map((i) => ({ url: `https://example.test/flat-affitto-${i}`, priceEuro: 700 + i * 50, areaM2: 62, typeCode: 'apartment', city: 'Imperia', lat: 43.889, lng: 8.039, dealType: 'rent' as const })) as never[]);
    await call('/api/properties/import', { method: 'POST', body: { test: true, regionId: 'it-p-im', items } });
    await runHpi(env, { fetch: fakeFetch }, 'IT');
    const id = (await env.DB.prepare("SELECT p.id FROM properties p JOIN listings l ON l.property_id = p.id WHERE l.deal_type = 'sale' LIMIT 1").first<string>('id'))!;

    const before = (await analyzePropertyById(env, id))!;
    expect(before.score.components.location.value).toBeNull();

    const jobs: QueuedJob[] = [];
    await runLocation(env, { fetch: fakeFetch, enqueue: async (j) => { jobs.push(...j); } }, geohashEncode({ lat: 43.889, lng: 8.039 }, 6), 43.889, 8.039);
    expect(jobs.filter((j) => j.type === 'analyze')).toHaveLength(8);

    const after = (await analyzePropertyById(env, id))!;
    expect(after.score.components.location.value).toBeGreaterThan(0);
    expect(after.score.components.growth.value).not.toBeNull();
    expect(after.netYieldAfterTax).not.toBeNull();
    expect(after.netYieldAfterTax!).toBeLessThan(after.netYield!);
    const row = await env.DB.prepare('SELECT net_yield_after_tax, location_score FROM properties WHERE id = ?1').bind(id).first<{ net_yield_after_tax: number; location_score: number }>();
    expect(row!.location_score).toBeGreaterThan(0);
  });
});
