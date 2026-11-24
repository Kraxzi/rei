/** UI <-> API conversions. API money is integer cents, rates are fractions. */

const eur = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(cents: number | null | undefined, precise = false): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  return (precise ? eur2 : eur).format(cents / 100);
}

export function percent(rate: number | null | undefined, digits = 2): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

export function years(y: number | null | undefined): string {
  if (y === null || y === undefined) return 'не окупается за срок';
  return `${y.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} г.`;
}

/** Parses user input like "1 250,50" or "1250.5" into a number; empty -> null; garbage -> NaN. */
export function parseNumber(s: string): number | null {
  const t = s.replace(/\s| /g, '').replace(',', '.');
  if (t === '') return null;
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : Number.NaN;
}

export const eurosToCents = (s: string): number | null => {
  const n = parseNumber(s);
  return n === null || Number.isNaN(n) ? n : Math.round(n * 100);
};
export const percentToRate = (s: string): number | null => {
  const n = parseNumber(s);
  return n === null || Number.isNaN(n) ? n : n / 100;
};
export const centsToEuros = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100).replace('.', ','));
export const rateToPercent = (r: number | null | undefined) =>
  r === null || r === undefined ? '' : String(Math.round(r * 10000) / 100).replace('.', ',');
