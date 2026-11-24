/** Monitoring: compare listing snapshots, decide events; duplicate detection between properties. */

import { haversine } from '../geo/index.js';
import { TYPES } from '../taxonomy/data.js';

export interface Snapshot {
  price: number | null;
  currency: string | null;
  dealType: string | null;
  title: string | null;
  areaM2: number | null;
  rooms: number | null;
  images: string[];
  status: 'active' | 'removed' | 'reappeared';
}

export type ListingEventType =
  | 'new' | 'price_down' | 'price_up' | 'features_changed' | 'photos_changed' | 'removed' | 'reappeared' | 'republished' | 'cross_posted';

export interface ListingEvent {
  type: ListingEventType;
  old: unknown;
  new: unknown;
  /** For price events: relative change (negative = drop). */
  change?: number;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function listingEvents(prev: Snapshot | null, next: Snapshot): ListingEvent[] {
  if (!prev) return [{ type: 'new', old: null, new: { price: next.price, currency: next.currency } }];
  const ev: ListingEvent[] = [];
  if (prev.status === 'removed') ev.push({ type: 'reappeared', old: 'removed', new: 'active' });
  if (prev.price !== null && next.price !== null && prev.price !== next.price && prev.currency === next.currency) {
    const change = (next.price - prev.price) / prev.price;
    ev.push({ type: next.price < prev.price ? 'price_down' : 'price_up', old: prev.price, new: next.price, change });
  }
  const f = (s: Snapshot) => ({ title: s.title, areaM2: s.areaM2, rooms: s.rooms, dealType: s.dealType });
  if (JSON.stringify(f(prev)) !== JSON.stringify(f(next))) ev.push({ type: 'features_changed', old: f(prev), new: f(next) });
  if (!sameSet(prev.images, next.images) && next.images.length > 0) ev.push({ type: 'photos_changed', old: prev.images.length, new: next.images.length });
  return ev;
}

/** A listing missing from a complete crawl this many times in a row is marked removed (never "sold"). */
export const MISSED_RUNS_TO_REMOVE = 2;

// ---------- duplicates ----------

export interface DedupItem {
  typeCode: string | null;
  dealType: string | null;
  price: number | null;
  areaM2: number | null;
  rooms: number | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  text: string;
  images: string[];
}

export interface DedupResult {
  probability: number;
  signals: Record<string, number>;
}

const categoryOf = (code: string | null) => (code ? TYPES.find((t) => t.code === code)?.category ?? null : null);

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9à-ü\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const fileName = (u: string) => u.split('?')[0]!.split('/').pop()!.toLowerCase();

/**
 * Probability that two listings describe the same physical property.
 * Hard stops (different deal or category, far apart) return 0. Signals are combined additively and capped;
 * the thresholds used by the pipeline: >= 0.85 merge automatically, 0.55–0.85 manual review.
 */
export function duplicateProbability(a: DedupItem, b: DedupItem): DedupResult {
  const signals: Record<string, number> = {};
  if (a.dealType && b.dealType && a.dealType !== b.dealType) return { probability: 0, signals: { deal: -1 } };
  if (categoryOf(a.typeCode) && categoryOf(b.typeCode) && categoryOf(a.typeCode) !== categoryOf(b.typeCode)) return { probability: 0, signals: { category: -1 } };
  if (a.lat !== null && a.lng !== null && b.lat !== null && b.lng !== null) {
    const d = haversine({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    if (d > 2000) return { probability: 0, signals: { distance: -1 } };
    signals.distance = d <= 60 ? 0.3 : d <= 300 ? 0.15 : 0;
  } else if (a.city && b.city) {
    if (a.city.toLowerCase() !== b.city.toLowerCase()) return { probability: 0, signals: { city: -1 } };
    signals.city = 0.05;
  }
  if (a.areaM2 && b.areaM2) {
    const r = Math.abs(a.areaM2 - b.areaM2) / Math.max(a.areaM2, b.areaM2);
    signals.area = r <= 0.03 ? 0.25 : r <= 0.08 ? 0.12 : r > 0.25 ? -0.3 : 0;
  }
  if (a.rooms && b.rooms) signals.rooms = a.rooms === b.rooms ? 0.1 : -0.15;
  if (a.price && b.price) {
    const r = Math.abs(a.price - b.price) / Math.max(a.price, b.price);
    signals.price = r <= 0.02 ? 0.2 : r <= 0.1 ? 0.1 : r > 0.3 ? -0.2 : 0;
  }
  if (a.typeCode && b.typeCode) signals.type = a.typeCode === b.typeCode ? 0.05 : 0;
  const j = jaccard(tokens(a.text), tokens(b.text));
  signals.text = j >= 0.6 ? 0.25 : j >= 0.35 ? 0.12 : 0;
  const imgA = new Set(a.images.map(fileName));
  const shared = b.images.map(fileName).filter((f) => imgA.has(f)).length;
  signals.images = shared >= 2 ? 0.3 : shared === 1 ? 0.1 : 0;

  const p = Math.max(0, Math.min(1, Object.values(signals).reduce((s, x) => s + x, 0)));
  return { probability: Math.round(p * 100) / 100, signals };
}

export const DEDUP_AUTO_MERGE = 0.85;
export const DEDUP_REVIEW = 0.55;
