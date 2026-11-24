import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env.js';
import { discoveryRegions } from '../src/routes/profiles.js';
import { handleJob, requestDiscovery, type Deps, type Job } from '../src/sources/discovery.js';
import { createTestD1, createTestQueue } from './d1-shim.js';
import { app } from '../src/index.js';
import { sha256Hex } from '../src/lib/auth.js';

// Fake internet: Overpass + three agency sites + Gemini.
const SITES: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
  'https://agenziamare.it/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /admin' },
  'https://agenziamare.it/': { status: 200, body: '<title>Mare</title><a href="/immobili/1">a</a><a href="/immobili/2">b</a><a href="/immobili/3">c</a><a href="/note-legali">Note legali</a>' },
  'https://agenziamare.it/note-legali': { status: 200, body: `<p>${'Testo legale sul copyright dei contenuti. '.repeat(20)}</p>` },
  'https://chiusa.it/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /' },
  'https://chiusa.it/': { status: 200, body: '<p>ciao</p>' },
  'https://protetta.it/robots.txt': { status: 404, body: '' },
  'https://protetta.it/': { status: 403, body: '<title>Just a moment...</title>', headers: { 'cf-mitigated': 'challenge' } },
  'https://vietato.it/robots.txt': { status: 404, body: '' },
  'https://vietato.it/': { status: 200, body: '<a href="/vendita/1">1</a><a href="/vendita/2">2</a><a href="/vendita/3">3</a><a href="/termini">Termini e condizioni</a>' },
  'https://vietato.it/termini': { status: 200, body: `<p>${'È vietata qualsiasi estrazione automatica dei dati. '.repeat(10)}</p>` },
};

const OVERPASS = {
  elements: [
    { type: 'node', id: 1, lat: 43.81, lon: 7.77, tags: { name: 'Agenzia Mare', website: 'https://agenziamare.it', 'addr:city': 'Sanremo' } },
    { type: 'node', id: 2, tags: { name: 'Chiusa', website: 'chiusa.it' } },
    { type: 'node', id: 3, tags: { name: 'Protetta', website: 'https://protetta.it' } },
    { type: 'node', id: 4, tags: { name: 'Vietato', website: 'https://vietato.it' } },
    { type: 'node', id: 5, tags: { name: 'Portale', website: 'https://www.immobiliare.it/agenzie/1' } },
    { type: 'node', id: 6, tags: { name: 'Nessun sito' } },
  ],
};

let calls: string[];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  calls.push(url);
  if (url.includes('/api/interpreter')) {
    expect(String(init?.body)).toContain(encodeURIComponent('"ISO3166-2"="IT-IM"'));
    return Response.json(OVERPASS);
  }
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const text = JSON.parse(String(init?.body)).contents[0].parts[0].text as string;
    const verdict = text.includes('vietata') ? { prohibitsScraping: true, summary: 'запрещено автоматическое извлечение', quote: 'È vietata qualsiasi estrazione automatica' } : { prohibitsScraping: false, summary: 'только копирайт на контент', quote: '' };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });
  }
  const site = SITES[url];
  if (!site) return new Response('not found', { status: 404 });
  return new Response(site.body, { status: site.status, headers: site.headers });
};

let env: Env;
let q: ReturnType<typeof createTestQueue<Job>>;
let deps: Deps;

async function drain() {
  while (q.messages.length) await handleJob(env, deps, q.messages.shift()!);
}

beforeEach(async () => {
  calls = [];
  q = createTestQueue<Job>();
  env = { DB: createTestD1(), ENVIRONMENT: 'test', JOBS: q.queue, GEMINI_API_KEY: 'test-key' };
  deps = { fetch: fakeFetch, enqueue: async (jobs) => { q.messages.push(...jobs); } };
  await env.DB.prepare("INSERT INTO users (id, display_name, role, created_at) VALUES ('u1', 'Батя', 'owner', '2026-01-01')").run();
});

describe('discovery regions', () => {
  it('province replaces its region; region alone is scanned whole', () => {
    expect(discoveryRegions(['it-r-07', 'it-p-im'])).toEqual(['it-p-im']);
    expect(discoveryRegions(['it-r-07'])).toEqual(['it-r-07']);
    expect(discoveryRegions(['it-r-09', 'it-r-07', 'it-p-sv'])).toEqual(['it-p-sv', 'it-r-09']);
    expect(discoveryRegions([])).toEqual([]);
  });
});

