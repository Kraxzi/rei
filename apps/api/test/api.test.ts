import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index.js';
import { sha256Hex } from '../src/lib/auth.js';
import type { Env } from '../src/env.js';
import { createTestD1, createTestQueue } from './d1-shim.js';

let env: Env;
const TOKEN = 'test-session-token';

async function req(path: string, init: RequestInit & { auth?: boolean } = {}) {
  const headers = new Headers(init.headers);
  if (init.auth !== false) headers.set('Cookie', `rei_session=${TOKEN}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return app.request(path, { ...init, headers }, env);
}

beforeEach(async () => {
  env = { DB: createTestD1(), ENVIRONMENT: 'test', JOBS: createTestQueue().queue };
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 3600_000).toISOString();
  await env.DB.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('u1', 'Owner', 'owner', ?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('u2', 'Other', 'user', ?1)").bind(now).run();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(await sha256Hex(TOKEN), 'u1', later, now)
    .run();
});

describe('database', () => {
  it('migrations create schema and seed reference data', async () => {
    const r = await req('/api/health', { auth: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, propertyTypes: 69 });
  });

  it('foreign keys are enforced', async () => {
    await expect(
      env.DB.prepare("INSERT INTO property_types (code, category_code, name, financial_models) VALUES ('x', 'nope', '{}', '[]')").run(),
    ).rejects.toThrow();
  });
});

describe('auth', () => {
  it('rejects requests without a session', async () => {
    expect((await req('/api/ref/countries', { auth: false })).status).toBe(401);
  });

  it('rejects expired sessions', async () => {
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'").run();
    expect((await req('/api/ref/countries')).status).toBe(401);
  });

  it('dev header is ignored unless DEV_AUTH=1 outside production', async () => {
    expect((await req('/api/ref/countries', { auth: false, headers: { 'X-Dev-User': 'u1' } })).status).toBe(401);
    env.DEV_AUTH = '1';
    expect((await req('/api/ref/countries', { auth: false, headers: { 'X-Dev-User': 'u1' } })).status).toBe(200);
    env.ENVIRONMENT = 'production';
    expect((await req('/api/ref/countries', { auth: false, headers: { 'X-Dev-User': 'u1' } })).status).toBe(401);
  });
});

describe('reference', () => {
  it('countries', async () => {
    const list = (await (await req('/api/ref/countries')).json()) as Array<{ code: string }>;
    expect(list.map((c) => c.code)).toEqual(['AT', 'DE', 'ES', 'FR', 'IT']);
  });

  it('italian regions and Liguria provinces', async () => {
    const regions = (await (await req('/api/ref/countries/it/regions')).json()) as Array<{ id: string; name: string }>;
    expect(regions).toHaveLength(20);
    const provinces = (await (await req('/api/ref/countries/IT/regions?parent=it-r-07')).json()) as Array<{ name: string }>;
    expect(provinces.map((p) => p.name)).toEqual(['Genova', 'Imperia', 'La Spezia', 'Savona']);
  });

  it('taxonomy comes from the database', async () => {
    const tax = (await (await req('/api/ref/taxonomy')).json()) as { categories: Array<{ code: string; types: unknown[] }>; fields: Record<string, unknown> };
    expect(tax.categories).toHaveLength(7);
    expect(tax.categories.reduce((n, c) => n + c.types.length, 0)).toBe(69);
    expect(tax.fields.area_m2).toBeDefined();
    // admin adds a type in the DB -> visible without code changes
    await env.DB.prepare(
      `INSERT INTO property_types (code, category_code, name, financial_models) VALUES ('wine_cellar', 'specialized', '{"ru":"Винный погреб"}', '["area_rental"]')`,
    ).run();
    const tax2 = (await (await req('/api/ref/taxonomy')).json()) as { categories: Array<{ code: string; types: Array<{ code: string }> }> };
    expect(tax2.categories.find((c) => c.code === 'specialized')!.types.map((t) => t.code)).toContain('wine_cellar');
  });
});

describe('search profiles', () => {
  const garages = {
    name: 'Гаражи в Лигурии',
    countries: ['it'],
    regions: ['it-r-07'],
    typeCodes: ['garage', 'parking_space'],
    priceMax: 4_000_000,
    targetNetYield: 0.06,
    geo: { circles: [{ center: { lat: 43.8159, lng: 7.7761 }, radiusM: 30_000 }] },
    notify: { minScore: 70 },
  };

  it('create, read, update, delete', async () => {
    const created = await req('/api/profiles', { method: 'POST', body: JSON.stringify(garages) });
    expect(created.status).toBe(201);
    const p = (await created.json()) as { id: string; countries: string[]; strategy: string; isActive: boolean };
    expect(p).toMatchObject({ countries: ['IT'], strategy: 'income', isActive: true });

    const list = (await (await req('/api/profiles')).json()) as unknown[];
    expect(list).toHaveLength(1);

    const upd = await req(`/api/profiles/${p.id}`, { method: 'PUT', body: JSON.stringify({ ...garages, name: 'Гаражи Сан-Ремо', isActive: false }) });
    expect(upd.status).toBe(200);
    expect(await upd.json()).toMatchObject({ name: 'Гаражи Сан-Ремо', isActive: false });

    expect((await req(`/api/profiles/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(`/api/profiles/${p.id}`)).status).toBe(404);

    const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE entity = 'search_profile' ORDER BY created_at, rowid").all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
  });

  it('profiles are independent per user', async () => {
    const created = (await (await req('/api/profiles', { method: 'POST', body: JSON.stringify(garages) })).json()) as { id: string };
    await env.DB.prepare("UPDATE sessions SET user_id = 'u2'").run();
    expect((await req(`/api/profiles/${created.id}`)).status).toBe(404);
    expect((await (await req('/api/profiles')).json()) as unknown[]).toHaveLength(0);
    expect((await req(`/api/profiles/${created.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('validation errors', async () => {
    const bad = await req('/api/profiles', { method: 'POST', body: JSON.stringify({ ...garages, priceMin: 5_000_000, priceMax: 1 }) });
    expect(bad.status).toBe(422);
    const unknownType = await req('/api/profiles', { method: 'POST', body: JSON.stringify({ ...garages, typeCodes: ['spaceship'] }) });
    expect(unknownType.status).toBe(422);
    expect(await unknownType.json()).toMatchObject({ missing: ['property_types:spaceship'] });
    expect((await req('/api/profiles', { method: 'POST', body: '{oops' })).status).toBe(400);
  });
});

describe('calculator', () => {
  it('garage: unit rental model, 3 scenarios × 1/3/5 years', async () => {
    const r = await req('/api/calc', {
      method: 'POST',
      body: JSON.stringify({
        model: 'unit_rental',
        modelInput: { units: 1, monthlyRatePerUnit: 12_000, occupancy: 0.92 },
        acquisition: { price: 2_800_000, purchaseTaxRate: 0.09, notaryFees: 150_000 },
        operating: { insurance: 8_000, holdingTax: 20_000, maintenance: 5_000 },
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      engineVersion: string;
      scenarios: Array<{ scenario: string; yearOne: { statement: { gri: number; noi: number }; netYield: number }; horizons: Array<{ horizonYears: number }> }>;
      assumptions: Array<{ key: string }>;
      disclaimer: string;
    };
    expect(body.engineVersion).toBe('fin-1.1.0');
    const base = body.scenarios.find((s) => s.scenario === 'base')!;
    // 120 €/month × 12 × 92% = 1,324.80 €
    expect(base.yearOne.statement.gri).toBe(132_480);
    expect(base.yearOne.statement.noi).toBe(132_480 - 33_000);
    // total cost = 28,000 + 2,520 + 1,500 = 32,020 €
    expect(base.yearOne.netYield).toBeCloseTo(99_480 / 3_202_000, 10);
    expect(base.horizons.map((h) => h.horizonYears)).toEqual([1, 3, 5]);
    expect(body.assumptions.map((a) => a.key)).toContain('occupancy');
    expect(body.disclaimer).toBeTruthy();
  });

  it('rejects unknown models and invalid model inputs', async () => {
    const unknown = await req('/api/calc', { method: 'POST', body: JSON.stringify({ model: 'magic', modelInput: {}, acquisition: { price: 1 } }) });
    expect(unknown.status).toBe(422);
    const bad = await req('/api/calc', {
      method: 'POST',
      body: JSON.stringify({ model: 'unit_rental', modelInput: { units: 1, monthlyRatePerUnit: 100, occupancy: 2 }, acquisition: { price: 100 } }),
    });
    expect(bad.status).toBe(422);
    const missing = await req('/api/calc', { method: 'POST', body: JSON.stringify({ model: 'residential_long_term', modelInput: {}, acquisition: { price: 100 } }) });
    expect(missing.status).toBe(422);
  });
});
