import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api';
import { eurosToCents, money, parseNumber, percent, percentToRate, years } from '../format';
import { MODEL_FORMS, type ModelField } from '../models';
import { ErrorBox, Field, Page, useTaxonomy } from '../ui';

interface ProjectionResult { horizonYears: number; irr: number | null; npv: number; paybackYears: number | null; totalReturn: number | null; annualizedReturn: number | null; saleValue: number; netSaleProceeds: number }
interface YearOne {
  acquisition: { price: number; lines: Record<string, number>; total: number };
  statement: { gri: number; vacancyLoss: number; egi: number; expenses: Record<string, number>; totalExpenses: number; noi: number };
  grossYield: number | null; netYield: number | null; capRate: number | null; debtService: number; cashFlow: number; equity: number; cashOnCash: number | null;
}
interface CalcResult {
  engineVersion: string;
  modelMetrics: Record<string, number | null>;
  scenarios: Array<{ scenario: 'pessimistic' | 'base' | 'optimistic'; yearOne: YearOne; horizons: ProjectionResult[] }>;
  assumptions: Array<{ key: string; value: number | string; unit?: string; source: string }>;
  disclaimer: string;
}

const SCEN_LABEL = { pessimistic: 'Плохой', base: 'Базовый', optimistic: 'Хороший' } as const;
const LINE_LABEL: Record<string, string> = {
  purchaseTax: 'Налог на покупку', notaryFees: 'Нотариус', registrationFees: 'Регистрация', agencyFee: 'Агентство',
  renovation: 'Ремонт', furnishing: 'Мебель', utilitiesConnection: 'Подключение коммуникаций', other: 'Прочее',
  management: 'Управление', capexReserve: 'Резерв на крупный ремонт', insurance: 'Страховка', holdingTax: 'Налог на владение',
  maintenance: 'Обслуживание', utilities: 'Коммунальные', platformFees: 'Комиссии платформ', cleaning: 'Уборка', staff: 'Персонал', licenses: 'Лицензии',
};

type Values = Record<string, string>;

const ASSUMPTION_LABEL: Record<string, string> = {
  monthlyRent: 'Аренда в месяц', adr: 'Цена за ночь', occupancy: 'Загрузка', availableNights: 'Доступных ночей в году',
  avgStayNights: 'Средний срок проживания', cleaningPerStay: 'Уборка за заезд', platformFeeRate: 'Комиссия платформы',
  units: 'Мест', monthlyRatePerUnit: 'Аренда места в месяц', rentRoll: 'Договоры аренды', asOf: 'Дата расчёта',
  rooms: 'Номеров', otherRevenueRate: 'Доп. доход', platformCommissionRate: 'Комиссия платформ', staffCostAnnual: 'Персонал в год',
  lettableAreaM2: 'Площадь под аренду', rentPerM2Month: 'Ставка за м² в месяц', leaseIncomeAnnual: 'Аренда земли в год',
  agriculturalIncomeAnnual: 'Сельхоздоход в год', revenueGrowth: 'Рост аренды в год', expenseGrowth: 'Рост расходов в год',
  appreciation: 'Рост стоимости в год', saleCostRate: 'Расходы на продажу', discountRate: 'Ставка дисконтирования',
};

function formatAssumption(a: { value: number | string; unit?: string }): string {
  if (typeof a.value !== 'number') return a.value;
  if (a.unit?.startsWith('cents')) return money(a.value);
  if (a.unit?.startsWith('fraction')) return percent(a.value, 1);
  if (a.unit === '%') return `${a.value.toLocaleString('ru-RU')} %`;
  if (a.unit === 'm2') return `${a.value.toLocaleString('ru-RU')} м²`;
  if (a.unit === 'nights' || a.unit === 'nights/year') return `${a.value.toLocaleString('ru-RU')} ноч.`;
  return a.value.toLocaleString('ru-RU');
}

function convert(kind: ModelField['kind'], v: string): number | null {
  if (kind === 'money') return eurosToCents(v);
  if (kind === 'percent') return percentToRate(v);
  return parseNumber(v);
}

