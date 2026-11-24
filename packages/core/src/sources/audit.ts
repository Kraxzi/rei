/**
 * Pure logic of the automatic source audit (spec 5.1). I/O happens in the API worker; this module only
 * interprets what was fetched, so the rules are testable and identical in the worker and in CI probes.
 */
import { isAllowed, parseRobots, rulesFor } from './robots.js';

export const BOT_USER_AGENT = 'REI-bot/0.1 (+private real-estate research; contact via site owner)';

/** Big portals are out of scope by owner's decision (24.11.2026) — never audited or connected. */
export const EXCLUDED_DOMAINS = [
  'immobiliare.it', 'idealista.it', 'idealista.com', 'casa.it', 'subito.it', 'wikicasa.it', 'trovacasa.it', 'immobiliare.com',
  'immoscout24.de', 'immobilienscout24.de', 'immowelt.de', 'kleinanzeigen.de', 'seloger.com', 'leboncoin.fr', 'bienici.com',
  'fotocasa.es', 'habitaclia.com', 'willhaben.at', 'immobilienscout24.at',
  // generic platforms that are not an agency's own site
  'facebook.com', 'instagram.com', 'linkedin.com', 'google.com', 'sites.google.com', 'wa.me',
];

export function normalizeWebsite(url: string | undefined | null): string | null {
  if (!url) return null;
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!parsed.hostname.includes('.')) return null;
    return `https://${parsed.hostname.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function registrableDomain(origin: string): string {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

export function isExcludedDomain(origin: string): boolean {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  return EXCLUDED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

// ---------- OSM discovery ----------

export interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface AgencyCandidate {
  osmId: string;
  name: string;
  website: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
}

/** Public Overpass instances, tried in order (the main one is often overloaded). */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export function overpassQuery(iso3166_2: string): string {
  return `[out:json][timeout:90];
