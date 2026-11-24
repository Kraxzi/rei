/** Finding listing pages on an approved agency site: sitemaps first, then catalogue pages. */

export function sitemapLocs(xml: string): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  const decode = (s: string) => s.replace(/&amp;/g, '&').trim();
  for (const m of xml.matchAll(/<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/sitemap>/gi)) sitemaps.push(decode(m[1]!));
  for (const m of xml.matchAll(/<url>[\s\S]*?<loc>([\s\S]*?)<\/loc>[\s\S]*?<\/url>/gi)) pages.push(decode(m[1]!));
  return { pages, sitemaps };
}

const LISTING_WORDS = /(immobil|annunc|vendita|vendite|affitt|propert|immobile|scheda|dettaglio|listing|appartament|villa|casa|box|terreno|negozio|locale|ufficio|magazzino|capannone|rustico|attico|bilocale|trilocale|monolocale)/i;
const NOT_LISTING = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?)($|\?)|\/(tag|tags|category|categoria|author|autore|feed|wp-json|wp-admin|login|cart|privacy|cookie|contatti|chi-siamo|news|blog)(\/|$)|[?&](page|paged|orderby|sort)=/i;
const INDEX_WORDS = /\/(immobili|vendita|vendite|affitto|affitti|annunci|proprieta|properties|ricerca|cerca|search|catalogo|offerte)(\/)?(\?|$)/i;

/** Detail page of a single property: listing vocabulary + an id-like part (number or long slug). */
export function isListingUrl(url: string, origin: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.origin !== new URL(origin).origin) return false;
  const path = decodeURIComponent(u.pathname + u.search);
  if (NOT_LISTING.test(path) || INDEX_WORDS.test(path)) return false;
  if (!LISTING_WORDS.test(path)) return false;
  const segments = u.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const hasId = /\d{3,}/.test(path) || /[?&](id|rif|ref|idimmobile)=/i.test(u.search);
  const longSlug = last.split('-').length >= 4;
  return hasId || longSlug;
}

export function isIndexUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === new URL(origin).origin && INDEX_WORDS.test(u.pathname + (u.search ? '?' : ''));
  } catch {
    return false;
  }
}

/** Absolute same-origin links of a page, fragments removed, deduplicated. */
export function sameOriginLinks(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1]!.replace(/&amp;/g, '&'), base);
      u.hash = '';
      if (u.origin === origin) out.add(u.toString());
    } catch { /* skip */ }
  }
  return [...out];
}
