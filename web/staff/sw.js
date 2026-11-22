/*
 * Jet Mobility Staff — фоновый помощник (service worker).
 * Нужен, чтобы телефон предлагал установить портал как приложение, и чтобы
 * приложение открывалось без сети (покажет «нет связи», данные — с сервера).
 * Файлы берём из сети, а копию держим на случай, если сети нет. API не трогаем.
 */
const CACHE = 'jm-staff-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/')).catch(() => null).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Только страница портала и его файлы в корне (staff.js, staff.css, иконки);
  // API, фото и загрузки — всегда напрямую
  const shell = request.mode === 'navigate' || (url.origin === location.origin && /^\/[^/]+\.(js|css|webp|png|json)$/.test(url.pathname) && url.pathname !== '/sw.js');
  if (!shell) return;
  const key = request.mode === 'navigate' ? '/' : request;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then(async (cache) => {
        // Старые версии того же файла (?v=…) убираем, чтобы копия не росла
        if (request.mode !== 'navigate') {
          for (const old of await cache.keys()) if (new URL(old.url).pathname === url.pathname) await cache.delete(old);
        }
        await cache.put(key, copy);
      });
    }
    return response;
  }).catch(() => caches.match(key).then((hit) => hit || Response.error())));
});
