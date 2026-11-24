/**
 * Read-only probe of real-world discovery quality (runs in GitHub Actions, never writes to the DB):
 * Overpass for an ISO region -> audit each agency site exactly like the worker does (without the AI terms step).
 * Usage: tsx scripts/probe-sources.ts IT-IM [limit]
 */
import { auditSource, BOT_USER_AGENT, candidatesFromOsm, overpassQuery, type OsmElement } from '@rei/core';

const iso = process.argv[2] ?? 'IT-IM';
const limit = Number(process.argv[3] ?? 60);

async function get(url: string) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': BOT_USER_AGENT, 'Accept-Language': 'it,en;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const headers: Record<string, string> = {};
    const m = r.headers.get('cf-mitigated'); if (m) headers['cf-mitigated'] = m;
    return { status: r.status, text: (await r.text()).slice(0, 300_000), headers };
  } catch { return { status: null, text: null, headers: {} }; }
}

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST', headers: { 'User-Agent': BOT_USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `data=${encodeURIComponent(overpassQuery(iso))}`,
});
const { elements } = (await res.json()) as { elements: OsmElement[] };
const { candidates, withoutWebsite, excluded } = candidatesFromOsm(elements);
const lines = [`## ${iso}: OSM elements ${elements.length}, with own site ${candidates.length}, without site ${withoutWebsite}, portals ${excluded}`, '', '|agency|site|verdict|platform|links|jsonld|terms link|reasons|', '|---|---|---|---|---|---|---|---|'];
const tally: Record<string, number> = {};
for (const c of candidates.slice(0, limit)) {
  const robots = await get(`${c.website}/robots.txt`);
  const home = await get(`${c.website}/`);
  const a = auditSource({ origin: c.website, robotsStatus: robots.status, robotsTxt: robots.status && robots.status < 300 ? robots.text : null, homeStatus: home.status, homeHtml: home.text, homeHeaders: home.headers, terms: { prohibitsScraping: false, summary: 'probe: terms not checked' } });
  tally[a.verdict] = (tally[a.verdict] ?? 0) + 1;
  lines.push(`|${c.name}|${c.website}|${a.verdict}|${a.signals?.platform ?? ''}|${a.signals?.listingLinkCount ?? ''}|${a.signals?.hasListingJsonLd ?? ''}|${a.signals?.termsLinks[0] ? 'yes' : ''}|${a.reasons.join('; ')}|`);
  await new Promise((r) => setTimeout(r, 300));
}
lines.splice(1, 0, `verdicts (terms step skipped): ${JSON.stringify(tally)}`);
console.log(lines.join('\n'));
