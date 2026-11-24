import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Calculator } from './pages/Calculator';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { More } from './pages/More';
import { ProfileEdit, ProfilesList } from './pages/Profiles';
import { useRoute } from './ui';

const I = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></>,
  calc: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8.5 7.5h7M8.5 12h1m3 0h1m-5 4h1m3 0h1" /></>,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
};
const icon = (p: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>
);

const TABS = [
  { path: '/', label: 'Главная', icon: I.home, match: (r: string) => r === '/' },
  { path: '/profiles', label: 'Поиски', icon: I.search, match: (r: string) => r.startsWith('/profiles') },
  { path: '/calc', label: 'Расчёт', icon: I.calc, match: (r: string) => r.startsWith('/calc') },
  { path: '/more', label: 'Ещё', icon: I.more, match: (r: string) => r.startsWith('/more') },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const route = useRoute();
  const refresh = useCallback(() => {
    api<Me>('/auth/me').then((m) => { setMe(m); setOffline(false); }, () => setOffline(true));
  }, []);
  useEffect(refresh, [refresh]);

  if (offline && !me) return <div className="gate"><div className="gate-inner"><h1>Нет связи с сервером</h1><p>Проверьте интернет и откройте приложение ещё раз.</p><button className="btn" onClick={refresh}>Повторить</button></div></div>;
  if (!me) return null;
  if (!me.user) return <Login me={me} onDone={refresh} />;

  let page: React.ReactNode;
  const m = route.match(/^\/profiles\/(.+)$/);
  if (route === '/profiles') page = <ProfilesList />;
  else if (m) page = <ProfileEdit key={m[1]} id={m[1] === 'new' ? null : m[1]!} />;
  else if (route === '/calc') page = <Calculator />;
  else if (route === '/more') page = <More user={me.user} onLogout={() => { setMe({ ...me, user: null }); refresh(); }} />;
  else page = <Home user={me.user} />;

  return (
    <div className="shell">
      <nav className="nav" aria-label="Разделы">
        {TABS.map((t) => (
          <a key={t.path} href={`#${t.path}`} aria-current={t.match(route) ? 'page' : undefined}>
            {icon(t.icon)}
            {t.label}
          </a>
        ))}
      </nav>
      {page}
    </div>
  );
}
