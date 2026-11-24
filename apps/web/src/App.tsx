import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Calculator } from './pages/Calculator';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { More } from './pages/More';
import { ProfileEdit, ProfilesList } from './pages/Profiles';
import { Sources } from './pages/Sources';
import { Favorites } from './pages/Feed';
import { Property } from './pages/Property';
import { MapPage, Market, Portfolio, Share } from './pages/Extra';
import { useRoute } from './ui';

const I = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></>,
  calc: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8.5 7.5h7M8.5 12h1m3 0h1m-5 4h1m3 0h1" /></>,
  map: <><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z" /><path d="M9 4v13.5M15 6.5V20" /></>,
  more: <><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></>,
};
const icon = (p: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p}</svg>
);

const TABS = [
  { path: '/', label: 'Главная', icon: I.home, match: (r: string) => r === '/' || r.startsWith('/p/') },
  { path: '/profiles', label: 'Поиски', icon: I.search, match: (r: string) => r.startsWith('/profiles') },
  { path: '/map', label: 'Карта', icon: I.map, match: (r: string) => r.startsWith('/map') },
  { path: '/calc', label: 'Расчёт', icon: I.calc, match: (r: string) => r.startsWith('/calc') },
  { path: '/more', label: 'Ещё', icon: I.more, match: (r: string) => r.startsWith('/more') },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [offline, setOffline] = useState(false);
  const route = useRoute();
  // Android "Share" opens /share?url=… (manifest share_target); move it into the hash router
  useEffect(() => {
    if (location.pathname === '/share') {
      const q = new URLSearchParams(location.search);
      const shared = q.get('url') ?? (q.get('text') ?? '').match(/https?:\/\/\S+/)?.[0] ?? '';
      history.replaceState(null, '', `/#/share?u=${encodeURIComponent(shared)}`);
      dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, []);
  const refresh = useCallback(() => {
    api<Me>('/auth/me').then((m) => { setMe(m); setOffline(false); }, () => setOffline(true));
  }, []);
  useEffect(refresh, [refresh]);

  if (offline && !me) return <div className="gate"><div className="gate-inner"><h1>Нет связи с сервером</h1><p>Проверьте интернет и откройте приложение ещё раз.</p><button className="btn" onClick={refresh}>Повторить</button></div></div>;
  if (!me) return null;
  if (!me.user) return <Login me={me} onDone={refresh} />;

  let page: React.ReactNode;
  const path = route.split('?')[0]!;
  const m = path.match(/^\/profiles\/(.+)$/);
  const pm = path.match(/^\/p\/(.+)$/);
  if (path === '/profiles') page = <ProfilesList />;
  else if (pm) page = <Property key={pm[1]} id={pm[1]!} user={me.user} />;
  else if (path === '/favorites') page = <Favorites />;
  else if (path === '/map') page = <MapPage />;
  else if (path === '/share') page = <Share />;
  else if (path === '/portfolio') page = <Portfolio />;
  else if (path === '/market') page = <Market />;
  else if (m) page = <ProfileEdit key={m[1]} id={m[1] === 'new' ? null : m[1]!} />;
  else if (path === '/calc') page = <Calculator key={route} />;
  else if (path === '/sources') page = <Sources user={me.user} />;
  else if (path === '/more') page = <More user={me.user} onLogout={() => { setMe({ ...me, user: null }); refresh(); }} />;
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
