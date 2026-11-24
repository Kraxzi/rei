import type { Assumption } from '../financial/models.js';
import { areaRental, residentialLongTerm, unitRental } from '../financial/models.js';
import { yearOne, type YearOneResult } from '../financial/statement.js';
import { computeScore, type ScoreResult } from './score.js';
import { itPurchaseTaxes, itRentalTaxRate, type RentalRegime } from '../tax/italy.js';
import { locationScore, type PoiCounts } from './context.js';
import { rentFromComps, valueFromComps, type Comparable, type RentEstimate, type Valuation } from './valuation.js';

/**
 * Automatic first-pass analysis of a listed property. Purchase costs and running costs are generic DEFAULT
 * assumptions (country tax rules are not verified yet) and are listed as such; the user refines them in the calculator.
 */
export const AUTO_ASSUMPTIONS = {
  acquisitionCostRate: 0.1, // taxes + notary + agency, rough — countries without verified tax rules
  vacancyRate: 0.05,
  maintenanceRateOfPrice: 0.01,
  insuranceRateOfPrice: 0.0015,
  unitOccupancy: 0.9,
  // Italy: market-practice assumptions (not law): agency 3 % + 22 % VAT, notary, IMU without known cadastral rent
  itAgencyRate: 0.0366,
  itNotaryEuro: 2000,
  itImuRateOfPrice: 0.004,
} as const;

/** How the owner buys and rents — decides Italian taxes. Defaults: individual, second home, private seller, cedolare 21 %. */
export interface TaxProfile {
  buyer: 'individual' | 'company';
  firstHome: boolean;
  rentalRegime: RentalRegime;
}
export const DEFAULT_TAX_PROFILE: TaxProfile = { buyer: 'individual', firstHome: false, rentalRegime: 'long_ordinary' };

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
  country?: string;
  taxProfile?: TaxProfile;
  location?: { pois: PoiCounts; exact: boolean } | null;
  growth?: { value: number; basis: string } | null;
}

export interface AnalyzeResult {
  valuation: Valuation | null;
  rent: RentEstimate | null;
  finance: YearOneResult | null;
  netYield: number | null;
  netYieldAfterTax: number | null;
  taxWarnings: string[];
  score: ScoreResult;
  assumptions: Assumption[];
}

export function analyzeProperty(i: AnalyzeInput): AnalyzeResult {
  const valuation = valueFromComps({ price: i.price, areaM2: i.areaM2 }, i.saleComps, i.perUnit);
  const rent = ['residential', 'commercial', 'industrial', 'parking', 'specialized'].includes(i.category)
    ? rentFromComps({ areaM2: i.areaM2 }, i.rentComps, i.perUnit)
    : null;

  const assumptions: Assumption[] = [];
  const taxWarnings: string[] = [];
  let finance: YearOneResult | null = null;
  if (rent) {
    const model = i.perUnit
      ? unitRental({ units: 1, monthlyRatePerUnit: rent.monthly, occupancy: AUTO_ASSUMPTIONS.unitOccupancy, source: `медиана ${rent.n} объявлений об аренде` })
      : i.category === 'residential'
        ? residentialLongTerm({ monthlyRent: rent.monthly, source: `медиана ${rent.n} объявлений об аренде` })
        : areaRental({ lettableAreaM2: i.areaM2 ?? 0, rentPerM2Month: Math.round(rent.monthly / (i.areaM2 || 1)), source: `медиана ${rent.n} объявлений об аренде` });
    const isIT = i.country === 'IT';
    const profile = i.taxProfile ?? DEFAULT_TAX_PROFILE;
    let acquisition;
    let holdingTax = 0;
    let incomeTaxRate: number | undefined;
    if (isIT) {
      const t = itPurchaseTaxes({ price: i.price, category: i.category, buyer: profile.buyer, firstHome: profile.firstHome, seller: 'private' });
      taxWarnings.push(...t.warnings);
      acquisition = {
        price: i.price,
        purchaseTaxAmount: t.total,
        agencyFeeRate: AUTO_ASSUMPTIONS.itAgencyRate,
        notaryFees: AUTO_ASSUMPTIONS.itNotaryEuro * 100,
      };
      holdingTax = Math.round(i.price * AUTO_ASSUMPTIONS.itImuRateOfPrice);
      const rt = ['residential', 'parking', 'specialized'].includes(i.category) ? itRentalTaxRate(profile.rentalRegime) : itRentalTaxRate('irpef');
      if (rt.rate !== null) incomeTaxRate = rt.rate;
      else taxWarnings.push(rt.note);
      assumptions.push(
        { key: 'purchaseTax', value: t.total, unit: 'cents', source: `налоги Италии (Agenzia Entrate)${t.estimated ? ', от цены — оценка сверху' : ''}` },
        { key: 'agencyFeeRate', value: AUTO_ASSUMPTIONS.itAgencyRate, unit: 'fraction', source: 'default: комиссия агентства 3 % + НДС 22 % (практика рынка)' },
        { key: 'notaryFees', value: AUTO_ASSUMPTIONS.itNotaryEuro * 100, unit: 'cents', source: 'default: нотариус, условно' },
        { key: 'imu', value: holdingTax, unit: 'cents', source: 'default: IMU ≈ 0,4 % цены — кадастровая рента неизвестна' },
        ...(incomeTaxRate !== undefined ? [{ key: 'incomeTaxRate', value: incomeTaxRate, unit: 'fraction', source: rt.note }] : []),
      );
    } else {
      acquisition = { price: i.price, other: Math.round(i.price * AUTO_ASSUMPTIONS.acquisitionCostRate) };
      assumptions.push({ key: 'acquisitionCostRate', value: AUTO_ASSUMPTIONS.acquisitionCostRate, unit: 'fraction', source: 'default: налоги, нотариус и агентство условно, ставки страны не проверены' });
    }
    finance = yearOne({
      acquisition,
      gri: model.gri,
      operating: {
        vacancyRate: i.perUnit ? 0 : AUTO_ASSUMPTIONS.vacancyRate,
        maintenance: Math.round(i.price * AUTO_ASSUMPTIONS.maintenanceRateOfPrice),
        insurance: Math.round(i.price * AUTO_ASSUMPTIONS.insuranceRateOfPrice),
        holdingTax,
      },
      incomeTaxRate,
    });
    assumptions.push(
      ...model.assumptions,
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
    growth: i.growth ? { value: i.growth.value, confidence: 0.25, basis: `Eurostat ${i.growth.basis}` } : null,
    location: i.location
      ? (() => { const l = locationScore(i.location.pois, i.category); return { value: l.value, confidence: i.location.exact ? 0.6 : 0.35, basis: `${l.details}${i.location.exact ? '' : ' (по центру города)'}` }; })()
      : null,
    liquidity: { comps: i.saleComps.length, daysOnMarket: i.daysOnMarket },
    condition: i.condition,
    isAuction: i.isAuction,
    completeness: i.completeness,
    dataAgeDays: i.dataAgeDays,
  });

  return { valuation, rent, finance, netYield, netYieldAfterTax: finance?.netYieldAfterTax ?? null, taxWarnings, score, assumptions };
}
