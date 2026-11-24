import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { money, percent } from '../format';
import { Chips } from '../ui';
import { Compare } from './Extra';

export interface Card {
  id: string; typeName: string; city: string | null; areaM2: number | null; rooms: number | null; price: number | null; dealType: string | null;
  title: string | null; score: number | null; scoreConfidence: number | null; netYield: number | null; undervaluation: number | null; image: string | null;
  firstSeenAt: string; listings: number; favorite: boolean; isTest: boolean; isAuction: boolean; profiles?: Array<{ id: string; name: string }>;
}

export function ScoreBadge({ score, confidence }: { score: number | null; confidence: number | null }) {
  if (score === null) return <span className="score none" title="Мало данных для рейтинга">—</span>;
  const conf = (confidence ?? 0) >= 0.5 ? 'высокая' : (confidence ?? 0) >= 0.25 ? 'средняя' : 'низкая';
  return (
    <span className={`score ${score >= 70 ? 'hi' : score >= 50 ? 'mid' : 'lo'}`} title={`Рейтинг ${Math.round(score)} из 100, уверенность ${conf}`}>
      <b className="num">{Math.round(score)}</b>
      <small>{conf}</small>
    </span>
  );
}

export function PropertyCard({ c }: { c: Card }) {
  const facts = [c.areaM2 ? `${Math.round(c.areaM2)} м²` : null, c.rooms ? `${c.rooms} комн.` : null, c.city].filter(Boolean).join(', ');
  return (
    <li className="prop">
      <a href={`#/p/${c.id}`}>
        <div className="prop-img">{c.image ? <img src={c.image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span aria-hidden="true" />}</div>
        <div className="prop-body">
          <div className="prop-top">
            <div>
              <div className="title">{c.typeName}{c.isAuction ? ' · аукцион' : ''}</div>
              <div className="sub">{facts || c.title}</div>
            </div>
            <ScoreBadge score={c.score} confidence={c.scoreConfidence} />
          </div>
          <div className="prop-nums num">
            <strong>{money(c.price)}</strong>
            {c.netYield !== null && <span>доходн. ≈ {percent(c.netYield, 1)}</span>}
            {c.undervaluation !== null && c.undervaluation > 0.05 && <span className="good">ниже рынка {percent(c.undervaluation, 0)}</span>}
          </div>
          {(c.isTest || c.favorite || c.listings > 1) && (
            <div className="sub">{[c.isTest ? 'тестовые данные' : null, c.favorite ? '★ в избранном' : null, c.listings > 1 ? `${c.listings} объявления` : null].filter(Boolean).join(' · ')}</div>
          )}
        </div>
      </a>
    </li>
  );
}

const SORTS = [
  { value: 'score', label: 'По рейтингу' },
  { value: 'new', label: 'Новые' },
  { value: 'yield', label: 'По доходности' },
] as const;

export function Feed() {
  const [sort, setSort] = useState<'score' | 'new' | 'yield'>('score');
  const [data, setData] = useState<{ items: Card[]; total: number; profiles: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<{ items: Card[]; total: number; profiles: number }>(`/properties/feed?sort=${sort}`).then(setData, (e: Error) => setError(e.message));
  }, [sort]);

  return (
    <section>
      <h2>Находки по вашим поискам {data ? <span className="muted num">{data.total}</span> : null}</h2>
      {error && <p className="error">{error}</p>}
      {data && data.profiles === 0 && <p className="muted">Создайте поиск — сюда будут попадать подходящие объекты.</p>}
      {data && data.profiles > 0 && data.items.length === 0 && (
        <p className="muted">Пока ничего. Объекты появятся, когда подключённые агентства и аукционы будут просканированы — обычно в течение нескольких часов после подключения.</p>
      )}
      {data && data.items.length > 0 && (
        <>
          <div style={{ marginBottom: 12 }}><Chips single options={[...SORTS]} selected={[sort]} onChange={(v) => setSort(v[0]!)} /></div>
          <ul className="list props">{data.items.map((c) => <PropertyCard key={c.id} c={c} />)}</ul>
        </>
      )}
    </section>
  );
}

export function Favorites() {
  const [items, setItems] = useState<Card[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  useEffect(() => { api<Card[]>('/properties/favorites').then(setItems, () => setItems([])); }, []);
  return (
    <main className="page">
      <a className="link" href="#/more">Назад</a>
      <h1 className="page-title">Избранное</h1>
      <p className="page-lead">Эти объекты проверяются чаще — раз в сутки: цена, снятие с продажи, новые фото.</p>
      {items?.length === 0 && <p className="muted">Пусто. Нажмите «В избранное» в карточке объекта.</p>}
      {items && items.length > 1 && (
        <p className="muted">Отметьте до 10 объектов, чтобы сравнить их рядом.</p>
      )}
      {comparing && items && <Compare items={items.filter((i) => picked.includes(i.id))} onClose={() => setComparing(false)} />}
      <ul className="list props">
        {items?.map((c) => (
          <Fragment key={c.id}>
            <PropertyCard c={c} />
            {items.length > 1 && (
              <label className="toggle" style={{ minHeight: 36, margin: '-4px 6px 10px', fontSize: 'var(--fs-sm)' }}>
                Сравнить
                <input type="checkbox" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && picked.length >= 10} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
              </label>
            )}
          </Fragment>
        ))}
      </ul>
      {picked.length >= 2 && !comparing && <button className="btn block" onClick={() => { setComparing(true); scrollTo({ top: 0, behavior: 'smooth' }); }}>Сравнить {picked.length}</button>}
    </main>
  );
}
