import { roundCents } from './math.js';

export interface LoanInput {
  /** Principal in cents. */
  principal: number;
  /** Nominal annual interest rate (fraction). */
  annualRate: number;
  /** Term in years. */
  years: number;
  /** Payments per year (12 = monthly). */
  paymentsPerYear?: number;
}

/** Level annuity payment per period, in cents (unrounded math, rounded result). */
export function annuityPayment(loan: LoanInput): number {
  const n = loan.years * (loan.paymentsPerYear ?? 12);
  if (loan.principal <= 0 || n <= 0) return 0;
  const i = loan.annualRate / (loan.paymentsPerYear ?? 12);
  if (i === 0) return roundCents(loan.principal / n);
  return roundCents((loan.principal * i) / (1 - (1 + i) ** -n));
}

/** Outstanding balance after `afterYears` full years of payments, in cents. */
export function remainingBalance(loan: LoanInput, afterYears: number): number {
  const ppy = loan.paymentsPerYear ?? 12;
  const n = loan.years * ppy;
  const k = Math.min(Math.max(0, Math.round(afterYears * ppy)), n);
  if (loan.principal <= 0) return 0;
  if (k >= n) return 0;
  const i = loan.annualRate / ppy;
  if (i === 0) return roundCents(loan.principal * (1 - k / n));
  const pmt = (loan.principal * i) / (1 - (1 + i) ** -n);
  const bal = loan.principal * (1 + i) ** k - pmt * (((1 + i) ** k - 1) / i);
  return roundCents(Math.max(0, bal));
}

/** Total debt service paid during year `year` (1-based), in cents. 0 after maturity. */
export function annualDebtService(loan: LoanInput, year: number): number {
  if (year > loan.years || loan.principal <= 0) return 0;
  return annuityPayment(loan) * (loan.paymentsPerYear ?? 12);
}
