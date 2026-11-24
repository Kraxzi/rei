/**
 * Numeric primitives for the financial engine.
 * Money is always integer minor units (cents). Rates are fractions (0.05 = 5%).
 */

/** Round to integer cents, half away from zero. */
export function roundCents(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`non-finite money value: ${x}`);
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

/** Ratio that returns null instead of Infinity/NaN when the denominator is not positive. */
export function safeRatio(num: number, den: number): number | null {
  if (!(den > 0)) return null;
  return num / den;
}

/** Net present value. cashflows[0] is at t=0 (not discounted). */
export function npv(rate: number, cashflows: readonly number[]): number {
  if (rate <= -1) throw new RangeError('discount rate must be > -100%');
  let v = 0;
  for (let t = 0; t < cashflows.length; t++) v += (cashflows[t] ?? 0) / (1 + rate) ** t;
  return v;
}

function npvDerivative(rate: number, cashflows: readonly number[]): number {
  let d = 0;
  for (let t = 1; t < cashflows.length; t++) d -= (t * (cashflows[t] ?? 0)) / (1 + rate) ** (t + 1);
  return d;
}

/**
 * Internal rate of return. Newton–Raphson from a guess, falling back to bisection on [-0.9999, 10].
 * Returns null when the cashflows have no sign change (IRR undefined) or no root is bracketed.
 */
export function irr(cashflows: readonly number[], guess = 0.1): number | null {
  const hasPos = cashflows.some((c) => c > 0);
  const hasNeg = cashflows.some((c) => c < 0);
  if (!hasPos || !hasNeg) return null;

  const tol = 1e-10;
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(r, cashflows);
    if (Math.abs(f) < tol) return r;
    const d = npvDerivative(r, cashflows);
    if (d === 0 || !Number.isFinite(d)) break;
    const next = r - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo, cashflows);
  const fhi = npv(hi, cashflows);
  if (Math.sign(flo) === Math.sign(fhi)) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid, cashflows);
    if (Math.abs(fm) < tol || (hi - lo) / 2 < 1e-12) return mid;
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Payback period in years from a cashflow series where cashflows[0] is the (negative) initial outlay.
 * Linear interpolation inside the year in which the cumulative cashflow turns non-negative.
 * Returns null if not paid back within the series.
 */
export function paybackYears(cashflows: readonly number[]): number | null {
  let cum = cashflows[0] ?? 0;
  if (cum >= 0) return 0;
  for (let t = 1; t < cashflows.length; t++) {
    const cf = cashflows[t] ?? 0;
    const prev = cum;
    cum += cf;
    if (cum >= 0) return t - 1 + -prev / cf;
  }
  return null;
}
