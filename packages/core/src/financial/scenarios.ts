import { roundCents } from './math.js';
import type { Assumption } from './models.js';
import { project, type GrowthAssumptions, type ProjectionResult } from './projection.js';
import { yearOne, type YearOneInput, type YearOneResult } from './statement.js';

export type ScenarioName = 'pessimistic' | 'base' | 'optimistic';

/** How a scenario deviates from the base case. All deltas are absolute (fractions), factors multiply. */
export interface ScenarioAdjustment {
  revenueFactor: number;
  vacancyDelta: number;
  revenueGrowthDelta: number;
  appreciationDelta: number;
  expenseFactor: number;
}

export const DEFAULT_ADJUSTMENTS: Record<ScenarioName, ScenarioAdjustment> = {
  pessimistic: { revenueFactor: 0.9, vacancyDelta: 0.05, revenueGrowthDelta: -0.01, appreciationDelta: -0.02, expenseFactor: 1.1 },
  base: { revenueFactor: 1, vacancyDelta: 0, revenueGrowthDelta: 0, appreciationDelta: 0, expenseFactor: 1 },
  optimistic: { revenueFactor: 1.05, vacancyDelta: -0.02, revenueGrowthDelta: 0.01, appreciationDelta: 0.01, expenseFactor: 1 },
};

export const DEFAULT_HORIZONS = [1, 3, 5] as const;

export interface ScenarioResult {
  scenario: ScenarioName;
  adjustment: ScenarioAdjustment;
  yearOne: YearOneResult;
  horizons: ProjectionResult[];
}

export interface ScenarioRun {
  scenarios: ScenarioResult[];
  assumptions: Assumption[];
  disclaimer: string;
}

const scaleRecord = (r: Record<string, number> | undefined, f: number) =>
  r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, roundCents(v * f)])) : undefined;

export function applyAdjustment(input: YearOneInput, g: GrowthAssumptions, a: ScenarioAdjustment): [YearOneInput, GrowthAssumptions] {
  const op = input.operating;
  const fixed = (v: number | undefined) => (v === undefined ? undefined : roundCents(v * a.expenseFactor));
  const adjusted: YearOneInput = {
    ...input,
    gri: roundCents(input.gri * a.revenueFactor),
    operating: {
      ...op,
      vacancyRate: Math.min(1, Math.max(0, (op.vacancyRate ?? 0) + a.vacancyDelta)),
      insurance: fixed(op.insurance),
      holdingTax: fixed(op.holdingTax),
      maintenance: fixed(op.maintenance),
      utilities: fixed(op.utilities),
      other: fixed(op.other),
      extraFixed: scaleRecord(op.extraFixed, a.expenseFactor),
    },
  };
  return [
    adjusted,
    { ...g, revenueGrowth: g.revenueGrowth + a.revenueGrowthDelta, appreciation: g.appreciation + a.appreciationDelta },
  ];
}

export function runScenarios(
  input: YearOneInput,
  growth: GrowthAssumptions,
  assumptions: Assumption[] = [],
  opts: { horizons?: readonly number[]; adjustments?: Record<ScenarioName, ScenarioAdjustment> } = {},
): ScenarioRun {
  const adj = opts.adjustments ?? DEFAULT_ADJUSTMENTS;
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const scenarios = (['pessimistic', 'base', 'optimistic'] as const).map((name) => {
    const [i, g] = applyAdjustment(input, growth, adj[name]);
    return { scenario: name, adjustment: adj[name], yearOne: yearOne(i), horizons: horizons.map((h) => project(i, g, h)) };
  });
  return {
    scenarios,
    assumptions: [
      ...assumptions,
      { key: 'revenueGrowth', value: growth.revenueGrowth, unit: 'fraction/year', source: 'user' },
      { key: 'expenseGrowth', value: growth.expenseGrowth, unit: 'fraction/year', source: 'user' },
      { key: 'appreciation', value: growth.appreciation, unit: 'fraction/year', source: 'user' },
      { key: 'saleCostRate', value: growth.saleCostRate, unit: 'fraction', source: 'user' },
      { key: 'discountRate', value: growth.discountRate, unit: 'fraction', source: 'user' },
    ],
    disclaimer: 'Прогноз основан на перечисленных предположениях и не является гарантией результата или инвестиционной рекомендацией.',
  };
}
