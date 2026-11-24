import { describe, expect, it } from 'vitest';
import { defaultCadastralCategory, itCadastralValue, itImu, itPurchaseTaxes, itRentalTaxRate } from '../src/index.js';

const EUR = (x: number) => Math.round(x * 100);

describe('Italy purchase taxes (Agenzia Entrate rules)', () => {
  it('second home from a private seller with known cadastral value: 9 % + 50 + 50', () => {
    const r = itPurchaseTaxes({ price: EUR(200_000), category: 'residential', buyer: 'individual', firstHome: false, seller: 'private', cadastralValue: EUR(80_000) });
    expect(r.lines.map((l) => [l.key, l.amount])).toEqual([['registro', EUR(7_200)], ['ipotecaria', EUR(50)], ['catastale', EUR(50)]]);
    expect(r.total).toBe(EUR(7_300));
    expect(r.estimated).toBe(false);
  });

  it('first home: 2 % with the 1 000 € minimum', () => {
    const r = itPurchaseTaxes({ price: EUR(60_000), category: 'residential', buyer: 'individual', firstHome: true, seller: 'private', cadastralValue: EUR(25_000) });
    expect(r.lines[0]!.amount).toBe(EUR(1_000)); // 2 % × 25 000 = 500 → minimum 1 000 (notariato example)
  });

  it('unknown cadastral value: price used as upper bound and flagged', () => {
    const r = itPurchaseTaxes({ price: EUR(28_000), category: 'parking', buyer: 'individual', firstHome: false, seller: 'private' });
    expect(r.lines[0]!.amount).toBe(EUR(2_520));
    expect(r.estimated).toBe(true);
    expect(r.warnings[0]).toContain('кадастровой');
  });

  it('new build from a VAT company: IVA 10 % (4 % first home) + 3 × 200', () => {
    const r = itPurchaseTaxes({ price: EUR(300_000), category: 'residential', buyer: 'individual', firstHome: false, seller: 'vat_company' });
    expect(r.total).toBe(EUR(30_000 + 600));
    expect(itPurchaseTaxes({ price: EUR(300_000), category: 'residential', buyer: 'individual', firstHome: true, seller: 'vat_company' }).total).toBe(EUR(12_000 + 600));
  });

  it('commercial: registro on price (no prezzo-valore); VAT seller -> manual with warning', () => {
    const r = itPurchaseTaxes({ price: EUR(100_000), category: 'commercial', buyer: 'individual', firstHome: true, seller: 'private', cadastralValue: EUR(10_000) });
    expect(r.lines[0]!.amount).toBe(EUR(9_000)); // first-home benefit does not apply to a shop
    expect(itPurchaseTaxes({ price: EUR(100_000), category: 'commercial', buyer: 'individual', firstHome: false, seller: 'vat_company' }).warnings.join(' ')).toContain('вручную');
  });
});

describe('IMU and cadastral value', () => {
  it('rendita 300 € on a home at max rate (example from L. 160/2019 method)', () => {
    // 300 × 1.05 × 160 = 50 400 base; × 1.06 % = 534.24 €
    expect(itImu(EUR(300), 'A/2')).toBe(EUR(534.24));
    expect(itImu(EUR(300), 'A/2', 0.0086)).toBe(EUR(433.44));
    expect(itImu(EUR(300), 'A/2', 0.0106, true)).toBe(0); // main residence exempt
    expect(itImu(EUR(100), 'C/1')).toBe(EUR(100 * 1.05 * 55 * 0.0106));
  });

  it('Agenzia Entrate example: rendita 900 € — registro 10 206 € (second home) / 2 079 € (first home)', () => {
    const second = itPurchaseTaxes({ price: EUR(200_000), category: 'residential', buyer: 'individual', firstHome: false, seller: 'private', cadastralValue: itCadastralValue(EUR(900), false) });
    expect(second.lines[0]!.amount).toBe(EUR(10_206));
    const first = itPurchaseTaxes({ price: EUR(200_000), category: 'residential', buyer: 'individual', firstHome: true, seller: 'private', cadastralValue: itCadastralValue(EUR(900), true) });
    expect(first.lines[0]!.amount).toBe(EUR(2_079));
  });

  it('prezzo-valore coefficients', () => {
    expect(itCadastralValue(EUR(500), false)).toBe(EUR(63_000));
    expect(itCadastralValue(EUR(500), true)).toBe(EUR(57_750));
  });

  it('default cadastral categories', () => {
    expect(defaultCadastralCategory('parking', 'garage')).toBe('C/6');
    expect(defaultCadastralCategory('commercial', 'shop')).toBe('C/1');
    expect(defaultCadastralCategory('residential', 'apartment')).toBe('A');
  });
});

describe('rental income tax', () => {
  it('cedolare secca 2026', () => {
    expect(itRentalTaxRate('long_ordinary').rate).toBe(0.21);
    expect(itRentalTaxRate('long_concordato').rate).toBe(0.1);
    expect(itRentalTaxRate('short_second').rate).toBe(0.26);
    expect(itRentalTaxRate('irpef').rate).toBeNull();
  });
});
