import { BOT_USER_AGENT, growthFromHpi, parseJsonStatSeries } from '@rei/core';
import type { Env } from '../env.js';
import { nowIso } from '../lib/util.js';
import type { Deps } from '../sources/discovery.js';

/** Eurostat house price index, annual rate of change (%), all dwellings. National level only. */
export const HPI_SOURCE = (country: string) =>
  `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hpi_a?geo=${encodeURIComponent(country)}&purchase=TOTAL&unit=RCH_A_AVG&format=JSON&lang=EN`;
const HPI_REFRESH_DAYS = 30;

export async function runHpi(env: Env, deps: Pick<Deps, 'fetch'>, country: string): Promise<void> {
  const url = HPI_SOURCE(country);
  const res = await deps.fetch(url, { headers: { 'User-Agent': BOT_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Eurostat HTTP ${res.status}`);
  const series = parseJsonStatSeries(await res.json());
  if (!series.length) throw new Error('Eurostat returned no data');
  const ts = nowIso();
  await env.DB.batch(series.map((r) =>
    env.DB.prepare(
      `INSERT INTO market_indicators (id, source, country_code, zone_code, metric, value, unit, period, kind, source_url, fetched_at)
       VALUES (?1, 'eurostat', ?2, ?2, 'hpi_rch_a', ?3, 'pct', ?4, 'official_estimate', ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET value = ?3, fetched_at = ?6`,
    ).bind(`eurostat-hpi-${country}-${r.period}`, country, r.value, r.period, url, ts),
  ));
}

/** Countries with properties whose HPI is missing or older than the refresh window. */
export async function countriesNeedingHpi(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.code FROM countries c WHERE EXISTS (SELECT 1 FROM search_profiles sp WHERE sp.is_active = 1)
       AND NOT EXISTS (SELECT 1 FROM market_indicators m WHERE m.source = 'eurostat' AND m.country_code = c.code
                       AND m.fetched_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ?1 || ' days'))`,
  ).bind(HPI_REFRESH_DAYS).all<{ code: string }>();
  return results.map((r) => r.code);
}

export async function marketGrowth(env: Env, country: string) {
  const { results } = await env.DB.prepare("SELECT period, value FROM market_indicators WHERE source = 'eurostat' AND country_code = ?1 AND metric = 'hpi_rch_a' ORDER BY period").bind(country).all<{ period: string; value: number }>();
  return { series: results, growth: growthFromHpi(results), source: HPI_SOURCE(country) };
}
