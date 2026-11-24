import { describe, expect, it } from 'vitest';
import { analyzeProperty, countPois, growthFromHpi, locationScore, parseJsonStatSeries, poiOverpassQuery } from '../src/index.js';

describe('location', () => {
  it('counts POIs by tag and scores by category', () => {
    const c = countPois([{ tags: { railway: 'station' } }, { tags: { shop: 'supermarket' } }, { tags: { shop: 'bakery' } }, { tags: { amenity: 'pharmacy' } }, { tags: { natural: 'beach' } }, ...Array(6).fill({ tags: { amenity: 'cafe' } })]);
    expect(c).toMatchObject({ station: 1, grocery: 2, pharmacy: 1, beach: 1, food: 6 });
    expect(locationScore(c, 'hospitality').value).toBeGreaterThan(80);
    expect(locationScore({ ...c, station: 0, beach: 0, food: 0 }, 'hospitality').value).toBeLessThan(25);
    expect(poiOverpassQuery(43.8, 7.7)).toContain('(around:1500,43.8,7.7)');
  });
});

describe('growth from Eurostat HPI', () => {
  it('parses JSON-stat and averages the last 3 years', () => {
    const js = { value: { '0': 1.2, '1': 2.0, '2': 3.1, '3': 4.0 }, dimension: { time: { category: { index: { '2022': 0, '2023': 1, '2024': 2, '2025': 3 } } } } };
    const s = parseJsonStatSeries(js);
    expect(s.map((x) => x.period)).toEqual(['2022', '2023', '2024', '2025']);
    expect(growthFromHpi(s)).toEqual({ value: (2.0 + 3.1 + 4.0) / 300, basis: '2023–2025' });
    expect(growthFromHpi([])).toBeNull();
  });
});

describe('analyzeProperty — Italy', () => {
  const base = {
    category: 'parking', price: 25_000_00, areaM2: 15, condition: null, isAuction: false, completeness: 1, dataAgeDays: 1, daysOnMarket: 20, perUnit: true,
    saleComps: [30_000_00, 32_000_00, 28_000_00, 31_000_00, 29_000_00].map((price) => ({ price, areaM2: null })),
    rentComps: [120_00, 130_00, 110_00].map((price) => ({ price, areaM2: null })),
  };
  it('uses Italian purchase taxes, IMU assumption, cedolare 21 %, location and growth', () => {
    const r = analyzeProperty({ ...base, country: 'IT', location: { pois: { station: 1, bus: 3, grocery: 2, pharmacy: 1, health: 1, school: 2, food: 6, beach: 1 }, exact: false }, growth: { value: 0.03, basis: '2023–2025' } });
    // registro 9 % of price (no cadastral value) = 2 250, + 100 fixed; agency 3.66 % = 915; notary 2 000
    expect(r.finance!.acquisition.lines.purchaseTax).toBe(2_350_00);
    expect(r.finance!.acquisition.total).toBe(25_000_00 + 2_350_00 + 915_00 + 2_000_00);
    expect(r.finance!.statement.expenses.holdingTax).toBe(100_00);
    expect(r.finance!.incomeTax).toBe(Math.round(120_00 * 12 * 0.9 * 0.21));
    expect(r.netYieldAfterTax!).toBeLessThan(r.netYield!);
    expect(r.taxWarnings.join(' ')).toContain('кадастровой');
    expect(r.score.components.location.value).not.toBeNull();
    expect(r.score.components.growth.basis).toContain('по стране');
  });
  it('other countries keep the generic, labelled 10 %', () => {
    const r = analyzeProperty({ ...base, country: 'DE' });
    expect(r.finance!.acquisition.lines.other).toBe(2_500_00);
    expect(r.finance!.incomeTax).toBe(0);
  });
});
