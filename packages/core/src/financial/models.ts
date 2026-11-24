import { roundCents, safeRatio, sum } from './math.js';
import type { OperatingInput } from './statement.js';

/**
 * Category-specific revenue models. Each turns category inputs into gross revenue (GRI, cents/year),
 * revenue-proportional cost rates, model metrics and the list of assumptions it relied on.
 * Generic costs (insurance, taxes, maintenance…) are supplied separately by the caller.
 */

export interface Assumption {
  key: string;
  value: number | string;
  unit?: string;
  /** Where the number came from: 'user', 'listing', 'omi', 'default', a URL… */
  source: string;
}

export interface ModelOutput {
  gri: number;
  /** Cost structure the model contributes (merged with the caller's generic operating input). */
  operating: OperatingInput;
  metrics: Record<string, number | null>;
  assumptions: Assumption[];
}

const pct = (x: number) => Math.round(x * 10000) / 100;

function requireRate(name: string, v: number) {
  if (!(v >= 0 && v <= 1)) throw new RangeError(`${name} must be within [0, 1]`);
}
function requireNonNeg(name: string, v: number) {
  if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`${name} must be >= 0`);
}

// ---------- residential ----------

export interface ResidentialLongTermInput {
  monthlyRent: number;
  source?: string;
}

export function residentialLongTerm(i: ResidentialLongTermInput): ModelOutput {
  requireNonNeg('monthlyRent', i.monthlyRent);
  return {
    gri: i.monthlyRent * 12,
    operating: {},
    metrics: {},
    assumptions: [{ key: 'monthlyRent', value: i.monthlyRent, unit: 'cents/month', source: i.source ?? 'user' }],
  };
}

export interface ResidentialShortTermInput {
  /** Average daily rate, cents. */
  adr: number;
  /** Fraction of available nights sold. */
  occupancy: number;
  availableNights?: number;
  avgStayNights: number;
  cleaningPerStay: number;
  /** Booking platform commission as fraction of revenue. */
  platformFeeRate: number;
  source?: string;
}

export function residentialShortTerm(i: ResidentialShortTermInput): ModelOutput {
  requireNonNeg('adr', i.adr);
  requireRate('occupancy', i.occupancy);
  requireRate('platformFeeRate', i.platformFeeRate);
  if (!(i.avgStayNights > 0)) throw new RangeError('avgStayNights must be > 0');
  const nights = i.availableNights ?? 365;
  const soldNights = nights * i.occupancy;
  const gri = roundCents(i.adr * soldNights);
  const stays = soldNights / i.avgStayNights;
  const src = i.source ?? 'user';
  return {
    gri,
    // occupancy already captures vacancy; cleaning is per stay, i.e. proportional to sold nights
    operating: {
      vacancyRate: 0,
      extraRates: { platformFees: i.platformFeeRate },
      extraFixed: { cleaning: roundCents(stays * i.cleaningPerStay) },
    },
    metrics: { soldNights, stays, revPerAvailableNight: roundCents(i.adr * i.occupancy) },
    assumptions: [
      { key: 'adr', value: i.adr, unit: 'cents/night', source: src },
      { key: 'occupancy', value: pct(i.occupancy), unit: '%', source: src },
      { key: 'availableNights', value: nights, unit: 'nights/year', source: i.availableNights ? src : 'default' },
      { key: 'avgStayNights', value: i.avgStayNights, unit: 'nights', source: src },
      { key: 'cleaningPerStay', value: i.cleaningPerStay, unit: 'cents', source: src },
      { key: 'platformFeeRate', value: pct(i.platformFeeRate), unit: '%', source: src },
    ],
  };
}

// ---------- parking / storage (units × rate × occupancy) ----------

export interface UnitRentalInput {
  units: number;
  monthlyRatePerUnit: number;
  occupancy: number;
  source?: string;
}

export function unitRental(i: UnitRentalInput): ModelOutput {
  requireNonNeg('units', i.units);
  requireNonNeg('monthlyRatePerUnit', i.monthlyRatePerUnit);
  requireRate('occupancy', i.occupancy);
  const src = i.source ?? 'user';
  return {
    gri: roundCents(i.units * i.monthlyRatePerUnit * 12 * i.occupancy),
    operating: { vacancyRate: 0 },
    metrics: { occupiedUnits: i.units * i.occupancy },
    assumptions: [
      { key: 'units', value: i.units, source: src },
      { key: 'monthlyRatePerUnit', value: i.monthlyRatePerUnit, unit: 'cents/month', source: src },
      { key: 'occupancy', value: pct(i.occupancy), unit: '%', source: src },
    ],
  };
}

// ---------- commercial (rent roll) ----------

export interface Lease {
  tenant: string;
  annualRent: number;
  /** ISO date (YYYY-MM-DD) of lease expiry or first break option. */
  leaseEnd: string;
  areaM2?: number;
}

const DAY_MS = 86_400_000;

/** Weighted average unexpired lease term in years, weighted by rent. Expired leases count as 0. */
export function wault(leases: readonly Lease[], asOf: string): number | null {
  const t0 = Date.parse(asOf);
  if (Number.isNaN(t0)) throw new RangeError('invalid asOf date');
  const total = sum(leases.map((l) => l.annualRent));
  if (!(total > 0)) return null;
  let w = 0;
  for (const l of leases) {
    const end = Date.parse(l.leaseEnd);
    if (Number.isNaN(end)) throw new RangeError(`invalid leaseEnd for ${l.tenant}`);
    w += l.annualRent * Math.max(0, (end - t0) / DAY_MS / 365.25);
  }
  return w / total;
}

export interface CommercialLeaseInput {
  rentRoll: Lease[];
  asOf: string;
  totalAreaM2?: number;
  source?: string;
}

