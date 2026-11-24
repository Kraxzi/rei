import { describe, expect, it } from 'vitest';
import { trailingPerformance } from '../src/index.js';

describe('portfolio performance', () => {
  it('full year: actual vs forecast', () => {
    const income = Array.from({ length: 12 }, (_, i) => ({ date: `2026-${String(i + 1).padStart(2, '0')}-05`, amount: 100_00 }));
    const r = trailingPerformance(income, [{ date: '2026-06-01', amount: 200_00 }], 20_000_00, 1_100_00, '2026-12-31', '2025-01-01');
    expect(r).toMatchObject({ income: 1_200_00, expenses: 200_00, net: 1_000_00, monthsCovered: 12 });
    expect(r.actualYield).toBeCloseTo(0.05, 10);
    expect(r.forecastYield).toBeCloseTo(0.055, 10);
    expect(r.vsForecast).toBe(-100_00);
  });

  it('bought 6 months ago: annualised and pro-rated forecast', () => {
    const r = trailingPerformance([{ date: '2026-09-01', amount: 600_00 }], [], 10_000_00, 1_200_00, '2026-12-31', '2026-07-01');
    expect(r.monthsCovered).toBe(6);
    expect(r.actualYield).toBeCloseTo(0.12, 10);
    expect(r.vsForecast).toBe(0);
  });

  it('entries outside the window are ignored; no cost -> no yield', () => {
    const r = trailingPerformance([{ date: '2020-01-01', amount: 999 }], [], null, null, '2026-12-31', null);
    expect(r).toMatchObject({ income: 0, actualYield: null, forecastYield: null, vsForecast: null });
  });
});
