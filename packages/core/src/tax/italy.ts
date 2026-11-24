import { roundCents } from '../financial/math.js';

/**
 * Italian purchase, holding and rental-income taxes. Only rules confirmed from official or primary sources
 * are applied; anything else becomes a warning and stays the user's input.
 * Verified 24.11.2026 — sources listed in IT_TAX_SOURCES.
 */
export const IT_TAX_VERIFIED_AT = '2026-11-24';
export const IT_TAX_SOURCES = [
  { title: "Agenzia delle Entrate — L'acquisto della casa: le imposte e le agevolazioni fiscali (guida, marzo 2024)", url: 'https://www.agenziaentrate.gov.it/portale/documents/20143/3949367/Guida_acquisto__Casa_imposte_e_agevolazioni.pdf' },
  { title: 'Consiglio Nazionale del Notariato — guida agevolazioni prima casa 2025 (tabelle imposte)', url: 'https://lavoripubblici.it/documenti2025/lvpb1/guida-notariato-agevolazioni-prima-casa-2025.pdf' },
  { title: 'Legge 160/2019, art. 1 cc. 745–755 (IMU): base imponibile, moltiplicatori, aliquote', url: 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2019-12-27;160' },
  { title: 'Cedolare secca 2026: 21 %, 10 % (canone concordato), locazioni brevi 21 %/26 % (Legge di Bilancio 2026)', url: 'https://www.agenziaentrate.gov.it/portale/cedolare-secca' },
];

export type Seller = 'private' | 'vat_company';

export interface ItPurchaseContext {
  price: number; // cents
  /** Category of the taxonomy (residential, parking, commercial, land …). */
  category: string;
  buyer: 'individual' | 'company';
  /** Main residence benefits ("prima casa"); residential only. */
  firstHome: boolean;
  seller: Seller;
  /** Cadastral value (rendita × 1.05 × coefficient) if known — taxable base under "prezzo-valore". */
  cadastralValue?: number | null;
}

export interface TaxLine { key: string; label: string; amount: number; basis: string }
export interface TaxResult { lines: TaxLine[]; total: number; warnings: string[]; estimated: boolean }

const EUR = (e: number) => e * 100;

/** Imposta di registro / ipotecaria / catastale or IVA on a purchase. */
export function itPurchaseTaxes(c: ItPurchaseContext): TaxResult {
  const lines: TaxLine[] = [];
  const warnings: string[] = [];
  let estimated = false;
  const residential = c.category === 'residential' || c.category === 'parking'; // garages are usually "pertinenze"
  const firstHome = c.firstHome && c.category === 'residential';

  if (c.seller === 'private') {
    // prezzo-valore: individuals buying homes (and pertinences) pay registro on the cadastral value
    const prezzoValore = c.buyer === 'individual' && residential;
    let base = c.price;
    if (prezzoValore) {
      if (c.cadastralValue && c.cadastralValue > 0) base = c.cadastralValue;
      else {
        estimated = true;
        warnings.push('Налог посчитан от цены — это оценка сверху. Для частного лица налог берётся с кадастровой стоимости (обычно заметно ниже); введите её из визуры, чтобы получить точную сумму.');
      }
    }
    if (c.category === 'land') warnings.push('Для сельскохозяйственной земли ставка регистра может отличаться (не проверено) — уточните у нотариуса.');
    const rate = firstHome ? 0.02 : 0.09;
    const registro = Math.max(roundCents(base * rate), EUR(1000));
    lines.push(
      { key: 'registro', label: `Imposta di registro ${firstHome ? '2 %' : '9 %'}`, amount: registro, basis: `${prezzoValore && c.cadastralValue ? 'от кадастровой стоимости' : 'от цены'}, минимум 1 000 €` },
      { key: 'ipotecaria', label: 'Imposta ipotecaria', amount: EUR(50), basis: 'фиксированная' },
      { key: 'catastale', label: 'Imposta catastale', amount: EUR(50), basis: 'фиксированная' },
    );
  } else {
    if (c.category === 'residential') {
      const rate = firstHome ? 0.04 : 0.1;
      lines.push({ key: 'iva', label: `IVA ${firstHome ? '4 %' : '10 %'}`, amount: roundCents(c.price * rate), basis: 'от цены (продавец — застройщик)' });
      warnings.push('Для жилья категорий «люкс» (A/1, A/8, A/9) НДС выше — проверьте категорию.');
    } else {
      warnings.push('Покупка нежилого объекта у компании с НДС: ставки НДС и регистрационных налогов зависят от случая — введите налог вручную.');
    }
    lines.push(
      { key: 'registro', label: 'Imposta di registro', amount: EUR(200), basis: 'фиксированная при продаже с НДС' },
      { key: 'ipotecaria', label: 'Imposta ipotecaria', amount: EUR(200), basis: 'фиксированная при продаже с НДС' },
      { key: 'catastale', label: 'Imposta catastale', amount: EUR(200), basis: 'фиксированная при продаже с НДС' },
    );
  }
  if (c.buyer === 'company') warnings.push('Покупка на компанию: возможны другие налоговые последствия — уточните у коммерчиалиста.');
  return { lines, total: lines.reduce((s, l) => s + l.amount, 0), warnings, estimated };
}

/** IMU multipliers by cadastral group (L. 160/2019 c. 745). */
export const IMU_MULTIPLIER: Record<string, number> = {
  A: 160, 'A/10': 80, B: 140, 'C/1': 55, 'C/2': 160, 'C/3': 140, 'C/4': 140, 'C/5': 140, 'C/6': 160, 'C/7': 160, D: 65, 'D/5': 80,
};
export const IMU_RATE_BASE = 0.0086;
export const IMU_RATE_MAX = 0.0106;

/** Default cadastral category for a taxonomy category (user can override). */
export function defaultCadastralCategory(category: string, typeCode: string): string {
  if (['garage', 'parking_space', 'motorcycle_space', 'underground_parking', 'garage_complex'].includes(typeCode)) return 'C/6';
  if (['storeroom', 'basement', 'storage_box'].includes(typeCode)) return 'C/2';
  if (typeCode === 'office') return 'A/10';
  if (category === 'commercial') return 'C/1';
  if (category === 'industrial' || category === 'hospitality') return 'D';
  return 'A';
}

/** Annual IMU from the cadastral rent: rendita × 1.05 × multiplier × municipal rate. Main residence: 0 (non-luxury). */
export function itImu(rendita: number, cadastralCategory: string, rate = IMU_RATE_MAX, mainResidence = false): number {
  if (mainResidence && !['A/1', 'A/8', 'A/9'].includes(cadastralCategory)) return 0;
  const mult = IMU_MULTIPLIER[cadastralCategory] ?? IMU_MULTIPLIER[cadastralCategory.split('/')[0]!] ?? 160;
  return roundCents(rendita * 1.05 * mult * rate);
}

/** Cadastral value for prezzo-valore (registro base): rendita × 1.05 × coefficient (110 for main residence, 120 otherwise). */
export function itCadastralValue(rendita: number, firstHome: boolean): number {
  return roundCents(rendita * 1.05 * (firstHome ? 110 : 120));
}

export type RentalRegime = 'long_ordinary' | 'long_concordato' | 'short_first' | 'short_second' | 'irpef';

/** Cedolare secca rates (2026). 'irpef' = ordinary personal income tax — depends on the owner, not computed. */
export const IT_CEDOLARE: Record<Exclude<RentalRegime, 'irpef'>, number> = {
  long_ordinary: 0.21,
  long_concordato: 0.1,
  short_first: 0.21,
  short_second: 0.26,
};

export function itRentalTaxRate(regime: RentalRegime): { rate: number | null; note: string } {
  if (regime === 'irpef') return { rate: null, note: 'Обычный IRPEF зависит от всех доходов владельца — посчитайте с коммерчиалистом.' };
  const notes: Record<string, string> = {
    long_ordinary: 'Cedolare secca 21 % от арендной платы (вместо IRPEF).',
    long_concordato: 'Cedolare secca 10 % — только для договоров «canone concordato» в определённых коммунах.',
    short_first: 'Посуточная аренда: 21 % для первого объекта.',
    short_second: 'Посуточная аренда: 26 % для второго объекта; с третьего нужна partita IVA.',
  };
  return { rate: IT_CEDOLARE[regime], note: notes[regime]! };
}
