import {
  FINANCIAL_MODELS,
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

export const ENGINE_VERSION = 'fin-1.0.0';

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
});

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
    const run = runScenarios(
      { acquisition: req.acquisition, gri: out.gri, operating: mergeOperating(req.operating, out.operating), loan: req.loan },
      { ...growthDefaults, ...req.growth },
      out.assumptions,
      { horizons: req.horizons },
    );
    return c.json({ engineVersion: ENGINE_VERSION, model, modelMetrics: out.metrics, ...run });
  } catch (e) {
    if (e instanceof RangeError || e instanceof TypeError) throw new HTTPException(422, { message: e.message });
    throw e;
  }
});