const ACQ: ModelField[] = [
  { key: 'price', label: 'Цена покупки', kind: 'money', required: true },
  { key: 'purchaseTaxRate', label: 'Налог на покупку', kind: 'percent', hint: 'Введите сами: ставки по странам ещё не проверены и не подставляются.' },
  { key: 'notaryFees', label: 'Нотариус', kind: 'money' },
  { key: 'agencyFeeRate', label: 'Комиссия агентства', kind: 'percent' },
  { key: 'renovation', label: 'Ремонт', kind: 'money' },
  { key: 'furnishing', label: 'Мебель', kind: 'money' },
];
const OPS: ModelField[] = [
  { key: 'vacancyRate', label: 'Простой (без арендатора)', kind: 'percent', hint: 'Доля года без дохода. Для посуточной аренды и мест уже учтена в загрузке.' },
  { key: 'managementRate', label: 'Управление', kind: 'percent', hint: 'от собранной аренды' },
  { key: 'capexReserveRate', label: 'Резерв на крупный ремонт', kind: 'percent', hint: 'от аренды' },
  { key: 'insurance', label: 'Страховка в год', kind: 'money' },
  { key: 'holdingTax', label: 'Налог на владение в год (IMU и т.п.)', kind: 'money' },
  { key: 'maintenance', label: 'Обслуживание и кондоминиум в год', kind: 'money' },
  { key: 'utilities', label: 'Коммунальные за счёт владельца в год', kind: 'money' },
];
const GROWTH: ModelField[] = [
  { key: 'revenueGrowth', label: 'Рост аренды в год', kind: 'percent' },
  { key: 'expenseGrowth', label: 'Рост расходов в год', kind: 'percent' },
  { key: 'appreciation', label: 'Рост стоимости объекта в год', kind: 'percent' },
  { key: 'saleCostRate', label: 'Расходы на продажу', kind: 'percent' },
  { key: 'discountRate', label: 'Ставка дисконтирования (для NPV)', kind: 'percent' },
];
const GROWTH_DEFAULTS: Values = { revenueGrowth: '2', expenseGrowth: '2', appreciation: '1', saleCostRate: '4', discountRate: '6' };

function Inputs({ fields, values, onChange }: { fields: ModelField[]; values: Values; onChange: (v: Values) => void }) {
  return (
    <>
      {fields.map((f) => {
        const v = values[f.key] ?? '';
        const n = convert(f.kind, v);
        return (
          <Field
            key={f.key}
            label={f.label}
            hint={f.hint}
            value={v}
            suffix={f.kind === 'money' ? '€' : f.kind === 'percent' ? '%' : undefined}
            inputMode={f.kind === 'int' ? 'numeric' : 'decimal'}
            bad={n !== null && Number.isNaN(n)}
            onChange={(x) => onChange({ ...values, [f.key]: x })}
          />
        );
      })}
    </>
  );
}

function collect(fields: ModelField[], values: Values): { out: Record<string, number>; missing: string[]; invalid: string[] } {
  const out: Record<string, number> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const f of fields) {
    const n = convert(f.kind, values[f.key] ?? '');
    if (n === null) { if (f.required) missing.push(f.label); continue; }
    if (Number.isNaN(n)) { invalid.push(f.label); continue; }
    out[f.key] = n;
  }
  return { out, missing, invalid };
}

interface Lease { tenant: string; rent: string; end: string }

