// Service worker: shows pushed spending alerts in the system notification tray.
const CACHE = 'dompet-v3';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/app.js', '/js/core.js', '/js/pages.js', '/js/charts.js', '/js/notify.js',
  '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// Network first so updates show immediately; cached shell only when offline. API calls are never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    } catch {
      return (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error());
    }
  })());
});

self.addEventListener('push', event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: 'Dompet Harian', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || 'Dompet Harian', {
    body: d.body || '', tag: d.tag || 'dompet', renotify: true,
    icon: '/icon.svg', badge: '/icon.svg', data: { url: d.url || '/#/dashboard' },
    requireInteraction: d.level === 'bahaya'
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
