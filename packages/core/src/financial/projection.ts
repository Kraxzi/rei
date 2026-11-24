import { irr, npv, paybackYears, roundCents, safeRatio, sum } from './math.js';
import { annualDebtService, remainingBalance } from './loan.js';
import { acquisitionCost, operatingStatement, type YearOneInput } from './statement.js';

export interface GrowthAssumptions {
  /** Annual revenue growth (fraction). */
  revenueGrowth: number;
  /** Annual growth of fixed operating costs. */
  expenseGrowth: number;
  /** Annual change of asset value. */
  appreciation: number;
  /** Selling costs at exit as a fraction of sale price (agency, notary, taxes on sale). */
  saleCostRate: number;
  /** Discount rate for NPV. */
  discountRate: number;
  /** Value of the asset today; defaults to purchase price. */
  currentValue?: number;
}

export interface ProjectionYear {
  year: number;
  gri: number;
  noi: number;
  debtService: number;
  cashFlow: number;
}

export interface ProjectionResult {
  horizonYears: number;
  years: ProjectionYear[];
  saleValue: number;
  saleCosts: number;
  loanBalanceAtSale: number;
  netSaleProceeds: number;
  /** Equity cashflows: [-equity, cf1, ..., cfN + net sale proceeds] */
  equityCashflows: number[];
  irr: number | null;
  npv: number;
  /** Payback of equity from operating cashflows only (sale excluded); null if not reached within horizon. */
  paybackYears: number | null;
  /** (sum of all inflows incl. sale - equity) / equity */
  totalReturn: number | null;
  /** Annualised totalReturn. */
  annualizedReturn: number | null;
}

export function project(input: YearOneInput, g: GrowthAssumptions, horizonYears: number): ProjectionResult {
  if (!Number.isInteger(horizonYears) || horizonYears < 1) throw new RangeError('horizon must be a positive integer');
  const acq = acquisitionCost(input.acquisition);
  const principal = input.loan?.principal ?? 0;
  const equity = acq.total - principal;

  const years: ProjectionYear[] = [];
  for (let t = 1; t <= horizonYears; t++) {
    const gri = roundCents(input.gri * (1 + g.revenueGrowth) ** (t - 1));
    const st = operatingStatement(gri, input.operating, (1 + g.expenseGrowth) ** (t - 1));
    const debtService = input.loan ? annualDebtService(input.loan, t) : 0;
    years.push({ year: t, gri, noi: st.noi, debtService, cashFlow: st.noi - debtService });
  }

  const baseValue = g.currentValue ?? acq.price;
  const saleValue = roundCents(baseValue * (1 + g.appreciation) ** horizonYears);
  const saleCosts = roundCents(saleValue * g.saleCostRate);
  const loanBalanceAtSale = input.loan ? remainingBalance(input.loan, horizonYears) : 0;
  const netSaleProceeds = saleValue - saleCosts - loanBalanceAtSale;

  const operating = years.map((y) => y.cashFlow);
  const equityCashflows = [-equity, ...operating];
  equityCashflows[horizonYears] = (equityCashflows[horizonYears] ?? 0) + netSaleProceeds;

  const totalReturn = safeRatio(sum(equityCashflows.slice(1)) - equity, equity);
  const annualizedReturn =
    totalReturn === null || totalReturn <= -1 ? null : (1 + totalReturn) ** (1 / horizonYears) - 1;

  return {
    horizonYears,
    years,
    saleValue,
    saleCosts,
    loanBalanceAtSale,
    netSaleProceeds,
    equityCashflows,
    irr: equity > 0 ? irr(equityCashflows) : null,
    npv: roundCents(npv(g.discountRate, equityCashflows)),
    paybackYears: equity > 0 ? paybackYears([-equity, ...operating]) : null,
    totalReturn,
    annualizedReturn,
  };
}
