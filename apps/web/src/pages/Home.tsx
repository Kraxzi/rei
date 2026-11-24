import { useEffect, useState } from 'react';
import { api, type SearchProfile, type User } from '../api';

export function Home({ user }: { user: User }) {
  const [profiles, setProfiles] = useState<SearchProfile[] | null>(null);
  useEffect(() => { api<SearchProfile[]>('/profiles').then(setProfiles, () => setProfiles([])); }, []);
  const active = profiles?.filter((p) => p.isActive).length ?? 0;

  return (
    <main className="page">
      <h1 className="page-title">Здравствуйте, {user.displayName}</h1>
      <p className="page-lead">
        Сейчас здесь можно настроить, что искать, и посчитать доходность любого объекта. Автоматический поиск объявлений
        подключается следующим этапом — первыми будут аукционы и агентства Лигурии.
      </p>

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

      <h2>Что будет дальше</h2>
      <p className="muted">Находки по вашим поискам, снижения цен и аукционы будут появляться здесь и приходить уведомлением на телефон.</p>
    </main>
  );
}
