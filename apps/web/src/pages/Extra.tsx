import { Fragment, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Region } from '../api';
import { eurosToCents, money, percent } from '../format';
import { Chips, ErrorBox, Field, Page, useRegions } from '../ui';
import type { Card } from './Feed';

// ---------- AI analyst block (used in the property card) ----------

interface Analysis {
  verdict: 'interesting' | 'neutral' | 'avoid'; summary: string; property?: { visible?: string[]; concerns?: string[] };
  location?: string[]; market?: string[]; legal?: string[]; strengths?: string[]; risks?: string[]; missing?: string[]; assumptions?: string[]; nextChecks?: string[];
  confidence: 'low' | 'medium' | 'high'; at: string; model: string; sources?: string[]; images?: number;
}
const VERDICT = { interesting: 'Стоит присмотреться', neutral: 'Без явных плюсов', avoid: 'Скорее не стоит' };
const CONF = { low: 'низкая', medium: 'средняя', high: 'высокая' };

export function AnalystBlock({ propertyId }: { propertyId: string }) {
  const [a, setA] = useState<Analysis | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Analysis | null>(`/analyst/${propertyId}`).then(setA, () => setA(null)); }, [propertyId]);
  const run = async (force = false) => {
    setBusy(true); setError(null);
    try { setA(await api<Analysis>(`/analyst/${propertyId}${force ? '?force=1' : ''}`, { method: 'POST' })); }
    catch (e) { setError(e instanceof ApiError ? ((e.body as { error?: string })?.error ?? e.message) : (e as Error).message); }
    finally { setBusy(false); }
  };
  const list = (title: string, xs?: string[]) => (xs?.length ? <><h3 style={{ margin: '14px 0 4px' }}>{title}</h3><ul className="assumptions">{xs.map((x) => <li key={x}>{x}</li>)}</ul></> : null);

  return (
    <section>
      <h2>Мнение ИИ-аналитика</h2>
      <ErrorBox error={error} />
      {a === null && <p className="muted">ИИ посмотрит объявление, фото, расчёты и подскажет, на что обратить внимание. Цифры он берёт только из расчётов программы.</p>}
      {a && (
        <section className="sheet" style={{ marginTop: 0 }}>
          <div className="hero-caption">{VERDICT[a.verdict] ?? a.verdict} · уверенность {CONF[a.confidence] ?? a.confidence}</div>
          <p style={{ marginBottom: 0 }}>{a.summary}</p>
          {list('Что видно', a.property?.visible)}
          {list('Настораживает', a.property?.concerns)}
          {list('Сильные стороны', a.strengths)}
          {list('Риски', a.risks)}
          {list('Локация', a.location)}
          {list('Рынок', a.market)}
          {list('Юридически проверить', a.legal)}
          {list('Не хватает данных', a.missing)}
          {list('Следующие шаги', a.nextChecks)}
          <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            {new Date(a.at).toLocaleString('ru-RU')} · {a.model}{a.images ? ` · фото: ${a.images}` : ''}. Это мнение модели, а не проверка документов.
          </p>
        </section>
      )}
      <button className="btn quiet block" disabled={busy} onClick={() => run(!!a)}>{busy ? 'Анализируем… (до минуты)' : a ? 'Обновить анализ' : 'Попросить ИИ оценить объект'}</button>
    </section>
  );
}

// ---------- push subscription ----------

const urlB64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));

export function PushToggle() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [state, setState] = useState<'unknown' | 'on' | 'off' | 'denied'>('unknown');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!supported) return;
    if (Notification.permission === 'denied') { setState('denied'); return; }
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setState(s ? 'on' : 'off'), () => setState('off'));
  }, [supported]);
  if (!supported) return <p className="muted">Этот браузер не поддерживает уведомления. Установите приложение через Chrome на Android.</p>;

  const enable = async () => {
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { setState('denied'); return; }
      const { publicKey } = await api<{ publicKey: string }>('/push/key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
      await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
      setState('on');
    } catch (e) { setError(`Не получилось: ${(e as Error).message}`); }
  };
  const disable = async () => {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
    setState('off');
  };
  return (
    <>
      <ErrorBox error={error} />
      {state === 'denied' && <p className="muted">Уведомления запрещены в настройках браузера для этого сайта. Разрешите их там и вернитесь сюда.</p>}
      {state === 'off' && <button className="btn block" onClick={enable}>Включить уведомления на этом телефоне</button>}
      {state === 'on' && <><p className="muted">Уведомления включены: новые находки, снижения цен и аукционы придут на телефон.</p><button className="btn quiet block" onClick={disable}>Выключить уведомления</button></>}
    </>
  );
}

