import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { app } from '../src/index.js';
import { sha256Hex } from '../src/lib/auth.js';
import { handleJob, type Deps, type Job, type QueuedJob } from '../src/sources/discovery.js';
import { createTestD1, createTestQueue } from './d1-shim.js';

// ---------- a small fake agency site ----------
const ORIGIN = 'https://agenziamare.it';
const ld = (o: Record<string, unknown>) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const flat = (id: number, price: number, area: number, city = 'Sanremo', extra: Record<string, unknown> = {}) =>
  ld({ '@context': 'https://schema.org', '@type': 'RealEstateListing', name: `Trilocale ${id}`, description: `Trilocale luminoso numero ${id} vicino al mare con terrazzo`,
    offers: { '@type': 'Offer', price, priceCurrency: 'EUR', businessFunction: 'http://purl.org/goodrelations/v1#Sell' },
    about: { '@type': 'Apartment', floorSize: { value: area, unitCode: 'MTK' }, numberOfRooms: 3, address: { addressLocality: city } }, image: [`${ORIGIN}/img/${id}.jpg`], ...extra });
const rent = (id: number, price: number, area: number) =>
  ld({ '@context': 'https://schema.org', '@type': 'RealEstateListing', name: `Trilocale in affitto ${id}`, offers: { price, priceCurrency: 'EUR', businessFunction: 'http://purl.org/goodrelations/v1#LeaseOut' },
    about: { '@type': 'Apartment', floorSize: { value: area }, numberOfRooms: 3, address: { addressLocality: 'Sanremo' } } });

let pages: Record<string, { status: number; body: string }>;
function site(saleIds: Array<[number, number]>) {
  pages = {
    [`${ORIGIN}/robots.txt`]: { status: 200, body: `User-agent: *\nDisallow: /admin\nSitemap: ${ORIGIN}/sitemap.xml` },
    [`${ORIGIN}/sitemap.xml`]: { status: 200, body: `<urlset>${[...saleIds.map(([id]) => `${ORIGIN}/immobili/vendita-trilocale-${id}`), ...[1, 2, 3, 4].map((i) => `${ORIGIN}/immobili/affitto-trilocale-90${i}`), `${ORIGIN}/admin/immobili/segreto-1234`].map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>` },
  };
  for (const [id, price] of saleIds) pages[`${ORIGIN}/immobili/vendita-trilocale-${id}`] = { status: 200, body: `<html>${flat(id, price, 80)}</html>` };
  for (const i of [1, 2, 3, 4]) pages[`${ORIGIN}/immobili/affitto-trilocale-90${i}`] = { status: 200, body: `<html>${rent(900 + i, 900 + i * 10, 80)}</html>` };
}

let requested: string[];
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  requested.push(url);
  if (url.startsWith('https://nominatim.openstreetmap.org/')) return Response.json([{ lat: '43.8159', lon: '7.7761' }]);
  const p = pages[url];
  return p ? new Response(p.body, { status: p.status }) : new Response('nope', { status: 404 });
};

let env: Env;
let q: ReturnType<typeof createTestQueue<Job>>;
let deps: Deps;
const drain = async () => { while (q.messages.length) await handleJob(env, deps, q.messages.shift()!); };
const TOKEN = 'tok';
const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(path, { method: init.method ?? 'GET', headers: { Cookie: `rei_session=${TOKEN}`, 'Content-Type': 'application/json' }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }, env);

beforeEach(async () => {
  requested = [];
  q = createTestQueue<Job>();
  env = { DB: createTestD1(), ENVIRONMENT: 'test', JOBS: q.queue };
  deps = { fetch: fakeFetch, enqueue: async (jobs: QueuedJob[]) => { q.messages.push(...jobs.map(({ delaySeconds: _d, ...j }) => j as Job)); } };
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('u1', 'Батя', 'owner', ?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, 'u1', '2999-01-01', ?2)").bind(await sha256Hex(TOKEN), now).run();
  await env.DB.prepare(
    `INSERT INTO sources (id, name, kind, connector, base_url, country_code, region_id, access_status, verdict, decision, is_active, rate_limit_ms, created_at)
     VALUES ('s1', 'Agenzia Mare', 'agency', 'generic', ?1, 'IT', 'it-p-im', 'approved_public', 'suitable', 'approved', 1, 5000, ?2)`,
  ).bind(ORIGIN, now).run();
  await env.DB.prepare(
    `INSERT INTO search_profiles (id, user_id, name, countries, regions, type_codes, price_max, notify, is_active, created_at, updated_at)
     VALUES ('p1', 'u1', 'Квартиры Империя', '["IT"]', '["it-r-07","it-p-im"]', '["apartment"]', 40000000, '{}', 1, ?1, ?1)`,
  ).bind(now).run();
});

