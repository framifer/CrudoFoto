// Service Worker di CrudoFoto: abilita l'uso offline della PWA.
// Strategia: "cache-first" per gli asset dell'app (guscio applicativo).
// Al primo caricamento online mette in cache i file; poi l'app funziona
// anche senza rete. Aggiorna il numero di versione per invalidare la cache.

const CACHE_NAME = 'crudofoto-v6';

// File che compongono il "guscio" dell'app da rendere disponibili offline.
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './shutter.ogg',
  './icon-192.png',
  './icon-512.png'
];

// Installazione: pre-carica il guscio applicativo in cache.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Attivazione: rimuove le cache vecchie di versioni precedenti.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: prova prima la cache; se manca, va in rete e (se GET) la salva.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          // Salva in cache solo risposte valide e dello stesso origine.
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline e non in cache: per le navigazioni, torna alla home.
          if (req.mode === 'navigate') return caches.match('./index.html');
        });
    })
  );
});