describe('discovery & audit pipeline', () => {
  it('finds agencies, audits them, classifies and never connects automatically', async () => {
    expect(await requestDiscovery(env, deps, ['it-p-im'], 'u1')).toHaveLength(1);
    // second request within 30 days is a no-op
    expect(await requestDiscovery(env, deps, ['it-p-im'], 'u1')).toHaveLength(0);
    await drain();

    const disc = await env.DB.prepare('SELECT status, found, without_website, excluded FROM region_discoveries').first();
    expect(disc).toEqual({ status: 'done', found: 4, without_website: 1, excluded: 1 });

    const { results } = await env.DB.prepare('SELECT base_url, verdict, access_status, is_active, decision FROM sources ORDER BY base_url').all<{ base_url: string; verdict: string; access_status: string; is_active: number; decision: string | null }>();
    const v = Object.fromEntries(results.map((r) => [r.base_url, r.verdict]));
    expect(v).toEqual({
      'https://agenziamare.it': 'suitable',
      'https://chiusa.it': 'rejected', // robots Disallow: /
      'https://protetta.it': 'rejected', // anti-bot
      'https://vietato.it': 'rejected', // terms prohibit scraping (AI)
    });
    // variant B: nothing is active until a human approves
    expect(results.every((r) => r.is_active === 0 && r.decision === null)).toBe(true);
    // rejected-by-robots site: home page fetched once, terms/AI never called for it
    expect(calls.filter((u) => u.startsWith('https://chiusa.it'))).toEqual(['https://chiusa.it/robots.txt', 'https://chiusa.it/']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls').first('n')).toBe(2);
  });

  it('audit is idempotent and AI budget is respected', async () => {
    env.AI_DAILY_LIMIT = '0';
    await requestDiscovery(env, deps, ['it-p-im'], 'u1');
    await drain();
    const mare = await env.DB.prepare("SELECT id, verdict, audit FROM sources WHERE base_url = 'https://agenziamare.it'").first<{ id: string; verdict: string; audit: string }>();
    expect(mare!.verdict).toBe('review'); // terms not checked -> human decides
    expect(mare!.audit).toContain('лимит ИИ');
    const before = calls.length;
    await handleJob(env, deps, { type: 'audit', sourceId: mare!.id });
    expect(calls.length).toBe(before);
  });

  it('falls back to another Overpass instance', async () => {
    const flaky: Deps = { ...deps, fetch: async (input, init) => (String(input).includes('overpass-api.de') ? new Response('busy', { status: 504 }) : fakeFetch(input, init)) };
    await requestDiscovery(env, flaky, ['it-p-im'], 'u1');
    while (q.messages.length) await handleJob(env, flaky, q.messages.shift()!);
    expect(await env.DB.prepare('SELECT found FROM region_discoveries').first('found')).toBe(4);
  });

  it('Overpass failure marks the discovery as error and rethrows for retry', async () => {
    const failing: Deps = { ...deps, fetch: async () => new Response('busy', { status: 429 }) };
    const [id] = await requestDiscovery(env, failing, ['it-p-im'], 'u1');
    await expect(handleJob(env, failing, { type: 'discover', discoveryId: id! })).rejects.toThrow('429');
    expect(await env.DB.prepare('SELECT status FROM region_discoveries').first('status')).toBe('error');
  });
});

describe('approval API (variant B)', () => {
  const TOKEN = 'tok';
  const call = (path: string, body?: unknown) =>
    app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: `rei_session=${TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?1, 'u1', '2999-01-01', '2026-01-01')").bind(await sha256Hex(TOKEN)).run();
    await requestDiscovery(env, deps, ['it-p-im'], 'u1');
    await drain();
  });

  it('summary, list with reasons, approve all suitable, rejected cannot be approved', async () => {
    const summary = (await (await call('/api/sources/summary')).json()) as Array<{ region_name: string; counts: { suitable: number; rejected: number } }>;
    expect(summary[0]).toMatchObject({ region_name: 'Imperia', counts: { suitable: 1, rejected: 3 } });

    const list = (await (await call('/api/sources?region=it-p-im')).json()) as Array<{ id: string; url: string; verdict: string; reasons: string[] }>;
    expect(list[0]!.url).toBe('https://agenziamare.it'); // suitable first
    expect(list.find((s) => s.url === 'https://vietato.it')!.reasons.join(' ')).toContain('запрещают');

    expect(await (await call('/api/sources/approve-suitable', { regionId: 'it-p-im' })).json()).toEqual({ approved: 1 });
    const rejected = list.filter((s) => s.verdict === 'rejected').map((s) => s.id);
    expect(await (await call('/api/sources/approve', { ids: rejected })).json()).toEqual({ approved: 0 });

    const active = await env.DB.prepare("SELECT base_url FROM sources WHERE is_active = 1 AND access_status = 'approved_public'").all<{ base_url: string }>();
    expect(active.results.map((r) => r.base_url)).toEqual(['https://agenziamare.it']);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'source_approved'").first('n')).toBe(2);
  });

  it('only owner/admin can decide', async () => {
    await env.DB.prepare("UPDATE users SET role = 'user'").run();
    expect((await call('/api/sources/approve-suitable', { regionId: 'it-p-im' })).status).toBe(403);
  });

  it('creating a profile with a region starts discovery automatically', async () => {
    const r = await call('/api/profiles', { name: 'Savona', countries: ['IT'], regions: ['it-r-07', 'it-p-sv'] });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ discoveryStarted: 1 });
    expect(q.messages).toEqual([{ type: 'discover', discoveryId: expect.any(String) }]);
  });
});

describe('cron', () => {
  it('starts discovery for regions of active profiles only', async () => {
    const worker = (await import('../src/index.js')).default;
    const now = '2026-01-01';
    await env.DB.prepare("INSERT INTO search_profiles (id, user_id, name, regions, is_active, created_at, updated_at) VALUES ('p1','u1','A','[\"it-r-07\",\"it-p-ge\"]',1,?1,?1), ('p2','u1','B','[\"it-r-09\"]',0,?1,?1)").bind(now).run();
    await (worker.scheduled as (e: unknown, env: Env) => Promise<void>)({}, env);
    const { results } = await env.DB.prepare('SELECT region_id FROM region_discoveries').all<{ region_id: string }>();
    expect(results.map((r) => r.region_id)).toEqual(['it-p-ge']);
    await (worker.scheduled as (e: unknown, env: Env) => Promise<void>)({}, env);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM region_discoveries').first('n')).toBe(1);
  });
});
