import { describe, expect, it } from 'vitest';
import { bboxAround, geoFilterBbox, geohashEncode, haversine, inBbox, matchesGeoFilter, pointInPolygon, type Polygon } from '../src/index.js';

const sanremo = { lat: 43.8159, lng: 7.7761 };
const imperia = { lat: 43.8890, lng: 8.0390 };
const genova = { lat: 44.4056, lng: 8.9463 };

describe('geo', () => {
  it('haversine: Paris–London ≈ 343.5 km (reference)', () => {
    const d = haversine({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 });
    expect(d / 1000).toBeCloseTo(343.5, 0);
  });

  it('haversine: zero and symmetric', () => {
    expect(haversine(sanremo, sanremo)).toBe(0);
    expect(haversine(sanremo, genova)).toBeCloseTo(haversine(genova, sanremo), 6);
  });

  it('bbox contains the circle', () => {
    const b = bboxAround(sanremo, 25_000);
    expect(inBbox(imperia, b)).toBe(true); // ~22.5 km
    expect(inBbox(genova, b)).toBe(false);
  });

  it('geohash reference value', () => {
    // classic example from the geohash spec
    expect(geohashEncode({ lat: 57.64911, lng: 10.40744 }, 11)).toBe('u4pruydqqvj');
  });

  const square: Polygon = [[[7.7, 43.7], [7.9, 43.7], [7.9, 43.9], [7.7, 43.9], [7.7, 43.7]]];
  const withHole: Polygon = [square[0]!, [[7.77, 43.81], [7.78, 43.81], [7.78, 43.82], [7.77, 43.82]]];

  it('point in polygon, holes excluded', () => {
    expect(pointInPolygon(sanremo, square)).toBe(true);
    expect(pointInPolygon(genova, square)).toBe(false);
    expect(pointInPolygon(sanremo, withHole)).toBe(false);
  });

  it('geo filter: includes, radius, exclusions', () => {
    expect(matchesGeoFilter(genova, {})).toBe(true);
    expect(matchesGeoFilter(imperia, { circles: [{ center: sanremo, radiusM: 25_000 }] })).toBe(true);
    expect(matchesGeoFilter(imperia, { circles: [{ center: sanremo, radiusM: 10_000 }] })).toBe(false);
    expect(matchesGeoFilter(sanremo, { polygons: [square], exclude: [withHole.slice(1) as unknown as Polygon] })).toBe(false);
    expect(geoFilterBbox({})).toBeNull();
    expect(inBbox(sanremo, geoFilterBbox({ polygons: [square] })!)).toBe(true);
  });
});
