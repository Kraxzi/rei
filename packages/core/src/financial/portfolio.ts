import { safeRatio } from './math.js';

/** Actual vs forecast performance of an owned asset over the last 12 months (trailing). */
export interface Entry { date: string; amount: number }

export interface Performance {
  income: number;
  expenses: number;
  net: number;
  actualYield: number | null;
  forecastYield: number | null;
  /** actual net minus forecast NOI (pro-rated to the covered months). */
  vsForecast: number | null;
  monthsCovered: number;
}

export function trailingPerformance(income: Entry[], expenses: Entry[], totalCost: number | null, expectedNoi: number | null, asOf: string, ownedSince: string | null): Performance {
  const end = Date.parse(asOf);
  const start = Math.max(end - 365 * 86_400_000, ownedSince ? Date.parse(ownedSince) : -Infinity);
  const inWindow = (e: Entry) => { const t = Date.parse(e.date); return t > start && t <= end; };
  const sum = (xs: Entry[]) => xs.filter(inWindow).reduce((s, e) => s + e.amount, 0);
  const inc = sum(income);
  const exp = sum(expenses);
  const months = Math.max(0, Math.min(12, Math.round((end - start) / (30.4375 * 86_400_000))));
  const net = inc - exp;
  const annualised = months > 0 ? (net * 12) / months : null;
  return {
    income: inc,
    expenses: exp,
    net,
    actualYield: annualised !== null && totalCost ? safeRatio(annualised, totalCost) : null,
    forecastYield: expectedNoi !== null && totalCost ? safeRatio(expectedNoi, totalCost) : null,
    vsForecast: expectedNoi !== null && months > 0 ? net - Math.round((expectedNoi * months) / 12) : null,
    monthsCovered: months,
  };
}
