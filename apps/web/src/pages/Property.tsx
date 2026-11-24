import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, type User } from '../api';
import { money, percent } from '../format';
import { ErrorBox, go } from '../ui';
import { ScoreBadge } from './Feed';
import { AnalystBlock } from './Extra';

interface Comp { value: number | null; weight: number; confidence: number; basis: string }
interface PropertyData {
  redirect?: string;
  id: string; typeCode: string; typeName: string; category: { code: string; name: string; risks: string[]; legalChecks: string[] } | null; financialModels: string[];
  city: string | null; region: string | null; address: string | null; lat: number | null; lng: number | null; geoPrecision: string | null;
  areaM2: number | null; rooms: number | null; floor: number | null; features: Record<string, unknown>; isTest: boolean;
  listings: Array<{ id: string; url: string; title: string | null; description: string | null; price: number | null; deal_type: string | null; status: string; first_seen_at: string; last_seen_at: string; removed_at: string | null; source_name: string; source_kind: string; extraction: { method: string; confidence: number } | null }>;
  priceHistory: Array<{ listing_id: string; price: number; observed_at: string }>;
  events: Array<{ type: string; old: unknown; new: { value: unknown; change: number | null } | null; at: string }>;
  images: string[];
  score: { score: number | null; confidence: number; components: Record<string, Comp>; reasons: string[]; profile: string; engine: string; at: string } | null;
  valuation: { low: number; mid: number; high: number; n: number; kind: string; confidence: number; at: string } | null;
  rental: { rent: { monthly: number; low: number; high: number; n: number } | null; assumptions: Array<{ key: string; value: number | string; unit?: string; source: string }>; finance: { statement: { gri: number; noi: number }; acquisition: { total: number }; netYield: number | null; grossYield: number | null } | null } | null;
  netYield: number | null; undervaluation: number | null;
  notes: Array<{ id: string; text: string; created_at: string }>; favorite: boolean;
  duplicates: Array<{ id: string; property_a: string; property_b: string; probability: number }>;
}

const COMP_LABEL: Record<string, string> = {
  undervaluation: 'Цена относительно рынка', growth: 'Потенциал роста', yield: 'Доходность', location: 'Локация', liquidity: 'Ликвидность', condition: 'Состояние', legal: 'Юридические риски',
};
const EVENT_LABEL: Record<string, string> = {
  new: 'Появилось объявление', price_down: 'Цена снижена', price_up: 'Цена повышена', features_changed: 'Изменились характеристики', photos_changed: 'Изменились фото',
  removed: 'Снято с публикации', reappeared: 'Снова опубликовано', republished: 'Опубликовано заново', cross_posted: 'Найдено ещё на одном сайте',
};
const ASSUMPTION: Record<string, string> = {
  monthlyRent: 'Аренда в месяц', monthlyRatePerUnit: 'Аренда места в месяц', units: 'Мест', occupancy: 'Загрузка', lettableAreaM2: 'Площадь под аренду', rentPerM2Month: 'Аренда за м²',
  acquisitionCostRate: 'Расходы на покупку', vacancyRate: 'Простой', maintenanceRateOfPrice: 'Обслуживание в год', insuranceRateOfPrice: 'Страховка в год',
};
const date = (s: string) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

