import { describe, expect, it } from 'vitest';
import {
  analyzeHtml,
  auditSource,
  BOT_USER_AGENT,
  candidatesFromOsm,
  isAllowed,
  isExcludedDomain,
  normalizeWebsite,
  overpassQuery,
  parseRobots,
  rulesFor,
} from '../src/index.js';

describe('robots.txt', () => {
  const txt = `
# comment
User-agent: *
Disallow: /admin/
Disallow: /*.pdf$
Allow: /admin/public/
Crawl-delay: 3

User-agent: BadBot
User-agent: REI-bot
Disallow: /private

Sitemap: https://example.it/sitemap.xml
`;
  const parsed = parseRobots(txt);

  it('parses groups and sitemaps', () => {
    expect(parsed.groups).toHaveLength(2);
    expect(parsed.groups[1]!.agents).toEqual(['badbot', 'rei-bot']);
    expect(parsed.sitemaps).toEqual(['https://example.it/sitemap.xml']);
  });

  it('specific agent group overrides *', () => {
    const r = rulesFor(parsed, BOT_USER_AGENT);
    expect(isAllowed(r, '/admin/x')).toBe(true); // our group does not mention /admin
    expect(isAllowed(r, '/private/1')).toBe(false);
  });

  it('wildcards, $ anchor, longest match, crawl-delay', () => {
    const r = rulesFor(parsed, 'SomeOtherBot');
    expect(isAllowed(r, '/admin/secret')).toBe(false);
    expect(isAllowed(r, '/admin/public/page')).toBe(true);
    expect(isAllowed(r, '/docs/file.pdf')).toBe(false);
    expect(isAllowed(r, '/docs/file.pdf?x=1')).toBe(true);
    expect(r.crawlDelaySec).toBe(3);
  });

  it('empty / missing rules allow everything; Disallow: / blocks all', () => {
    expect(isAllowed(rulesFor(parseRobots(''), BOT_USER_AGENT), '/')).toBe(true);
    expect(isAllowed(rulesFor(parseRobots('User-agent: *\nDisallow: /'), BOT_USER_AGENT), '/')).toBe(false);
    expect(isAllowed(rulesFor(parseRobots('User-agent: *\nDisallow:'), BOT_USER_AGENT), '/')).toBe(true);
  });
});

describe('discovery', () => {
  it('overpass query targets the ISO area and both tags', () => {
    const q = overpassQuery('IT-42');
    expect(q).toContain('"ISO3166-2"="IT-42"');
    expect(q).toContain('"office"="estate_agent"');
    expect(q).toContain('"shop"="estate_agent"');
  });

  it('normalizes websites and drops portals and duplicates', () => {
    expect(normalizeWebsite('www.agenzia-mare.it/')).toBe('https://www.agenzia-mare.it');
    expect(normalizeWebsite('http://Agenzia.IT/contatti')).toBe('https://agenzia.it');
    expect(normalizeWebsite('not a url')).toBeNull();
    expect(isExcludedDomain('https://www.immobiliare.it')).toBe(true);
    expect(isExcludedDomain('https://agenzie.idealista.it')).toBe(true);
    expect(isExcludedDomain('https://immobiliare-rossi.it')).toBe(false);

    const { candidates, withoutWebsite, excluded } = candidatesFromOsm([
      { type: 'node', id: 1, lat: 43.8, lon: 7.7, tags: { name: 'Agenzia Mare', website: 'https://agenziamare.it', 'addr:city': 'Sanremo' } },
      { type: 'way', id: 2, center: { lat: 43.9, lon: 8.0 }, tags: { name: 'Agenzia Mare (dup)', 'contact:website': 'agenziamare.it' } },
      { type: 'node', id: 3, tags: { name: 'Solo portale', website: 'https://www.immobiliare.it/agenzie/123' } },
      { type: 'node', id: 4, tags: { name: 'Senza sito' } },
    ]);
    expect(candidates).toEqual([{ osmId: 'node/1', name: 'Agenzia Mare', website: 'https://agenziamare.it', lat: 43.8, lng: 7.7, city: 'Sanremo' }]);
    expect(withoutWebsite).toBe(1);
    expect(excluded).toBe(1);
  });
});

describe('page signals', () => {
  it('detects anti-bot pages', () => {
    expect(analyzeHtml('<html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>', 'https://a.it').antibot).toBe('Cloudflare challenge');
    expect(analyzeHtml('<script src="https://ct.captcha-delivery.com/c.js"></script>', 'https://a.it').antibot).toBe('DataDome');
    expect(analyzeHtml('<p>Benvenuti</p>', 'https://a.it').antibot).toBeNull();
  });

  it('detects listings, platform and terms links', () => {
    const html = `<title>Agenzia Mare</title>
      <link href="/wp-content/themes/houzez/style.css">
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"RealEstateListing","name":"Bilocale"}</script>
      <a href="/immobili/1">1</a><a href="/immobili/2">2</a><a href="/vendita/3">3</a>
      <a href="/note-legali">Note legali</a>`;
    const s = analyzeHtml(html, 'https://agenziamare.it');
    expect(s).toMatchObject({ platform: 'wp-houzez', hasListingJsonLd: true, listingLinkCount: 3, title: 'Agenzia Mare' });
    expect(s.termsLinks).toEqual(['https://agenziamare.it/note-legali']);
  });
});

describe('audit verdict', () => {
  const okHome = '<a href="/immobili/1">1</a><a href="/immobili/2">2</a><a href="/immobili/3">3</a>';
  const base = { origin: 'https://agenziamare.it', robotsStatus: 200, robotsTxt: 'User-agent: *\nDisallow: /admin', homeStatus: 200, homeHtml: okHome, terms: { prohibitsScraping: false, summary: 'нет запрета' } };

  it('suitable when everything is clean', () => {
    expect(auditSource(base).verdict).toBe('suitable');
  });

  it('robots 404 means no restrictions', () => {
    expect(auditSource({ ...base, robotsStatus: 404, robotsTxt: null }).verdict).toBe('suitable');
  });

  it('rejects: robots disallow, 401/403 robots, anti-bot, blocking status, terms prohibit, portal', () => {
    expect(auditSource({ ...base, robotsTxt: 'User-agent: *\nDisallow: /' }).verdict).toBe('rejected');
    expect(auditSource({ ...base, robotsStatus: 403, robotsTxt: null }).verdict).toBe('rejected');
    expect(auditSource({ ...base, homeHtml: '<title>Just a moment...</title>' }).verdict).toBe('rejected');
    expect(auditSource({ ...base, homeStatus: 403 }).verdict).toBe('rejected');
    expect(auditSource({ ...base, homeHeaders: { 'cf-mitigated': 'challenge' } }).verdict).toBe('rejected');
    const t = auditSource({ ...base, terms: { prohibitsScraping: true, summary: 'vietata l’estrazione automatica' } });
    expect(t.verdict).toBe('rejected');
    expect(t.reasons[0]).toContain('vietata');
    expect(auditSource({ ...base, origin: 'https://www.immobiliare.it' }).verdict).toBe('rejected');
  });

  it('review when something is uncertain', () => {
    expect(auditSource({ ...base, terms: null }).verdict).toBe('review');
    expect(auditSource({ ...base, robotsStatus: null, robotsTxt: null }).verdict).toBe('review');
    expect(auditSource({ ...base, homeHtml: '<p>Siamo una piccola agenzia</p>' }).verdict).toBe('review');
    expect(auditSource({ ...base, homeStatus: null, homeHtml: null }).verdict).toBe('review');
  });
});
