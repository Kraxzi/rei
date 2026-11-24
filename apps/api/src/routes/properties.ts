import { CATEGORIES, matchProfile, TYPES, type ExtractedListing, type MatchProfile } from '@rei/core';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { analyzePropertyById } from '../ingest/analyze.js';
import { ingestListing } from '../ingest/ingest.js';
import { notifyForProperty } from '../ingest/notify.js';
import { audit } from '../lib/auth.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';

export const properties = new Hono<AppEnv>();

const requireAdmin = async (c: Context<AppEnv>, next: () => Promise<void>) => {
  if (!['owner', 'admin'].includes(c.get('user').role)) throw new HTTPException(403, { message: 'forbidden' });
  await next();
};

interface FeedRow {
  id: string; type_code: string; country_code: string; region_id: string | null; parent_id: string | null; city_id: string | null; city: string | null;
  area_m2: number | null; rooms: number | null; lat: number | null; lng: number | null; features: string; score: number | null; score_confidence: number | null;
  net_yield: number | null; undervaluation: number | null; is_test: number; price: number | null; currency: string | null; deal_type: string | null;
  title: string | null; first_seen_at: string; image: string | null; listing_count: number; fav: number; source_kind: string | null;
}

const FEED_SQL = `
  SELECT p.id, p.type_code, p.country_code, p.region_id, r.parent_id, p.city_id, c.name AS city, p.area_m2, p.rooms, p.lat, p.lng, p.features,
         p.score, p.score_confidence, p.net_yield, p.undervaluation, p.is_test,
         l.price, l.currency, l.deal_type, l.title, l.first_seen_at, s.kind AS source_kind,
         (SELECT url FROM property_images i WHERE i.property_id = p.id ORDER BY position LIMIT 1) AS image,
         (SELECT COUNT(*) FROM listings x WHERE x.property_id = p.id AND x.status != 'removed') AS listing_count,
         EXISTS(SELECT 1 FROM favorites f WHERE f.property_id = p.id AND f.user_id = ?1) AS fav
  FROM properties p
  JOIN listings l ON l.id = (SELECT id FROM listings WHERE property_id = p.id AND status != 'removed' ORDER BY last_seen_at DESC LIMIT 1)
  LEFT JOIN sources s ON s.id = l.source_id
  LEFT JOIN regions r ON r.id = p.region_id LEFT JOIN cities c ON c.id = p.city_id
  WHERE p.merged_into IS NULL`;

const card = (r: FeedRow) => ({
  id: r.id, typeCode: r.type_code, typeName: TYPES.find((t) => t.code === r.type_code)?.name.ru ?? r.type_code, city: r.city,
  areaM2: r.area_m2, rooms: r.rooms, lat: r.lat, lng: r.lng, price: r.price, currency: r.currency, dealType: r.deal_type, title: r.title,
  score: r.score, scoreConfidence: r.score_confidence, netYield: r.net_yield, undervaluation: r.undervaluation, image: r.image,
  firstSeenAt: r.first_seen_at, listings: r.listing_count, favorite: r.fav === 1, isTest: r.is_test === 1, isAuction: r.source_kind === 'auction',
});

const profileOf = (row: Record<string, unknown>): MatchProfile => ({
  countries: parseJson(row.countries as string, []), regions: parseJson(row.regions as string, []), cities: parseJson(row.cities as string, []),
  typeCodes: parseJson(row.type_codes as string, []), priceMin: row.price_min as number | null, priceMax: row.price_max as number | null,
  areaMin: row.area_min as number | null, areaMax: row.area_max as number | null, targetNetYield: row.target_net_yield as number | null,
  condition: parseJson(row.condition as string, []), geo: parseJson(row.geo as string, {}), isActive: true,
});

/** Feed: properties matching the user's active searches (or one search), sorted by score / newest / yield. */
properties.get('/feed', async (c) => {
  const user = c.get('user');
  const profileId = c.req.query('profile');
  const sort = c.req.query('sort') ?? 'score';
  const includeTest = c.req.query('test') === '1';
  const { results: profs } = await c.env.DB.prepare(`SELECT * FROM search_profiles WHERE user_id = ?1 AND is_active = 1 ${profileId ? 'AND id = ?2' : ''}`)
    .bind(...(profileId ? [user.id, profileId] : [user.id]))
    .all<Record<string, unknown>>();
  const { results } = await c.env.DB.prepare(`${FEED_SQL} AND p.is_test = ?2 AND l.deal_type IS NOT 'rent' ORDER BY l.first_seen_at DESC LIMIT 1000`)
    .bind(user.id, includeTest ? 1 : 0)
    .all<FeedRow>();
  const matched = results
    .map((r) => {
      const f = parseJson<Record<string, unknown>>(r.features, {});
      const subject = { countryCode: r.country_code, regionIds: [r.region_id, r.parent_id].filter((x): x is string => !!x), cityId: r.city_id, typeCode: r.type_code, dealType: r.deal_type, price: r.price, areaM2: r.area_m2, lat: r.lat, lng: r.lng, condition: typeof f.condition === 'string' ? f.condition : null, netYield: r.net_yield };
      const hits = profs.filter((p) => matchProfile(subject, profileOf(p)).match).map((p) => ({ id: p.id as string, name: p.name as string }));
      return { ...card(r), profiles: hits };
    })
    .filter((x) => x.profiles.length > 0);
  const key = (x: (typeof matched)[number]) => (sort === 'new' ? x.firstSeenAt : sort === 'yield' ? (x.netYield ?? -1) : (x.score ?? -1));
  matched.sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
  return c.json({ items: matched.slice(0, 200), total: matched.length, profiles: profs.length });
});

