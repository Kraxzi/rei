import { describe, expect, it } from 'vitest';
import {
  acquisitionCost,
  annuityPayment,
  annualDebtService,
  areaRental,
  commercialLease,
  convert,
  hospitality,
  irr,
  land,
  mergeOperating,
  npv,
  operatingStatement,
  paybackYears,
  project,
  remainingBalance,
  residentialLongTerm,
  residentialShortTerm,
  runScenarios,
  unitRental,
  wault,
  yearOne,
} from '../src/index.js';

const EUR = (x: number) => Math.round(x * 100); // euros -> cents

describe('math: IRR / NPV / payback (reference values)', () => {
  it('trivial IRR', () => {
    expect(irr([-100, 110])).toBeCloseTo(0.1, 10);
    expect(irr([-100, 0, 121])).toBeCloseTo(0.1, 10);
  });

  it('matches Excel IRR documentation example (8.66%)', () => {
    expect(irr([-70000, 12000, 15000, 18000, 21000, 26000])).toBeCloseTo(0.086630948, 8);
  });

  it('matches Excel NPV documentation example (1188.44)', () => {
    // Excel NPV discounts the first value too -> shift by one period
    expect(npv(0.1, [0, -10000, 3000, 4200, 6800])).toBeCloseTo(1188.44, 2);
  });

  it('IRR undefined without sign change', () => {
    expect(irr([100, 100])).toBeNull();
    expect(irr([-100, -5])).toBeNull();
  });

  it('IRR for negative returns (bisection path)', () => {
    expect(irr([-100, 50])).toBeCloseTo(-0.5, 8);
  });

  it('payback with interpolation', () => {
    expect(paybackYears([-1000, 400, 400, 400])).toBeCloseTo(2.5, 10);
    expect(paybackYears([-1000, 100, 100])).toBeNull();
  });
});

describe('loan', () => {
  it('annuity: 200,000 at 6% for 30y monthly = 1,199.10', () => {
    expect(annuityPayment({ principal: EUR(200_000), annualRate: 0.06, years: 30 })).toBe(EUR(1199.10));
  });

  it('balance after 5 years = 186,108.71 (standard amortisation table)', () => {
    expect(remainingBalance({ principal: EUR(200_000), annualRate: 0.06, years: 30 }, 5)).toBeCloseTo(EUR(186_108.71), -1);
  });

  it('zero-rate loan is linear', () => {
    const loan = { principal: EUR(50_000), annualRate: 0, years: 10 };
    expect(remainingBalance(loan, 5)).toBe(EUR(25_000));
    expect(remainingBalance(loan, 10)).toBe(0);
    expect(annualDebtService(loan, 11)).toBe(0);
  });
});

describe('acquisition & operating statement', () => {
  const acquisition = {
    price: EUR(200_000),
    purchaseTaxRate: 0.09,
    notaryFees: EUR(2_500),
    agencyFeeRate: 0.03,
    renovation: EUR(10_000),
  };
  const operating = {
    vacancyRate: 0.05,
    managementRate: 0.08,
    capexReserveRate: 0.02,
    insurance: EUR(300),
    holdingTax: EUR(800),
    maintenance: EUR(500),
  };

  it('total acquisition cost', () => {
    const a = acquisitionCost(acquisition);
    expect(a.lines.purchaseTax).toBe(EUR(18_000));
    expect(a.lines.agencyFee).toBe(EUR(6_000));
    expect(a.total).toBe(EUR(236_500));
  });

  it('explicit tax amount overrides rate (tax on cadastral value)', () => {
    expect(acquisitionCost({ price: EUR(100_000), purchaseTaxRate: 0.09, purchaseTaxAmount: EUR(2_000) }).total).toBe(EUR(102_000));
  });

  it('rejects non-positive price', () => {
    expect(() => acquisitionCost({ price: 0 })).toThrow();
  });

  it('NOI', () => {
    const s = operatingStatement(EUR(12_000), operating);
    expect(s.vacancyLoss).toBe(EUR(600));
    expect(s.egi).toBe(EUR(11_400));
    expect(s.expenses.management).toBe(EUR(912));
    expect(s.expenses.capexReserve).toBe(EUR(240));
    expect(s.totalExpenses).toBe(EUR(2_752));
    expect(s.noi).toBe(EUR(8_648));
  });

  it('yields and cash-on-cash', () => {
    const r = yearOne({ acquisition, gri: EUR(12_000), operating });
    expect(r.grossYield).toBeCloseTo(0.06, 10);
    expect(r.netYield).toBeCloseTo(8_648 / 236_500, 10);
    expect(r.capRate).toBeCloseTo(8_648 / 200_000, 10);
    expect(r.equity).toBe(EUR(236_500));
    expect(r.cashOnCash).toBeCloseTo(8_648 / 236_500, 10);
  });

  it('cash-on-cash with leverage', () => {
    const r = yearOne({
      acquisition: { price: EUR(100_000) },
      gri: EUR(10_000),
      operating: {},
      loan: { principal: EUR(50_000), annualRate: 0, years: 10 },
    });
    // monthly 416.67 -> 5,000.04/year
    expect(r.debtService).toBe(500_004);
    expect(r.cashFlow).toBe(EUR(10_000) - 500_004);
    expect(r.cashOnCash).toBeCloseTo((EUR(10_000) - 500_004) / EUR(50_000), 10);
  });
});