export function Calculator() {
  const { data: tax } = useTaxonomy();
  const [typeCode, setTypeCode] = useState('');
  const [model, setModel] = useState('');
  const [mv, setMv] = useState<Values>({});
  const [leases, setLeases] = useState<Lease[]>([{ tenant: '', rent: '', end: '' }]);
  const [acq, setAcq] = useState<Values>({});
  const [ops, setOps] = useState<Values>({});
  const [loanOn, setLoanOn] = useState(false);
  const [loan, setLoan] = useState<Values>({ principal: '', annualRate: '', years: '20' });
  const [growth, setGrowth] = useState<Values>(GROWTH_DEFAULTS);
  const [result, setResult] = useState<CalcResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [horizon, setHorizon] = useState(2); // index into [1,3,5]

  // prefill from a property card: #/calc?type=garage&price=28000&rent=120
  useEffect(() => {
    if (!tax) return;
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const t = q.get('type');
    if (!t || typeCode) return;
    const found = tax.categories.flatMap((c) => c.types).find((x) => x.code === t);
    if (!found) return;
    setTypeCode(t);
    const m = found.financialModels[0] ?? '';
    setModel(m);
    if (q.get('price')) setAcq((a) => ({ ...a, price: q.get('price')!.replace('.', ',') }));
    const rent = q.get('rent');
    if (rent) {
      const key = m === 'unit_rental' ? 'monthlyRatePerUnit' : m === 'residential_long_term' ? 'monthlyRent' : null;
      if (key) setMv((v) => ({ ...v, [key]: rent.replace('.', ','), ...(m === 'unit_rental' ? { units: '1', occupancy: '90' } : {}) }));
    }
  }, [tax, typeCode]);

  const type = useMemo(() => tax?.categories.flatMap((c) => c.types).find((t) => t.code === typeCode), [tax, typeCode]);
  const form = MODEL_FORMS[model];

  function pickType(code: string) {
    setTypeCode(code);
    const t = tax?.categories.flatMap((c) => c.types).find((x) => x.code === code);
    setModel(t?.financialModels[0] ?? '');
    setResult(null);
  }

  async function run() {
    if (!form) return;
    setError(null);
    const m = collect(form.fields, mv);
    const a = collect(ACQ, acq);
    const o = collect(OPS, ops);
    const g = collect(GROWTH, growth);
    const l = loanOn ? collect([
      { key: 'principal', label: 'Сумма кредита', kind: 'money', required: true },
      { key: 'annualRate', label: 'Ставка кредита', kind: 'percent', required: true },
      { key: 'years', label: 'Срок кредита', kind: 'int', required: true },
    ], loan) : null;
    const missing = [...m.missing, ...a.missing, ...(l?.missing ?? [])];
    const invalid = [...m.invalid, ...a.invalid, ...o.invalid, ...g.invalid, ...(l?.invalid ?? [])];

    let modelInput: Record<string, unknown> = m.out;
    if (model === 'commercial_lease') {
      const rentRoll = leases
        .filter((x) => x.tenant || x.rent || x.end)
        .map((x) => ({ tenant: x.tenant || 'Арендатор', annualRent: eurosToCents(x.rent), leaseEnd: x.end }));
      if (rentRoll.length === 0) missing.push('хотя бы один договор аренды');
      if (rentRoll.some((r) => r.annualRent === null || Number.isNaN(r.annualRent) || !/^\d{4}-\d{2}-\d{2}$/.test(r.leaseEnd))) invalid.push('договоры: аренда в год и дата окончания');
      modelInput = { rentRoll, asOf: new Date().toISOString().slice(0, 10) };
    }
    if (missing.length) { setError(`Заполните: ${missing.join(', ')}.`); return; }
    if (invalid.length) { setError(`Не число: ${invalid.join(', ')}.`); return; }

    setBusy(true);
    try {
      const r = await api<CalcResult>('/calc', {
        method: 'POST',
        body: { model, modelInput, acquisition: a.out, operating: o.out, loan: l?.out, growth: g.out },
      });
      setResult(r);
      requestAnimationFrame(() => document.getElementById('result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (e) {
      setError(e instanceof ApiError ? `Расчёт не выполнен: ${e.message}` : (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Page title="Посчитать объект" lead="Все цифры считает программа по формулам — без догадок. Каждое предположение видно в результате.">
      <section className="group">
        <label className="field">
          <span>Тип объекта</span>
          <select className="input" value={typeCode} onChange={(e) => pickType(e.target.value)}>
            <option value="">Выберите…</option>
            {tax?.categories.map((c) => (
              <optgroup key={c.code} label={c.name.ru}>
                {c.types.map((t) => <option key={t.code} value={t.code}>{t.name.ru}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {type && type.financialModels.length > 1 && (
          <label className="field">
            <span>Как зарабатывать</span>
            <select className="input" value={model} onChange={(e) => { setModel(e.target.value); setResult(null); }}>
              {type.financialModels.map((m) => <option key={m} value={m}>{MODEL_FORMS[m]?.label ?? m}</option>)}
            </select>
          </label>
        )}
        {form && <p className="muted" style={{ marginTop: 0 }}>{form.explain}</p>}
      </section>

      {form && (
        <>
          <section className="group">
            <h3>Доход</h3>
            {model === 'commercial_lease' ? (
              <>
                {leases.map((l, i) => (
                  <div key={i} style={{ borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
                    <label className="field"><span>Арендатор</span><input className="input" value={l.tenant} onChange={(e) => setLeases(leases.map((x, j) => (j === i ? { ...x, tenant: e.target.value } : x)))} /></label>
                    <div className="row2">
                      <Field label="Аренда в год" suffix="€" value={l.rent} onChange={(v) => setLeases(leases.map((x, j) => (j === i ? { ...x, rent: v } : x)))} />
                      <Field label="Договор до" type="date" inputMode="text" value={l.end} onChange={(v) => setLeases(leases.map((x, j) => (j === i ? { ...x, end: v } : x)))} />
                    </div>
                  </div>
                ))}
                <p><button className="btn quiet small" type="button" onClick={() => setLeases([...leases, { tenant: '', rent: '', end: '' }])}>Добавить арендатора</button></p>
              </>
            ) : (
              <Inputs fields={form.fields} values={mv} onChange={setMv} />
            )}
          </section>

          <section className="group">
            <h3>Покупка</h3>
            <Inputs fields={ACQ} values={acq} onChange={setAcq} />
          </section>

          <details className="group">
            <summary>Расходы владения</summary>
            <Inputs fields={OPS} values={ops} onChange={setOps} />
          </details>

          <details className="group">
            <summary>Кредит</summary>
            <label className="toggle">Покупка в кредит<input type="checkbox" checked={loanOn} onChange={(e) => setLoanOn(e.target.checked)} /></label>
            {loanOn && (
              <Inputs
                fields={[
                  { key: 'principal', label: 'Сумма кредита', kind: 'money' },
                  { key: 'annualRate', label: 'Ставка в год', kind: 'percent' },
                  { key: 'years', label: 'Срок, лет', kind: 'int' },
                ]}
                values={loan}
                onChange={setLoan}
              />
            )}
          </details>

          <details className="group">
            <summary>Прогноз: рост и продажа</summary>
            <p className="muted" style={{ marginTop: 0 }}>Значения по умолчанию — осторожные допущения, а не данные рынка. Поменяйте, если знаете лучше.</p>
            <Inputs fields={GROWTH} values={growth} onChange={setGrowth} />
          </details>

          <ErrorBox error={error} />
          <button className="btn block" disabled={busy} onClick={run}>{busy ? 'Считаем…' : 'Посчитать'}</button>
        </>
      )}

      {result && <Result r={result} horizon={horizon} setHorizon={setHorizon} />}
    </Page>
  );
}

function Spread({ r, h }: { r: CalcResult; h: number }) {
  const irrs = r.scenarios.map((s) => s.horizons[h]?.irr ?? null);
  if (irrs.some((x) => x === null)) return null;
  const [lo, base, hi] = irrs as [number, number, number];
  const min = Math.min(0, lo) - 0.01;
  const max = Math.max(hi, 0.02) + 0.01;
  const pos = (x: number) => `${((x - min) / (max - min)) * 100}%`;
  return (
    <div className="spread" aria-label={`Годовая доходность (IRR) от ${percent(lo, 1)} до ${percent(hi, 1)}, базовая ${percent(base, 1)}`}>
      <div className="spread-track">
        <div className="spread-band" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})` }} />
        <div className="spread-mark" style={{ left: pos(base) }} />
      </div>
      <div className="spread-labels num">
        <span>плохо {percent(lo, 1)}</span>
        <span>хорошо {percent(hi, 1)}</span>
      </div>
    </div>
  );
}

function Result({ r, horizon, setHorizon }: { r: CalcResult; horizon: number; setHorizon: (i: number) => void }) {
  const base = r.scenarios.find((s) => s.scenario === 'base')!;
  const y1 = base.yearOne;
  const hz = base.horizons[horizon];
  type S = CalcResult['scenarios'][number];
  const all: Array<[string, (s: S) => string, (s: S) => boolean, boolean?]> = [
    ['Доход в 1\u2011й год', (s) => money(s.yearOne.statement.noi), (s) => s.yearOne.statement.noi < 0],
    ['Доходность', (s) => percent(s.yearOne.netYield, 1), (s) => (s.yearOne.netYield ?? 0) < 0],
    ['На руках в 1-й год', (s) => money(s.yearOne.cashFlow), (s) => s.yearOne.cashFlow < 0, y1.debtService === 0],
    ['IRR в год', (s) => percent(s.horizons[horizon]?.irr, 1), (s) => (s.horizons[horizon]?.irr ?? 0) < 0],
    ['NPV', (s) => money(s.horizons[horizon]?.npv), (s) => (s.horizons[horizon]?.npv ?? 0) < 0],
    ['Итог с продажей', (s) => percent(s.horizons[horizon]?.totalReturn, 1), (s) => (s.horizons[horizon]?.totalReturn ?? 0) < 0],
    ['Окупаемость', (s) => { const y = s.horizons[horizon]?.paybackYears; return y === null || y === undefined ? 'дольше' : years(y); }, () => false],
  ];
  const rows = all.filter((r) => !r[3]);

  return (
    <section id="result" className="sheet enter" aria-live="polite">
      <div className="hero-caption">Чистая доходность, базовый сценарий</div>
      <div className={`hero-figure num${(y1.netYield ?? 0) < 0 ? ' neg' : ''}`}>{percent(y1.netYield)}</div>
      <div className="hero-caption num">
        {money(y1.statement.noi)} в год чистыми при вложении {money(y1.acquisition.total)}
      </div>

      <div className="seg" role="group" aria-label="Горизонт">
        {base.horizons.map((h, i) => (
          <button key={h.horizonYears} aria-pressed={i === horizon} onClick={() => setHorizon(i)}>{h.horizonYears} {h.horizonYears === 1 ? 'год' : h.horizonYears < 5 ? 'года' : 'лет'}</button>
        ))}
      </div>
      <Spread r={r} h={horizon} />
      <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: '4px 0 0' }}>IRR, NPV, итог и окупаемость — за {hz?.horizonYears} {hz?.horizonYears === 1 ? 'год' : hz && hz.horizonYears < 5 ? 'года' : 'лет'} с продажей в конце срока.</p>

      <table className="scen num">
        <thead>
          <tr><th />{r.scenarios.map((s) => <th key={s.scenario} className={s.scenario === 'base' ? 'base' : undefined}>{SCEN_LABEL[s.scenario]}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(([label, f, neg]) => (
            <tr key={label}>
              <td>{label}</td>
              {r.scenarios.map((s) => <td key={s.scenario} className={[s.scenario === 'base' ? 'base' : '', neg(s) ? 'neg' : ''].join(' ')}>{f(s)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Покупка</h2>
      <dl className="kv num">
        <dt>Цена</dt><dd>{money(y1.acquisition.price)}</dd>
        {Object.entries(y1.acquisition.lines).filter(([, v]) => v).map(([k, v]) => (<Fragment key={k}><dt>{LINE_LABEL[k] ?? k}</dt><dd>{money(v)}</dd></Fragment>))}
        <dt className="total">Всего вложить</dt><dd className="total">{money(y1.acquisition.total)}</dd>
        {y1.equity !== y1.acquisition.total && (<><dt>Из них свои деньги</dt><dd>{money(y1.equity)}</dd></>)}
      </dl>

      <h2>Первый год</h2>
      <dl className="kv num">
        <dt>Доход до простоя</dt><dd>{money(y1.statement.gri)}</dd>
        {y1.statement.vacancyLoss > 0 && (<><dt>Простой</dt><dd className="neg">−{money(y1.statement.vacancyLoss)}</dd></>)}
        {Object.entries(y1.statement.expenses).filter(([, v]) => v).map(([k, v]) => (<Fragment key={k}><dt>{LINE_LABEL[k] ?? k}</dt><dd className="neg">−{money(v)}</dd></Fragment>))}
        <dt className="total">Чистый доход (NOI)</dt><dd className="total">{money(y1.statement.noi)}</dd>
        {y1.debtService > 0 && (<><dt>Платежи по кредиту</dt><dd className="neg">−{money(y1.debtService)}</dd><dt className="total">Остаётся на руках</dt><dd className="total">{money(y1.cashFlow)}</dd></>)}
        <dt>Валовая доходность</dt><dd>{percent(y1.grossYield)}</dd>
        <dt>Cap rate</dt><dd>{percent(y1.capRate)}</dd>
        <dt>Cash-on-cash</dt><dd>{percent(y1.cashOnCash)}</dd>
        {r.modelMetrics.waultYears !== undefined && (<><dt>WAULT</dt><dd>{years(r.modelMetrics.waultYears)}</dd></>)}
        {r.modelMetrics.revPar !== undefined && (<><dt>RevPAR</dt><dd>{money(r.modelMetrics.revPar)}</dd></>)}
      </dl>

      <h2>На чём основан расчёт</h2>
      <ul className="assumptions">
        {r.assumptions.map((a) => (
          <li key={a.key}>{ASSUMPTION_LABEL[a.key] ?? a.key}: {formatAssumption(a)} — {a.source === 'user' ? 'вы ввели' : a.source === 'default' ? 'по умолчанию' : a.source}</li>
        ))}
        <li>Сценарии: плохой — доход −10 %, простой +5 п.п., рост аренды −1 п.п., стоимость −2 п.п. в год, расходы +10 %; хороший — доход +5 %, простой −2 п.п., рост аренды и стоимости +1 п.п.</li>
      </ul>
      <p className="muted">{r.disclaimer} Версия расчёта: {r.engineVersion}.</p>
    </section>
  );
}
