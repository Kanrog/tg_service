const CACHE_NAME   = 'service-sjekkliste-v4';
const RUNTIME_CACHE = 'service-sjekkliste-runtime-v4';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.map(name => {
        if (name !== CACHE_NAME && name !== RUNTIME_CACHE) return caches.delete(name);
      }))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.hostname === 'docs.google.com' && url.pathname.includes('/export')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fresh = fetch(request).then(res => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }

  if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(res => { caches.open(CACHE_NAME).then(c => c.put(request, res.clone())); return res; })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res || res.status !== 200 || res.type === 'error') return res;
        caches.open(RUNTIME_CACHE).then(c => c.put(request, res.clone()));
        return res;
      });
    })
  );
});

// Push event - fired by FCM when Cloudflare Worker sends a notification
self.addEventListener('push', (event) => {
  console.log('[SW] Push received');
  let data = { title: 'Service Sjekkliste', body: 'Ny påminnelse', tag: 'reminder' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:             data.body,
      icon:             './icons/icon-192x192.png',
      badge:            './icons/icon-72x72.png',
      tag:              data.tag || 'reminder',
      requireInteraction: true,
      renotify:         true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
