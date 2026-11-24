/**
 * Investment Score 0–100 (spec XIII). Weights are per category profile and can be overridden.
 * Missing components are excluded from the score and lower the confidence — never filled with guesses.
 */

export type ComponentKey = 'undervaluation' | 'growth' | 'yield' | 'location' | 'liquidity' | 'condition' | 'legal';
export type Weights = Record<ComponentKey, number>;

export const DEFAULT_WEIGHTS: Weights = { undervaluation: 0.2, growth: 0.2, yield: 0.2, location: 0.15, liquidity: 0.1, condition: 0.1, legal: 0.05 };

export const SCORING_PROFILES: Record<string, Weights> = {
  residential: DEFAULT_WEIGHTS,
  commercial: { undervaluation: 0.15, growth: 0.1, yield: 0.3, location: 0.15, liquidity: 0.1, condition: 0.1, legal: 0.1 },
  industrial: { undervaluation: 0.15, growth: 0.1, yield: 0.3, location: 0.15, liquidity: 0.1, condition: 0.1, legal: 0.1 },
  parking: { undervaluation: 0.2, growth: 0.1, yield: 0.3, location: 0.15, liquidity: 0.1, condition: 0.05, legal: 0.1 },
  land: { undervaluation: 0.25, growth: 0.3, yield: 0.1, location: 0.15, liquidity: 0.05, condition: 0, legal: 0.15 },
  hospitality: { undervaluation: 0.15, growth: 0.1, yield: 0.3, location: 0.2, liquidity: 0.05, condition: 0.1, legal: 0.1 },
  specialized: { undervaluation: 0.2, growth: 0.1, yield: 0.3, location: 0.1, liquidity: 0.1, condition: 0.05, legal: 0.15 },
};

/** Baseline legal-risk score by category (higher = fewer typical legal issues). Unverified -> confidence 0.4. */
const LEGAL_BASELINE: Record<string, number> = { residential: 75, commercial: 70, industrial: 60, parking: 65, land: 50, hospitality: 55, specialized: 50 };

export interface ScoreInput {
  category: string;
  undervaluation: { value: number; confidence: number } | null;
  netYield: { value: number; confidence: number } | null;
  growth: { value: number; confidence: number; basis?: string } | null;
  location: { value: number; confidence: number; basis?: string } | null;
  liquidity: { comps: number; daysOnMarket: number | null } | null;
  condition: string | null;
  isAuction?: boolean;
  /** Share of key listing fields present, 0..1. */
  completeness: number;
  /** Age of the newest data in days. */
  dataAgeDays: number;
}

export interface ScoreComponent {
  value: number | null; // 0..100
  weight: number;
  confidence: number;
  basis: string;
}

