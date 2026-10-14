// Service worker: guarda la app en el dispositivo para que abra sin internet.
// Los datos del negocio NO pasan por aquí; viven en la base de datos del navegador.
const VERSION = 'caraudio-v3';
const BASE = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/favicon.svg', '/fondo-acceso.svg', '/isotipo.svg', '/assets/sql-wasm.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(BASE).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Primero la red (para recibir versiones nuevas); si no hay internet, lo guardado.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // La API nunca se guarda: sin internet debe fallar para que la app trabaje en local
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copia = res.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
