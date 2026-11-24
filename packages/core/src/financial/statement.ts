import { roundCents, safeRatio, sum } from './math.js';
import { annualDebtService, type LoanInput } from './loan.js';

/** One-off costs of buying the asset. All amounts in cents. */
export interface AcquisitionInput {
  price: number;
  /** Purchase tax as a fraction of price. Ignored when purchaseTaxAmount is given (e.g. tax on cadastral value). */
  purchaseTaxRate?: number;
  purchaseTaxAmount?: number;
  notaryFees?: number;
  registrationFees?: number;
  /** Agency fee as fraction of price. Ignored when agencyFeeAmount is given. */
  agencyFeeRate?: number;
  agencyFeeAmount?: number;
  renovation?: number;
  furnishing?: number;
  utilitiesConnection?: number;
  other?: number;
}

export interface AcquisitionResult {
  price: number;
  lines: Record<string, number>;
  /** price + all lines */
  total: number;
}

export function acquisitionCost(a: AcquisitionInput): AcquisitionResult {
  if (!(a.price > 0)) throw new RangeError('price must be > 0');
  const lines: Record<string, number> = {
    purchaseTax: a.purchaseTaxAmount ?? roundCents(a.price * (a.purchaseTaxRate ?? 0)),
    notaryFees: a.notaryFees ?? 0,
    registrationFees: a.registrationFees ?? 0,
    agencyFee: a.agencyFeeAmount ?? roundCents(a.price * (a.agencyFeeRate ?? 0)),
    renovation: a.renovation ?? 0,
    furnishing: a.furnishing ?? 0,
    utilitiesConnection: a.utilitiesConnection ?? 0,
    other: a.other ?? 0,
  };
  return { price: a.price, lines, total: a.price + sum(Object.values(lines)) };
}

/**
 * Operating cost structure for one year.
 * - `rates`: costs proportional to revenue. vacancy and capexReserve apply to gross revenue; management and
 *   every entry of `extraRates` apply to effective (collected) revenue.
 * - `fixed`: annual amounts in cents, grow with expense inflation in projections.
 */
export interface OperatingInput {
  vacancyRate?: number;
  managementRate?: number;
  capexReserveRate?: number;
  extraRates?: Record<string, number>;
  insurance?: number;
  holdingTax?: number;
  maintenance?: number;
  utilities?: number;
  other?: number;
  extraFixed?: Record<string, number>;
}

export interface OperatingStatement {
  /** Gross (potential) revenue. */
  gri: number;
  vacancyLoss: number;
  /** Effective revenue = gri - vacancyLoss. */
  egi: number;
  expenses: Record<string, number>;
  totalExpenses: number;
  noi: number;
}

/** Operating statement for revenue `gri` (cents) with fixed costs scaled by `fixedFactor` (expense inflation). */
export function operatingStatement(gri: number, op: OperatingInput, fixedFactor = 1): OperatingStatement {
  const vacancyLoss = roundCents(gri * (op.vacancyRate ?? 0));
  const egi = gri - vacancyLoss;
  const expenses: Record<string, number> = {
    management: roundCents(egi * (op.managementRate ?? 0)),
    capexReserve: roundCents(gri * (op.capexReserveRate ?? 0)),
    insurance: roundCents((op.insurance ?? 0) * fixedFactor),
    holdingTax: roundCents((op.holdingTax ?? 0) * fixedFactor),
    maintenance: roundCents((op.maintenance ?? 0) * fixedFactor),
    utilities: roundCents((op.utilities ?? 0) * fixedFactor),
    other: roundCents((op.other ?? 0) * fixedFactor),
  };
  for (const [k, r] of Object.entries(op.extraRates ?? {})) expenses[k] = (expenses[k] ?? 0) + roundCents(egi * r);
  for (const [k, v] of Object.entries(op.extraFixed ?? {})) expenses[k] = (expenses[k] ?? 0) + roundCents(v * fixedFactor);
  const totalExpenses = sum(Object.values(expenses));
  return { gri, vacancyLoss, egi, expenses, totalExpenses, noi: egi - totalExpenses };
}

export interface YearOneInput {
  acquisition: AcquisitionInput;
  gri: number;
  operating: OperatingInput;
  loan?: LoanInput;
  /** Flat tax on collected rent (e.g. Italian cedolare secca). Applied to EGI; not part of NOI. */
  incomeTaxRate?: number;
}

export interface YearOneResult {
  acquisition: AcquisitionResult;
  statement: OperatingStatement;
  /** GRI / price */
  grossYield: number | null;
  /** NOI / total acquisition cost */
  netYield: number | null;
  /** NOI / price */
  capRate: number | null;
  debtService: number;
  /** NOI - debt service (before income tax) */
  cashFlow: number;
  /** Own money invested = total acquisition cost - loan principal */
  equity: number;
  /** cashFlow / equity */
  cashOnCash: number | null;
  /** Tax on rent (incomeTaxRate × EGI), 0 when no rate given. */
  incomeTax: number;
  cashFlowAfterTax: number;
  /** (NOI - income tax) / total acquisition cost */
  netYieldAfterTax: number | null;
}

export function yearOne(input: YearOneInput): YearOneResult {
  const acquisition = acquisitionCost(input.acquisition);
  const statement = operatingStatement(input.gri, input.operating);
  const debtService = input.loan ? annualDebtService(input.loan, 1) : 0;
  const equity = acquisition.total - (input.loan?.principal ?? 0);
  const cashFlow = statement.noi - debtService;
  const incomeTax = roundCents(Math.max(0, statement.egi) * (input.incomeTaxRate ?? 0));
  return {
    incomeTax,
    cashFlowAfterTax: cashFlow - incomeTax,
    netYieldAfterTax: safeRatio(statement.noi - incomeTax, acquisition.total),
    acquisition,
    statement,
    grossYield: safeRatio(input.gri, acquisition.price),
    netYield: safeRatio(statement.noi, acquisition.total),
    capRate: safeRatio(statement.noi, acquisition.price),
    debtService,
    cashFlow,
    equity,
    cashOnCash: safeRatio(cashFlow, equity),
  };
}
