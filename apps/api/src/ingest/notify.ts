import { matchProfile, TYPES, type ListingEvent, type MatchProfile } from '@rei/core';
import type { Env } from '../env.js';
import { nowIso, parseJson, ulid } from '../lib/util.js';
import { pushPing } from '../lib/push.js';

/**
 * Opportunities agent, per property: after ingest/analysis, decide which users should hear about it.
 * Notifications are idempotent per (user, dedupe key), so re-processing never spams.
 */
const EVENT_KINDS = new Set(['new', 'price_down', 'reappeared', 'republished']);
const money = (c: number) => `${Math.round(c / 100).toLocaleString('ru-RU')} €`;

export async function notifyForProperty(env: Env, propertyId: string, events: Array<ListingEvent & { id: string }>): Promise<number> {
  const p = await env.DB.prepare(
    `SELECT p.id, p.type_code, p.country_code, p.region_id, r.parent_id, p.city_id, p.area_m2, p.lat, p.lng, p.features, p.score, p.score_confidence, p.net_yield, p.undervaluation, p.is_test,
            l.price, l.deal_type, c.name AS city
     FROM properties p LEFT JOIN regions r ON r.id = p.region_id LEFT JOIN cities c ON c.id = p.city_id
     LEFT JOIN listings l ON l.id = (SELECT id FROM listings WHERE property_id = p.id AND status != 'removed' ORDER BY last_seen_at DESC LIMIT 1)
     WHERE p.id = ?1`,
  )
    .bind(propertyId)
    .first<{ id: string; type_code: string; country_code: string; region_id: string | null; parent_id: string | null; city_id: string | null; area_m2: number | null; lat: number | null; lng: number | null; features: string; score: number | null; score_confidence: number | null; net_yield: number | null; undervaluation: number | null; is_test: number; price: number | null; deal_type: string | null; city: string | null }>();
  if (!p || p.is_test) return 0; // test data never notifies anybody

  const relevant = events.filter((e) => EVENT_KINDS.has(e.type));
  const { results: profiles } = await env.DB.prepare('SELECT * FROM search_profiles WHERE is_active = 1').all<Record<string, unknown>>();
  const typeName = TYPES.find((t) => t.code === p.type_code)?.name.ru ?? p.type_code;
  const features = parseJson<Record<string, unknown>>(p.features, {});
  let created = 0;
  const notifiedUsers = new Set<string>();

  for (const row of profiles) {
    const prof: MatchProfile = {
      countries: parseJson(row.countries as string, []), regions: parseJson(row.regions as string, []), cities: parseJson(row.cities as string, []),
      typeCodes: parseJson(row.type_codes as string, []), priceMin: row.price_min as number | null, priceMax: row.price_max as number | null,
      areaMin: row.area_min as number | null, areaMax: row.area_max as number | null, targetNetYield: row.target_net_yield as number | null,
      condition: parseJson(row.condition as string, []), geo: parseJson(row.geo as string, {}), isActive: row.is_active === 1,
    };
    const m = matchProfile(
      { countryCode: p.country_code, regionIds: [p.region_id, p.parent_id].filter((x): x is string => !!x), cityId: p.city_id, typeCode: p.type_code, dealType: p.deal_type, price: p.price, areaM2: p.area_m2, lat: p.lat, lng: p.lng, condition: typeof features.condition === 'string' ? features.condition : null, netYield: p.net_yield },
      prof,
    );
    if (!m.match) continue;
    const notify = parseJson<{ minScore?: number; minNetYield?: number; priceDropPct?: number }>(row.notify as string, {});

    const send = async (kind: string, key: string, title: string) => {
      if (notify.minScore !== undefined && kind !== 'price_down' && (p.score ?? -1) < notify.minScore) return;
      const body = [
        p.price ? money(p.price) : null,
        p.net_yield !== null ? `доходность ≈ ${(p.net_yield * 100).toFixed(1).replace('.', ',')} %` : null,
        p.score !== null ? `рейтинг ${Math.round(p.score)}` : null,
        `поиск «${row.name as string}»`,
      ].filter(Boolean).join(', ');
      const res = await env.DB.prepare('INSERT INTO notifications (id, user_id, kind, property_id, profile_id, title, body, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(user_id, dedupe_key) DO NOTHING')
        .bind(ulid(), row.user_id as string, kind, p.id, row.id as string, title, body, key, nowIso())
        .run();
      if (res.meta.changes) { created++; notifiedUsers.add(row.user_id as string); }
    };

    const place = p.city ? `, ${p.city}` : '';
    for (const e of relevant) {
      if (e.type === 'price_down') {
        const drop = -(e.change ?? 0);
        if (notify.priceDropPct !== undefined && drop < notify.priceDropPct) continue;
        await send('price_down', `${p.id}:price:${String(e.new)}`, `Цена снижена на ${(drop * 100).toFixed(0)} %: ${typeName}${place}`);
      } else if (e.type === 'new') {
        await send('new', `${p.id}:new`, `Новый объект: ${typeName}${place}`);
      } else {
        await send(e.type, `${p.id}:${e.type}:${e.id}`, `${e.type === 'reappeared' ? 'Снова в продаже' : 'Опубликован заново'}: ${typeName}${place}`);
      }
    }
    // opportunity signals independent of events (re-analysis may reveal them)
    if (p.undervaluation !== null && p.undervaluation >= 0.15 && (p.score_confidence ?? 0) >= 0.25) {
      await send('undervalued', `${p.id}:undervalued`, `Ниже рынка на ${(p.undervaluation * 100).toFixed(0)} %: ${typeName}${place}`);
    }
    if (p.net_yield !== null && prof.targetNetYield !== null && p.net_yield >= prof.targetNetYield + 0.02) {
      await send('high_yield', `${p.id}:yield`, `Доходность выше цели: ${typeName}${place}`);
    }
  }
  if (notifiedUsers.size) await pushPing(env, [...notifiedUsers]);
  return created;
}
