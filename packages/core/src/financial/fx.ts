import { roundCents } from './math.js';

/** Rates quoted as units of `quote` per 1 EUR (ECB reference rates). EUR itself is implicit 1. */
export type EurRates = Readonly<Record<string, number>>;

function eurRate(rates: EurRates, ccy: string): number {
  if (ccy === 'EUR') return 1;
  const r = rates[ccy];
  if (!(r && r > 0)) throw new RangeError(`no FX rate for ${ccy}`);
  return r;
}

/** Convert minor units between currencies via EUR cross rates. Assumes both currencies use 2 decimals. */
export function convert(amount: number, from: string, to: string, rates: EurRates): number {
  if (from === to) return amount;
  return roundCents((amount / eurRate(rates, from)) * eurRate(rates, to));
}