properties.get('/favorites', async (c) => {
  const { results } = await c.env.DB.prepare(`${FEED_SQL} AND EXISTS(SELECT 1 FROM favorites f WHERE f.property_id = p.id AND f.user_id = ?1) ORDER BY p.score DESC`)
    .bind(c.get('user').id)
    .all<FeedRow>();
  return c.json(results.map(card));
});

/** Map: all analysed offers with coordinates (optionally only matches is done client-side via feed). */
properties.get('/map', async (c) => {
  const { results } = await c.env.DB.prepare(`${FEED_SQL} AND p.lat IS NOT NULL AND p.is_test = 0 AND l.deal_type IS NOT 'rent' LIMIT 2000`).bind(c.get('user').id).all<FeedRow>();
  return c.json(results.map(card));
});

properties.get('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const p = await c.env.DB.prepare(
    `SELECT p.*, c.name AS city, r.name AS region_name FROM properties p LEFT JOIN cities c ON c.id = p.city_id LEFT JOIN regions r ON r.id = p.region_id WHERE p.id = ?1`,
  ).bind(id).first<Record<string, unknown>>();
  if (!p) throw new HTTPException(404, { message: 'not found' });
  if (p.merged_into) return c.json({ redirect: p.merged_into });

  const [listings, prices, events, images, score, valuation, rental, notes, fav, dups] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT l.id, l.url, l.title, l.description, l.price, l.currency, l.deal_type, l.status, l.first_seen_at, l.last_seen_at, l.removed_at, l.extraction, l.is_test, s.name AS source_name, s.kind AS source_kind, s.base_url
                      FROM listings l JOIN sources s ON s.id = l.source_id WHERE l.property_id = ?1 ORDER BY l.status = 'removed', l.last_seen_at DESC`).bind(id),
    c.env.DB.prepare('SELECT h.listing_id, h.price, h.currency, h.observed_at FROM price_history h JOIN listings l ON l.id = h.listing_id WHERE l.property_id = ?1 ORDER BY h.observed_at').bind(id),
    c.env.DB.prepare('SELECT type, old_value, new_value, occurred_at FROM listing_events WHERE property_id = ?1 ORDER BY occurred_at DESC LIMIT 50').bind(id),
    c.env.DB.prepare('SELECT url FROM property_images WHERE property_id = ?1 AND gone_at IS NULL ORDER BY position LIMIT 20').bind(id),
    c.env.DB.prepare('SELECT score, components, confidence, confidence_reasons, profile_code, engine_version, computed_at FROM investment_scores WHERE property_id = ?1 ORDER BY computed_at DESC LIMIT 1').bind(id),
    c.env.DB.prepare('SELECT value_low, value_mid, value_high, inputs, confidence, computed_at FROM property_valuations WHERE property_id = ?1 ORDER BY computed_at DESC LIMIT 1').bind(id),
    c.env.DB.prepare("SELECT inputs, assumptions, results, computed_at FROM rental_models WHERE property_id = ?1 AND model = 'auto' ORDER BY computed_at DESC LIMIT 1").bind(id),
    c.env.DB.prepare('SELECT id, text, created_at FROM notes WHERE property_id = ?1 AND user_id = ?2 ORDER BY created_at DESC').bind(id, user.id),
    c.env.DB.prepare('SELECT 1 AS f FROM favorites WHERE property_id = ?1 AND user_id = ?2').bind(id, user.id),
    c.env.DB.prepare("SELECT id, property_a, property_b, probability FROM dedup_candidates WHERE status = 'pending' AND (property_a = ?1 OR property_b = ?1)").bind(id),
  ]);
  const type = TYPES.find((t) => t.code === p.type_code);
  const cat = CATEGORIES.find((x) => x.code === type?.category);
  const s = score!.results[0] as Record<string, string | number> | undefined;
  const v = valuation!.results[0] as Record<string, string | number> | undefined;
  const rm = rental!.results[0] as Record<string, string> | undefined;
  return c.json({
    id: p.id, typeCode: p.type_code, typeName: type?.name.ru, category: cat ? { code: cat.code, name: cat.name.ru, risks: cat.typicalRisks, legalChecks: cat.legalChecks } : null,
    financialModels: type?.financialModels ?? [], city: p.city, region: p.region_name, address: p.address_norm, postalCode: p.postal_code,
    lat: p.lat, lng: p.lng, geoPrecision: p.geo_precision, areaM2: p.area_m2, rooms: p.rooms, floor: p.floor,
    features: parseJson(p.features as string, {}), provenance: parseJson(p.provenance as string, {}), isTest: p.is_test === 1,
    listings: (listings!.results as Array<Record<string, unknown>>).map((l) => ({ ...l, extraction: parseJson(l.extraction as string, null), normalized: undefined })),
    priceHistory: prices!.results,
    events: (events!.results as Array<Record<string, string>>).map((e) => ({ type: e.type, old: parseJson(e.old_value, null), new: parseJson(e.new_value, null), at: e.occurred_at })),
    images: (images!.results as Array<{ url: string }>).map((i) => i.url),
    score: s ? { score: Number(s.score) < 0 ? null : s.score, confidence: s.confidence, components: parseJson(s.components as string, {}), reasons: parseJson(s.confidence_reasons as string, []), profile: s.profile_code, engine: s.engine_version, at: s.computed_at } : null,
    valuation: v ? { low: v.value_low, mid: v.value_mid, high: v.value_high, ...parseJson<object>(v.inputs as string, {}), confidence: v.confidence, at: v.computed_at } : null,
    rental: rm ? { ...parseJson<object>(rm.inputs, {}), assumptions: parseJson(rm.assumptions, []), finance: parseJson(rm.results, null), at: rm.computed_at } : null,
    netYield: p.net_yield, undervaluation: p.undervaluation,
    notes: notes!.results, favorite: fav!.results.length > 0, duplicates: dups!.results,
  });
});

properties.put('/:id/favorite', async (c) => {
  await c.env.DB.prepare('INSERT OR IGNORE INTO favorites (user_id, property_id, created_at) VALUES (?1, ?2, ?3)').bind(c.get('user').id, c.req.param('id'), nowIso()).run();
  return c.json({ favorite: true });
});
properties.delete('/:id/favorite', async (c) => {
  await c.env.DB.prepare('DELETE FROM favorites WHERE user_id = ?1 AND property_id = ?2').bind(c.get('user').id, c.req.param('id')).run();
  return c.json({ favorite: false });
});

properties.post('/:id/notes', async (c) => {
  const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(await c.req.json().catch(() => ({})));
  const id = ulid();
  await c.env.DB.prepare('INSERT INTO notes (id, user_id, property_id, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, c.get('user').id, c.req.param('id'), text, nowIso()).run();
  return c.json({ id }, 201);
});
properties.delete('/:id/notes/:noteId', async (c) => {
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ?1 AND user_id = ?2').bind(c.req.param('noteId'), c.get('user').id).run();
  return c.body(null, 204);
});

properties.post('/:id/reanalyze', async (c) => {
  const r = await analyzePropertyById(c.env, c.req.param('id'));
  return c.json({ analyzed: !!r });
});

// ---------- duplicates review (admin) ----------

properties.post('/dedup/:candidateId', requireAdmin, async (c) => {
  const { decision } = z.object({ decision: z.enum(['merge', 'reject']) }).parse(await c.req.json().catch(() => ({})));
  const d = await c.env.DB.prepare("SELECT * FROM dedup_candidates WHERE id = ?1 AND status = 'pending'").bind(c.req.param('candidateId')).first<{ id: string; property_a: string; property_b: string }>();
  if (!d) throw new HTTPException(404, { message: 'not found' });
  const now = nowIso();
  if (decision === 'merge') {
    // keep the older property (a < b by ULID); move listings, images; mark b merged
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE listings SET property_id = ?1 WHERE property_id = ?2').bind(d.property_a, d.property_b),
      c.env.DB.prepare('UPDATE property_images SET property_id = ?1 WHERE property_id = ?2').bind(d.property_a, d.property_b),
      c.env.DB.prepare('UPDATE listing_events SET property_id = ?1 WHERE property_id = ?2').bind(d.property_a, d.property_b),
      c.env.DB.prepare('UPDATE OR IGNORE favorites SET property_id = ?1 WHERE property_id = ?2').bind(d.property_a, d.property_b),
      c.env.DB.prepare('UPDATE properties SET merged_into = ?1, updated_at = ?3 WHERE id = ?2').bind(d.property_a, d.property_b, now),
      c.env.DB.prepare("UPDATE dedup_candidates SET status = 'merged', decided_by = ?2, decided_at = ?3 WHERE id = ?1").bind(d.id, c.get('user').id, now),
    ]);
    await analyzePropertyById(c.env, d.property_a);
  } else {
    await c.env.DB.prepare("UPDATE dedup_candidates SET status = 'rejected', decided_by = ?2, decided_at = ?3 WHERE id = ?1").bind(d.id, c.get('user').id, now).run();
  }
  await audit(c.env.DB, { userId: c.get('user').id, action: `dedup_${decision}`, entity: 'property', entityId: d.property_a, details: d }, ulid());
  return c.json({ ok: true, keep: d.property_a });
});

// ---------- manual import (spec stage 2: CSV/JSON) ----------

const importItem = z.object({
  url: z.string().url(),
  title: z.string().max(300).optional(),
  description: z.string().max(5000).optional(),
  priceEuro: z.number().positive(),
  dealType: z.enum(['sale', 'rent']).default('sale'),
  typeCode: z.string(),
  areaM2: z.number().positive().optional(),
  rooms: z.number().int().positive().optional(),
  city: z.string().optional(),
  address: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  images: z.array(z.string().url()).max(20).default([]),
});

/**
 * Imports listings typed in by hand or exported from elsewhere. `test: true` marks them as test data:
 * kept apart from real data, never notified, hidden from the feed unless asked.
 */
properties.post('/import', requireAdmin, async (c) => {
  const body = z.object({ test: z.boolean(), regionId: z.string(), items: z.array(importItem).min(1).max(200) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'validation', issues: body.error.issues }, 422);
  const { test, regionId, items } = body.data;
  const region = await c.env.DB.prepare('SELECT id, country_code FROM regions WHERE id = ?1').bind(regionId).first<{ id: string; country_code: string }>();
  if (!region) return c.json({ error: 'unknown region' }, 422);
  const unknownTypes = items.filter((i) => !TYPES.some((t) => t.code === i.typeCode)).map((i) => i.typeCode);
  if (unknownTypes.length) return c.json({ error: 'unknown types', unknownTypes }, 422);

  const sourceId = test ? 'manual-test' : 'manual-import';
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO sources (id, name, kind, connector, base_url, country_code, access_status, is_active, created_at)
     VALUES (?1, ?2, ?3, 'manual', ?4, ?5, 'manual_import', 1, ?6)`,
  ).bind(sourceId, test ? 'Тестовый импорт' : 'Ручной импорт', test ? 'test' : 'manual', `manual://${sourceId}`, region.country_code, nowIso()).run();

  let created = 0;
  const done: Array<{ propertyId: string; events: Awaited<ReturnType<typeof ingestListing>> extends infer R ? R extends { events: infer E } ? E : never : never }> = [];
  for (const it of items) {
    const listing: ExtractedListing = {
      url: it.url, externalId: it.url, title: it.title ?? null, description: it.description ?? null, price: Math.round(it.priceEuro * 100), currency: 'EUR',
      dealType: it.dealType, typeCode: it.typeCode, areaM2: it.areaM2 ?? null, rooms: it.rooms ?? null, bathrooms: null, floor: null,
      address: it.address ?? null, city: it.city ?? null, postalCode: null, lat: it.lat ?? null, lng: it.lng ?? null, images: it.images, features: {},
      method: 'jsonld', confidence: 1,
    };
    const fetcher: typeof fetch = test ? (async () => new Response('[]', { status: 200 })) as typeof fetch : fetch; // tests never geocode externally
    const r = await ingestListing(c.env, fetcher, { id: sourceId, countryCode: region.country_code, regionId }, listing, { isTest: test });
    if (!r) continue;
    if (r.isNew) created++;
    done.push({ propertyId: r.propertyId, events: r.events });
  }
  // analyse after everything is stored, so rent offers from the same batch serve as comparables
  for (const d of done) await analyzePropertyById(c.env, d.propertyId);
  if (!test) for (const d of done) await notifyForProperty(c.env, d.propertyId, d.events);
  await audit(c.env.DB, { userId: c.get('user').id, action: 'import', entity: 'listings', details: { test, count: items.length, created } }, ulid());
  return c.json({ imported: items.length, created });
});

// ---------- notifications ----------

export const notifications = new Hono<AppEnv>();
notifications.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, kind, property_id, title, body, created_at, read_at FROM notifications WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 100')
    .bind(c.get('user').id)
    .all();
  return c.json(results);
});
notifications.get('/latest', async (c) => {
  const n = await c.env.DB.prepare('SELECT id, title, body, property_id, created_at FROM notifications WHERE user_id = ?1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .bind(c.get('user').id).first();
  const unread = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?1 AND read_at IS NULL').bind(c.get('user').id).first<number>('n');
  return c.json({ latest: n, unread });
});
notifications.post('/read', async (c) => {
  await c.env.DB.prepare('UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL').bind(c.get('user').id, nowIso()).run();
  return c.json({ ok: true });
});
