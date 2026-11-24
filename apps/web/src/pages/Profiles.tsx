import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type SearchProfile } from '../api';
import { centsToEuros, eurosToCents, money, parseNumber, percent, percentToRate, rateToPercent } from '../format';
import { Chips, ErrorBox, Field, go, Page, useCountries, useRegions, useTaxonomy } from '../ui';

const STRATEGIES = [
  { value: 'income', label: 'Регулярный доход' },
  { value: 'growth', label: 'Рост стоимости' },
  { value: 'value_add', label: 'Ремонт и перепродажа' },
  { value: 'mixed', label: 'Смешанная' },
] as const;

const CONDITIONS = [
  { value: 'new', label: 'Новое' },
  { value: 'renovated', label: 'После ремонта' },
  { value: 'good', label: 'Хорошее' },
  { value: 'to_renovate', label: 'Под ремонт' },
  { value: 'ruin', label: 'Руины' },
] as const;

export function ProfilesList() {
  const [list, setList] = useState<SearchProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<SearchProfile[]>('/profiles').then(setList, (e: Error) => setError(e.message)); }, []);

  return (
    <Page title="Мои поиски" lead="Каждый поиск работает сам по себе: свой регион, типы объектов, бюджет и цель по доходности.">
      <ErrorBox error={error} />
      <a className="btn block" href="#/profiles/new" style={{ marginBottom: 18 }}>Новый поиск</a>
      {list?.length === 0 && <p className="muted">Поисков пока нет. Например: «Гаражи в Лигурии до 40 000 €, доходность от 6 %».</p>}
      <ul className="list">
        {list?.map((p) => (
          <li key={p.id}>
            <a href={`#/profiles/${p.id}`}>
              <div>
                <div className="title">{p.name}</div>
                <div className="sub num">
                  {[p.priceMax ? `до ${money(p.priceMax)}` : null, p.targetNetYield ? `от ${percent(p.targetNetYield, 1)}` : null, `${p.typeCodes.length || 'все'} типов`]
                    .filter(Boolean)
                    .join(', ')}
                </div>
              </div>
              <span className={`pill${p.isActive ? ' on' : ''}`}>{p.isActive ? 'Активен' : 'Выключен'}</span>
            </a>
          </li>
        ))}
      </ul>
    </Page>
  );
}

const EMPTY: SearchProfile = {
  name: '', countries: ['IT'], regions: [], cities: [], geo: {}, typeCodes: [], priceMin: null, priceMax: null, areaMin: null,
  areaMax: null, targetNetYield: null, condition: [], extra: {}, strategy: 'income', refreshMin: 720, notify: {}, isActive: true,
};

