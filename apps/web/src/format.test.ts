import { describe, expect, it } from 'vitest';
import { centsToEuros, eurosToCents, money, parseNumber, percent, percentToRate, rateToPercent } from './format';

describe('format', () => {
  it('parses Russian/Italian and dot decimals, spaces as thousand separators', () => {
    expect(parseNumber('1 250,50')).toBe(1250.5);
    expect(parseNumber('1250.5')).toBe(1250.5);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('12abc')).toBeNaN();
  });

  it('converts euros to cents and percent to rate without float drift', () => {
    expect(eurosToCents('0,29')).toBe(29);
    expect(eurosToCents('28 000')).toBe(2_800_000);
    expect(percentToRate('7,5')).toBeCloseTo(0.075, 12);
    expect(centsToEuros(2_800_050)).toBe('28000,5');
    expect(rateToPercent(0.075)).toBe('7,5');
  });

  it('formats', () => {
    expect(money(2_800_000).replace(/\s/g, ' ')).toBe('28 000 €');
    expect(money(null)).toBe('—');
    expect(percent(0.0448)).toBe('4,48 %');
  });
});