describe('scan → listing → ingest → analyse → notify', () => {
  it('collects sale and rent listings, respects robots, values and scores, notifies matches', async () => {
    // 8 comparable offers: enough for a medium-confidence valuation (fewer comps -> no "below market" alert)
    site([[101, 250_000], [102, 260_000], [103, 240_000], [104, 255_000], [106, 245_000], [107, 265_000], [108, 250_000], [105, 180_000]]);
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();

    expect(requested.some((u) => u.includes('/admin/'))).toBe(false); // robots Disallow respected
    const counts = await env.DB.prepare("SELECT deal_type, COUNT(*) AS n FROM listings GROUP BY deal_type ORDER BY deal_type").all();
    expect(counts.results).toEqual([{ deal_type: 'rent', n: 4 }, { deal_type: 'sale', n: 8 }]);

    // cheap flat (180k vs ~250k median of others) is undervalued and gets the best score
    const cheap = await env.DB.prepare("SELECT p.* FROM properties p JOIN listings l ON l.property_id = p.id WHERE l.price = 18000000").first<{ id: string; score: number; undervaluation: number; net_yield: number; geo_precision: string }>();
    expect(cheap!.undervaluation).toBeGreaterThan(0.2);
    expect(cheap!.net_yield).toBeGreaterThan(0.03);
    expect(cheap!.score).toBeGreaterThan(60);
    expect(cheap!.geo_precision).toBe('city');

    const notes = await env.DB.prepare("SELECT kind, title FROM notifications WHERE user_id = 'u1' ORDER BY title").all<{ kind: string; title: string }>();
    expect(notes.results.filter((n) => n.kind === 'new')).toHaveLength(8); // rent listings don't match a purchase search
    expect(notes.results.some((n) => n.kind === 'undervalued')).toBe(true);

    const feed = (await (await call('/api/properties/feed')).json()) as { items: Array<{ price: number; score: number; profiles: unknown[] }> };
    expect(feed.items).toHaveLength(8);
    expect(feed.items[0]!.price).toBe(18_000_000); // sorted by score
  });

  it('monitoring: price drop event + notification, removal after two complete scans, no duplicate notifications', async () => {
    site([[101, 250_000], [102, 260_000], [103, 240_000], [104, 255_000]]);
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    // second pass: 101 drops price, 104 disappears
    site([[101, 225_000], [102, 260_000], [103, 240_000]]);
    await env.DB.prepare("UPDATE listings SET last_fetched_at = '2000-01-01T00:00:00Z'").run(); // force refresh
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    const drop = await env.DB.prepare("SELECT type, new_value FROM listing_events WHERE type = 'price_down'").first<{ new_value: string }>();
    expect(JSON.parse(drop!.new_value)).toEqual({ value: 22_500_000, change: -0.1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'price_down'").first('n')).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM price_history WHERE price = 22500000").first('n')).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM listings WHERE url LIKE '%-104'").first('status')).toBe('active'); // 1 miss is not enough

    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    expect(await env.DB.prepare("SELECT status FROM listings WHERE url LIKE '%-104'").first('status')).toBe('removed');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_events WHERE type = 'removed'").first('n')).toBe(1);
    // scanning again changes nothing and notifies nobody again
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first('n');
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first('n')).toBe(before);
  });

  it('a 404 detail page marks the listing removed (not sold)', async () => {
    site([[101, 250_000]]);
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    delete pages[`${ORIGIN}/immobili/vendita-trilocale-101`];
    q.messages.push({ type: 'listing', sourceId: 's1', url: `${ORIGIN}/immobili/vendita-trilocale-101` });
    await drain();
    const ev = await env.DB.prepare("SELECT new_value FROM listing_events WHERE type = 'removed'").first<{ new_value: string }>();
    expect(JSON.parse(ev!.new_value).value).toContain('HTTP 404');
  });

  it('unapproved or deactivated sources are never fetched', async () => {
    site([[101, 250_000]]);
    await env.DB.prepare("UPDATE sources SET is_active = 0").run();
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    expect(requested).toEqual([]);
  });

  it('robots.txt turning hostile disables the source', async () => {
    site([[101, 250_000]]);
    pages[`${ORIGIN}/robots.txt`] = { status: 200, body: 'User-agent: *\nDisallow: /' };
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    expect(await env.DB.prepare("SELECT access_status || '/' || is_active AS s FROM sources WHERE id = 's1'").first('s')).toBe('forbidden/0');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM listings').first('n')).toBe(0);
  });
});

