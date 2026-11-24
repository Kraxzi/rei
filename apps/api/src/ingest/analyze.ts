import { analyzeProperty, completeness, TYPES, type AnalyzeResult, type Comparable } from '@rei/core';
import type { Env } from '../env.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';

export const SCORE_ENGINE = 'score-1.0.0';
const PER_UNIT = new Set(['parking', 'specialized']);

interface PropRow {
  id: string; type_code: string; lat: number | null; lng: number | null; city_id: string | null; area_m2: number | null; features: string;
  is_test: number; created_at: string; listing_id: string | null; price: number | null; deal_type: string | null; normalized: string | null; last_seen_at: string | null; first_seen_at: string | null; source_kind: string | null;
}

/** Comparable offers: same type group, nearby (≈3 km) or same city, active, seen within a year, not the subject. */
async function comps(env: Env, p: PropRow, deal: 'sale' | 'rent'): Promise<Comparable[]> {
  const cat = TYPES.find((t) => t.code === p.type_code)?.category;
  const codes = PER_UNIT.has(cat ?? '') ? TYPES.filter((t) => t.category === cat).map((t) => t.code) : [p.type_code];
  const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
  const ph = codes.map((_, i) => `?${i + 7}`).join(',');
  const geo = p.lat !== null && p.lng !== null ? 'pr.lat BETWEEN ?2 - 0.03 AND ?2 + 0.03 AND pr.lng BETWEEN ?3 - 0.04 AND ?3 + 0.04' : 'pr.city_id = ?4';
  const { results } = await env.DB.prepare(
    `SELECT l.price, pr.area_m2 FROM listings l JOIN properties pr ON pr.id = l.property_id
     WHERE l.deal_type = ?5 AND l.status != 'removed' AND l.price > 0 AND l.last_seen_at > ?6 AND pr.id != ?1 AND pr.is_test = (SELECT is_test FROM properties WHERE id = ?1)
       AND pr.merged_into IS NULL AND ${geo} AND pr.type_code IN (${ph})
     LIMIT 200`,
  )
    .bind(p.id, p.lat, p.lng, p.city_id, deal, since, ...codes)
    .all<{ price: number; area_m2: number | null }>();
  return results.map((r) => ({ price: r.price, areaM2: r.area_m2 }));
}

/** Recomputes valuation, rent estimate, auto financials and Investment Score; stores history and cache columns. */
export async function analyzePropertyById(env: Env, propertyId: string): Promise<AnalyzeResult | null> {
  const p = await env.DB.prepare(
    `SELECT p.id, p.type_code, p.lat, p.lng, p.city_id, p.area_m2, p.features, p.is_test, p.created_at,
            l.id AS listing_id, l.price, l.deal_type, l.normalized, l.last_seen_at, l.first_seen_at, s.kind AS source_kind
     FROM properties p
     LEFT JOIN listings l ON l.id = (SELECT id FROM listings WHERE property_id = p.id AND deal_type = 'sale' AND status != 'removed' AND price > 0 ORDER BY last_seen_at DESC LIMIT 1)
     LEFT JOIN sources s ON s.id = l.source_id
     WHERE p.id = ?1`,
  )
    .bind(propertyId)
    .first<PropRow>();
  if (!p || !p.listing_id || !p.price) return null; // only properties offered for sale are analysed
  const cat = TYPES.find((t) => t.code === p.type_code)?.category ?? 'residential';
  const features = parseJson<Record<string, unknown>>(p.features, {});
  const norm = parseJson<Parameters<typeof completeness>[0]>(p.normalized, {});
  const [saleComps, rentComps] = await Promise.all([comps(env, p, 'sale'), comps(env, p, 'rent')]);
  const now = Date.now();
  const r = analyzeProperty({
    category: cat,
    price: p.price,
    areaM2: p.area_m2,
    condition: typeof features.condition === 'string' ? features.condition : null,
    isAuction: p.source_kind === 'auction',
    completeness: completeness(norm),
    dataAgeDays: p.last_seen_at ? (now - Date.parse(p.last_seen_at)) / 86_400_000 : 999,
    daysOnMarket: p.first_seen_at ? (now - Date.parse(p.first_seen_at)) / 86_400_000 : null,
    perUnit: PER_UNIT.has(cat),
    saleComps,
    rentComps,
  });

  const ts = nowIso();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO investment_scores (id, property_id, profile_code, score, components, confidence, confidence_reasons, engine_version, computed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(ulid(), p.id, cat, r.score.score ?? -1, JSON.stringify(r.score.components), r.score.confidence, JSON.stringify(r.score.reasons), SCORE_ENGINE, ts),
    env.DB.prepare('UPDATE properties SET score = ?2, score_confidence = ?3, net_yield = ?4, undervaluation = ?5, analyzed_at = ?6 WHERE id = ?1')
      .bind(p.id, r.score.score, r.score.confidence, r.netYield, r.valuation?.undervaluation ?? null, ts),
  ];
  if (r.valuation) {
    stmts.push(env.DB.prepare("INSERT INTO property_valuations (id, property_id, method, value_low, value_mid, value_high, currency, inputs, confidence, computed_at) VALUES (?1, ?2, 'comparables_asking', ?3, ?4, ?5, 'EUR', ?6, ?7, ?8)")
      .bind(ulid(), p.id, r.valuation.low, r.valuation.mid, r.valuation.high, JSON.stringify({ n: r.valuation.n, kind: 'asking' }), r.valuation.confidence, ts));
  }
  if (r.finance) {
    stmts.push(env.DB.prepare('INSERT INTO rental_models (id, property_id, model, inputs, assumptions, results, engine_version, computed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(ulid(), p.id, 'auto', JSON.stringify({ rent: r.rent }), JSON.stringify(r.assumptions), JSON.stringify(r.finance), SCORE_ENGINE, ts));
  }
  await env.DB.batch(stmts);
  return r;
}
