export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`, data);
  return data as T;
}

// ---------- shared types ----------

export interface User { id: string; displayName: string; role: 'owner' | 'admin' | 'user' }
export interface Me { user: User | null; needsBootstrap: boolean; bootstrapEnabled: boolean }

export type I18n = { ru: string; it?: string; en?: string };
export interface FieldDef { key: string; type: string; unit?: string; label: { ru: string } }
export interface PropertyType { code: string; name: I18n; financialModels: string[] }
export interface Category { code: string; name: I18n; types: PropertyType[]; typicalRisks: string[]; legalChecks: string[] }
export interface Taxonomy { categories: Category[]; fields: Record<string, FieldDef> }
export interface Country { code: string; name: I18n; currency: string }
export interface Region { id: string; code: string; name: string; level: 'region' | 'province'; parent_id: string | null }

export interface SearchProfile {
  id?: string;
  name: string;
  countries: string[];
  regions: string[];
  cities: string[];
  geo: Record<string, unknown>;
  typeCodes: string[];
  priceMin: number | null;
  priceMax: number | null;
  areaMin: number | null;
  areaMax: number | null;
  targetNetYield: number | null;
  condition: string[];
  extra: Record<string, unknown>;
  strategy: 'income' | 'growth' | 'value_add' | 'mixed';
  refreshMin: number;
  notify: { minScore?: number; minNetYield?: number; priceDropPct?: number };
  isActive: boolean;
}