export interface ScoreResult {
  score: number | null;
  confidence: number;
  label: 'высокая' | 'средняя' | 'низкая';
  components: Record<ComponentKey, ScoreComponent>;
  reasons: string[];
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const CONDITION: Record<string, number> = { new: 90, renovated: 85, good: 70, to_renovate: 45, ruin: 20 };
const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')} %`;

export function computeScore(i: ScoreInput, override?: Partial<Weights>): ScoreResult {
  const w: Weights = { ...(SCORING_PROFILES[i.category] ?? DEFAULT_WEIGHTS), ...override };
  const reasons: string[] = [];
  const c = {} as Record<ComponentKey, ScoreComponent>;

  c.undervaluation = i.undervaluation
    ? { value: clamp(50 + i.undervaluation.value * 250), weight: w.undervaluation, confidence: i.undervaluation.confidence, basis: `цена ${i.undervaluation.value >= 0 ? 'ниже' : 'выше'} медианы похожих предложений на ${pct(Math.abs(i.undervaluation.value))}` }
    : { value: null, weight: w.undervaluation, confidence: 0, basis: 'мало похожих объявлений для сравнения' };
  c.yield = i.netYield
    ? { value: clamp((i.netYield.value / 0.08) * 100), weight: w.yield, confidence: i.netYield.confidence, basis: `оценка чистой доходности ${pct(i.netYield.value)}` }
    : { value: null, weight: w.yield, confidence: 0, basis: 'нет данных об аренде для этого типа и места' };
  c.growth = i.growth
    ? { value: clamp(50 + i.growth.value * 500), weight: w.growth, confidence: i.growth.confidence, basis: `цены на жильё по стране: ${i.growth.value >= 0 ? '+' : ''}${pct(i.growth.value)} в год${i.growth.basis ? ` (${i.growth.basis})` : ''}, не по району` }
    : { value: null, weight: w.growth, confidence: 0, basis: 'нет истории цен по району' };
  c.location = i.location
    ? { value: clamp(i.location.value), weight: w.location, confidence: i.location.confidence, basis: i.location.basis ?? 'инфраструктура рядом' }
    : { value: null, weight: w.location, confidence: 0, basis: 'анализ локации ещё не выполнен' };
  c.liquidity = i.liquidity
    ? {
        value: clamp(30 + Math.min(i.liquidity.comps, 15) * 3 + (i.liquidity.daysOnMarket === null ? 0 : i.liquidity.daysOnMarket < 60 ? 10 : i.liquidity.daysOnMarket > 365 ? -20 : 0)),
        weight: w.liquidity,
        confidence: i.liquidity.comps >= 5 ? 0.6 : 0.3,
        basis: `${i.liquidity.comps} похожих предложений рядом${i.liquidity.daysOnMarket !== null ? `, в продаже ${Math.round(i.liquidity.daysOnMarket)} дн.` : ''}`,
      }
    : { value: null, weight: w.liquidity, confidence: 0, basis: 'нет данных о рынке' };
  c.condition = i.condition && CONDITION[i.condition] !== undefined
    ? { value: CONDITION[i.condition]!, weight: w.condition, confidence: 0.6, basis: `состояние по объявлению: ${i.condition}` }
    : { value: null, weight: w.condition, confidence: 0, basis: 'состояние не указано' };
  const legalBase = LEGAL_BASELINE[i.category] ?? 50;
  c.legal = { value: i.isAuction ? Math.min(legalBase, 45) : legalBase, weight: w.legal, confidence: 0.4, basis: i.isAuction ? 'аукцион: особые юридические риски, нужна проверка документов' : 'типовые риски категории, документы не проверены' };

  const keys = Object.keys(c) as ComponentKey[];
  const available = keys.filter((k) => c[k].value !== null && c[k].weight > 0);
  const wAvail = available.reduce((s, k) => s + c[k].weight, 0);
  const wTotal = keys.reduce((s, k) => s + c[k].weight, 0);

  if (!available.some((k) => k === 'undervaluation' || k === 'yield')) {
    reasons.push('Нет ни оценки рыночной цены, ни доходности — рейтинг не рассчитан.');
    return { score: null, confidence: 0, label: 'низкая', components: c, reasons };
  }

  const score = Math.round(available.reduce((s, k) => s + c[k].value! * c[k].weight, 0) / wAvail);
  const coverage = wAvail / wTotal;
  const compConf = available.reduce((s, k) => s + c[k].confidence * c[k].weight, 0) / wAvail;
  const recency = i.dataAgeDays <= 14 ? 1 : i.dataAgeDays <= 60 ? 0.8 : 0.6;
  const confidence = Math.round(coverage * compConf * (0.5 + 0.5 * i.completeness) * recency * 100) / 100;

  for (const k of keys) if (c[k].value === null && c[k].weight > 0) reasons.push(`Не учтено: ${c[k].basis}.`);
  if (i.completeness < 0.8) reasons.push('В объявлении не хватает части данных (цена, площадь, тип или город).');
  if (recency < 1) reasons.push('Данные старше двух недель.');
  const label = confidence >= 0.5 ? 'высокая' : confidence >= 0.25 ? 'средняя' : 'низкая';
  return { score, confidence, label, components: c, reasons };
}
