import { BOT_USER_AGENT } from '@rei/core';

export interface FetchResult {
  status: number | null;
  text: string | null;
  headers: Record<string, string>;
  finalUrl: string | null;
}

/** Polite GET: our bot UA, timeout, size cap, no exceptions (status null = network error). */
export async function politeGet(fetcher: typeof fetch, url: string, maxBytes = 300_000, accept = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5'): Promise<FetchResult> {
  try {
    const res = await fetcher(url, {
      headers: { 'User-Agent': BOT_USER_AGENT, Accept: accept, 'Accept-Language': 'it,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    const headers: Record<string, string> = {};
    for (const h of ['cf-mitigated', 'server', 'content-type']) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    const text = (await res.text()).slice(0, maxBytes);
    return { status: res.status, text, headers, finalUrl: res.url || url };
  } catch {
    return { status: null, text: null, headers: {}, finalUrl: null };
  }
}
