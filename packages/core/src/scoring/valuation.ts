/**
 * Market value and rent estimates from comparable listings.
 * These are ASKING prices of offers (not transactions) — every result says so, and carries the sample size.
 */

export interface Comparable {
  price: number; // cents (rent: per month)
  areaM2: number | null;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface MarketStats {
  n: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
  basis: 'per_m2' | 'per_unit';
  kind: 'asking';
}

/** Per-m² stats when areas are known (≥ 3 comps), else per-unit price stats. Outliers beyond 3×IQR dropped. */
export function marketStats(comps: Comparable[], basis: 'per_m2' | 'per_unit'): MarketStats {
  const values = comps
    .map((c) => (basis === 'per_m2' ? (c.areaM2 && c.areaM2 > 0 ? c.price / c.areaM2 : null) : c.price))
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (values.length >= 4) {
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const kept = values.filter((v) => v >= q1 - 3 * iqr && v <= q3 + 3 * iqr);
    values.splice(0, values.length, ...kept);
  }
  if (!values.length) return { n: 0, p25: null, median: null, p75: null, basis, kind: 'asking' };
  return { n: values.length, p25: quantile(values, 0.25), median: quantile(values, 0.5), p75: quantile(values, 0.75), basis, kind: 'asking' };
}

export function sampleConfidence(n: number): number {
  if (n >= 15) return 0.85;
  if (n >= 10) return 0.75;
  if (n >= 5) return 0.55;
  if (n >= 3) return 0.35;
  return 0;
}

export interface Valuation {
  low: number;
  mid: number;
  high: number;
  /** (mid - price) / mid: positive = offered below the comparable median. */
  undervaluation: number;
  n: number;
  confidence: number;
  kind: 'asking';
}

/** Value of the subject from comparable sale offers; null when fewer than 3 usable comparables. */
export function valueFromComps(subject: { price: number; areaM2: number | null }, comps: Comparable[], perUnit: boolean): Valuation | null {
  const basis = perUnit || !subject.areaM2 ? 'per_unit' : 'per_m2';
  const s = marketStats(comps, basis);
  if (s.n < 3 || s.median === null) return null;
  const mult = basis === 'per_m2' ? subject.areaM2! : 1;
  const mid = Math.round(s.median * mult);
  return {
    low: Math.round(s.p25! * mult),
    mid,
    high: Math.round(s.p75! * mult),
    undervaluation: (mid - subject.price) / mid,
    n: s.n,
    confidence: sampleConfidence(s.n),
    kind: 'asking',
  };
}

export interface RentEstimate {
  monthly: number;
  low: number;
  high: number;
  n: number;
  confidence: number;
  kind: 'asking';
}

export function rentFromComps(subject: { areaM2: number | null }, rentComps: Comparable[], perUnit: boolean): RentEstimate | null {
  const basis = perUnit || !subject.areaM2 ? 'per_unit' : 'per_m2';
  const s = marketStats(rentComps, basis);
  if (s.n < 3 || s.median === null) return null;
  const mult = basis === 'per_m2' ? subject.areaM2! : 1;
  return { monthly: Math.round(s.median * mult), low: Math.round(s.p25! * mult), high: Math.round(s.p75! * mult), n: s.n, confidence: sampleConfidence(s.n), kind: 'asking' };
}
