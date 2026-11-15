import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSnapshot } from '../src/site/placedModel.ts';
import { StudyStore, openStudyStore, type Backend, type StoreName } from '../src/site/store.ts';
import { newStudy, type Study } from '../src/site/study.ts';

/** Le stockage en mémoire, à la place d'IndexedDB (absent sous Node). `failPuts` : espace plein. */
function memoryBackend(failPuts = false): Backend & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const key = (store: StoreName, id: string) => `${store}/${id}`;
  return {
    data,
    getAll: async (store) => [...data].filter(([k]) => k.startsWith(`${store}/`)).map(([, v]) => structuredClone(v)),
    get: async (store, id) => structuredClone(data.get(key(store, id))),
    put: async (store, id, value) => {
      if (failPuts) throw new DOMException('Quota dépassé', 'QuotaExceededError');
      data.set(key(store, id), structuredClone(value));
    },
    delete: async (store, id) => { data.delete(key(store, id)); },
  };
}

function study(name: string, place?: string): Study {
  const s = newStudy();
  s.name = name;
  if (place) s.site.place = place;
  s.site.limit = [[0, 0], [20, 0], [20, 10]];
  return s;
}

const snapshot = (id: string): ModelSnapshot => ({
  id, name: 'Maquette', box: [0, 0, 0, 1, 1, 1], offset: [0, 0, 0], georeference: null, triangles: 1,
  parts: [{ positions: new Float32Array(9), normals: new Int8Array(9), colors: null, index: new Uint16Array([0, 1, 2]), transparent: false, doubleSided: false }],
});

test('une étude gardée est listée, rouverte telle quelle, puis retirée avec ses maquettes', async () => {
  const store = new StudyStore(memoryBackend());
  assert.equal(store.available, true);
  const a = study('Îlot A', 'Wadduwa, Sri Lanka'), b = study('Îlot B');
  a.models.push({ id: 'm1', name: 'Maquette', role: 'context', east: 0, north: 0, up: 0, rotation: 0, georeferenced: false, triangles: 1 });
  assert.equal(await store.save(a, new Date('2026-11-15T10:00:00Z')), true);
  assert.equal(await store.save(b, new Date('2026-11-15T11:00:00Z')), true);
  assert.equal(await store.saveModel(a.id, snapshot('m1')), true);

  // La plus récente d'abord ; le lieu, ou les coordonnées quand il n'a pas de nom.
  const list = await store.list();
  assert.deepEqual(list.map((s) => s.name), ['Îlot B', 'Îlot A']);
  assert.equal(list[1].place, 'Wadduwa, Sri Lanka');
  assert.match(list[0].place, /48\.8566°, 2\.3522°/);
  assert.equal(list[0].updatedAt, '2026-11-15T11:00:00.000Z');

  assert.deepEqual(await store.open(a.id), a);
  assert.equal((await store.model('m1'))?.id, 'm1');
  assert.equal(await store.open('inconnue'), null);

  // Enregistrée de nouveau : une seule entrée, mise à jour.
  a.name = 'Îlot A bis';
  await store.save(a, new Date('2026-11-15T12:00:00Z'));
  assert.deepEqual((await store.list()).map((s) => s.name), ['Îlot A bis', 'Îlot B']);

  await store.remove(a.id);
  assert.deepEqual((await store.list()).map((s) => s.name), ['Îlot B']);
  assert.equal(await store.model('m1'), null);
});

test('la maquette envoyée par le viewer n’est reprise qu’une fois', async () => {
  const store = new StudyStore(memoryBackend());
  await store.putHandoff(snapshot('h1'));
  assert.equal((await store.takeHandoff())?.id, 'h1');
  assert.equal(await store.takeHandoff(), null);
});

test('sans IndexedDB (navigation privée), rien n’est gardé et rien ne casse', async () => {
  for (const factory of [undefined, null, { open: () => { throw new DOMException('refusé', 'SecurityError'); } } as unknown as IDBFactory]) {
    const store = await openStudyStore(factory);
    assert.equal(store.available, false);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.save(study('X')), false);
    assert.equal(await store.open('x'), null);
    assert.equal(await store.saveModel('x', snapshot('m')), false);
    assert.equal(await store.takeHandoff(), null);
    await store.remove('x');
    await assert.rejects(store.putHandoff(snapshot('m')), /ne garde rien/);
  }
});

test('une base qui refuse de s’ouvrir rend un magasin indisponible ; un espace plein fait échouer l’enregistrement sans erreur', async () => {
  const refusing = {
    open: () => {
      const request = {} as IDBOpenDBRequest & { onerror: (() => void) | null };
      setTimeout(() => request.onerror?.(), 0);
      return request;
    },
  } as unknown as IDBFactory;
  assert.equal((await openStudyStore(refusing)).available, false);

  const full = new StudyStore(memoryBackend(true));
  assert.equal(await full.save(study('Pleine')), false);
  assert.equal(await full.saveModel('x', snapshot('m')), false);
});

test('le fichier d’une étude déjà gardée ici s’ouvre en copie : la version gardée (plus récente) n’est pas écrasée', async () => {
  const store = new StudyStore(memoryBackend());
  const kept = study('Îlot A');
  kept.models.push({ id: 'm1', name: 'Maquette', role: 'context', east: 0, north: 0, up: 0, rotation: 0, georeferenced: false, triangles: 1 });
  await store.save(kept);
  await store.saveModel(kept.id, snapshot('m1'));
  const file = structuredClone(kept);
  kept.name = 'Îlot A, version plus récente';
  await store.save(kept);

  const opened = await store.fromFile(file);
  assert.notEqual(opened.id, kept.id);
  assert.equal(opened.name, 'Îlot A (copie du fichier)');
  assert.notEqual(opened.models[0].id, 'm1', 'its models are its own');
  assert.equal((await store.model(opened.models[0].id))?.id, opened.models[0].id, 'with the geometry kept here');
  await store.save(opened);
  assert.equal((await store.open(kept.id))?.name, 'Îlot A, version plus récente');
  await store.remove(opened.id);
  assert.equal((await store.model('m1'))?.id, 'm1', 'removing the copy keeps the original’s geometry');

  const unknown = study('Îlot C');
  assert.equal(await store.fromFile(unknown), unknown, 'a study not kept here opens as it is');
});
