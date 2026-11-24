import type { Env } from '../env.js';
import { nowIso, ulid } from '../lib/util.js';

/**
 * AI Provider Layer. Only Gemini is implemented; the interface lets us swap providers without touching callers.
 * AI never produces the numbers of the financial engine — it classifies, extracts and summarises text.
 */
export interface AIJsonRequest {
  purpose: string;
  prompt: string;
  /** Text payload (page content etc.), kept separate from instructions. */
  input: string;
  tier: 2 | 3;
}

export interface AIJsonResult<T> {
  ok: boolean;
  data: T | null;
  error?: 'no_key' | 'budget' | 'http' | 'parse';
  model?: string;
}

export const DEFAULT_LITE_MODEL = 'gemini-flash-lite-latest';
export const DEFAULT_DEEP_MODEL = 'gemini-flash-latest';

async function usedToday(db: D1Database): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE day = ?1').bind(nowIso().slice(0, 10)).first<number>('n')) ?? 0;
}

export async function aiJson<T>(env: Env, req: AIJsonRequest, fetcher: typeof fetch = fetch): Promise<AIJsonResult<T>> {
  if (!env.GEMINI_API_KEY) return { ok: false, data: null, error: 'no_key' };
  const limit = Number(env.AI_DAILY_LIMIT ?? 200);
  if ((await usedToday(env.DB)) >= limit) return { ok: false, data: null, error: 'budget' };

  const model = req.tier === 3 ? (env.GEMINI_MODEL_DEEP ?? DEFAULT_DEEP_MODEL) : (env.GEMINI_MODEL_LITE ?? DEFAULT_LITE_MODEL);
  let ok = false;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  try {
    const res = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.prompt }] },
        contents: [{ role: 'user', parts: [{ text: req.input }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, data: null, error: 'http', model };
    const body = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    tokensIn = body.usageMetadata?.promptTokenCount ?? null;
    tokensOut = body.usageMetadata?.candidatesTokenCount ?? null;
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    try {
      const data = JSON.parse(text) as T;
      ok = true;
      return { ok: true, data, model };
    } catch {
      return { ok: false, data: null, error: 'parse', model };
    }
  } catch {
    return { ok: false, data: null, error: 'http', model };
  } finally {
    await env.DB.prepare('INSERT INTO ai_calls (id, day, purpose, provider, model, ok, tokens_in, tokens_out, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
      .bind(ulid(), nowIso().slice(0, 10), req.purpose, 'gemini', model, ok ? 1 : 0, tokensIn, tokensOut, nowIso())
      .run();
  }
}
