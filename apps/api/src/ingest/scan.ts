import {
  AI_EXTRACT_PROMPT, extractListing, isAllowed, isIndexUrl, isListingUrl, mergeAi, MISSED_RUNS_TO_REMOVE, parseRobots, rulesFor,
  sameOriginLinks, sitemapLocs, stripToText, BOT_USER_AGENT, type AiExtraction,
} from '@rei/core';
import { aiJson } from '../ai/provider.js';
import type { Env } from '../env.js';
import { politeGet } from '../lib/http.js';
import { nowIso, ulid } from '../lib/util.js';
import type { Deps } from '../sources/discovery.js';
import { analyzePropertyById } from './analyze.js';
import { ingestListing, markRemoved } from './ingest.js';
import { notifyForProperty } from './notify.js';

/** Per scan: how many new detail pages and refreshes we fetch (free-tier queue budget, politeness). */
export const NEW_PER_SCAN = 25;
export const REFRESH_PER_SCAN = 10;
const REFRESH_AFTER_DAYS = 3;
const FAVORITE_REFRESH_DAYS = 1;
const MAX_URLS = 3000;

interface SourceRow { id: string; base_url: string; country_code: string; region_id: string | null; rate_limit_ms: number; is_active: number; access_status: string }

async function loadSource(env: Env, id: string) {
  return env.DB.prepare('SELECT id, base_url, country_code, region_id, rate_limit_ms, is_active, access_status FROM sources WHERE id = ?1').bind(id).first<SourceRow>();
}
const allowedToCrawl = (s: SourceRow | null): s is SourceRow =>
  !!s && s.is_active === 1 && ['official_api', 'partner_feed', 'authorized_account', 'approved_public'].includes(s.access_status);

