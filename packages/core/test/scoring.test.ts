import { describe, expect, it } from 'vitest';
import { analyzeProperty, computeScore, marketStats, matchProfile, quantile, rentFromComps, valueFromComps, type MatchProfile, type MatchSubject } from '../src/index.js';

const comp = (eurPerM2: number, area = 50) => ({ price: eurPerM2 * area * 100, areaM2: area });

describe('valuation from comparables', () => {
  it('quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.25)).toBe(10);
  });

  it('median €/m² with outlier removal', () => {
    const s = marketStats([comp(3000), comp(3100), comp(2900), comp(3050), comp(30_000)], 'per_m2');
    expect(s.n).toBe(4);
    expect(s.median).toBe(302_500); // cents per m²
    expect(s.kind).toBe('asking');
  });

  it('subject value and undervaluation', () => {
    const v = valueFromComps({ price: 240_000_00, areaM2: 100 }, [comp(3000), comp(3000), comp(3000), comp(3000), comp(3000)], false)!;
    expect(v.mid).toBe(300_000_00);
    expect(v.undervaluation).toBeCloseTo(0.2, 10);
    expect(v.confidence).toBeGreaterThan(0);
  });

  it('no valuation below 3 comparables', () => {
    expect(valueFromComps({ price: 1, areaM2: 10 }, [comp(3000), comp(3000)], false)).toBeNull();
  });

  it('per-unit for garages', () => {
    const r = rentFromComps({ areaM2: 15 }, [{ price: 100_00, areaM2: null }, { price: 120_00, areaM2: null }, { price: 110_00, areaM2: null }], true)!;
    expect(r.monthly).toBe(110_00);
  });
});

describe('investment score', () => {
  const base = { category: 'residential', growth: null, location: null, liquidity: { comps: 10, daysOnMarket: 30 }, condition: 'good', completeness: 1, dataAgeDays: 1 };

  it('cheap with good yield scores higher than expensive with poor yield', () => {
    const good = computeScore({ ...base, undervaluation: { value: 0.15, confidence: 0.75 }, netYield: { value: 0.07, confidence: 0.6 } });
    const bad = computeScore({ ...base, undervaluation: { value: -0.15, confidence: 0.75 }, netYield: { value: 0.02, confidence: 0.6 } });
    expect(good.score!).toBeGreaterThan(70);
    expect(bad.score!).toBeLessThan(45);
  });

  it('missing growth/location lower confidence and are explained, not guessed', () => {
    const r = computeScore({ ...base, undervaluation: { value: 0.1, confidence: 0.75 }, netYield: { value: 0.05, confidence: 0.6 } });
    expect(r.components.growth.value).toBeNull();
    expect(r.confidence).toBeLessThan(0.6);
    expect(r.reasons.join(' ')).toContain('истории цен');
  });

  it('no score without valuation and yield', () => {
    const r = computeScore({ ...base, undervaluation: null, netYield: null });
    expect(r.score).toBeNull();
    expect(r.label).toBe('низкая');
  });

  it('category profiles and overrides change weights', () => {
    const inp = { ...base, category: 'parking', undervaluation: { value: 0, confidence: 0.75 }, netYield: { value: 0.08, confidence: 0.6 } };
    const parking = computeScore(inp);
    const noYield = computeScore(inp, { yield: 0 });
    expect(parking.score!).toBeGreaterThan(noYield.score!);
  });

  it('auction lowers legal component', () => {
    const a = computeScore({ ...base, undervaluation: { value: 0, confidence: 0.7 }, netYield: null, isAuction: true });
    expect(a.components.legal.value).toBeLessThanOrEqual(45);
  });
});

describe('profile matching', () => {
  const s: MatchSubject = { countryCode: 'IT', regionIds: ['it-p-im', 'it-r-07'], cityId: null, typeCode: 'garage', dealType: 'sale', price: 28_000_00, areaM2: 15, lat: 43.815, lng: 7.776, condition: null, netYield: 0.05 };
  const p: MatchProfile = { countries: ['IT'], regions: ['it-r-07', 'it-p-im'], cities: [], typeCodes: ['garage'], priceMin: null, priceMax: 40_000_00, areaMin: null, areaMax: null, targetNetYield: 0.04, condition: [], geo: {}, isActive: true };

  it('matches', () => expect(matchProfile(s, p)).toEqual({ match: true, failed: [] }));
  it('province narrows region', () => expect(matchProfile({ ...s, regionIds: ['it-p-sv', 'it-r-07'] }, p).failed).toContain('провинция'));
  it('budget, type, rent, yield', () => {
    expect(matchProfile({ ...s, price: 50_000_00 }, p).failed).toContain('цена выше бюджета');
    expect(matchProfile({ ...s, typeCode: 'villa' }, p).failed).toContain('тип объекта');
    expect(matchProfile({ ...s, dealType: 'rent' }, p).failed).toContain('это аренда, а не продажа');
    expect(matchProfile({ ...s, netYield: 0.03 }, p).failed).toContain('доходность ниже цели');
    expect(matchProfile({ ...s, netYield: null }, p).match).toBe(true); // unknown yield does not exclude
  });
  it('map zone', () => {
    const geo = { circles: [{ center: { lat: 44.4, lng: 8.9 }, radiusM: 5000 }] };
    expect(matchProfile(s, { ...p, geo }).failed).toContain('зона на карте');
  });
});

describe('analyzeProperty', () => {
  it('garage: per-unit value, rent, yield and score with listed assumptions', () => {
    const r = analyzeProperty({
      category: 'parking', price: 25_000_00, areaM2: 15, condition: null, isAuction: false, completeness: 1, dataAgeDays: 1, daysOnMarket: 20, perUnit: true,
      saleComps: [30_000_00, 32_000_00, 28_000_00, 31_000_00, 29_000_00].map((price) => ({ price, areaM2: null })),
      rentComps: [120_00, 130_00, 110_00].map((price) => ({ price, areaM2: null })),
    });
    expect(r.valuation!.mid).toBe(30_000_00);
    expect(r.valuation!.undervaluation).toBeCloseTo(1 / 6, 10);
    expect(r.rent!.monthly).toBe(120_00);
    // 120 × 12 × 90% = 1,296; costs: 1% maint 250 + ins 37.50 → NOI 1,008.50; total cost 27,500
    expect(r.finance!.statement.noi).toBe(100_850);
    expect(r.netYield).toBeCloseTo(100_850 / 2_750_000, 10);
    expect(r.score.score).not.toBeNull();
    expect(r.assumptions.some((a) => String(a.source).includes('не проверены'))).toBe(true);
  });

  it('land: no yield invented', () => {
    const r = analyzeProperty({ category: 'land', price: 50_000_00, areaM2: 10_000, condition: null, isAuction: false, completeness: 0.8, dataAgeDays: 1, daysOnMarket: null, perUnit: false, saleComps: [], rentComps: [] });
    expect(r.netYield).toBeNull();
    expect(r.score.score).toBeNull();
  });
});
