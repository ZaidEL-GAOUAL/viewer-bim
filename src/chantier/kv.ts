// Le stockage de l'appareil pour le suivi de chantier : IndexedDB, un magasin par table, plus les fichiers (photos, plans, en
// Blob), la file d'envoi et quelques réglages. Une écriture peut toucher plusieurs magasins en une transaction : une ligne et
// sa modification en file sont gardées ensemble ou pas du tout. Sans IndexedDB (navigation privée, stockage bloqué), un
// stockage en mémoire prend sa place : la page marche, rien n'est gardé après sa fermeture, et elle le dit.

export const STORES = ['profiles', 'organisations', 'projects', 'memberships', 'topics', 'comments', 'viewpoints', 'photos', 'plans', 'events', 'files', 'queue', 'meta'] as const;
export type StoreName = (typeof STORES)[number];
type Key = string | number;

/** Une écriture : `value` absent supprime la clé. */
export interface KvWrite {
  store: StoreName;
  key: Key;
  value?: unknown;
}

export interface Kv {
  /** Vrai si ce qui est écrit survit à la fermeture de la page. */
  readonly persistent: boolean;
  all(store: StoreName): Promise<unknown[]>;
  get(store: StoreName, key: Key): Promise<unknown>;
  /** Toutes les écritures en une transaction. */
  write(writes: readonly KvWrite[]): Promise<void>;
  /** Vide tous les magasins. */
  clear(): Promise<void>;
}

export function memoryKv(): Kv {
  const data = new Map<StoreName, Map<Key, unknown>>(STORES.map((name) => [name, new Map()]));
  return {
    persistent: false,
    all: async (store) => [...data.get(store)!.values()].map((value) => structuredClone(value)),
    get: async (store, key) => structuredClone(data.get(store)!.get(key)),
    write: async (writes) => {
      for (const { store, key, value } of writes) {
        if (value === undefined) data.get(store)!.delete(key);
        else data.get(store)!.set(key, structuredClone(value));
      }
    },
    clear: async () => { for (const map of data.values()) map.clear(); },
  };
}

const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB'));
});
const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
});

/** IndexedDB ; échoue si la base ne s'ouvre pas. */
export async function indexedDbKv(factory: IDBFactory, name: string): Promise<Kv> {
  const request = factory.open(name, 1);
  request.onupgradeneeded = () => {
    for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB bloquée par un autre onglet'));
  });
  return {
    persistent: true,
    all: (store) => result(db.transaction(store).objectStore(store).getAll()),
    get: (store, key) => result(db.transaction(store).objectStore(store).get(key)),
    write: async (writes) => {
      if (writes.length === 0) return;
      const transaction = db.transaction([...new Set(writes.map((write) => write.store))], 'readwrite');
      const finished = done(transaction);
      for (const { store, key, value } of writes) {
        if (value === undefined) transaction.objectStore(store).delete(key);
        else transaction.objectStore(store).put(value, key);
      }
      await finished;
    },
    clear: async () => {
      const transaction = db.transaction([...STORES], 'readwrite');
      const finished = done(transaction);
      for (const store of STORES) transaction.objectStore(store).clear();
      await finished;
    },
  };
}

/** Le stockage de ce navigateur ; en mémoire (jamais d'erreur) si IndexedDB manque ou refuse de s'ouvrir. */
export async function openKv(name: string, factory: IDBFactory | null | undefined = globalThis.indexedDB): Promise<Kv> {
  if (!factory) return memoryKv();
  try {
    return await indexedDbKv(factory, name);
  } catch {
    return memoryKv();
  }
}