export function ProfileEdit({ id }: { id: string | null }) {
  const [p, setP] = useState<SearchProfile | null>(id ? null : EMPTY);
  const [text, setText] = useState({ priceMin: '', priceMax: '', areaMin: '', areaMax: '', yield: '', minScore: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: tax } = useTaxonomy();
  const { data: countries } = useCountries();
  const { data: itRegions } = useRegions(p?.countries.includes('IT') ? 'IT' : null);
  const { data: liguria } = useRegions(p?.regions.includes('it-r-07') ? 'IT' : null, 'it-r-07');

  useEffect(() => {
    if (!id) return;
    api<SearchProfile>(`/profiles/${id}`).then((x) => {
      setP(x);
      setText({
        priceMin: centsToEuros(x.priceMin), priceMax: centsToEuros(x.priceMax),
        areaMin: x.areaMin?.toString() ?? '', areaMax: x.areaMax?.toString() ?? '',
        yield: rateToPercent(x.targetNetYield), minScore: x.notify.minScore?.toString() ?? '',
      });
    }, (e: Error) => setError(e.message));
  }, [id]);

  const parsed = useMemo(() => ({
    priceMin: eurosToCents(text.priceMin), priceMax: eurosToCents(text.priceMax),
    areaMin: parseNumber(text.areaMin), areaMax: parseNumber(text.areaMax),
    yield: percentToRate(text.yield), minScore: parseNumber(text.minScore),
  }), [text]);
  const bad = (v: number | null) => v !== null && Number.isNaN(v);

  if (!p) return <Page title="Поиск" back="/profiles"><ErrorBox error={error} />{!error && <p>Загружаем…</p>}</Page>;
  const set = (patch: Partial<SearchProfile>) => setP({ ...p, ...patch });

  async function save() {
    if (!p) return;
    if (Object.values(parsed).some(bad)) { setError('Проверьте числа: в полях, выделенных красным, не число.'); return; }
    setBusy(true); setError(null);
    const body: SearchProfile = {
      ...p,
      priceMin: parsed.priceMin, priceMax: parsed.priceMax, areaMin: parsed.areaMin, areaMax: parsed.areaMax,
      targetNetYield: parsed.yield,
      notify: { ...p.notify, minScore: parsed.minScore ?? undefined },
    };
    try {
      await api(id ? `/profiles/${id}` : '/profiles', { method: id ? 'PUT' : 'POST', body });
      go('/profiles');
    } catch (e) {
      const issues = e instanceof ApiError ? (e.body as { issues?: Array<{ path: string[]; message: string }> })?.issues : null;
      setError(issues?.length ? `Не сохранено: ${issues.map((i) => `${i.path.join('.')} — ${i.message}`).join('; ')}` : `Не сохранено: ${(e as Error).message}`);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!id || !confirm('Удалить этот поиск? Это нельзя отменить.')) return;
    await api(`/profiles/${id}`, { method: 'DELETE' });
    go('/profiles');
  }

  const provinceIds = new Set(liguria?.map((r) => r.id));

  return (
    <Page title={id ? 'Поиск' : 'Новый поиск'} back="/profiles">
      <ErrorBox error={error} />
      <section className="group">
        <label className="field">
          <span>Название</span>
          <input className="input" value={p.name} placeholder="Например, гаражи на побережье" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="toggle">
          Поиск включён
          <input type="checkbox" checked={p.isActive} onChange={(e) => set({ isActive: e.target.checked })} />
        </label>
      </section>

      <section className="group">
        <h3>Где искать</h3>
        <div className="field">
          <span>Страны</span>
          <Chips options={(countries ?? []).map((c) => ({ value: c.code, label: c.name.ru }))} selected={p.countries} onChange={(v) => set({ countries: v })} />
        </div>
        {p.countries.includes('IT') && itRegions && (
          <div className="field">
            <span>Регионы Италии</span>
            <Chips
              options={itRegions.map((r) => ({ value: r.id, label: r.name }))}
              selected={p.regions}
              onChange={(v) => set({ regions: v.includes('it-r-07') ? v : v.filter((x) => !provinceIds.has(x)) })}
            />
            <small>Ничего не выбрано — вся страна.</small>
          </div>
        )}
        {liguria && p.regions.includes('it-r-07') && (
          <div className="field">
            <span>Провинции Лигурии</span>
            <Chips options={liguria.map((r) => ({ value: r.id, label: r.name }))} selected={p.regions} onChange={(v) => set({ regions: v })} />
            <small>Ничего не выбрано — вся Лигурия.</small>
          </div>
        )}
        {p.countries.some((c) => c !== 'IT') && <p className="muted">Регионы других стран добавятся, когда подключим их источники.</p>}
      </section>

      <section className="group">
        <h3>Что искать</h3>
        {tax?.categories.map((cat) => {
          const codes = cat.types.map((t) => t.code);
          const all = codes.every((c) => p.typeCodes.includes(c));
          return (
            <div className="field" key={cat.code}>
              <span>
                {cat.name.ru}{' '}
                <button type="button" className="link" onClick={() => set({ typeCodes: all ? p.typeCodes.filter((c) => !codes.includes(c)) : [...new Set([...p.typeCodes, ...codes])] })}>
                  {all ? 'снять все' : 'выбрать все'}
                </button>
              </span>
              <Chips options={cat.types.map((t) => ({ value: t.code, label: t.name.ru }))} selected={p.typeCodes} onChange={(v) => set({ typeCodes: v })} />
            </div>
          );
        })}
        <small className="muted">Ничего не выбрано — все типы.</small>
      </section>

      <section className="group">
        <h3>Деньги и площадь</h3>
        <div className="row2">
          <Field label="Цена от" suffix="€" value={text.priceMin} bad={bad(parsed.priceMin)} onChange={(v) => setText({ ...text, priceMin: v })} />
          <Field label="Цена до" suffix="€" value={text.priceMax} bad={bad(parsed.priceMax)} onChange={(v) => setText({ ...text, priceMax: v })} />
          <Field label="Площадь от" suffix="м²" value={text.areaMin} bad={bad(parsed.areaMin)} onChange={(v) => setText({ ...text, areaMin: v })} />
          <Field label="Площадь до" suffix="м²" value={text.areaMax} bad={bad(parsed.areaMax)} onChange={(v) => setText({ ...text, areaMax: v })} />
        </div>
        <Field label="Чистая доходность не ниже" suffix="%" value={text.yield} bad={bad(parsed.yield)} onChange={(v) => setText({ ...text, yield: v })} hint="После всех расходов, от полной стоимости покупки." />
        <div className="field">
          <span>Состояние</span>
          <Chips options={[...CONDITIONS]} selected={p.condition as Array<(typeof CONDITIONS)[number]['value']>} onChange={(v) => set({ condition: v })} />
        </div>
        <div className="field">
          <span>Стратегия</span>
          <Chips single options={[...STRATEGIES]} selected={[p.strategy]} onChange={(v) => set({ strategy: v[0]! })} />
        </div>
      </section>

      <section className="group">
        <h3>Уведомления</h3>
        <Field label="Сообщать об объектах с рейтингом от" value={text.minScore} bad={bad(parsed.minScore)} inputMode="numeric" placeholder="например, 70" onChange={(v) => setText({ ...text, minScore: v })} hint="Рейтинг от 0 до 100. Уведомления заработают вместе с автоматическим поиском." />
      </section>

      <button className="btn block" disabled={busy || !p.name.trim()} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить поиск'}</button>
      {id && <p style={{ marginTop: 14 }}><button className="btn danger block" onClick={remove}>Удалить поиск</button></p>}
    </Page>
  );
}
