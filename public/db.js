/**
 * King Chess — IndexedDB storage for game history.
 *
 * Every game the child plays is persisted locally (works fully offline). Each
 * record carries a `synced` flag (0/1) so the Service Worker can push the
 * un-synced ones to the server once the network comes back.
 *
 * The Service Worker (sw.js) opens the SAME database with the SAME constants —
 * keep DB_NAME / DB_VERSION / STORE in sync between the two files.
 */
export const DB_NAME = 'king-chess';
export const DB_VERSION = 1;
export const STORE = 'games';

function openDB() {
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

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Insert or update a game record. Always marks it un-synced. */
export async function saveGame(record) {
  const db = await openDB();
  const full = { synced: 0, ...record, updatedAt: Date.now() };
  await toPromise(tx(db, 'readwrite').put(full));
  db.close();
  return full;
}

export async function getGame(id) {
  const db = await openDB();
  const result = await toPromise(tx(db, 'readonly').get(id));
  db.close();
  return result;
}

/** All games, newest first. */
export async function getAllGames() {
  const db = await openDB();
  const all = await toPromise(tx(db, 'readonly').getAll());
  db.close();
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteGame(id) {
  const db = await openDB();
  await toPromise(tx(db, 'readwrite').delete(id));
  db.close();
}

/** Games that still need to be pushed to the server. */
export async function getUnsynced() {
  const all = await getAllGames();
  return all.filter((g) => !g.synced);
}

export async function markSynced(ids) {
  const db = await openDB();
  const store = tx(db, 'readwrite');
  for (const id of ids) {
    const rec = await toPromise(store.get(id));
    if (rec) {
      rec.synced = 1;
      rec.syncedAt = Date.now();
      await toPromise(store.put(rec));
    }
  }
  db.close();
}
