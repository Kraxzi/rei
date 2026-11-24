import { useEffect, useState } from 'react';
import { api, type SearchProfile, type User } from '../api';
import { ApproveSuitable, regionLine, useSourceSummary } from './Sources';
import { Feed } from './Feed';

export function Home({ user }: { user: User }) {
  const [profiles, setProfiles] = useState<SearchProfile[] | null>(null);
  useEffect(() => { api<SearchProfile[]>('/profiles').then(setProfiles, () => setProfiles([])); }, []);
  const active = profiles?.filter((p) => p.isActive).length ?? 0;
  const { data: regions, reload } = useSourceSummary();
  const canDecide = user.role === 'owner' || user.role === 'admin';
  const [notes, setNotes] = useState<Array<{ id: string; title: string; body: string; property_id: string | null; read_at: string | null; created_at: string }> | null>(null);
  useEffect(() => { api<NonNullable<typeof notes>>('/notifications').then(setNotes, () => setNotes([])); }, []);
  const unread = notes?.filter((n) => !n.read_at) ?? [];
  const markRead = async () => { await api('/notifications/read', { method: 'POST' }); setNotes(notes?.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })) ?? null); };
  const busy = regions?.some((r) => r.status === 'queued' || r.status === 'running' || (r.counts?.pending ?? 0) > 0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [busy, reload]);

  return (
    <main className="page">
      <h1 className="page-title">Здравствуйте, {user.displayName}</h1>
      <p className="page-lead">
        REI сам находит агентства в регионах ваших поисков, собирает объявления с подключённых сайтов, оценивает их и показывает лучшие здесь.
      </p>

      {unread.length > 0 && (
        <section className="group">
          <h3>Новое <span className="muted num">{unread.length}</span></h3>
          <ul className="list">
            {unread.slice(0, 8).map((n) => (
              <li key={n.id}><a href={n.property_id ? `#/p/${n.property_id}` : '#/'}><div><div className="title">{n.title}</div><div className="sub num">{n.body}</div></div></a></li>
            ))}
          </ul>
          <button className="link" onClick={markRead}>Отметить всё прочитанным</button>
        </section>
      )}

      {regions && regions.length > 0 && (
        <section className="group">
          <h3>Агентства в регионах ваших поисков</h3>
          {regions.map((r) => (
            <div key={r.region_id} style={{ marginBottom: 14 }}>
              <div><strong>{r.region_name}:</strong> {regionLine(r)}.</div>
              {canDecide && <div style={{ marginTop: 10 }}><ApproveSuitable r={r} onDone={reload} /></div>}
            </div>
          ))}
          <p style={{ marginTop: 0 }}><a className="link" href="#/sources">Посмотреть все агентства и причины</a></p>
        </section>
      )}

      <ul className="list">
        <li>
          <a href="#/profiles">
            <div>
              <div className="title">Мои поиски</div>
              <div className="sub">
                {profiles === null ? 'Загружаем…' : profiles.length === 0 ? 'Пока ни одного — создайте первый' : `Активных: ${active} из ${profiles.length}`}
              </div>
            </div>
            <span className="pill num">{profiles?.length ?? '…'}</span>
          </a>
        </li>
        <li>
          <a href="#/calc">
            <div>
              <div className="title">Посчитать объект</div>
              <div className="sub">Доходность, окупаемость и три сценария на 1, 3 и 5 лет</div>
            </div>
          </a>
        </li>
      </ul>

      <Feed />
    </main>
  );
}