describe('tax on rent (cedolare secca)', () => {
  it('reduces after-tax cash flow and yield, not NOI', () => {
    const r = yearOne({ acquisition: { price: EUR(100_000) }, gri: EUR(10_000), operating: { vacancyRate: 0.1 }, incomeTaxRate: 0.21 });
    expect(r.statement.noi).toBe(EUR(9_000));
    expect(r.incomeTax).toBe(EUR(1_890)); // 21 % of collected rent 9 000
    expect(r.cashFlowAfterTax).toBe(EUR(7_110));
    expect(r.netYieldAfterTax).toBeCloseTo(0.0711, 10);
    const p = project({ acquisition: { price: EUR(100_000) }, gri: EUR(10_000), operating: {}, incomeTaxRate: 0.21 }, { revenueGrowth: 0, expenseGrowth: 0, appreciation: 0, saleCostRate: 0, discountRate: 0.1 }, 1);
    expect(p.years[0]!.cashFlow).toBe(EUR(7_900));
  });
});

describe('projection', () => {
  const simple = { acquisition: { price: EUR(100_000) }, gri: EUR(10_000), operating: {} };
  const flat = { revenueGrowth: 0, expenseGrowth: 0, appreciation: 0, saleCostRate: 0, discountRate: 0.1 };

  it('10% income, flat value -> IRR 10%, NPV@10% = 0', () => {
    const p = project(simple, flat, 5);
    expect(p.equityCashflows).toEqual([-EUR(100_000), EUR(10_000), EUR(10_000), EUR(10_000), EUR(10_000), EUR(110_000)]);
    expect(p.irr).toBeCloseTo(0.1, 9);
    expect(Math.abs(p.npv)).toBeLessThanOrEqual(1);
    expect(p.paybackYears).toBeNull();
    expect(p.totalReturn).toBeCloseTo(0.5, 10);
  });

  it('appreciation and selling costs', () => {
    const p = project(simple, { ...flat, appreciation: 0.03, saleCostRate: 0.04 }, 3);
    expect(p.saleValue).toBe(Math.round(EUR(100_000) * 1.03 ** 3));
    expect(p.saleCosts).toBe(Math.round(p.saleValue * 0.04));
    expect(p.netSaleProceeds).toBe(p.saleValue - p.saleCosts);
  });

  it('revenue growth compounds from year 2', () => {
    const p = project(simple, { ...flat, revenueGrowth: 0.02 }, 3);
    expect(p.years.map((y) => y.gri)).toEqual([EUR(10_000), EUR(10_200), EUR(10_404)]);
  });

  it('loan balance repaid at sale', () => {
    const p = project({ ...simple, loan: { principal: EUR(50_000), annualRate: 0, years: 10 } }, flat, 5);
    expect(p.loanBalanceAtSale).toBe(EUR(25_000));
    expect(p.equityCashflows[0]).toBe(-EUR(50_000));
  });

  it('payback within horizon', () => {
    const p = project({ ...simple, gri: EUR(40_000) }, flat, 5);
    expect(p.paybackYears).toBeCloseTo(2.5, 10);
  });
});

