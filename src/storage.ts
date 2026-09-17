/**
 * Каталог весит около 30 МБ — это мимо localStorage, поэтому копия
 * разобранных данных лежит в IndexedDB. Браузер хранит её как объект,
 * так что при следующем открытии не нужен ни запрос, ни разбор JSON.
 */

const DB_NAME = 'yandex-games-analytics';
const STORE = 'files';
const VERSION = 1;

export type CacheKey = 'catalog' | 'delta' | 'tags' | 'categories';

export interface Cached<T> {
  /** Когда данные положили в браузер. */
  savedAt: string;
  /** Last-Modified файла на сервере — по нему видно, что на диске уже свежее. */
  sourceModifiedAt: string | null;
  data: T;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = act(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      }),
  );
}

export async function readCached<T>(key: CacheKey): Promise<Cached<T> | null> {
  try {
    return (await run<Cached<T> | undefined>('readonly', (store) => store.get(key))) ?? null;
  } catch {
    return null;
  }
}

/** false — хранилище недоступно или не хватило места; тогда работаем без копии. */
export async function writeCached<T>(key: CacheKey, entry: Cached<T>): Promise<boolean> {
  try {
    await run('readwrite', (store) => store.put(entry, key));
    return true;
  } catch {
    return false;
  }
}

export async function clearCached(): Promise<void> {
  try {
    await run('readwrite', (store) => store.clear());
  } catch {
    // см. writeCached
  }
}