describe('dedup across agencies', () => {
  it('same flat on a second agency is attached to the same property (cross-posted)', async () => {
    site([[101, 250_000]]);
    q.messages.push({ type: 'scan', sourceId: 's1' });
    await drain();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO sources (id, name, kind, connector, base_url, country_code, region_id, access_status, is_active, rate_limit_ms, created_at)
       VALUES ('s2', 'Altra', 'agency', 'generic', 'https://altra.it', 'IT', 'it-p-im', 'approved_public', 1, 5000, ?1)`,
    ).bind(now).run();
    pages['https://altra.it/robots.txt'] = { status: 404, body: '' };
    pages['https://altra.it/sitemap.xml'] = { status: 200, body: '<urlset><url><loc>https://altra.it/annunci/trilocale-sanremo-777</loc></url></urlset>' };
    pages['https://altra.it/annunci/trilocale-sanremo-777'] = { status: 200, body: flat(101, 249_000, 80).replace(`${ORIGIN}/img/101.jpg`, 'https://altra.it/media/101.jpg') };
    q.messages.push({ type: 'scan', sourceId: 's2' });
    await drain();
    const pid = (url: string) => env.DB.prepare('SELECT property_id FROM listings WHERE url = ?1').bind(url).first<string>('property_id');
    expect(await pid('https://altra.it/annunci/trilocale-sanremo-777')).toBe(await pid(`${ORIGIN}/immobili/vendita-trilocale-101`));
    // similar rent flats with city-level coordinates are NOT merged automatically — they go to manual review
    expect(await env.DB.prepare("SELECT COUNT(DISTINCT property_id) AS n FROM listings WHERE deal_type = 'rent'").first('n')).toBe(4);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_events WHERE type = 'cross_posted'").first('n')).toBe(1);
  });
});

describe('manual / test import and property card', () => {
  const items = [1, 2, 3, 4, 5].map((i) => ({ url: `https://example.test/box-${i}`, priceEuro: 20_000 + i * 2_000, typeCode: 'garage', city: 'Imperia', lat: 43.889, lng: 8.039 }))
    .concat([1, 2, 3].map((i) => ({ url: `https://example.test/box-affitto-${i}`, priceEuro: 100 + i * 10, typeCode: 'garage', city: 'Imperia', lat: 43.889, lng: 8.039, dealType: 'rent' as const })) as never[]);

  it('test data is flagged, analysed, kept out of the default feed and never notifies', async () => {
    const r = await call('/api/properties/import', { method: 'POST', body: { test: true, regionId: 'it-p-im', items } });
    expect(await r.json()).toEqual({ imported: 8, created: 8 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM properties WHERE is_test = 1').first('n')).toBe(8);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notifications').first('n')).toBe(0);
    await env.DB.prepare("UPDATE search_profiles SET type_codes = '[\"garage\"]'").run();
    expect(((await (await call('/api/properties/feed')).json()) as { items: unknown[] }).items).toHaveLength(0);
    const testFeed = (await (await call('/api/properties/feed?test=1')).json()) as { items: Array<{ id: string; isTest: boolean; netYield: number | null }> };
    expect(testFeed.items).toHaveLength(5);
    expect(testFeed.items.every((i) => i.isTest)).toBe(true);

    const card = (await (await call(`/api/properties/${testFeed.items[0]!.id}`)).json()) as { isTest: boolean; valuation: { n: number; kind: string }; rental: { assumptions: Array<{ source: string }> }; score: { reasons: string[] }; category: { risks: string[] } };
    expect(card.isTest).toBe(true);
    expect(card.valuation.kind).toBe('asking');
    expect(card.rental.assumptions.some((a) => a.source.includes('не проверены'))).toBe(true);
    expect(card.category.risks.length).toBeGreaterThan(0);
  });

  it('favorites and notes', async () => {
    await call('/api/properties/import', { method: 'POST', body: { test: true, regionId: 'it-p-im', items: items.slice(0, 1) } });
    const id = await env.DB.prepare('SELECT id FROM properties').first<string>('id');
    await call(`/api/properties/${id}/favorite`, { method: 'PUT' });
    expect(((await (await call('/api/properties/favorites')).json()) as unknown[])).toHaveLength(1);
    expect((await call(`/api/properties/${id}/notes`, { method: 'POST', body: { text: 'Позвонить агенту' } })).status).toBe(201);
    const card = (await (await call(`/api/properties/${id}`)).json()) as { favorite: boolean; notes: Array<{ text: string }> };
    expect(card).toMatchObject({ favorite: true, notes: [{ text: 'Позвонить агенту' }] });
  });

  it('import validation', async () => {
    expect((await call('/api/properties/import', { method: 'POST', body: { test: true, regionId: 'it-p-im', items: [{ ...items[0], typeCode: 'spaceship' }] } })).status).toBe(422);
    expect((await call('/api/properties/import', { method: 'POST', body: { test: true, regionId: 'nowhere', items: items.slice(0, 1) } })).status).toBe(422);
  });
});

describe('share target', () => {
  it('accepts links only from connected sites; portals rejected', async () => {
    const r1 = (await (await call('/api/properties/share', { method: 'POST', body: { url: 'https://www.immobiliare.it/annunci/123' } })).json()) as { status: string };
    expect(r1.status).toBe('unknown_site');
    const r2 = (await (await call('/api/properties/share', { method: 'POST', body: { url: 'https://agenziamare.it/immobili/vendita-trilocale-555' } })).json()) as { status: string };
    expect(r2.status).toBe('queued');
    expect(q.messages).toContainEqual({ type: 'listing', sourceId: 's1', url: 'https://agenziamare.it/immobili/vendita-trilocale-555' });
  });
});