/** Enumerates listing URLs of an approved site; queues new and stale detail pages; tracks disappearances. */
export async function runScan(env: Env, deps: Deps, sourceId: string): Promise<void> {
  const s = await loadSource(env, sourceId);
  if (!allowedToCrawl(s)) return;
  const runId = ulid();
  const started = nowIso();
  await env.DB.prepare("INSERT INTO scan_runs (id, source_id, started_at, status) VALUES (?1, ?2, ?3, 'running')").bind(runId, s.id, started).run();

  try {
    const robotsRes = await politeGet(deps.fetch, `${s.base_url}/robots.txt`, 200_000, 'text/plain');
    if (robotsRes.status === 401 || robotsRes.status === 403) throw new Error('robots.txt now denies access');
    const robots = parseRobots(robotsRes.status && robotsRes.status < 300 && robotsRes.text ? robotsRes.text : '');
    const rules = rulesFor(robots, BOT_USER_AGENT);
    const allowed = (u: string) => { const x = new URL(u); return isAllowed(rules, x.pathname + x.search); };
    if (!allowed(`${s.base_url}/`)) throw new Error('robots.txt now disallows the site');

    // 1) sitemaps
    const found = new Set<string>();
    const queue = [...robots.sitemaps, `${s.base_url}/sitemap.xml`, `${s.base_url}/sitemap_index.xml`];
    const seenMaps = new Set<string>();
    let fetchedMaps = 0;
    while (queue.length && fetchedMaps < 8 && found.size < MAX_URLS) {
      const sm = queue.shift()!;
      if (seenMaps.has(sm)) continue;
      seenMaps.add(sm);
      const r = await politeGet(deps.fetch, sm, 1_000_000, 'application/xml,text/xml');
      fetchedMaps++;
      if (!r.text || !r.status || r.status >= 300) continue;
      const { pages, sitemaps } = sitemapLocs(r.text);
      for (const child of sitemaps) if (/immobil|annunc|propert|listing|vendit|affitt|estate|post|page|sitemap/i.test(child)) queue.push(child);
      for (const p of pages) if (isListingUrl(p, s.base_url) && allowed(p)) found.add(p);
    }
    // 2) catalogue pages when sitemaps gave nothing
    if (found.size === 0) {
      const home = await politeGet(deps.fetch, `${s.base_url}/`);
      const links = home.text ? sameOriginLinks(home.text, s.base_url) : [];
      for (const l of links) if (isListingUrl(l, s.base_url) && allowed(l)) found.add(l);
      const indexes = links.filter((l) => isIndexUrl(l, s.base_url) && allowed(l)).slice(0, 6);
      for (const ix of indexes) {
        const page = await politeGet(deps.fetch, ix);
        if (page.text) for (const l of sameOriginLinks(page.text, ix)) if (isListingUrl(l, s.base_url) && allowed(l)) found.add(l);
      }
    }
    const complete = found.size > 0;

    // 3) bookkeeping of known listings
    const { results: known } = await env.DB.prepare(
      `SELECT l.id, l.url, l.status, l.last_fetched_at, l.missed_runs, EXISTS(SELECT 1 FROM favorites f WHERE f.property_id = l.property_id) AS fav
       FROM listings l WHERE l.source_id = ?1`,
    ).bind(s.id).all<{ id: string; url: string; status: string; last_fetched_at: string | null; missed_runs: number; fav: number }>();
    const knownByUrl = new Map(known.map((k) => [k.url, k]));
    const { results: ignored } = await env.DB.prepare('SELECT url FROM ignored_urls WHERE source_id = ?1').bind(s.id).all<{ url: string }>();
    const ignoredSet = new Set(ignored.map((i) => i.url));

    const now = nowIso();
    const seenIds = known.filter((k) => found.has(k.url)).map((k) => k.id);
    for (let i = 0; i < seenIds.length; i += 90) {
      const chunk = seenIds.slice(i, i + 90);
      await env.DB.prepare(`UPDATE listings SET last_seen_at = ?1, missed_runs = 0 WHERE id IN (${chunk.map((_, k) => `?${k + 2}`).join(',')})`).bind(now, ...chunk).run();
    }
    if (complete) {
      for (const k of known.filter((x) => !found.has(x.url) && x.status !== 'removed')) {
        const missed = k.missed_runs + 1;
        await env.DB.prepare('UPDATE listings SET missed_runs = ?2 WHERE id = ?1').bind(k.id, missed).run();
        if (missed >= MISSED_RUNS_TO_REMOVE) {
          const ev = await markRemoved(env, k.id, 'не найдено на сайте при двух полных проверках подряд');
          const pid = await env.DB.prepare('SELECT property_id FROM listings WHERE id = ?1').bind(k.id).first<string>('property_id');
          if (pid && ev.length) await notifyForProperty(env, pid, ev);
        }
      }
    }

    // 4) queue detail pages: new first, then stale (favorites more often)
    const rentFirst = (u: string) => (/affitt|locazion|noleggio|rent/i.test(u) ? 0 : 1);
    const fresh = [...found].filter((u) => !knownByUrl.has(u) && !ignoredSet.has(u)).sort((a, b) => rentFirst(a) - rentFirst(b)).slice(0, NEW_PER_SCAN);
    const staleBefore = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const stale = known
      .filter((k) => found.has(k.url) && (!k.last_fetched_at || k.last_fetched_at < staleBefore(k.fav ? FAVORITE_REFRESH_DAYS : REFRESH_AFTER_DAYS)))
      .sort((a, b) => b.fav - a.fav || (a.last_fetched_at ?? '').localeCompare(b.last_fetched_at ?? ''))
      .slice(0, REFRESH_PER_SCAN)
      .map((k) => k.url);
    const jobs = [...fresh, ...stale].map((url, i) => ({ type: 'listing' as const, sourceId: s.id, url, delaySeconds: Math.ceil(((i + 1) * s.rate_limit_ms) / 1000) }));
    if (jobs.length) await deps.enqueue(jobs);

    await env.DB.batch([
      env.DB.prepare("UPDATE scan_runs SET finished_at = ?2, status = ?3, pages = ?4, listings_seen = ?5 WHERE id = ?1").bind(runId, nowIso(), complete ? 'ok' : 'partial', fetchedMaps, found.size),
      env.DB.prepare(`INSERT INTO source_crawl_state (source_id, last_scan_at, last_complete_at, urls_found) VALUES (?1, ?2, ?3, ?4)
                      ON CONFLICT(source_id) DO UPDATE SET last_scan_at = ?2, last_complete_at = COALESCE(?3, last_complete_at), urls_found = ?4`).bind(s.id, started, complete ? started : null, found.size),
      env.DB.prepare(`INSERT INTO source_health (source_id, status, consecutive_errors, last_ok_at) VALUES (?1, ?2, 0, ?3)
                      ON CONFLICT(source_id) DO UPDATE SET status = ?2, consecutive_errors = 0, last_ok_at = ?3`).bind(s.id, complete ? 'ok' : 'degraded', nowIso()),
    ]);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await env.DB.batch([
      env.DB.prepare("UPDATE scan_runs SET finished_at = ?2, status = 'error', error = ?3 WHERE id = ?1").bind(runId, nowIso(), msg),
      env.DB.prepare(`INSERT INTO source_health (source_id, status, consecutive_errors, last_error) VALUES (?1, 'degraded', 1, ?2)
                      ON CONFLICT(source_id) DO UPDATE SET consecutive_errors = consecutive_errors + 1, last_error = ?2,
                      status = CASE WHEN consecutive_errors + 1 >= 3 THEN 'broken' ELSE 'degraded' END`).bind(s.id, msg),
    ]);
    // robots/terms changes are not retried: the source stays inactive until reviewed
    if (/robots/.test(msg)) await env.DB.prepare("UPDATE sources SET is_active = 0, access_status = 'forbidden' WHERE id = ?1").bind(s.id).run();
  }
}

