/** Geographic helpers replacing PostGIS: SQL does a bbox prefilter, these functions do exact checks. */

export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON-style ring: array of [lng, lat], first point may or may not repeat the last. */
export type Ring = ReadonlyArray<readonly [number, number]>;
/** Polygon: outer ring followed by holes. */
export type Polygon = ReadonlyArray<Ring>;

export interface BBox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

const R = 6_371_008.8; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

export function isValidLatLng(p: LatLng): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding box that contains the circle (center, radius). Not antimeridian-aware (fine for Europe). */
export function bboxAround(c: LatLng, radiusM: number): BBox {
  const dLat = (radiusM / R) * (180 / Math.PI);
  const cos = Math.max(Math.cos(rad(c.lat)), 1e-6);
  const dLng = dLat / cos;
  return {
    minLat: Math.max(-90, c.lat - dLat),
    maxLat: Math.min(90, c.lat + dLat),
    minLng: Math.max(-180, c.lng - dLng),
    maxLng: Math.min(180, c.lng + dLng),
  };
}

export function polygonBbox(poly: Polygon): BBox {
  const outer = poly[0];
  if (!outer || outer.length < 3) throw new RangeError('polygon needs an outer ring with >= 3 points');
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lng, lat] of outer) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
  }
  return { minLat, minLng, maxLat, maxLng };
}

export function inBbox(p: LatLng, b: BBox): boolean {
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

function inRing(p: LatLng, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ray-casting point-in-polygon; points inside a hole are outside. */
export function pointInPolygon(p: LatLng, poly: Polygon): boolean {
  const [outer, ...holes] = poly;
  if (!outer || !inRing(p, outer)) return false;
  return !holes.some((h) => inRing(p, h));
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash encoding. Precision 6 ≈ 1.2 × 0.6 km, 7 ≈ 150 × 150 m. */
export function geohashEncode(p: LatLng, precision = 9): string {
  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180;
  let hash = '';
  let bit = 0, ch = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (p.lng >= mid) { ch = (ch << 1) | 1; lngLo = mid; } else { ch <<= 1; lngHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (p.lat >= mid) { ch = (ch << 1) | 1; latLo = mid; } else { ch <<= 1; latHi = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32[ch]; bit = 0; ch = 0; }
  }
  return hash;
}

/** Search-profile geography. A point matches if it is in ANY include area (or none are given) and in NO exclusion. */
export interface GeoFilter {
  circles?: Array<{ center: LatLng; radiusM: number }>;
  polygons?: Polygon[];
  exclude?: Polygon[];
}

export function matchesGeoFilter(p: LatLng, f: GeoFilter): boolean {
  if (f.exclude?.some((poly) => pointInPolygon(p, poly))) return false;
  const hasIncludes = (f.circles?.length ?? 0) + (f.polygons?.length ?? 0) > 0;
  if (!hasIncludes) return true;
  return (
    (f.circles?.some((c) => haversine(p, c.center) <= c.radiusM) ?? false) ||
    (f.polygons?.some((poly) => pointInPolygon(p, poly)) ?? false)
  );
}

/** Union bbox of all include areas, for the SQL prefilter. null = no geographic restriction. */
export function geoFilterBbox(f: GeoFilter): BBox | null {
  const boxes = [
    ...(f.circles ?? []).map((c) => bboxAround(c.center, c.radiusM)),
    ...(f.polygons ?? []).map(polygonBbox),
  ];
  if (boxes.length === 0) return null;
  return boxes.reduce((a, b) => ({
    minLat: Math.min(a.minLat, b.minLat), minLng: Math.min(a.minLng, b.minLng),
    maxLat: Math.max(a.maxLat, b.maxLat), maxLng: Math.max(a.maxLng, b.maxLng),
  }));
}
