import {
  defaultCadastralCategory,
  FINANCIAL_MODELS,
  IT_TAX_SOURCES,
  IT_TAX_VERIFIED_AT,
  itCadastralValue,
  itImu,
  itPurchaseTaxes,
  itRentalTaxRate,
  IMU_RATE_MAX,
  TYPES,
  type RentalRegime,
  isFinancialModelCode,
  mergeOperating,
  runScenarios,
  type FinancialModelCode,
  type ModelOutput,
} from '@rei/core';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from '../env.js';

export const ENGINE_VERSION = 'fin-1.1.0';

const cents = z.number().int().nonnegative();
const rate = z.number().min(0).max(1);

const calcSchema = z.object({
  model: z.string().refine(isFinancialModelCode, 'unknown financial model'),
  /** Category-specific inputs; validated by the model itself. */
  modelInput: z.record(z.string(), z.unknown()),
  acquisition: z.object({
    price: z.number().int().positive(),
    purchaseTaxRate: rate.optional(),
    purchaseTaxAmount: cents.optional(),
    notaryFees: cents.optional(),
    registrationFees: cents.optional(),
    agencyFeeRate: rate.optional(),
    agencyFeeAmount: cents.optional(),
    renovation: cents.optional(),
    furnishing: cents.optional(),
    utilitiesConnection: cents.optional(),
    other: cents.optional(),
  }),
  operating: z
    .object({
      vacancyRate: rate.optional(),
      managementRate: rate.optional(),
      capexReserveRate: rate.optional(),
      insurance: cents.optional(),
      holdingTax: cents.optional(),
      maintenance: cents.optional(),
      utilities: cents.optional(),
      other: cents.optional(),
    })
    .default({}),
  loan: z.object({ principal: cents, annualRate: z.number().min(0).max(0.5), years: z.number().int().min(1).max(50) }).optional(),
  growth: z
    .object({
      revenueGrowth: z.number().min(-0.5).max(0.5).default(0.02),
      expenseGrowth: z.number().min(-0.5).max(0.5).default(0.02),
      appreciation: z.number().min(-0.5).max(0.5).default(0.01),
      saleCostRate: rate.default(0.04),
      discountRate: z.number().min(0).max(1).default(0.06),
      currentValue: z.number().int().positive().optional(),
    })
    .default({ revenueGrowth: 0.02, expenseGrowth: 0.02, appreciation: 0.01, saleCostRate: 0.04, discountRate: 0.06 }),
  horizons: z.array(z.number().int().min(1).max(30)).min(1).max(5).default([1, 3, 5]),
  /** Tax on rental income as a fraction of collected rent (overrides the regime below). */
  incomeTaxRate: rate.optional(),
  /** Country tax rules. Only Italy is automated; explicit acquisition/operating amounts always win. */
  tax: z
    .object({
      country: z.literal('IT'),
      typeCode: z.string(),
      buyer: z.enum(['individual', 'company']).default('individual'),
      firstHome: z.boolean().default(false),
      seller: z.enum(['private', 'vat_company']).default('private'),
      /** Rendita catastale, cents per year. */
      rendita: cents.optional(),
      cadastralCategory: z.string().max(5).optional(),
      imuRate: z.number().min(0).max(0.02).optional(),
      rentalRegime: z.enum(['long_ordinary', 'long_concordato', 'short_first', 'short_second', 'irpef']).default('long_ordinary'),
    })
    .optional(),
});

type CalcRequest = z.infer<typeof calcSchema>;

/** Fills purchase tax, IMU and rental tax from Italian rules where the user didn't enter them. */
export function applyItalianTax(req: CalcRequest) {
  const t = req.tax;
  if (!t) return { acquisition: req.acquisition, operating: req.operating, incomeTaxRate: req.incomeTaxRate, tax: null };
  const type = TYPES.find((x) => x.code === t.typeCode);
  if (!type) throw new RangeError(`unknown property type ${t.typeCode}`);
  const residential = type.category === 'residential';
  const firstHome = t.firstHome && residential;
  const purchase = itPurchaseTaxes({
    price: req.acquisition.price, category: type.category, buyer: t.buyer, firstHome, seller: t.seller,
    cadastralValue: t.rendita ? itCadastralValue(t.rendita, firstHome) : null,
  });
  const userPurchase = req.acquisition.purchaseTaxAmount !== undefined || req.acquisition.purchaseTaxRate !== undefined;
  const cadastralCategory = t.cadastralCategory || defaultCadastralCategory(type.category, type.code);
  const imu = t.rendita ? itImu(t.rendita, cadastralCategory, t.imuRate ?? IMU_RATE_MAX, firstHome) : null;
  const rental = itRentalTaxRate(t.rentalRegime as RentalRegime);
  const warnings = [...purchase.warnings];
  if (!t.rendita) warnings.push('Без кадастровой ренты IMU не считается — внесите её в «Налог на владение» вручную или укажите ренту (есть в visura catastale).');
  if (rental.rate === null) warnings.push(rental.note);
  return {
    acquisition: userPurchase ? req.acquisition : { ...req.acquisition, purchaseTaxAmount: purchase.total },
    operating: req.operating.holdingTax === undefined && imu !== null ? { ...req.operating, holdingTax: imu } : req.operating,
    incomeTaxRate: req.incomeTaxRate ?? rental.rate ?? undefined,
    tax: {
      purchase: { ...purchase, applied: !userPurchase },
      imu: imu === null ? null : { amount: imu, cadastralCategory, rate: t.imuRate ?? IMU_RATE_MAX, applied: req.operating.holdingTax === undefined, mainResidence: firstHome },
      rental: { regime: t.rentalRegime, rate: rental.rate, note: rental.note, applied: req.incomeTaxRate === undefined },
      warnings,
      sources: IT_TAX_SOURCES,
      verifiedAt: IT_TAX_VERIFIED_AT,
    },
  };
}

export const calc = new Hono<AppEnv>();

/**
 * Deterministic investment calculation for any property type (manual input).
 * The same core functions are used by the automatic pipeline — no duplicated formulas.
 */
calc.post('/', async (c) => {
  const parsed = calcSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'validation', issues: parsed.error.issues }, 422);
  const req = parsed.data;
  const model = req.model as FinancialModelCode;

  let out: ModelOutput;
  try {
    out = (FINANCIAL_MODELS[model] as (i: unknown) => ModelOutput)(req.modelInput);
    if (!Number.isFinite(out.gri)) throw new RangeError('model produced a non-numeric revenue — check modelInput');
    const growthDefaults = { revenueGrowth: 0.02, expenseGrowth: 0.02, appreciation: 0.01, saleCostRate: 0.04, discountRate: 0.06 };
    const taxed = applyItalianTax(req);
    const run = runScenarios(
      { acquisition: taxed.acquisition, gri: out.gri, operating: mergeOperating(taxed.operating, out.operating), loan: req.loan, incomeTaxRate: taxed.incomeTaxRate },
      { ...growthDefaults, ...req.growth },
      out.assumptions,
      { horizons: req.horizons },
    );
    return c.json({ engineVersion: ENGINE_VERSION, model, modelMetrics: out.metrics, tax: taxed.tax, ...run });
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) throw new HTTPException(422, { message: e.message });
    throw e;
  }
});