/** Fetches one detail page, extracts (JSON-LD → text → AI for gaps), ingests, analyses and notifies. */
export async function runListing(env: Env, deps: Deps, sourceId: string, url: string): Promise<void> {
  const s = await loadSource(env, sourceId);
  if (!allowedToCrawl(s)) return;
  const page = await politeGet(deps.fetch, url, 400_000);
  if (page.status === 404 || page.status === 410) {
    const l = await env.DB.prepare('SELECT id, property_id FROM listings WHERE source_id = ?1 AND url = ?2').bind(s.id, url).first<{ id: string; property_id: string }>();
    if (l) {
      const ev = await markRemoved(env, l.id, `страница объявления отвечает HTTP ${page.status}`);
      if (ev.length) await notifyForProperty(env, l.property_id, ev);
    }
    return;
  }
  if (!page.text || !page.status || page.status >= 400) throw new Error(`fetch ${url}: HTTP ${page.status}`);

  let { listing, needsAi } = extractListing(page.text, url);
  if (needsAi) {
    const ai = await aiJson<AiExtraction>(env, { purpose: 'listing_extract', tier: 2, prompt: AI_EXTRACT_PROMPT, input: stripToText(page.text).slice(0, 10_000) }, deps.fetch);
    if (ai.ok && ai.data) {
      if (ai.data.isListing === false) {
        await env.DB.prepare('INSERT OR IGNORE INTO ignored_urls (source_id, url, reason, created_at) VALUES (?1, ?2, ?3, ?4)').bind(s.id, url, 'not a listing (AI)', nowIso()).run();
        return;
      }
      listing = mergeAi(listing, ai.data);
    }
  }
  if (!listing.typeCode) {
    await env.DB.prepare('INSERT OR IGNORE INTO ignored_urls (source_id, url, reason, created_at) VALUES (?1, ?2, ?3, ?4)').bind(s.id, url, 'property type not recognised', nowIso()).run();
    return;
  }
  const res = await ingestListing(env, deps.fetch, { id: s.id, countryCode: s.country_code, regionId: s.region_id }, listing, { raw: page.text.slice(0, 50_000) });
  if (!res) return;
  await analyzePropertyById(env, res.propertyId);
  await notifyForProperty(env, res.propertyId, res.events);
}
