import { useCallback, useEffect, useState } from 'react';
import { api, type User } from '../api';
import { ErrorBox, Page } from '../ui';

export interface RegionSummary {
  region_id: string;
  region_name: string;
  status: 'queued' | 'running' | 'done' | 'error';
  found: number;
  without_website: number;
  excluded: number;
  error: string | null;
  finished_at: string | null;
  counts: { pending: number; suitable: number; review: number; rejected: number; approved: number; declined: number } | null;
}

interface SourceItem {
  id: string; name: string; url: string; city: string | null; verdict: 'pending' | 'suitable' | 'review' | 'rejected';
  decision: 'approved' | 'declined' | null; platform: string | null; reasons: string[]; terms: string | null;
}

export const useSourceSummary = () => {
  const [data, setData] = useState<RegionSummary[] | null>(null);
  const load = useCallback(() => { api<RegionSummary[]>('/sources/summary').then(setData, () => setData([])); }, []);
  useEffect(load, [load]);
  return { data, reload: load };
};

export function regionLine(r: RegionSummary): string {
  if (r.status === 'queued' || r.status === 'running') return 'ищем агентства и проверяем их сайты';
  if (r.status === 'error') return 'поиск не удался, повторим в течение часа';
  const c = r.counts;
  if (!c || r.found === 0) return 'агентств с собственным сайтом не нашлось';
  const parts = [`найдено ${r.found}`];
  if (c.pending) parts.push(`проверяем ещё ${c.pending}`);
  if (c.suitable) parts.push(`подходят ${c.suitable}`);
  if (c.review) parts.push(`под вопросом ${c.review}`);
  if (c.approved) parts.push(`подключено ${c.approved}`);
  return parts.join(', ');
}

export function ApproveSuitable({ r, onDone }: { r: RegionSummary; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!r.counts?.suitable) return null;
  return (
    <button
      className="btn block"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await api('/sources/approve-suitable', { method: 'POST', body: { regionId: r.region_id } }); onDone(); } finally { setBusy(false); }
      }}
    >
      {busy ? 'Подключаем…' : `Подключить все подходящие (${r.counts.suitable})`}
    </button>
  );
}

export function Sources({ user }: { user: User }) {
  const { data: summary, reload } = useSourceSummary();
  const [region, setRegion] = useState<string | null>(null);
  const [items, setItems] = useState<SourceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDecide = user.role === 'owner' || user.role === 'admin';
  const active = region ?? summary?.[0]?.region_id ?? null;

  const loadItems = useCallback(() => {
    if (!active) return;
    api<SourceItem[]>(`/sources?region=${encodeURIComponent(active)}`).then(setItems, (e: Error) => setError(e.message));
  }, [active]);
  useEffect(loadItems, [loadItems]);

  const decide = async (ids: string[], what: 'approve' | 'decline') => {
    try { await api(`/sources/${what}`, { method: 'POST', body: { ids } }); loadItems(); reload(); } catch (e) { setError((e as Error).message); }
  };

  const current = summary?.find((s) => s.region_id === active);
  const groups: Array<[string, SourceItem[]]> = items
    ? [
        ['Подходят', items.filter((i) => i.verdict === 'suitable' && !i.decision)],
        ['Нужно ваше решение', items.filter((i) => i.verdict === 'review' && !i.decision)],
        ['Подключены', items.filter((i) => i.decision === 'approved')],
        ['Проверяем', items.filter((i) => i.verdict === 'pending')],
        ['Отклонены вами', items.filter((i) => i.decision === 'declined')],
        ['Нельзя подключить', items.filter((i) => i.verdict === 'rejected')],
      ]
    : [];

  return (
    <Page
      title="Источники"
      back="/"
      lead="Агентства находятся сами по регионам ваших поисков. Сайт каждого проверяется: разрешён ли сбор, нет ли защиты от ботов, что сказано в условиях. Подключаются только те, что вы одобрили."
    >
      <ErrorBox error={error} />
      {summary?.length === 0 && <p className="muted">Пока пусто. Создайте поиск и выберите регион или провинцию — поиск агентств начнётся сам.</p>}
      {summary && summary.length > 1 && (
        <div className="chips" style={{ marginBottom: 16 }}>
          {summary.map((s) => (
            <button key={s.region_id} className="chip" aria-pressed={s.region_id === active} onClick={() => setRegion(s.region_id)}>{s.region_name}</button>
          ))}
        </div>
      )}
      {current && (
        <section className="group">
          <h3>{current.region_name}</h3>
          <p style={{ marginTop: 0 }}>{regionLine(current)}.</p>
          {current.status === 'done' && current.without_website + current.excluded > 0 && (
            <p className="muted" style={{ marginTop: 0 }}>
              Ещё {current.without_website + current.excluded} агентств без своего сайта или только на порталах — их не используем.
            </p>
          )}
          {canDecide && <p><ApproveSuitable r={current} onDone={() => { loadItems(); reload(); }} /></p>}
        </section>
      )}
      {groups.filter(([, list]) => list.length).map(([title, list]) => (
        <section key={title}>
          <h2>{title} <span className="muted num">{list.length}</span></h2>
          <ul className="list">
            {list.map((s) => (
              <li key={s.id}>
                <div style={{ display: 'block' }}>
                  <div className="title">{s.name}</div>
                  <div className="sub">
                    <a href={s.url} target="_blank" rel="noreferrer noopener">{s.url.replace('https://', '')}</a>
                    {s.city ? `, ${s.city}` : ''}
                  </div>
                  {s.verdict !== 'pending' && (
                    <div className="sub" style={{ marginTop: 6 }}>
                      {s.reasons.length ? s.reasons.join('; ') : 'Проверка пройдена: сбор разрешён, защиты нет, объявления видны.'}
                      {s.terms && s.verdict !== 'rejected' ? ` Условия: ${s.terms}` : ''}
                    </div>
                  )}
                  {canDecide && !s.decision && (s.verdict === 'suitable' || s.verdict === 'review') && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button className="btn small" onClick={() => decide([s.id], 'approve')}>Подключить</button>
                      <button className="btn quiet small" onClick={() => decide([s.id], 'decline')}>Не подключать</button>
                    </div>
                  )}
                  {s.decision === 'approved' && <div className="sub" style={{ marginTop: 6 }}>Подключено. Сбор объявлений начнётся, когда будет готов адаптер под этот тип сайта{s.platform && s.platform !== 'generic' ? ` (${s.platform})` : ''}.</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Page>
  );
}
