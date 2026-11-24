import { BOT_USER_AGENT } from '@rei/core';
import type { Env } from '../env.js';
import { ulid } from '../lib/util.js';

/**
 * City-level geocoding with a permanent cache in `cities`. Uses OSM Nominatim (public instance, max ~1 req/s,
 * identified user agent) only for cities not seen before — a few hundred lookups for a whole region, ever.
 */
export async function cityFor(
  env: Env,
  fetcher: typeof fetch,
  city: string | null,
  regionId: string | null,
): Promise<{ id: string; lat: number | null; lng: number | null } | null> {
  if (!city || !regionId) return null;
  const name = city.trim().replace(/\s+/g, ' ');
  const cached = await env.DB.prepare('SELECT id, lat, lng FROM cities WHERE region_id = ?1 AND lower(name) = lower(?2)')
    .bind(regionId, name)
    .first<{ id: string; lat: number | null; lng: number | null }>();
  if (cached) return cached;

  const region = await env.DB.prepare('SELECT name, country_code FROM regions WHERE id = ?1').bind(regionId).first<{ name: string; country_code: string }>();
  let lat: number | null = null;
  let lng: number | null = null;
  try {
    const q = new URLSearchParams({ q: `${name}, ${region?.name ?? ''}`, format: 'jsonv2', limit: '1', countrycodes: (region?.country_code ?? 'it').toLowerCase() });
    const res = await fetcher(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { 'User-Agent': BOT_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const [hit] = (await res.json()) as Array<{ lat: string; lon: string }>;
      if (hit) { lat = Number(hit.lat); lng = Number(hit.lon); }
    }
  } catch { /* keep the city without coordinates */ }
  const id = ulid();
  await env.DB.prepare('INSERT INTO cities (id, region_id, name, lat, lng) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(region_id, name) DO NOTHING')
    .bind(id, regionId, name, lat, lng)
    .run();
  return (await env.DB.prepare('SELECT id, lat, lng FROM cities WHERE region_id = ?1 AND lower(name) = lower(?2)').bind(regionId, name).first()) ?? { id, lat, lng };
}
