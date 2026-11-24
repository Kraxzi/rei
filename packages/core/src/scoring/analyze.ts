import type { Assumption } from '../financial/models.js';
import { areaRental, residentialLongTerm, unitRental } from '../financial/models.js';
import { yearOne, type YearOneResult } from '../financial/statement.js';
import { computeScore, type ScoreResult } from './score.js';
import { rentFromComps, valueFromComps, type Comparable, type RentEstimate, type Valuation } from './valuation.js';

/**
 * Automatic first-pass analysis of a listed property. Purchase costs and running costs are generic DEFAULT
 * assumptions (country tax rules are not verified yet) and are listed as such; the user refines them in the calculator.
 */
export const AUTO_ASSUMPTIONS = {
  acquisitionCostRate: 0.1, // taxes + notary + agency, rough
  vacancyRate: 0.05,
  maintenanceRateOfPrice: 0.01,
  insuranceRateOfPrice: 0.0015,
  unitOccupancy: 0.9,
} as const;

export interface AnalyzeInput {
  category: string;
  price: number;
  areaM2: number | null;
  condition: string | null;
  isAuction: boolean;
  completeness: number;
  dataAgeDays: number;
  daysOnMarket: number | null;
  /** Unit-based categories (parking, storage) compare per unit, not per m². */
  perUnit: boolean;
  saleComps: Comparable[];
  rentComps: Comparable[];
}

export interface AnalyzeResult {
  valuation: Valuation | null;
  rent: RentEstimate | null;
  finance: YearOneResult | null;
  netYield: number | null;
  score: ScoreResult;
  assumptions: Assumption[];
}

export function analyzeProperty(i: AnalyzeInput): AnalyzeResult {
  const valuation = valueFromComps({ price: i.price, areaM2: i.areaM2 }, i.saleComps, i.perUnit);
  const rent = ['residential', 'commercial', 'industrial', 'parking', 'specialized'].includes(i.category)
    ? rentFromComps({ areaM2: i.areaM2 }, i.rentComps, i.perUnit)
    : null;

  const assumptions: Assumption[] = [];
  let finance: YearOneResult | null = null;
  if (rent) {
    const model = i.perUnit
      ? unitRental({ units: 1, monthlyRatePerUnit: rent.monthly, occupancy: AUTO_ASSUMPTIONS.unitOccupancy, source: `медиана ${rent.n} объявлений об аренде` })
      : i.category === 'residential'
        ? residentialLongTerm({ monthlyRent: rent.monthly, source: `медиана ${rent.n} объявлений об аренде` })
        : areaRental({ lettableAreaM2: i.areaM2 ?? 0, rentPerM2Month: Math.round(rent.monthly / (i.areaM2 || 1)), source: `медиана ${rent.n} объявлений об аренде` });
    finance = yearOne({
      acquisition: { price: i.price, other: Math.round(i.price * AUTO_ASSUMPTIONS.acquisitionCostRate) },
      gri: model.gri,
      operating: {
        vacancyRate: i.perUnit ? 0 : AUTO_ASSUMPTIONS.vacancyRate,
        maintenance: Math.round(i.price * AUTO_ASSUMPTIONS.maintenanceRateOfPrice),
        insurance: Math.round(i.price * AUTO_ASSUMPTIONS.insuranceRateOfPrice),
      },
    });
    assumptions.push(
      ...model.assumptions,
      { key: 'acquisitionCostRate', value: AUTO_ASSUMPTIONS.acquisitionCostRate, unit: 'fraction', source: 'default: налоги, нотариус и агентство условно, ставки страны не проверены' },
      { key: 'vacancyRate', value: i.perUnit ? 0 : AUTO_ASSUMPTIONS.vacancyRate, unit: 'fraction', source: 'default' },
      { key: 'maintenanceRateOfPrice', value: AUTO_ASSUMPTIONS.maintenanceRateOfPrice, unit: 'fraction', source: 'default' },
      { key: 'insuranceRateOfPrice', value: AUTO_ASSUMPTIONS.insuranceRateOfPrice, unit: 'fraction', source: 'default' },
    );
  }
  const netYield = finance?.netYield ?? null;

  const score = computeScore({
    category: i.category,
    undervaluation: valuation ? { value: valuation.undervaluation, confidence: valuation.confidence } : null,
    netYield: netYield !== null && rent ? { value: netYield, confidence: rent.confidence * 0.8 } : null,
    growth: null,
    location: null,
    liquidity: { comps: i.saleComps.length, daysOnMarket: i.daysOnMarket },
    condition: i.condition,
    isAuction: i.isAuction,
    completeness: i.completeness,
    dataAgeDays: i.dataAgeDays,
  });

  return { valuation, rent, finance, netYield, score, assumptions };
}