describe('category models', () => {
  it('long-term residential', () => {
    expect(residentialLongTerm({ monthlyRent: EUR(800) }).gri).toBe(EUR(9_600));
  });

  it('short-term rental: occupancy, cleaning per stay, platform fees', () => {
    const m = residentialShortTerm({ adr: EUR(100), occupancy: 0.6, avgStayNights: 3, cleaningPerStay: EUR(40), platformFeeRate: 0.15 });
    expect(m.gri).toBe(EUR(21_900));
    expect(m.metrics.stays).toBeCloseTo(73, 10);
    const s = operatingStatement(m.gri, m.operating);
    expect(s.expenses.cleaning).toBe(EUR(2_920));
    expect(s.expenses.platformFees).toBe(EUR(3_285));
    expect(s.vacancyLoss).toBe(0);
  });

  it('parking spaces', () => {
    expect(unitRental({ units: 10, monthlyRatePerUnit: EUR(100), occupancy: 0.9 }).gri).toBe(EUR(10_800));
  });

  it('WAULT weighted by rent', () => {
    const leases = [
      { tenant: 'A', annualRent: EUR(60_000), leaseEnd: '2031-01-01' },
      { tenant: 'B', annualRent: EUR(40_000), leaseEnd: '2028-01-01' },
    ];
    expect(wault(leases, '2026-01-01')).toBeCloseTo(3.8, 2);
    expect(wault([{ tenant: 'X', annualRent: EUR(1), leaseEnd: '2020-01-01' }], '2026-01-01')).toBe(0);
    const m = commercialLease({ rentRoll: leases, asOf: '2026-01-01' });
    expect(m.gri).toBe(EUR(100_000));
  });

  it('hotel: RevPAR and revenue', () => {
    const m = hospitality({
      rooms: 10, adr: EUR(120), occupancy: 0.7, otherRevenueRate: 0.1,
      platformCommissionRate: 0.18, cleaningPerOccupiedRoom: EUR(15), staffCostAnnual: EUR(60_000),
    });
    expect(m.metrics.roomNights).toBeCloseTo(2555, 10);
    expect(m.metrics.revPar).toBe(EUR(84));
    expect(m.gri).toBe(EUR(337_260));
    expect(operatingStatement(m.gri, m.operating).expenses.cleaning).toBe(EUR(38_325));
  });

  it('warehouse by area', () => {
    expect(areaRental({ lettableAreaM2: 500, rentPerM2Month: EUR(5) }).gri).toBe(EUR(30_000));
  });

  it('land: only contracted / evidenced income', () => {
    expect(land({ leaseIncomeAnnual: EUR(3_000) }).gri).toBe(EUR(3_000));
    expect(land({}).gri).toBe(0);
  });

  it('input validation', () => {
    expect(() => unitRental({ units: 1, monthlyRatePerUnit: 1, occupancy: 1.5 })).toThrow();
    expect(() => residentialShortTerm({ adr: 1, occupancy: 0.5, avgStayNights: 0, cleaningPerStay: 0, platformFeeRate: 0 })).toThrow();
  });

  it('mergeOperating: model vacancy wins, extras merged', () => {
    const op = mergeOperating({ vacancyRate: 0.05, insurance: 1, extraFixed: { a: 1 } }, { vacancyRate: 0, extraFixed: { b: 2 } });
    expect(op).toMatchObject({ vacancyRate: 0, insurance: 1, extraFixed: { a: 1, b: 2 } });
  });
});

describe('scenarios', () => {
  const input = { acquisition: { price: EUR(100_000) }, gri: EUR(10_000), operating: { vacancyRate: 0.05, insurance: EUR(200) } };
  const growth = { revenueGrowth: 0.02, expenseGrowth: 0.02, appreciation: 0.01, saleCostRate: 0.03, discountRate: 0.06 };

  it('three scenarios × three horizons, ordered by outcome', () => {
    const run = runScenarios(input, growth);
    expect(run.scenarios.map((s) => s.scenario)).toEqual(['pessimistic', 'base', 'optimistic']);
    for (const s of run.scenarios) expect(s.horizons.map((h) => h.horizonYears)).toEqual([1, 3, 5]);
    const noi = run.scenarios.map((s) => s.yearOne.statement.noi);
    expect(noi[0]!).toBeLessThan(noi[1]!);
    expect(noi[1]!).toBeLessThan(noi[2]!);
    const irr5 = run.scenarios.map((s) => s.horizons[2]!.irr!);
    expect(irr5[0]!).toBeLessThan(irr5[1]!);
    expect(irr5[1]!).toBeLessThan(irr5[2]!);
  });

  it('base scenario equals the unadjusted calculation', () => {
    const run = runScenarios(input, growth);
    expect(run.scenarios[1]!.yearOne).toEqual(yearOne(input));
    expect(run.scenarios[1]!.horizons[2]).toEqual(project(input, growth, 5));
  });

  it('lists assumptions and disclaimer', () => {
    const run = runScenarios(input, growth, [{ key: 'monthlyRent', value: 1, source: 'omi' }]);
    expect(run.assumptions.map((a) => a.key)).toContain('monthlyRent');
    expect(run.assumptions.map((a) => a.key)).toContain('discountRate');
    expect(run.disclaimer).toMatch(/не является гарантией/);
  });
});

describe('fx', () => {
  it('converts via EUR cross rates', () => {
    const rates = { USD: 1.08, CHF: 0.95 };
    expect(convert(EUR(100), 'EUR', 'USD', rates)).toBe(EUR(108));
    expect(convert(EUR(108), 'USD', 'EUR', rates)).toBe(EUR(100));
    expect(convert(EUR(108), 'USD', 'CHF', rates)).toBe(EUR(95));
    expect(() => convert(1, 'EUR', 'XXX', rates)).toThrow();
  });
});