area["ISO3166-2"="${iso3166_2}"]->.a;
(
  nwr(area.a)["office"="estate_agent"];
  nwr(area.a)["shop"="estate_agent"];
);
out tags center;`;
}

/** Turns Overpass elements into unique agency candidates with their own website (portal pages dropped). */
export function candidatesFromOsm(elements: OsmElement[]): { candidates: AgencyCandidate[]; withoutWebsite: number; excluded: number } {
  const byOrigin = new Map<string, AgencyCandidate>();
  let withoutWebsite = 0;
  let excluded = 0;
  for (const el of elements) {
    const t = el.tags ?? {};
    const origin = normalizeWebsite(t.website ?? t['contact:website'] ?? t.url);
    if (!origin) { withoutWebsite++; continue; }
    if (isExcludedDomain(origin)) { excluded++; continue; }
    if (byOrigin.has(origin)) continue;
    byOrigin.set(origin, {
      osmId: `${el.type}/${el.id}`,
      name: t.name ?? t.brand ?? new URL(origin).hostname,
      website: origin,
      lat: el.lat ?? el.center?.lat ?? null,
      lng: el.lon ?? el.center?.lon ?? null,
      city: t['addr:city'] ?? null,
    });
  }
  return { candidates: [...byOrigin.values()], withoutWebsite, excluded };
}

// ---------- page signals ----------

const ANTIBOT_MARKERS: Array<[RegExp, string]> = [
  [/cf-chl|challenge-platform|cf_chl_opt|Just a moment\.\.\.|Attention Required! \| Cloudflare/i, 'Cloudflare challenge'],
  [/captcha-delivery\.com|datadome/i, 'DataDome'],
  [/px-captcha|perimeterx|_pxhd/i, 'PerimeterX'],
  [/_Incapsula_Resource|incap_ses|Incapsula incident/i, 'Imperva/Incapsula'],
  [/g-recaptcha|hcaptcha\.com|recaptcha\/api\.js\?render/i, 'CAPTCHA on page'],
  [/akamai.*bot manager|_abck=/i, 'Akamai Bot Manager'],
];

/**
 * Known agency-website platforms (fingerprints in HTML). A match means one adapter can serve many agencies.
 * Fingerprints are heuristics and are confirmed by the trial extraction.
 */
const PLATFORM_MARKERS: Array<[RegExp, string]> = [
  [/miogest/i, 'miogest'],
  [/getrix/i, 'getrix'],
  [/gestim/i, 'gestim'],
  [/realsmart/i, 'realsmart'],
  [/immobilsoft/i, 'immobilsoft'],
  [/cometa ?web|cometaweb/i, 'cometa'],
  [/wp-content\/themes\/houzez|houzez/i, 'wp-houzez'],
  [/wp-content\/plugins\/estatik|estatik/i, 'wp-estatik'],
  [/easy-property-listings/i, 'wp-epl'],
  [/wp-content\/plugins\/essential-real-estate|essential-real-estate/i, 'wp-ere'],
  [/wp-content\/themes\/wpresidence|wpresidence/i, 'wp-residence'],
  [/wp-content\//i, 'wordpress'],
];

const LISTING_LD_TYPES = /"@type"\s*:\s*"(RealEstateListing|Residence|Apartment|House|SingleFamilyResidence|Accommodation|Place|Offer|Product)"/i;
const LISTING_LINK = /href="[^"]*(immobil|annunc|vendita|vendite|affitto|propert|immobile|scheda|dettaglio|listing)[^"]*"/gi;
const TERMS_LINK = /<a\b[^>]*href="([^"]+)"[^>]*>([^<]{0,80}(termini|condizioni|note legali|legal|terms|cgu|aviso legal|impressum|agb)[^<]{0,40})<\/a>/gi;

export interface PageSignals {
  antibot: string | null;
  platform: string | null;
  hasListingJsonLd: boolean;
  listingLinkCount: number;
  termsLinks: string[];
  title: string | null;
}

export function analyzeHtml(html: string, baseUrl: string): PageSignals {
  const antibot = ANTIBOT_MARKERS.find(([re]) => re.test(html))?.[1] ?? null;
  const platform = PLATFORM_MARKERS.find(([re]) => re.test(html))?.[1] ?? null;
  const ldBlocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? '');
  const listingLinks = new Set([...html.matchAll(LISTING_LINK)].map((m) => m[0]));
  const terms = new Set<string>();
  for (const m of html.matchAll(TERMS_LINK)) {
    try { terms.add(new URL(m[1]!, baseUrl).toString()); } catch { /* ignore */ }
  }
  const title = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i)?.[1]?.trim() ?? null;
  return {
    antibot,
    platform,
    hasListingJsonLd: ldBlocks.some((b) => LISTING_LD_TYPES.test(b)),
    listingLinkCount: listingLinks.size,
    termsLinks: [...terms].slice(0, 3),
    title,
  };
}

// ---------- verdict ----------

export type AuditVerdict = 'suitable' | 'review' | 'rejected';

export interface AuditInput {
  origin: string;
  robotsStatus: number | null; // HTTP status of /robots.txt, null = network error
  robotsTxt: string | null;
  homeStatus: number | null;
  homeHtml: string | null;
  /** Response headers that reveal bot management, e.g. cf-mitigated. */
  homeHeaders?: Record<string, string>;
  /** Result of the terms-of-use check (AI or manual). */
  terms?: { prohibitsScraping: boolean | null; summary: string } | null;
}

export interface AuditResult {
  verdict: AuditVerdict;
  reasons: string[];
  robots: { found: boolean; allowsRoot: boolean; crawlDelaySec: number | null; sitemaps: string[] };
  signals: PageSignals | null;
  terms: AuditInput['terms'] | null;
}

export function auditSource(i: AuditInput): AuditResult {
  const reasons: string[] = [];
  const rejected: string[] = [];
  const review: string[] = [];

  if (isExcludedDomain(i.origin)) rejected.push('портал или соцсеть — вне решения владельца');

  // robots.txt: 404 = no restrictions; 401/403 = full disallow (RFC 9309); 5xx/network = unreachable -> review
  let robots: AuditResult['robots'] = { found: false, allowsRoot: true, crawlDelaySec: null, sitemaps: [] };
  if (i.robotsStatus !== null && i.robotsStatus >= 200 && i.robotsStatus < 300 && i.robotsTxt !== null) {
    const parsed = parseRobots(i.robotsTxt);
    const rules = rulesFor(parsed, BOT_USER_AGENT);
    robots = { found: true, allowsRoot: isAllowed(rules, '/'), crawlDelaySec: rules.crawlDelaySec, sitemaps: parsed.sitemaps };
    if (!robots.allowsRoot) rejected.push('robots.txt запрещает обход сайта');
  } else if (i.robotsStatus === 401 || i.robotsStatus === 403) {
    robots = { found: true, allowsRoot: false, crawlDelaySec: null, sitemaps: [] };
    rejected.push('robots.txt закрыт (401/403) — по правилам это полный запрет');
  } else if (i.robotsStatus === null || i.robotsStatus >= 500) {
    review.push('robots.txt недоступен');
  }

  const h = i.homeHeaders ?? {};
  let signals: PageSignals | null = null;
  if (h['cf-mitigated'] === 'challenge') rejected.push('защита от ботов (Cloudflare challenge)');
  if (i.homeStatus === null) review.push('сайт не отвечает');
  else if (i.homeStatus === 403 || i.homeStatus === 429 || i.homeStatus === 503) rejected.push(`сайт блокирует автоматический доступ (HTTP ${i.homeStatus})`);
  else if (i.homeStatus >= 400) review.push(`главная страница вернула HTTP ${i.homeStatus}`);

  if (i.homeHtml) {
    signals = analyzeHtml(i.homeHtml, i.origin);
    if (signals.antibot) rejected.push(`защита от ботов: ${signals.antibot}`);
    if (!signals.hasListingJsonLd && signals.listingLinkCount < 3 && !robots.sitemaps.length && !signals.platform) {
      review.push('не видно объявлений на главной — возможно, это не сайт с каталогом');
    }
  }

  if (i.terms?.prohibitsScraping === true) rejected.push(`условия сайта запрещают автоматический сбор: ${i.terms.summary}`);
  else if (!i.terms || i.terms.prohibitsScraping === null) review.push('условия использования не проверены');

  reasons.push(...rejected, ...review);
  const verdict: AuditVerdict = rejected.length ? 'rejected' : review.length ? 'review' : 'suitable';
  return { verdict, reasons, robots, signals, terms: i.terms ?? null };
}