export function Property({ id, user }: { id: string; user: User }) {
  const [p, setP] = useState<PropertyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => {
    api<PropertyData>(`/properties/${id}`).then((d) => (d.redirect ? go(`/p/${d.redirect}`) : setP(d)), (e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <main className="page"><ErrorBox error={error} /></main>;
  if (!p) return <main className="page"><p>Загружаем…</p></main>;

  const active = p.listings.filter((l) => l.status !== 'removed');
  const main = active[0] ?? p.listings[0];
  const price = main?.price ?? null;
  const canAdmin = user.role === 'owner' || user.role === 'admin';
  const facts: Array<[string, string]> = [
    ['Тип', `${p.typeName}${p.category ? ` (${p.category.name.toLowerCase()})` : ''}`],
    ['Где', [p.address, p.city, p.region].filter(Boolean).join(', ') || '—'],
    ...(p.areaM2 ? [['Площадь', `${Math.round(p.areaM2)} м²`] as [string, string]] : []),
    ...(p.rooms ? [['Комнат', String(p.rooms)] as [string, string]] : []),
    ...(p.floor !== null && p.floor !== undefined ? [['Этаж', String(p.floor)] as [string, string]] : []),
    ...(price && p.areaM2 ? [['Цена за м²', money(Math.round(price / p.areaM2))] as [string, string]] : []),
    ...(typeof p.features.condition === 'string' ? [['Состояние', String(p.features.condition)] as [string, string]] : []),
  ];

  const toggleFav = async () => { await api(`/properties/${id}/favorite`, { method: p.favorite ? 'DELETE' : 'PUT' }); load(); };
  const addNote = async () => { if (!note.trim()) return; await api(`/properties/${id}/notes`, { method: 'POST', body: { text: note } }); setNote(''); load(); };
  const decideDup = async (cid: string, decision: 'merge' | 'reject') => { await api(`/properties/dedup/${cid}`, { method: 'POST', body: { decision } }); load(); };
  const calcLink = () => {
    const q = new URLSearchParams({ type: p.typeCode, price: String((price ?? 0) / 100) });
    if (p.rental?.rent) q.set('rent', String(p.rental.rent.monthly / 100));
    return `#/calc?${q}`;
  };

  return (
    <main className="page">
      <a className="link" href="#/">Назад</a>
      {p.isTest && <p className="notice">Это тестовые данные, а не реальное объявление.</p>}
      {p.images.length > 0 && (
        <div className="gallery">{p.images.map((src) => <img key={src} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />)}</div>
      )}
      <h1 className="page-title">{p.typeName}{p.city ? `, ${p.city}` : ''}</h1>
      <div className="price-line num">
        <strong>{money(price)}</strong>
        {main?.deal_type === 'rent' && <span className="muted"> в месяц</span>}
        <ScoreBadge score={p.score?.score ?? null} confidence={p.score?.confidence ?? null} />
      </div>
      <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className={`btn small${p.favorite ? '' : ' quiet'}`} onClick={toggleFav}>{p.favorite ? '★ В избранном' : '☆ В избранное'}</button>
        {main?.deal_type !== 'rent' && <a className="btn quiet small" href={calcLink()}>Посчитать подробно</a>}
      </p>

      <dl className="kv">{facts.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>

      {p.duplicates.length > 0 && (
        <section className="group" style={{ marginTop: 18 }}>
          <h3>Возможно, это тот же объект</h3>
          {p.duplicates.map((d) => (
            <div key={d.id} style={{ marginBottom: 10 }}>
              <a className="link" href={`#/p/${d.property_a === p.id ? d.property_b : d.property_a}`}>Похожий объект</a> — совпадение {percent(d.probability, 0)}.
              {canAdmin && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn small" onClick={() => decideDup(d.id, 'merge')}>Это один объект</button>
                  <button className="btn quiet small" onClick={() => decideDup(d.id, 'reject')}>Разные</button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <h2>Оценка</h2>
      {p.score?.score !== null && p.score ? (
        <section className="sheet" style={{ marginTop: 0 }}>
          <div className="hero-caption">Investment Score — уверенность {p.score.confidence >= 0.5 ? 'высокая' : p.score.confidence >= 0.25 ? 'средняя' : 'низкая'}</div>
          <div className="hero-figure num">{Math.round(p.score.score)}<span className="muted" style={{ fontSize: '1.2rem' }}> / 100</span></div>
          <ul className="comps">
            {Object.entries(p.score.components).filter(([, c]) => c.weight > 0).map(([k, c]) => (
              <li key={k}>
                <div className="comp-head"><span>{COMP_LABEL[k] ?? k}</span><span className="num">{c.value === null ? 'нет данных' : Math.round(c.value)}<span className="muted"> · вес {Math.round(c.weight * 100)} %</span></span></div>
                <div className="comp-bar"><span style={{ width: `${c.value ?? 0}%` }} /></div>
                <div className="sub">{c.basis}</div>
              </li>
            ))}
          </ul>
          {p.score.reasons.length > 0 && <ul className="assumptions">{p.score.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
        </section>
      ) : (
        <p className="muted">{p.score?.reasons?.[0] ?? 'Пока не оценено: нужно больше похожих объявлений рядом.'}</p>
      )}

      {p.valuation && (
        <dl className="kv num">
          <dt>Рыночная цена по похожим предложениям</dt><dd>{money(p.valuation.mid)}</dd>
          <dt>Диапазон (25–75 %)</dt><dd>{money(p.valuation.low)} – {money(p.valuation.high)}</dd>
          <dt>Отклонение цены</dt><dd className={(p.undervaluation ?? 0) > 0 ? 'good' : 'neg'}>{p.undervaluation !== null ? `${p.undervaluation > 0 ? 'ниже' : 'выше'} на ${percent(Math.abs(p.undervaluation), 1)}` : '—'}</dd>
          <dt className="muted">Основа</dt><dd className="muted">{p.valuation.n} объявлений, цены предложений, не сделок</dd>
        </dl>
      )}
      {p.rental?.finance && p.rental.rent && (
        <dl className="kv num">
          <dt>Аренда по похожим объявлениям</dt><dd>{money(p.rental.rent.monthly)} / мес</dd>
          <dt>Чистый доход в год (оценка)</dt><dd>{money(p.rental.finance.statement.noi)}</dd>
          <dt>Чистая доходность (оценка)</dt><dd>{percent(p.rental.finance.netYield, 1)}</dd>
          <dt className="muted">Основа</dt><dd className="muted">{p.rental.rent.n} объявлений об аренде</dd>
        </dl>
      )}

      {p.rental?.assumptions && p.rental.assumptions.length > 0 && (
        <ul className="assumptions">
          {p.rental.assumptions.filter((a) => a.source !== 'user').map((a) => (
            <li key={a.key}>{ASSUMPTION[a.key] ?? a.key}: {typeof a.value === 'number' && a.unit === 'fraction' ? percent(a.value, 1) : typeof a.value === 'number' && a.unit?.startsWith('cents') ? money(a.value) : a.unit === '%' ? `${a.value} %` : String(a.value)} — {a.source.replace(/^default: ?/, 'допущение: ').replace(/^default$/, 'допущение')}</li>
          ))}
        </ul>
      )}

      {main?.deal_type !== 'rent' && <AnalystBlock propertyId={p.id} />}

      <h2>Объявления</h2>
      <ul className="list">
        {p.listings.map((l) => (
          <li key={l.id}>
            <div style={{ display: 'block' }}>
              <div className="title">{l.source_name}{l.source_kind === 'auction' ? ' (аукцион)' : ''}</div>
              <div className="sub num">{money(l.price)}{l.deal_type === 'rent' ? ' / мес' : ''} · {l.status === 'removed' ? `снято ${l.removed_at ? date(l.removed_at) : ''}` : `на сайте с ${date(l.first_seen_at)}`}</div>
              <div className="sub"><a href={l.url} target="_blank" rel="noreferrer noopener">Открыть оригинал</a>{l.extraction?.method === 'ai' || l.extraction?.method === 'mixed' ? ' · часть данных распознана ИИ' : ''}</div>
            </div>
          </li>
        ))}
      </ul>
      {main?.description && <p className="muted" style={{ whiteSpace: 'pre-line' }}>{main.description.slice(0, 1200)}</p>}

      {p.events.length > 0 && (
        <>
          <h2>История</h2>
          <ul className="assumptions">
            {p.events.map((e, i) => (
              <li key={i}>{date(e.at)} — {EVENT_LABEL[e.type] ?? e.type}{(e.type === 'price_down' || e.type === 'price_up') && e.new ? `: ${money(e.old as number)} → ${money(e.new.value as number)} (${percent(e.new.change, 1)})` : ''}</li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Снятие объявления не означает продажу.</p>
        </>
      )}

      {p.category && (
        <>
          <h2>Что проверить</h2>
          <ul className="assumptions">{p.category.risks.map((r) => <li key={r}>{r}</li>)}</ul>
          <ul className="assumptions">{p.category.legalChecks.map((r) => <li key={r}>{r}</li>)}</ul>
        </>
      )}

      <h2>Заметки</h2>
      {p.notes.map((n) => <p key={n.id} className="group" style={{ padding: 14 }}>{n.text}<br /><span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{date(n.created_at)}</span></p>)}
      <label className="field"><span className="sr-only">Новая заметка</span><textarea className="input" style={{ minHeight: 90, paddingTop: 12 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: позвонить агенту, спросить про кондоминиум" /></label>
      <button className="btn quiet block" onClick={addNote} disabled={!note.trim()}>Сохранить заметку</button>
      <p className="muted" style={{ fontSize: 'var(--fs-sm)', marginTop: 24 }}>Расчёты — оценка по объявлениям и допущениям, не инвестиционная рекомендация.</p>
    </main>
  );
}
