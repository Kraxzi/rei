import {
  contentHash, DEDUP_AUTO_MERGE, DEDUP_REVIEW, duplicateProbability, geohashEncode, listingEvents, TYPES,
  type DedupItem, type ExtractedListing, type ListingEvent, type Snapshot,
} from '@rei/core';
import type { Env } from '../env.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';
import { cityFor } from './geocode.js';

export interface SourceRef {
  id: string;
  countryCode: string;
  regionId: string | null;
}

export interface IngestResult {
  propertyId: string;
  listingId: string;
  events: Array<ListingEvent & { id: string }>;
  isNew: boolean;
}

interface ListingRow {
  id: string; property_id: string; price: number | null; currency: string | null; deal_type: string | null; title: string | null;
  normalized: string; status: 'active' | 'removed' | 'reappeared';
}

const categoryOf = (code: string) => TYPES.find((t) => t.code === code)?.category ?? null;

function snapshotOf(row: ListingRow): Snapshot {
  const n = parseJson<Partial<ExtractedListing>>(row.normalized, {});
  return { price: row.price, currency: row.currency, dealType: row.deal_type, title: row.title, areaM2: n.areaM2 ?? null, rooms: n.rooms ?? null, images: n.images ?? [], status: row.status };
}
const snapshotFrom = (l: ExtractedListing): Snapshot => ({ price: l.price, currency: l.currency, dealType: l.dealType, title: l.title, areaM2: l.areaM2, rooms: l.rooms, images: l.images, status: 'active' });

const dedupItem = (l: { geoExact?: boolean; typeCode: string | null; dealType: string | null; price: number | null; areaM2: number | null; rooms: number | null; lat: number | null; lng: number | null; city: string | null; title: string | null; description: string | null; images: string[] }): DedupItem => ({
  typeCode: l.typeCode, dealType: l.dealType, price: l.price, areaM2: l.areaM2, rooms: l.rooms, lat: l.lat, lng: l.lng, city: l.city,
  text: `${l.title ?? ''} ${l.description ?? ''}`, images: l.images, geoExact: l.geoExact ?? false,
});

async function insertEvents(env: Env, propertyId: string, listingId: string, events: ListingEvent[], hash: string): Promise<Array<ListingEvent & { id: string }>> {
  const out: Array<ListingEvent & { id: string }> = [];
  const now = nowIso();
  for (const e of events) {
    const id = ulid();
    // the key makes the same change idempotent (re-processing the page doesn't duplicate events or notifications)
    const key = `${listingId}:${e.type}:${e.type === 'new' ? '' : hash}`;
    const res = await env.DB.prepare(
      'INSERT INTO listing_events (id, listing_id, property_id, type, old_value, new_value, occurred_at, event_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(event_key) DO NOTHING',
    )
      .bind(id, listingId, propertyId, e.type, JSON.stringify(e.old ?? null), JSON.stringify({ value: e.new ?? null, change: e.change ?? null }), now, key)
      .run();
    if (res.meta.changes) out.push({ ...e, id });
  }
  return out;
}

