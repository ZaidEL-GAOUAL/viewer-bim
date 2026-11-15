// Les études gardées dans ce navigateur (IndexedDB), en attendant les comptes : chaque étude est enregistrée à chaque
// changement et listée sur l'écran d'accueil ; les maquettes posées sur un site y sont gardées à part (leur géométrie
// n'est pas dans le fichier de l'étude) ; le viewer y dépose la maquette qu'il envoie à l'étude. Sans IndexedDB
// (navigation privée, stockage bloqué), le magasin est « indisponible » : rien n'est gardé, la page le dit et
// travaille avec des fichiers. Le stockage est derrière une petite interface (`Backend`) que les tests remplacent.

import type { ModelSnapshot } from './placedModel.ts';
import { parseStudy, type Study } from './study.ts';

export type StoreName = 'studies' | 'models' | 'handoff';
const STORES: readonly StoreName[] = ['studies', 'models', 'handoff'];
const DATABASE = 'etude-de-site';

export interface Backend {
  getAll(store: StoreName): Promise<unknown[]>;
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
}

export interface StudySummary {
  id: string;
  name: string;
  /** Lieu (nom complet) ou coordonnées. */
  place: string;
  /** Dernier enregistrement (ISO 8601). */
  updatedAt: string;
}

interface StudyRecord extends StudySummary {
  study: Study;
}

interface ModelRecord {
  studyId: string;
  snapshot: ModelSnapshot;
}

const HANDOFF_KEY = 'maquette';

const asPromise = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
});

/** IndexedDB derrière l'interface `Backend` ; échoue si la base ne s'ouvre pas. */
export async function indexedDbBackend(factory: IDBFactory): Promise<Backend> {
  const request = factory.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB bloquée par un autre onglet'));
  });
  const run = async <T>(store: StoreName, mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const transaction = db.transaction(store, mode);
    // Une écriture ne compte qu'une fois la transaction terminée (l'espace peut manquer à ce moment-là).
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB'));
    });
    done.catch(() => undefined);
    const result = await asPromise(action(transaction.objectStore(store)));
    if (mode === 'readwrite') await done;
    return result;
  };
  return {
    getAll: (store) => run(store, 'readonly', (objects) => objects.getAll()),
    get: (store, key) => run(store, 'readonly', (objects) => objects.get(key)),
    put: async (store, key, value) => { await run(store, 'readwrite', (objects) => objects.put(value, key)); },
    delete: async (store, key) => { await run(store, 'readwrite', (objects) => objects.delete(key)); },
  };
}

const placeOf = (study: Study): string => study.site.place
  ?? `${study.site.origin.latitude.toFixed(4)}°, ${study.site.origin.longitude.toFixed(4)}°`;

export class StudyStore {
  private readonly backend: Backend | null;

  constructor(backend: Backend | null) {
    this.backend = backend;
  }

  /** Faux : rien n'est gardé dans ce navigateur. */
  get available(): boolean {
    return this.backend !== null;
  }

  /** Les études gardées, la plus récente d'abord ; vide si le magasin est indisponible ou illisible. */
  async list(): Promise<StudySummary[]> {
    if (!this.backend) return [];
    try {
      const records = (await this.backend.getAll('studies')) as Partial<StudyRecord>[];
      return records
        .filter((r): r is StudyRecord => typeof r?.id === 'string' && typeof r.updatedAt === 'string')
        .map(({ id, name, place, updatedAt }) => ({ id, name: name || 'Étude', place: place || '', updatedAt }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  /** Garde l'étude ; faux si elle n'a pas pu l'être (magasin indisponible, espace plein). */
  async save(study: Study, now: Date = new Date()): Promise<boolean> {
    if (!this.backend) return false;
    // Une copie JSON : ce qui est gardé est exactement ce qu'un fichier aurait porté.
    const record: StudyRecord = { id: study.id, name: study.name, place: placeOf(study), updatedAt: now.toISOString(), study: JSON.parse(JSON.stringify(study)) as Study };
    try {
      await this.backend.put('studies', study.id, record);
      return true;
    } catch {
      return false;
    }
  }

  /** L'étude gardée sous cet identifiant, relue comme un fichier ; null si elle n'y est pas. Lève si elle est illisible. */
  async open(id: string): Promise<Study | null> {
    if (!this.backend) return null;
    const record = (await this.backend.get('studies', id)) as Partial<StudyRecord> | undefined;
    if (!record?.study) return null;
    const study = parseStudy(record.study);
    study.id = id;
    return study;
  }

  /** Retire l'étude et les maquettes posées sur son site. */
  async remove(id: string): Promise<void> {
    if (!this.backend) return;
    const study = await this.open(id).catch(() => null);
    await this.backend.delete('studies', id);
    for (const model of study?.models ?? []) await this.backend.delete('models', model.id).catch(() => undefined);
  }

  async saveModel(studyId: string, snapshot: ModelSnapshot): Promise<boolean> {
    if (!this.backend) return false;
    try {
      await this.backend.put('models', snapshot.id, { studyId, snapshot } satisfies ModelRecord);
      return true;
    } catch {
      return false;
    }
  }

  /** La géométrie d'une maquette gardée ; null si elle n'est pas dans ce navigateur. */
  async model(id: string): Promise<ModelSnapshot | null> {
    if (!this.backend) return null;
    const record = (await this.backend.get('models', id).catch(() => undefined)) as ModelRecord | undefined;
    return record?.snapshot ?? null;
  }

  async removeModel(id: string): Promise<void> {
    await this.backend?.delete('models', id).catch(() => undefined);
  }

  /** Le viewer dépose ici la maquette qu'il envoie à l'étude ; lève si le magasin est indisponible ou plein. */
  async putHandoff(snapshot: ModelSnapshot): Promise<void> {
    if (!this.backend) throw new Error('ce navigateur ne garde rien (navigation privée ?)');
    await this.backend.put('handoff', HANDOFF_KEY, snapshot);
  }

  /** La maquette déposée par le viewer, retirée du magasin (une seule lecture) ; null s'il n'y en a pas. */
  async takeHandoff(): Promise<ModelSnapshot | null> {
    if (!this.backend) return null;
    const snapshot = (await this.backend.get('handoff', HANDOFF_KEY).catch(() => undefined)) as ModelSnapshot | undefined;
    if (snapshot) await this.backend.delete('handoff', HANDOFF_KEY).catch(() => undefined);
    return snapshot ?? null;
  }
}

/** Le magasin de ce navigateur ; « indisponible » (jamais d'erreur) si IndexedDB manque ou refuse de s'ouvrir. */
export async function openStudyStore(factory: IDBFactory | null | undefined = globalThis.indexedDB): Promise<StudyStore> {
  if (!factory) return new StudyStore(null);
  try {
    return new StudyStore(await indexedDbBackend(factory));
  } catch {
    return new StudyStore(null);
  }
}