export function commercialLease(i: CommercialLeaseInput): ModelOutput {
  const gri = sum(i.rentRoll.map((l) => l.annualRent));
  const leasedArea = sum(i.rentRoll.map((l) => l.areaM2 ?? 0));
  return {
    gri,
    operating: {},
    metrics: {
      tenants: i.rentRoll.length,
      waultYears: wault(i.rentRoll, i.asOf),
      areaOccupancy: i.totalAreaM2 ? safeRatio(leasedArea, i.totalAreaM2) : null,
    },
    assumptions: [
      { key: 'rentRoll', value: `${i.rentRoll.length} lease(s)`, source: i.source ?? 'user' },
      { key: 'asOf', value: i.asOf, source: 'user' },
    ],
  };
}

// ---------- hospitality ----------

export interface HospitalityInput {
  rooms: number;
  adr: number;
  occupancy: number;
  /** Ancillary revenue (breakfast, F&B…) as fraction of room revenue. */
  otherRevenueRate?: number;
  /** OTA commission as fraction of revenue. */
  platformCommissionRate: number;
  cleaningPerOccupiedRoom: number;
  staffCostAnnual: number;
  licensesAnnual?: number;
  source?: string;
}

export function hospitality(i: HospitalityInput): ModelOutput {
  requireNonNeg('rooms', i.rooms);
  requireNonNeg('adr', i.adr);
  requireRate('occupancy', i.occupancy);
  requireRate('platformCommissionRate', i.platformCommissionRate);
  const roomNights = i.rooms * 365 * i.occupancy;
  const roomRevenue = i.adr * roomNights;
  const gri = roundCents(roomRevenue * (1 + (i.otherRevenueRate ?? 0)));
  const src = i.source ?? 'user';
  return {
    gri,
    operating: {
      vacancyRate: 0,
      extraRates: { platformFees: i.platformCommissionRate },
      extraFixed: {
        cleaning: roundCents(roomNights * i.cleaningPerOccupiedRoom),
        staff: i.staffCostAnnual,
        licenses: i.licensesAnnual ?? 0,
      },
    },
    metrics: { roomNights, revPar: roundCents(i.adr * i.occupancy), adr: i.adr, occupancy: i.occupancy },
    assumptions: [
      { key: 'rooms', value: i.rooms, source: src },
      { key: 'adr', value: i.adr, unit: 'cents/night', source: src },
      { key: 'occupancy', value: pct(i.occupancy), unit: '%', source: src },
      { key: 'otherRevenueRate', value: pct(i.otherRevenueRate ?? 0), unit: '%', source: i.otherRevenueRate ? src : 'default' },
      { key: 'platformCommissionRate', value: pct(i.platformCommissionRate), unit: '%', source: src },
      { key: 'staffCostAnnual', value: i.staffCostAnnual, unit: 'cents/year', source: src },
    ],
  };
}

// ---------- area based (industrial, offices without rent roll) ----------

export interface AreaRentalInput {
  lettableAreaM2: number;
  rentPerM2Month: number;
  source?: string;
}

export function areaRental(i: AreaRentalInput): ModelOutput {
  requireNonNeg('lettableAreaM2', i.lettableAreaM2);
  requireNonNeg('rentPerM2Month', i.rentPerM2Month);
  const src = i.source ?? 'user';
  return {
    gri: roundCents(i.lettableAreaM2 * i.rentPerM2Month * 12),
    operating: {},
    metrics: {},
    assumptions: [
      { key: 'lettableAreaM2', value: i.lettableAreaM2, unit: 'm2', source: src },
      { key: 'rentPerM2Month', value: i.rentPerM2Month, unit: 'cents/m2/month', source: src },
    ],
  };
}

// ---------- land ----------

export interface LandInput {
  /** Contracted lease income (e.g. agricultural lease, solar lease, parking lot lease), cents/year. */
  leaseIncomeAnnual?: number;
  /** Own agricultural net income, cents/year. Only with evidence — development potential is never monetised here. */
  agriculturalIncomeAnnual?: number;
  source?: string;
}

export function land(i: LandInput): ModelOutput {
  const src = i.source ?? 'user';
  return {
    gri: (i.leaseIncomeAnnual ?? 0) + (i.agriculturalIncomeAnnual ?? 0),
    operating: { vacancyRate: 0 },
    metrics: {},
    assumptions: [
      { key: 'leaseIncomeAnnual', value: i.leaseIncomeAnnual ?? 0, unit: 'cents/year', source: src },
      { key: 'agriculturalIncomeAnnual', value: i.agriculturalIncomeAnnual ?? 0, unit: 'cents/year', source: src },
    ],
  };
}

// ---------- registry ----------

export const FINANCIAL_MODELS = {
  residential_long_term: residentialLongTerm,
  residential_short_term: residentialShortTerm,
  unit_rental: unitRental,
  commercial_lease: commercialLease,
  hospitality,
  area_rental: areaRental,
  land,
} as const;

export type FinancialModelCode = keyof typeof FINANCIAL_MODELS;

export function isFinancialModelCode(x: string): x is FinancialModelCode {
  return Object.hasOwn(FINANCIAL_MODELS, x);
}

/** Merge model-supplied operating structure over the caller's generic costs. Model rates win for vacancy. */
export function mergeOperating(generic: OperatingInput, model: OperatingInput): OperatingInput {
  return {
    ...generic,
    ...Object.fromEntries(Object.entries(model).filter(([k]) => k !== 'extraRates' && k !== 'extraFixed')),
    extraRates: { ...(generic.extraRates ?? {}), ...(model.extraRates ?? {}) },
    extraFixed: { ...(generic.extraFixed ?? {}), ...(model.extraFixed ?? {}) },
  };
}
