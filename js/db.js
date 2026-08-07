/*
 * db.js — a tiny IndexedDB wrapper.
 *
 * Everything pdfThings persists (saved signatures, the recent-files list,
 * user settings, in-progress drafts) lives in one IndexedDB database on
 * this device. Nothing here is ever sent anywhere.
 */
(function () {
  const DB_NAME = 'pdfThings';
  const DB_VERSION = 1;
  const STORES = ['signatures', 'recents', 'settings', 'drafts'];

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'key' });
          }
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function withStore(storeName, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const DB = {
    async get(store, key) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
        req.onerror = () => reject(req.error);
      });
    },
    async set(store, key, value) {
      return withStore(store, 'readwrite', (s) => s.put({ key, value }));
    },
    async delete(store, key) {
      return withStore(store, 'readwrite', (s) => s.delete(key));
    },
    async getAll(store) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve((req.result || []).map((r) => ({ key: r.key, value: r.value })));
        req.onerror = () => reject(req.error);
      });
    },
    async clear(store) {
      return withStore(store, 'readwrite', (s) => s.clear());
    },
  };

  window.PTDB = DB;
})();