/** Stores one extracted listing: monitoring for known listings, dedup + new property for new ones. */
export async function ingestListing(env: Env, fetcher: typeof fetch, source: SourceRef, l: ExtractedListing, opts: { isTest?: boolean; raw?: string } = {}): Promise<IngestResult | null> {
  if (!l.typeCode) return null;
  const now = nowIso();
  const hash = contentHash(l);
  const isTest = opts.isTest ? 1 : 0;
  const normalized = JSON.stringify(l);
  const raw = opts.raw ?? normalized;

  const existing = await env.DB.prepare('SELECT id, property_id, price, currency, deal_type, title, normalized, status FROM listings WHERE source_id = ?1 AND external_id = ?2')
    .bind(source.id, l.externalId)
    .first<ListingRow>();

  if (existing) {
    const events = listingEvents(snapshotOf(existing), snapshotFrom(l));
    await env.DB.prepare(
      `UPDATE listings SET url = ?2, title = ?3, description = ?4, price = ?5, currency = ?6, deal_type = ?7, status = 'active', last_seen_at = ?8,
         last_fetched_at = ?8, missed_runs = 0, removed_at = NULL, raw = ?9, normalized = ?10, content_hash = ?11, extraction = ?12 WHERE id = ?1`,
    )
      .bind(existing.id, l.url, l.title, l.description, l.price, l.currency, l.dealType, now, raw.slice(0, 50_000), normalized, hash, JSON.stringify({ method: l.method, confidence: l.confidence }))
      .run();
    if (l.price !== null && l.price !== existing.price) {
      await env.DB.prepare('INSERT OR IGNORE INTO price_history (listing_id, price, currency, observed_at) VALUES (?1, ?2, ?3, ?4)').bind(existing.id, l.price, l.currency ?? 'EUR', now).run();
    }
    return { propertyId: existing.property_id, listingId: existing.id, events: await insertEvents(env, existing.property_id, existing.id, events, hash), isNew: false };
  }

  // ---- new listing: location ----
  const city = await cityFor(env, fetcher, l.city, source.regionId);
  const lat = l.lat ?? city?.lat ?? null;
  const lng = l.lng ?? city?.lng ?? null;
  const precision = l.lat !== null ? 'exact' : city?.lat !== null && city?.lat !== undefined ? 'city' : 'unknown';

  // ---- duplicates: same category, nearby or same city, active listings ----
  const cat = categoryOf(l.typeCode);
  const sameCat = TYPES.filter((t) => t.category === cat).map((t) => t.code);
  const ph = sameCat.map((_, i) => `?${i + 5}`).join(',');
  const near = lat !== null && lng !== null ? 0.02 : null; // ~2 km box
  const { results: cands } = await env.DB.prepare(
    `SELECT p.id, p.type_code, p.lat, p.lng, p.geo_precision, p.area_m2, p.rooms, c.name AS city, l.id AS listing_id, l.source_id, l.price, l.deal_type, l.title, l.description, l.normalized, l.status
     FROM properties p JOIN listings l ON l.property_id = p.id LEFT JOIN cities c ON c.id = p.city_id
     WHERE p.merged_into IS NULL AND p.is_test = ?1 AND p.type_code IN (${ph})
       AND ${near !== null ? 'p.lat BETWEEN ?2 - 0.02 AND ?2 + 0.02 AND p.lng BETWEEN ?3 - 0.02 AND ?3 + 0.02' : '(?2 IS NULL AND ?3 IS NULL AND p.city_id = ?4)'}
     LIMIT 200`,
  )
    .bind(isTest, lat, lng, city?.id ?? null, ...sameCat)
    .all<{ id: string; type_code: string; geo_precision: string | null; lat: number | null; lng: number | null; area_m2: number | null; rooms: number | null; city: string | null; listing_id: string; source_id: string; price: number | null; deal_type: string | null; title: string | null; description: string | null; normalized: string; status: string }>();

  const me = dedupItem({ ...l, lat, lng, geoExact: precision === 'exact' });
  let best: { propertyId: string; p: number; signals: Record<string, number>; sameSourceRemoved: boolean } | null = null;
  for (const c of cands) {
    const imgs = parseJson<{ images?: string[] }>(c.normalized, {}).images ?? [];
    const r = duplicateProbability(me, dedupItem({ geoExact: c.geo_precision === 'exact', typeCode: c.type_code, dealType: c.deal_type, price: c.price, areaM2: c.area_m2, rooms: c.rooms, lat: c.lat, lng: c.lng, city: c.city, title: c.title, description: c.description, images: imgs }));
    if (!best || r.probability > best.p) best = { propertyId: c.id, p: r.probability, signals: r.signals, sameSourceRemoved: c.source_id === source.id && c.status === 'removed' };
  }

  let propertyId: string;
  const extraEvents: ListingEvent[] = [];
  if (best && best.p >= DEDUP_AUTO_MERGE) {
    propertyId = best.propertyId;
    extraEvents.push(best.sameSourceRemoved ? { type: 'republished', old: null, new: l.url } : { type: 'cross_posted', old: null, new: l.url });
  } else {
    propertyId = ulid();
    const features: Record<string, unknown> = { ...l.features };
    await env.DB.prepare(
      `INSERT INTO properties (id, type_code, country_code, region_id, city_id, address_norm, postal_code, lat, lng, geo_precision, geohash, area_m2, rooms, floor, features, provenance, is_test, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)`,
    )
      .bind(
        propertyId, l.typeCode, source.countryCode, source.regionId, city?.id ?? null, l.address, l.postalCode, lat, lng, precision,
        lat !== null && lng !== null ? geohashEncode({ lat, lng }, 7) : null, l.areaM2, l.rooms, l.floor, JSON.stringify(features),
        JSON.stringify({ source_id: source.id, fetched_at: now, method: l.method, confidence: l.confidence, geo: precision }), isTest, now,
      )
      .run();
    if (best && best.p >= DEDUP_REVIEW) {
      const [a, b] = [best.propertyId, propertyId].sort();
      await env.DB.prepare("INSERT OR IGNORE INTO dedup_candidates (id, property_a, property_b, probability, signals, status) VALUES (?1, ?2, ?3, ?4, ?5, 'pending')")
        .bind(ulid(), a, b, best.p, JSON.stringify(best.signals))
        .run();
    }
  }

  const listingId = ulid();
  await env.DB.prepare(
    `INSERT INTO listings (id, property_id, source_id, external_id, url, title, description, price, currency, deal_type, status, first_seen_at, last_seen_at, last_fetched_at, raw, normalized, content_hash, extraction, is_test)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?11, ?11, ?12, ?13, ?14, ?15, ?16)`,
  )
    .bind(listingId, propertyId, source.id, l.externalId, l.url, l.title, l.description, l.price, l.currency, l.dealType, now, raw.slice(0, 50_000), normalized, hash, JSON.stringify({ method: l.method, confidence: l.confidence }), isTest)
    .run();
  if (l.price !== null) await env.DB.prepare('INSERT OR IGNORE INTO price_history (listing_id, price, currency, observed_at) VALUES (?1, ?2, ?3, ?4)').bind(listingId, l.price, l.currency ?? 'EUR', now).run();
  for (const [i, url] of l.images.slice(0, 20).entries()) {
    await env.DB.prepare('INSERT INTO property_images (id, property_id, listing_id, url, position, first_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(ulid(), propertyId, listingId, url, i, now).run();
  }
  await env.DB.prepare('UPDATE properties SET primary_listing_id = COALESCE(primary_listing_id, ?2), updated_at = ?3 WHERE id = ?1').bind(propertyId, listingId, now).run();

  const events = await insertEvents(env, propertyId, listingId, [...listingEvents(null, snapshotFrom(l)), ...extraEvents], hash);
  return { propertyId, listingId, events, isNew: true };
}

/** A listing that disappeared: counted per complete crawl; removed after MISSED_RUNS_TO_REMOVE. Never treated as "sold". */
export async function markRemoved(env: Env, listingId: string, reason: string): Promise<Array<ListingEvent & { id: string }>> {
  const row = await env.DB.prepare("SELECT property_id, status FROM listings WHERE id = ?1").bind(listingId).first<{ property_id: string; status: string }>();
  if (!row || row.status === 'removed') return [];
  const now = nowIso();
  await env.DB.prepare("UPDATE listings SET status = 'removed', removed_at = ?2 WHERE id = ?1").bind(listingId, now).run();
  return insertEvents(env, row.property_id, listingId, [{ type: 'removed', old: 'active', new: reason }], now.slice(0, 10));
}