// ---------- map ----------

export function MapPage() {
  const el = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Card[] | null>(null);
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (onlyMatches ? api<{ items: Card[] }>('/properties/feed?sort=score').then((r) => r.items) : api<Card[]>('/properties/map'))
      .then((x) => setItems(x.filter((i) => (i as Card & { lat?: number }).lat !== null && (i as Card & { lat?: number }).lat !== undefined)), (e: Error) => setError(e.message));
  }, [onlyMatches]);

  useEffect(() => {
    if (!el.current || !items) return;
    let map: import('maplibre-gl').Map | null = null;
    let cancelled = false;
    (async () => {
      const maplibre = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      if (cancelled || !el.current) return;
      map = new maplibre.Map({ container: el.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: [8.2, 44.0], zoom: 7.5, attributionControl: { compact: true } });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
      const bounds = new maplibre.LngLatBounds();
      for (const it of items as Array<Card & { lat: number; lng: number }>) {
        const dot = document.createElement('a');
        dot.className = `pin ${it.score === null ? 'none' : it.score >= 70 ? 'hi' : it.score >= 50 ? 'mid' : 'lo'}`;
        dot.href = `#/p/${it.id}`;
        dot.textContent = it.score === null ? '•' : String(Math.round(it.score));
        dot.setAttribute('aria-label', `${it.typeName}, ${money(it.price)}`);
        new maplibre.Marker({ element: dot }).setLngLat([it.lng, it.lat]).addTo(map);
        bounds.extend([it.lng, it.lat]);
      }
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 50, maxZoom: 13, duration: 0 });
    })().catch((e: Error) => setError(e.message));
    return () => { cancelled = true; map?.remove(); };
  }, [items]);

  return (
    <main className="page" style={{ maxWidth: 'none', padding: '12px 12px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>Карта</h1>
        <Chips single options={[{ value: 'm', label: 'Мои находки' }, { value: 'a', label: 'Все объекты' }]} selected={[onlyMatches ? 'm' : 'a']} onChange={(v) => setOnlyMatches(v[0] === 'm')} />
      </div>
      <ErrorBox error={error} />
      {items?.length === 0 && <p className="muted">Пока нет объектов с координатами.</p>}
      <div ref={el} className="map" />
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Цифра на точке — рейтинг. Точность места — по адресу из объявления или по центру города.</p>
    </main>
  );
}

// ---------- compare up to 10 ----------

export function Compare({ items, onClose }: { items: Card[]; onClose: () => void }) {
  const rows: Array<[string, (c: Card) => string]> = [
    ['Цена', (c) => money(c.price)],
    ['Город', (c) => c.city ?? '—'],
    ['Площадь', (c) => (c.areaM2 ? `${Math.round(c.areaM2)} м²` : '—')],
    ['Цена за м²', (c) => (c.price && c.areaM2 ? money(Math.round(c.price / c.areaM2)) : '—')],
    ['Рейтинг', (c) => (c.score === null ? '—' : String(Math.round(c.score)))],
    ['Доходность (оценка)', (c) => percent(c.netYield, 1)],
    ['К рынку', (c) => (c.undervaluation === null ? '—' : `${c.undervaluation > 0 ? 'ниже' : 'выше'} ${percent(Math.abs(c.undervaluation), 0)}`)],
  ];
  return (
    <section className="sheet">
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Сравнение</h3><button className="link" onClick={onClose}>Закрыть</button></div>
      <div style={{ overflowX: 'auto' }}>
        <table className="scen num compare">
          <thead><tr><th />{items.map((c) => <th key={c.id}><a href={`#/p/${c.id}`}>{c.typeName}</a></th>)}</tr></thead>
          <tbody>{rows.map(([label, f]) => <tr key={label}><td>{label}</td>{items.map((c) => <td key={c.id}>{f(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- market analytics ----------

interface MarketRow { city: string; typeName: string; basis: string; saleCount: number; saleMedian: number | null; rentCount: number; rentMedian: number | null; grossYield: number | null }

export function Market() {
  const { data: regions } = useRegions('IT');
  const { data: provinces } = useRegions('IT', 'it-r-07');
  const [region, setRegion] = useState('it-r-07');
  const [data, setData] = useState<{ rows: MarketRow[]; note: string } | null>(null);
  useEffect(() => { setData(null); api<{ rows: MarketRow[]; note: string }>(`/market?region=${region}`).then(setData, () => setData({ rows: [], note: '' })); }, [region]);
  const options = [...(regions ?? []).filter((r) => r.id === 'it-r-07'), ...(provinces ?? [])] as Region[];
  return (
    <Page title="Аналитика рынка" back="/more" lead="Медианы цен и аренды по собранным объявлениям: одна методика для всех строк. Гаражи и места считаются за штуку, остальное — за м².">
      <Chips single options={options.map((r) => ({ value: r.id, label: r.name }))} selected={[region]} onChange={(v) => setRegion(v[0]!)} />
      {data && data.rows.length === 0 && <p className="muted" style={{ marginTop: 16 }}>Данных пока нет — они появятся после сканирования подключённых источников.</p>}
      {data && data.rows.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 16 }}>
          <table className="scen num compare">
            <thead><tr><th>Город, тип</th><th>Продажа</th><th>Аренда/мес</th><th>Валовая доходн.</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.city}${r.typeName}`}>
                  <td>{r.city}<div className="sub">{r.typeName}</div></td>
                  <td>{r.saleMedian ? `${money(Math.round(r.saleMedian))}${r.basis === 'per_m2' ? '/м²' : ''}` : '—'}<div className="sub">{r.saleCount} объявл.</div></td>
                  <td>{r.rentMedian ? `${money(Math.round(r.rentMedian))}${r.basis === 'per_m2' ? '/м²' : ''}` : '—'}<div className="sub">{r.rentCount} объявл.</div></td>
                  <td>{percent(r.grossYield, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{data.note}</p>
        </div>
      )}
    </Page>
  );
}

// ---------- portfolio ----------

interface Asset {
  id: string; name: string; purchase_date: string; purchase_price: number; total_cost: number | null; expected_noi: number | null; property_id: string | null;
  income: Array<{ id: string; period_start: string; period_end: string; amount: number; tenant: string | null }>;
  expenses: Array<{ id: string; date: string; category: string; amount: number }>;
  performance: { income: number; expenses: number; net: number; actualYield: number | null; forecastYield: number | null; vsForecast: number | null; monthsCovered: number };
}

export function Portfolio() {
  const [data, setData] = useState<{ assets: Asset[]; totals: { cost: number; net: number; expectedNoi: number } } | null>(null);
  const [form, setForm] = useState({ name: '', date: '', price: '', total: '', noi: '' });
  const [entry, setEntry] = useState<Record<string, { kind: 'income' | 'expense'; date: string; amount: string; category: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const load = () => api<NonNullable<typeof data>>('/portfolio').then(setData, (e: Error) => setError(e.message));
  useEffect(() => { load(); }, []);
  const n = (s: string) => { const c = eurosToCents(s); return c === null || Number.isNaN(c) ? null : c / 100; };

  const addAsset = async () => {
    setError(null);
    if (!form.name || !/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !n(form.price)) { setError('Заполните название, дату покупки и цену.'); return; }
    await api('/portfolio/assets', { method: 'POST', body: { name: form.name, purchaseDate: form.date, purchasePriceEuro: n(form.price), totalCostEuro: n(form.total) ?? undefined, expectedNoiEuro: n(form.noi) ?? undefined } });
    setForm({ name: '', date: '', price: '', total: '', noi: '' });
    load();
  };
  const addEntry = async (assetId: string) => {
    const e = entry[assetId];
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !n(e.amount)) { setError('Укажите дату и сумму.'); return; }
    await api(`/portfolio/assets/${assetId}/${e.kind === 'income' ? 'income' : 'expenses'}`, { method: 'POST', body: e.kind === 'income' ? { periodStart: e.date, periodEnd: e.date, amountEuro: n(e.amount) } : { date: e.date, category: e.category || 'Прочее', amountEuro: n(e.amount) } });
    setEntry({ ...entry, [assetId]: { ...e, amount: '' } });
    load();
  };

  return (
    <Page title="Портфель" back="/more" lead="Купленные объекты: фактические доходы и расходы за последние 12 месяцев и сравнение с прогнозом.">
      <ErrorBox error={error} />
      {data?.assets.length ? (
        <dl className="kv num"><dt>Вложено</dt><dd>{money(data.totals.cost)}</dd><dt>Чистыми за 12 мес.</dt><dd>{money(data.totals.net)}</dd><dt>Прогноз в год</dt><dd>{money(data.totals.expectedNoi)}</dd></dl>
      ) : null}
      {data?.assets.map((a) => {
        const e = entry[a.id] ?? { kind: 'income' as const, date: new Date().toISOString().slice(0, 10), amount: '', category: '' };
        return (
          <section className="group" key={a.id} style={{ marginTop: 16 }}>
            <h3>{a.name}</h3>
            <dl className="kv num" style={{ marginTop: 0 }}>
              <dt>Куплено</dt><dd>{a.purchase_date}, {money(a.purchase_price)}</dd>
              <dt>Доходы / расходы</dt><dd>{money(a.performance.income)} / {money(a.performance.expenses)}</dd>
              <dt>Фактическая доходность</dt><dd>{percent(a.performance.actualYield, 1)}</dd>
              <dt>Прогноз</dt><dd>{percent(a.performance.forecastYield, 1)}</dd>
              {a.performance.vsForecast !== null && (<><dt>К прогнозу</dt><dd className={a.performance.vsForecast >= 0 ? 'good' : 'neg'}>{a.performance.vsForecast >= 0 ? '+' : ''}{money(a.performance.vsForecast)}</dd></>)}
            </dl>
            <div style={{ marginTop: 12 }}>
              <Chips single options={[{ value: 'income', label: 'Доход' }, { value: 'expense', label: 'Расход' }]} selected={[e.kind]} onChange={(v) => setEntry({ ...entry, [a.id]: { ...e, kind: v[0] as 'income' | 'expense' } })} />
              <div className="row2" style={{ marginTop: 10 }}>
                <Field label="Дата" type="date" inputMode="text" value={e.date} onChange={(v) => setEntry({ ...entry, [a.id]: { ...e, date: v } })} />
                <Field label="Сумма" suffix="€" value={e.amount} onChange={(v) => setEntry({ ...entry, [a.id]: { ...e, amount: v } })} />
              </div>
              {e.kind === 'expense' && <Field label="Статья" inputMode="text" value={e.category} placeholder="Кондоминиум, IMU, ремонт…" onChange={(v) => setEntry({ ...entry, [a.id]: { ...e, category: v } })} />}
              <button className="btn quiet block" onClick={() => addEntry(a.id)}>Добавить {e.kind === 'income' ? 'доход' : 'расход'}</button>
            </div>
            {(a.income.length > 0 || a.expenses.length > 0) && (
              <ul className="assumptions">
                {[...a.income.map((i) => ({ k: 'income', id: i.id, d: i.period_end, t: 'Доход', v: i.amount })), ...a.expenses.map((x) => ({ k: 'expense', id: x.id, d: x.date, t: x.category, v: -x.amount }))]
                  .sort((x, y) => y.d.localeCompare(x.d)).slice(0, 12).map((r) => (
                    <li key={r.id}>{r.d} — {r.t}: <span className={r.v < 0 ? 'neg' : 'good'}>{money(r.v)}</span> <button className="link" onClick={async () => { await api(`/portfolio/entries/${r.k}/${r.id}`, { method: 'DELETE' }); load(); }}>удалить</button></li>
                  ))}
              </ul>
            )}
          </section>
        );
      })}
      <h2>Добавить объект</h2>
      <section className="group">
        <Field label="Название" inputMode="text" value={form.name} placeholder="Например, квартира в Костарайнере" onChange={(v) => setForm({ ...form, name: v })} />
        <div className="row2">
          <Field label="Дата покупки" type="date" inputMode="text" value={form.date} onChange={(v) => setForm({ ...form, date: v })} />
          <Field label="Цена" suffix="€" value={form.price} onChange={(v) => setForm({ ...form, price: v })} />
        </div>
        <Field label="Всего вложено (с налогами и ремонтом)" suffix="€" value={form.total} onChange={(v) => setForm({ ...form, total: v })} />
        <Field label="Ожидаемый чистый доход в год" suffix="€" value={form.noi} hint="Из расчёта при покупке — с ним сравнивается факт." onChange={(v) => setForm({ ...form, noi: v })} />
        <button className="btn block" onClick={addAsset}>Добавить в портфель</button>
      </section>
      <Fragment />
    </Page>
  );
}

// ---------- share target ----------

export function Share() {
  const url = new URLSearchParams(location.hash.split('?')[1] ?? '').get('u') ?? '';
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!url) { setMsg('Ссылка не передана.'); return; }
    api<{ status: string; message?: string; propertyId?: string }>('/properties/share', { method: 'POST', body: { url } })
      .then((r) => (r.status === 'known' && r.propertyId ? (location.hash = `/p/${r.propertyId}`) : setMsg(r.message ?? 'Готово.')), (e: Error) => setMsg(`Не получилось: ${e.message}`));
  }, [url]);
  return (
    <Page title="Поделились ссылкой" back="/">
      <p className="muted" style={{ wordBreak: 'break-all' }}>{url}</p>
      <p>{msg ?? 'Проверяем…'}</p>
    </Page>
  );
}
