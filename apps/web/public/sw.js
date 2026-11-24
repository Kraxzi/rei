// REI service worker: installable app, offline shell, push notifications.
// API responses are never cached — figures must always be current.
const CACHE = 'rei-shell-v2';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match('/'))),
  );
});

// Push carries no payload: fetch the newest unread notification with the user's session cookie.
self.addEventListener('push', (e) => {
  e.waitUntil(
    fetch('/api/notifications/latest', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const n = d && d.latest;
        const title = n ? n.title : 'REI: есть новости';
        const body = n ? n.body : 'Откройте приложение, чтобы посмотреть.';
        const url = n && n.property_id ? `/#/p/${n.property_id}` : '/#/';
        return self.registration.showNotification(title, { body, icon: '/icon-192.png', badge: '/icon-192.png', tag: n ? n.id : 'rei', data: { url } });
      })
      .catch(() => self.registration.showNotification('REI: есть новости', { body: 'Откройте приложение.', icon: '/icon-192.png', data: { url: '/#/' } })),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/#/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus(); }
      return self.clients.openWindow(url);
    }),
  );
});
