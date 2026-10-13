// Service Worker — Mercadito La Bota POS
// Estrategia: Network First para API, Cache First para assets estáticos

const CACHE = 'pos-v1';
const STATIC = [
  '/pos.html',
  '/logo-mercadito.png',
  '/logo.png',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
];

// Instalar: cachear assets estáticos
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(STATIC).catch(() => {}))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API calls: Network First con fallback a cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone())
        .then(res => {
          // Solo cachear GET exitosos
          if (e.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Socket.IO: siempre red, nunca cachear
  if (url.pathname.startsWith('/socket.io')) return;

  // Assets estáticos: Cache First
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
