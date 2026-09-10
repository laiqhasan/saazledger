/**
 * Client-Side IndexedDB Photo Cache & Self-Healing Service
 * 
 * Provides local resilience against ephemeral cloud container rebuilds (e.g. Railway).
 * 1. Caches uploaded jewelry photos in browser IndexedDB (hundreds of MBs available).
 * 2. If an image returns 404 from the server, automatically restores it from the local cache.
 * 3. Self-heals the backend server in the background by re-posting the image to /api/photos/restore.
 */

const DB_NAME = 'saaz_ledger_photo_cache_v1';
const STORE_NAME = 'photos';
const DB_VERSION = 1;

interface CachedPhotoRecord {
  filename: string;
  url: string;
  dataUrl: string;
  mimeType: string;
  savedAt: number;
}

let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

function getDb(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported in this environment'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'filename' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.warn('[PhotoCache] IndexedDB open error:', (event.target as IDBOpenDBRequest).error);
      reject((event.target as IDBOpenDBRequest).error);
    };
  });

  return dbPromise;
}

export function extractFilename(urlOrFilename: string): string {
  if (!urlOrFilename) return '';
  const clean = urlOrFilename.split('?')[0].split('#')[0];
  if (clean.includes('/api/photos/')) {
    return clean.split('/api/photos/')[1];
  }
  const parts = clean.split('/');
  return parts[parts.length - 1];
}

/**
 * Cache photo data URL in IndexedDB
 */
export async function savePhotoToClientCache(urlOrFilename: string, dataUrl: string): Promise<void> {
  const filename = extractFilename(urlOrFilename);
  if (!filename || !dataUrl || !dataUrl.startsWith('data:')) {
    return;
  }

  try {
    const db = await getDb();
    const mimeMatch = dataUrl.match(/^data:([^;]+);/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    const record: CachedPhotoRecord = {
      filename,
      url: `/api/photos/${filename}`,
      dataUrl,
      mimeType,
      savedAt: Date.now(),
    };

    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[PhotoCache] Failed saving to IndexedDB:', err);
  }
}

/**
 * Retrieve cached photo data URL from IndexedDB
 */
export async function getCachedPhotoFromClient(urlOrFilename: string): Promise<string | null> {
  const filename = extractFilename(urlOrFilename);
  if (!filename) return null;

  try {
    const db = await getDb();
    return await new Promise<string | null>((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const req = store.get(filename);
      req.onsuccess = () => {
        const result = req.result as CachedPhotoRecord | undefined;
        resolve(result ? result.dataUrl : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Re-uploads a cached photo to the backend /api/photos/restore endpoint
 */
export async function healPhotoOnServer(urlOrFilename: string): Promise<boolean> {
  const filename = extractFilename(urlOrFilename);
  if (!filename) return false;

  const dataUrl = await getCachedPhotoFromClient(filename);
  if (!dataUrl) return false;

  try {
    const res = await fetch('/api/photos/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, base64Data: dataUrl }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[PhotoCache] Background healing error:', err);
    return false;
  }
}

/**
 * Global image self-healing observer:
 * Automatically catches broken 404 images from /api/photos, swaps them with IndexedDB
 * local cache so the user never sees a broken icon, and heals the server!
 */
export function initAutoPhotoSelfHealing(): void {
  if (typeof window === 'undefined') return;

  // Use capture phase so we see the error before React
  window.addEventListener(
    'error',
    async (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target.tagName === 'IMG') {
        const img = target as HTMLImageElement;
        const src = img.src || '';
        if (src.includes('/api/photos/') && !img.dataset.healed) {
          img.dataset.healed = 'pending';
          const filename = extractFilename(src);
          const cachedDataUrl = await getCachedPhotoFromClient(filename);
          if (cachedDataUrl) {
            img.dataset.healed = 'restored';
            img.src = cachedDataUrl;
            // Background restore on server
            healPhotoOnServer(filename).catch(() => {});
          } else {
            img.dataset.healed = 'failed';
          }
        }
      }
    },
    true
  );
}
