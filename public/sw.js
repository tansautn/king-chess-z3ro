/**
 * King Chess — Service Worker.
 *
 *   • Precaches the whole app shell so the game works fully OFFLINE.
 *   • Owns the background-sync "unit": when connectivity returns, it reads the
 *     un-synced games out of IndexedDB and POSTs them to /api/sync, then marks
 *     them synced. Triggered by the Background Sync API ('sync' event) or, on
 *     browsers without it (e.g. Safari), by a 'sync-now' message from the page.
 *
 * Kept as a classic worker for maximum install compatibility, so it embeds its
 * own small IndexedDB helper mirroring db.js (keep the constants in sync).
 */

const CACHE = 'king-chess-279e1e4.1784566257655';
const SYNC_TAG = 'sync-games';

// Must match db.js
const DB_NAME = 'king-chess';
const DB_VERSION = 1;
const STORE = 'games';

// NOTE: only cache '/', not '/index.html' — Cloudflare Assets 307-redirects
// /index.html to /, and cache.addAll() rejects on a redirected response.
const APP_SHELL = [
  '/',
  '/app.css',
  '/app.js',
  '/version.js',
  '/engine.js',
  '/db.js',
  '/ai-worker.js',
  '/vendor/chess.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache the API; just try the network.
  if (url.pathname.startsWith('/api/')) return;

  // App navigations: serve the cached shell ('/') so offline launches work
  // for any route (single-page app).
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then((cached) => cached || fetch(request)),
    );
    return;
  }

  // Static assets: cache-first, then network (and cache what we fetch).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
  }
});

// --- Background sync ---------------------------------------------------------

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(syncGames());
  }
});

// Fallback trigger for browsers without the Background Sync API.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'sync-now') {
    event.waitUntil(syncGames());
  }
});

async function syncGames() {
  let unsynced;
  try {
    unsynced = await idbGetUnsynced();
  } catch {
    return;
  }
  if (!unsynced.length) return;

  let result;
  try {
    result = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ games: unsynced }),
    });
  } catch {
    // Offline again — Background Sync will retry this tag automatically.
    throw new Error('sync-failed');
  }

  if (!result.ok) throw new Error('sync-rejected');

  const data = await result.json().catch(() => ({}));
  const acceptedIds = Array.isArray(data.accepted)
    ? data.accepted
    : unsynced.map((g) => g.id);

  await idbMarkSynced(acceptedIds);
  await notifyClients({ type: 'synced', ids: acceptedIds });
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

// --- Minimal IndexedDB helper (mirrors db.js) -------------------------------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('synced', 'synced', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetUnsynced() {
  const db = await idbOpen();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const all = await reqToPromise(store.getAll());
  db.close();
  return all.filter((g) => !g.synced);
}

async function idbMarkSynced(ids) {
  const db = await idbOpen();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  for (const id of ids) {
    const rec = await reqToPromise(store.get(id));
    if (rec) {
      rec.synced = 1;
      rec.syncedAt = Date.now();
      await reqToPromise(store.put(rec));
    }
  }
  db.close();
}
