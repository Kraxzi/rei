/**
 * robots.txt parser (RFC 9309 subset): groups by user-agent, Allow/Disallow with longest-match precedence,
 * `*` and `$` wildcards, Crawl-delay and Sitemap lines.
 */

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec: number | null;
}

export interface ParsedRobots {
  groups: Array<{ agents: string[]; rules: RobotsRules }>;
  sitemaps: string[];
}

export function parseRobots(txt: string): ParsedRobots {
  const groups: ParsedRobots['groups'] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [], crawlDelaySec: null } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' && value) current.rules.allow.push(value);
    else if (key === 'disallow' && value) current.rules.disallow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.rules.crawlDelaySec = n;
    }
  }
  return { groups, sitemaps };
}

/** Rules for our agent: the most specific matching group (product token), else `*`, else allow-all. */
export function rulesFor(robots: ParsedRobots, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  if (chosen.length === 0) return { allow: [], disallow: [], crawlDelaySec: null };
  return {
    allow: chosen.flatMap((g) => g.rules.allow),
    disallow: chosen.flatMap((g) => g.rules.disallow),
    crawlDelaySec: chosen.map((g) => g.rules.crawlDelaySec).find((d) => d !== null) ?? null,
  };
}

function patternToRegex(p: string): RegExp {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Is `path` (with query) allowed? Longest matching pattern wins; on a tie Allow wins. */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  const consider = (patterns: string[], allow: boolean) => {
    for (const p of patterns) {
      if (patternToRegex(p).test(path)) {
        const len = p.length;
        if (!best || len > best.len || (len === best.len && allow)) best = { len, allow };
      }
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best === null ? true : (best as { allow: boolean }).allow;
}
