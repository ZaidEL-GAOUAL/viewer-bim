import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Color, Sphere } from 'three';
import { ownValue, parseMetadata } from '../src/data/metadata.ts';
import { evaluatePhases } from '../src/data/phases.ts';
import { cameraPose, hiddenByView } from '../src/data/savedViews.ts';
import { buildModel, type RawModel } from '../src/engine/buildModel.ts';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { initSync, readRevit as readRevitWasm, type RevitChunk, type RevitOutput } from '../src/revit/pkg/revit.js';
import {
  PRUDENT_WARNING, RevitTooLargeError, deviceTriangleBudget, triangleBudgetFor, isMemoryFailure, isPanicFailure, isRevitFile, metadataFromChunks, rawFromChunk, rawFromOutput, readRevit, revitFailureToError, splitRevitName, type RevitReport,
} from '../src/revit/readRevit.ts';
import { describeRevitReport } from '../src/revit/revitReport.ts';

/** Le modèle brut d'une lecture arrivée d'un bloc (sans message `chunk`) : un seul morceau. */
function single(raw: RawModel | RawModel[]): RawModel {
  assert.ok(!Array.isArray(raw), 'un seul modèle brut attendu');
  return raw;
}

const integer = new Intl.NumberFormat('fr-FR');
const select = () => ({ value: new Color() });

// ------------------------------------------------------------------------ fichiers et taille
test('un projet .rvt, une famille .rfa et leurs gabarits .rte et .rft se reconnaissent à leur extension, majuscules comprises', () => {
  assert.equal(isRevitFile('maquette.rvt'), true);
  assert.equal(isRevitFile('MAQUETTE.RVT'), true);
  assert.equal(isRevitFile('projet.v2.Rvt'), true);
  assert.equal(isRevitFile('maquette.rvt.txt'), false);
  assert.equal(isRevitFile('famille.rfa'), true);
  assert.equal(isRevitFile('FAMILLE.RFA'), true);
  assert.equal(isRevitFile('famille.rfa.txt'), false);
  assert.equal(isRevitFile('gabarit.rte'), true);
  assert.equal(isRevitFile('Gabarit.RTE'), true);
  assert.equal(isRevitFile('gabarit.rte.txt'), false);
  assert.equal(isRevitFile('famille.rft'), true);
  assert.equal(isRevitFile('FAMILLE.Rft'), true);
  assert.equal(isRevitFile('famille.rft.bak'), false);
  assert.equal(isRevitFile('maquette.ifc'), false);
  assert.equal(isRevitFile('rvt'), false);
  assert.equal(isRevitFile('rte'), false);
});

test('le nom d’un fichier Revit se sépare de son extension, qui reste la sienne (rte et rft comme rvt et rfa)', () => {
  assert.deepEqual(splitRevitName('maquette.rvt'), { base: 'maquette', extension: 'rvt' });
  assert.deepEqual(splitRevitName('Projet.v2.RFA'), { base: 'Projet.v2', extension: 'rfa' });
  assert.deepEqual(splitRevitName('RiR-Template-2018.rte'), { base: 'RiR-Template-2018', extension: 'rte' });
  assert.deepEqual(splitRevitName('Famille métrique.RFT'), { base: 'Famille métrique', extension: 'rft' });
  assert.deepEqual(splitRevitName('sans-extension'), { base: 'sans-extension', extension: 'rvt' });
});

test('le budget de triangles suit la mémoire de l’appareil : un quart pour le modèle, entre 2 et 20 millions', () => {
  // 2,5 millions de triangles par Go (≈ 100 octets par triangle au fil principal) ; 4 Go quand le navigateur ne dit rien.
  assert.equal(triangleBudgetFor(8), 20e6);
  assert.equal(triangleBudgetFor(4), 10e6);
  assert.equal(triangleBudgetFor(2), 5e6);
  assert.equal(triangleBudgetFor(1), 2.5e6);
  assert.equal(triangleBudgetFor(0.25), 2e6, 'jamais moins de 2 millions');
  assert.equal(triangleBudgetFor(64), 20e6, 'jamais plus de 20 millions');
  assert.equal(triangleBudgetFor(undefined), 10e6);
  assert.equal(triangleBudgetFor(Number.NaN), 10e6);
  assert.equal(deviceTriangleBudget(), triangleBudgetFor((navigator as Navigator & { deviceMemory?: number }).deviceMemory));
});

test('plus de limite de taille : un gros .rvt part au lecteur, avec le budget de triangles de l’appareil', async (t) => {
  withFakeWorker(t);
  const big = new File([new Uint8Array(1)], 'grande-maquette.rvt');
  const reading = readRevit(big, () => {});
  const worker = FakeWorker.instances[0];
  const { options } = worker.requests[0];
  assert.equal(options?.triangleBudget, deviceTriangleBudget());
  assert.equal(options?.prudent, undefined);
  worker.message({ id: worker.requests[0].id, type: 'done', output: cubeOutput() });
  await reading;
});

// ---------------------------------------------------------------------------- les erreurs
test('un manque de mémoire se reconnaît à son nom ou à son texte, une panique non', () => {
  const failure = (name: string, message: string) => ({ name, message });
  // L'allocation qui échoue arrête le module WebAssembly : la trappe nue.
  assert.equal(isMemoryFailure(failure('RuntimeError', 'unreachable')), true);
  assert.equal(isMemoryFailure(failure('RuntimeError', 'unreachable executed')), true);
  assert.equal(isMemoryFailure(failure('RuntimeError', 'Unreachable code should not be executed (evaluating \'wasm_function(1)\')')), true, 'la même trappe, dite par Safari');
  assert.equal(isMemoryFailure(failure('RuntimeError', 'internal error: entered unreachable code')), false, 'un texte qui en dit plus n’est pas la trappe nue');
  assert.equal(isMemoryFailure(failure('RuntimeError', 'unreachable code at src/lib.rs:12')), false);
  assert.equal(isMemoryFailure(failure('RangeError', 'WebAssembly.Memory.grow(): Maximum memory size exceeded')), true);
  assert.equal(isMemoryFailure(failure('RangeError', 'Array buffer allocation failed')), true);
  assert.equal(isMemoryFailure(failure('Error', 'memory allocation of 4294967296 bytes failed')), true);
  assert.equal(isMemoryFailure(failure('RuntimeError', 'WebAssembly.Memory.grow(): Unable to grow instance memory')), true);
  // `unreachable` n'est une trappe de mémoire que pour un RuntimeError : une autre erreur qui le cite n'en est pas une.
  assert.equal(isMemoryFailure(failure('Error', 'unreachable')), false);
  assert.equal(isMemoryFailure(failure('TypeError', 'unreachable')), false);
  // Un `unreachable!()` du code Rust est une panique, avec son texte : pas un problème de taille.
  assert.equal(isMemoryFailure(failure('Error', 'panique interne de la lecture Revit : panicked at src/geometry/saved.rs:812:18:\ninternal error: entered unreachable code')), false);
  assert.equal(isMemoryFailure(failure('RuntimeError', 'panique interne de la lecture Revit : entered unreachable code')), false);
  // Un `capacity overflow` vient d'un nombre mal formé dans le fichier, pas d'un fichier trop gros.
  assert.equal(isMemoryFailure(failure('Error', 'panique interne de la lecture Revit : capacity overflow')), false);
  assert.equal(isMemoryFailure(failure('Error', '  panique interne de la lecture Revit : memory allocation of 8 bytes failed')), false, 'aucune panique n’est un manque de mémoire');
  assert.equal(isMemoryFailure(failure('RangeError', 'panique interne de la lecture Revit : index out of bounds')), false);
  assert.equal(isMemoryFailure(failure('Error', 'panique interne de la lecture Revit : index out of bounds: the len is 3 but the index is 5')), false);
  // Un fichier illisible, une pile épuisée, un accès hors limites : pas un problème de taille.
  assert.equal(isMemoryFailure(failure('Error', 'le fichier n\'est pas un fichier Revit lisible: Not a Revit file (magic bytes did not match CFB/OLE)')), false);
  assert.equal(isMemoryFailure(failure('RangeError', 'Maximum call stack size exceeded')), false);
  assert.equal(isMemoryFailure(failure('RuntimeError', 'memory access out of bounds')), false);
});

test('une panique de Rust se reconnaît à son préfixe, et à lui seul', () => {
  const failure = (name: string, message: string) => ({ name, message });
  assert.equal(isPanicFailure(failure('Error', 'panique interne de la lecture Revit : panicked at src/lib.rs:1:1:\nboom')), true);
  assert.equal(isPanicFailure(failure('Error', '  panique interne de la lecture Revit : capacity overflow')), true);
  assert.equal(isPanicFailure(failure('RuntimeError', 'unreachable')), false, 'la trappe nue est un manque de mémoire');
  assert.equal(isPanicFailure(failure('Error', 'le fichier n\'est pas un fichier Revit lisible')), false);
  assert.equal(isPanicFailure(failure('WorkerError', 'panique interne de la lecture Revit : boom')), false, 'un worker mort n’a pas attrapé de panique');
  assert.equal(isPanicFailure(failure('Error', 'Erreur : panique interne')), false, 'le préfixe est au début du message');
});

test('un échec devient un message français : trop gros, illisible ou fichier inaccessible', () => {
  const file = { name: 'tour.rvt', size: 150_400_000 };

  const memory = revitFailureToError(file, { name: 'RuntimeError', message: 'unreachable' });
  assert.ok(memory instanceof RevitTooLargeError);
  assert.match(memory.message, /« tour\.rvt » \(150 Mo\) est trop volumineux pour être lu dans le navigateur/);
  assert.match(memory.message, /Réessayez sur un appareil qui a plus de mémoire/);

  // Le texte du lecteur sert de détail, sans point doublé.
  const notRevit = revitFailureToError(file, { name: 'Error', message: 'le fichier n\'est pas un fichier Revit lisible: Not a Revit file (magic bytes did not match CFB/OLE)' });
  assert.ok(!(notRevit instanceof RevitTooLargeError));
  assert.equal(notRevit.message, 'Impossible de lire « tour.rvt » : le fichier n\'est pas un fichier Revit lisible: Not a Revit file (magic bytes did not match CFB/OLE).');
  assert.equal(revitFailureToError(file, { name: 'Error', message: 'fichier tronqué.\n' }).message, 'Impossible de lire « tour.rvt » : fichier tronqué.');

  const unreadable = revitFailureToError(file, { name: 'NotReadableError', message: 'The requested file could not be read' });
  assert.match(unreadable.message, /le navigateur n’a pas pu accéder au fichier/);
});

// ------------------------------------------------------------------------------ le worker
type Listener = (event: unknown) => void;

/** Un Worker de papier : il garde ce que le fil principal lui envoie et laisse le test répondre. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  terminated = false;
  requests: { id: number; file: File; options?: { prudent?: boolean; triangleBudget?: number } }[] = [];
  readonly url: URL;
  readonly options: WorkerOptions;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  postMessage(request: { id: number; file: File; options?: { prudent?: boolean; triangleBudget?: number } }): void {
    this.requests.push(request);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(data: unknown): void {
    this.emit('message', { data });
  }
}

function withFakeWorker(t: { after(fn: () => void): void }): void {
  FakeWorker.instances = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor);
    else Reflect.deleteProperty(globalThis, 'Worker');
  });
}

const EMPTY_REPORT: RevitReport = {
  release: 2023, experimental: false, elements: 0, triangles: 0, seconds: 0,
  sources: { revit: 0, partial: 0, rebuilt: 0, unknown: 0 }, withoutGeometry: 0, warnings: [], stages: [],
};

/** Cube de 1 m sur un seul élément, au format de sortie du lecteur : 24 sommets, 12 triangles. */
function cubeOutput(): RevitOutput {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  faces.forEach(([normal, corners], f) => {
    for (const corner of corners) {
      positions.push(corner[0] - 0.5, corner[1] - 0.5, corner[2] - 0.5);
      normals.push(...normal);
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return {
    keys: ['2O2Fr$t4X7Zf8NOew3FLOH', 'rvt-4242'],
    names: ['Mur de base : Béton 20', 'Niveau 1'],
    sources: new Uint8Array([0, 3]),
    origin: [1234.5, 20, -300.25],
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    primitives: new Uint32Array([0, 0, 24, 0, 36, 0]),
    materials: new Uint8Array([180, 180, 175, 255, 0, 0]),
    metadata: JSON.stringify({
      version: 1,
      readOnly: ['Catégorie'],
      elements: {
        '2O2Fr$t4X7Zf8NOew3FLOH': { label: 'Mur de base : Béton 20', properties: { Catégorie: 'Murs', 'Source de la géométrie': 'Forme Revit' } },
        'rvt-4242': { label: 'Niveau 1', properties: { Catégorie: 'Niveaux', 'Source de la géométrie': 'Inconnue (boîte englobante)' } },
      },
    }),
    report: { ...EMPTY_REPORT, elements: 2, triangles: 12, seconds: 0.4, sources: { revit: 1, partial: 0, rebuilt: 0, unknown: 1 } },
  };
}

test('une lecture envoie le fichier tel quel à un worker neuf, qui rend les tableaux sans copie', async (t) => {
  withFakeWorker(t);
  const statuses: string[] = [];
  const file = new File([new Uint8Array(10)], 'maquette.rvt');
  const reading = readRevit(file, (message) => statuses.push(message));

  assert.equal(FakeWorker.instances.length, 1);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.options.type, 'module');
  assert.match(worker.url.pathname, /revitWorker\.ts$/);
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0].file, file, 'le File lui-même, pas une copie de ses octets');
  const { id } = worker.requests[0];

  worker.message({ id: id + 99, type: 'status', message: 'd’une autre lecture' }); // ignoré
  worker.message({ id, type: 'status', message: 'Chargement du lecteur Revit…' });
  worker.message({ id, type: 'status', message: 'Lecture du fichier Revit…' });
  const output = cubeOutput();
  worker.message({ id, type: 'done', output });
  const read = await reading;

  assert.deepEqual(statuses, ['Chargement du lecteur Revit…', 'Lecture du fichier Revit…']);
  assert.equal(worker.terminated, true, 'le worker est jeté après le résultat');
  assert.equal(single(read.raw).kind, 'raw');
  assert.equal(single(read.raw).positions, output.positions, 'les tableaux passent tels quels à buildModel');
  assert.equal(single(read.raw).indices, output.indices);
  assert.equal(read.metadata, output.metadata);
  assert.equal(read.report, output.report);
});

test('chaque fichier a son propre worker, même après une erreur', async (t) => {
  withFakeWorker(t);
  const first = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  const w1 = FakeWorker.instances[0];
  w1.message({ id: w1.requests[0].id, type: 'error', name: 'RuntimeError', message: 'unreachable' });
  await assert.rejects(first, (error: unknown) => error instanceof RevitTooLargeError && /« a\.rvt » \(0 Mo\) est trop volumineux/.test(error.message));
  assert.equal(w1.terminated, true, 'une instance qui a planté ne resservira pas');

  const second = readRevit(new File([new Uint8Array(1)], 'b.rvt'), () => {});
  assert.equal(FakeWorker.instances.length, 2);
  const w2 = FakeWorker.instances[1];
  assert.notEqual(w2, w1);
  w2.message({ id: w2.requests[0].id, type: 'done', output: cubeOutput() });
  await second;
  assert.equal(w2.terminated, true);
});

const PANIC = 'panique interne de la lecture Revit : panicked at src/geometry/saved.rs:812:18:\nindex out of bounds: the len is 3 but the index is 5';
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('une panique de Rust fait relire le fichier une fois, en mode prudent, dans un worker neuf', async (t) => {
  withFakeWorker(t);
  const statuses: string[] = [];
  const file = new File([new Uint8Array(10)], 'maquette.rvt');
  const reading = readRevit(file, (message) => statuses.push(message));

  const first = FakeWorker.instances[0];
  assert.equal(first.requests[0].options?.prudent, undefined, 'la première lecture n’est pas prudente');
  first.message({ id: first.requests[0].id, type: 'status', message: 'Lecture du fichier Revit…' });
  first.message({ id: first.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await settle();

  assert.equal(first.terminated, true, 'le worker qui a paniqué est jeté');
  assert.equal(FakeWorker.instances.length, 2, 'un worker neuf pour la relecture');
  const second = FakeWorker.instances[1];
  assert.notEqual(second, first);
  assert.equal(second.terminated, false);
  assert.equal(second.requests[0].file, file, 'le même fichier, sans copie');
  assert.equal(second.requests[0].options?.prudent, true, 'la relecture est prudente');
  assert.equal(second.requests[0].options?.triangleBudget, first.requests[0].options?.triangleBudget, 'avec le même budget de triangles');
  assert.notEqual(second.requests[0].id, first.requests[0].id);
  assert.deepEqual(statuses, [
    'Lecture du fichier Revit…',
    'Une erreur interne a interrompu la lecture : nouvelle lecture en mode prudent…',
  ]);

  second.message({ id: second.requests[0].id, type: 'status', message: 'Lecture du fichier Revit…' });
  const output = cubeOutput();
  output.report.warnings = ['3 formes n’ont pas pu être tracées.'];
  second.message({ id: second.requests[0].id, type: 'done', output });
  const read = await reading;

  assert.equal(statuses.at(-1), 'Lecture du fichier Revit… (mode prudent)', 'le mode reste dit pendant la relecture');
  assert.equal(second.terminated, true);
  assert.equal(single(read.raw).positions, output.positions, 'les tableaux passent tels quels');
  assert.deepEqual(read.report.warnings, [PRUDENT_WARNING, '3 formes n’ont pas pu être tracées.']);
  assert.equal(PRUDENT_WARNING, 'Une erreur interne a interrompu la première lecture ; le fichier a été relu en mode prudent : certaines formes peuvent être incomplètes.');
  assert.deepEqual(output.report.warnings, ['3 formes n’ont pas pu être tracées.'], 'le rapport du lecteur n’est pas modifié');
  // La carte de lecture le dit, en style d'avertissement.
  const card = describeRevitReport(read.report);
  assert.equal(card.warning, true);
  assert.match(card.text, /Une erreur interne a interrompu la première lecture ; le fichier a été relu en mode prudent/);
});

/**
 * La sortie du cube en deux morceaux, comme le worker les envoie : l'élément dessiné puis l'élément sans forme, et
 * une fin qui n'a que le rapport et les deux bouts du JSON de métadonnées.
 */
function cubeChunks(): { chunks: RevitChunk[]; done: RevitOutput } {
  const whole = cubeOutput();
  const elements = JSON.parse(whole.metadata).elements as Record<string, unknown>;
  const fragment = (key: string) => `${JSON.stringify(key)}:${JSON.stringify(elements[key])}`;
  const chunks: RevitChunk[] = [
    {
      keys: [whole.keys[0]], names: [whole.names[0]], sources: new Uint8Array([0]), origin: whole.origin,
      positions: whole.positions, normals: whole.normals, indices: whole.indices, primitives: whole.primitives, materials: whole.materials,
      metadataElements: fragment(whole.keys[0]),
    },
    {
      keys: [whole.keys[1]], names: [whole.names[1]], sources: new Uint8Array([3]), origin: whole.origin,
      positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), primitives: new Uint32Array(0), materials: whole.materials,
      metadataElements: fragment(whole.keys[1]),
    },
  ];
  const done: RevitOutput = {
    ...whole,
    keys: [], names: [], sources: new Uint8Array(0), positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), primitives: new Uint32Array(0), materials: new Uint8Array(0),
    metadata: '',
    metadataHead: '{"version":1,"readOnly":["Catégorie"],"elements":{',
    metadataTail: '}}',
  };
  return { chunks, done };
}

test('une lecture arrivée par morceaux donne un modèle brut par morceau et le même JSON de métadonnées qu’un bloc', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  const worker = FakeWorker.instances[0];
  const { id } = worker.requests[0];
  const { chunks, done } = cubeChunks();
  worker.message({ id, type: 'chunk', chunk: chunks[0] });
  worker.message({ id: id + 99, type: 'chunk', chunk: chunks[1] }); // d’une autre lecture : ignoré
  worker.message({ id, type: 'chunk', chunk: chunks[1] });
  worker.message({ id, type: 'done', output: done });
  const read = await reading;
  assert.ok(Array.isArray(read.raw));
  assert.equal(read.raw.length, 2);
  assert.equal(read.raw[0].positions, chunks[0].positions, 'les tableaux des morceaux passent tels quels');
  assert.deepEqual(read.raw[1].keys, ['rvt-4242']);
  assert.equal(read.metadata, cubeOutput().metadata, 'le JSON assemblé est celui d’un bloc');
  assert.equal(read.report, done.report);
  // Les morceaux se construisent ensemble, comme le bloc.
  const model = buildModel(read.raw, select());
  const whole = buildModel(rawFromOutput(cubeOutput()), select());
  assert.deepEqual(model.keys, whole.keys);
  assert.equal(model.triangleCount, whole.triangleCount);
  assert.deepEqual(model.chunks.map((chunk) => [...chunk.positions]), whole.chunks.map((chunk) => [...chunk.positions]));
  assert.deepEqual(model.box.min.toArray(), whole.box.min.toArray());
  assert.deepEqual(model.offset.toArray(), whole.offset.toArray());
});

test('avec un rappel, chaque morceau est remis dès son arrivée, tableaux tels quels, et n’est pas gardé', async (t) => {
  withFakeWorker(t);
  const delivered: { raw: RawModel; first: boolean }[] = [];
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, undefined, (raw, first) => delivered.push({ raw, first }));
  const worker = FakeWorker.instances[0];
  const { id } = worker.requests[0];
  const { chunks, done } = cubeChunks();
  worker.message({ id, type: 'chunk', chunk: chunks[0] });
  assert.equal(delivered.length, 1, 'remis avant la fin de la lecture');
  assert.equal(delivered[0].first, true);
  assert.equal(delivered[0].raw.kind, 'raw');
  assert.equal(delivered[0].raw.positions, chunks[0].positions, 'les tableaux du morceau passent tels quels');
  assert.deepEqual(delivered[0].raw.keys, [chunks[0].keys[0]]);
  worker.message({ id: id + 99, type: 'chunk', chunk: chunks[1] }); // d’une autre lecture : ignoré
  worker.message({ id, type: 'chunk', chunk: chunks[1] });
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].first, false);
  assert.deepEqual(delivered[1].raw.keys, ['rvt-4242']);
  worker.message({ id, type: 'done', output: done });
  const read = await reading;
  assert.deepEqual(read.raw, [], 'les morceaux remis ne sont pas gardés');
  assert.equal(read.metadata, cubeOutput().metadata, 'le JSON assemblé est celui d’un bloc');
  assert.equal(read.report, done.report);
  assert.equal(worker.terminated, true);
  // Les morceaux remis construisent le même modèle que le bloc.
  const model = buildModel(delivered.map((item) => item.raw), select());
  const whole = buildModel(rawFromOutput(cubeOutput()), select());
  assert.deepEqual(model.keys, whole.keys);
  assert.equal(model.triangleCount, whole.triangleCount);
  model.dispose();
  whole.dispose();
});

test('la relecture en mode prudent remet ses morceaux du début, et le rappel le sait', async (t) => {
  withFakeWorker(t);
  const firsts: boolean[] = [];
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, undefined, (_raw, first) => firsts.push(first));
  const { chunks, done } = cubeChunks();
  const first = FakeWorker.instances[0];
  first.message({ id: first.requests[0].id, type: 'chunk', chunk: chunks[0] });
  first.message({ id: first.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await settle();
  const second = FakeWorker.instances[1];
  const { id } = second.requests[0];
  second.message({ id, type: 'chunk', chunk: chunks[0] });
  second.message({ id, type: 'chunk', chunk: chunks[1] });
  second.message({ id, type: 'done', output: done });
  const read = await reading;
  assert.deepEqual(firsts, [true, true, false]);
  assert.deepEqual(read.raw, []);
  assert.equal(read.report.warnings[0], PRUDENT_WARNING);
  assert.equal(read.metadata, cubeOutput().metadata);
});

test('une relecture prudente sans morceau rend le modèle d’un bloc : ce que la lecture interrompue a remis n’en fait pas partie', async (t) => {
  withFakeWorker(t);
  const delivered: { raw: RawModel; first: boolean }[] = [];
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, undefined, (raw, first) => delivered.push({ raw, first }));
  const { chunks } = cubeChunks();
  const first = FakeWorker.instances[0];
  first.message({ id: first.requests[0].id, type: 'chunk', chunk: chunks[0] });
  first.message({ id: first.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await settle();
  // La relecture ne remet aucun morceau : tout arrive d'un bloc, avec la fin.
  const second = FakeWorker.instances[1];
  second.message({ id: second.requests[0].id, type: 'done', output: cubeOutput() });
  const read = await reading;
  assert.equal(delivered.length, 1, 'le seul morceau remis est celui de la lecture interrompue');
  assert.ok(!Array.isArray(read.raw), 'un modèle seul, pas la liste vide d’une lecture par morceaux : l’appelant ne garde pas ce qu’il a construit');
  assert.deepEqual(single(read.raw).keys, cubeOutput().keys);
  assert.equal(read.names, undefined);
  assert.equal(read.report.warnings[0], PRUDENT_WARNING);
});

test('une erreur levée par le rappel interrompt la lecture telle quelle, sans relecture', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, undefined, () => {
    throw new Error('morceau refusé');
  });
  const worker = FakeWorker.instances[0];
  worker.message({ id: worker.requests[0].id, type: 'chunk', chunk: cubeChunks().chunks[0] });
  await assert.rejects(reading, { message: 'morceau refusé' });
  await settle();
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.instances.length, 1, 'une erreur du viewer n’est pas une panique du lecteur');
});

test('sans morceau, le JSON est celui de la sortie ; avec des morceaux vides de fragment, les virgules restent justes', () => {
  const whole = cubeOutput();
  assert.equal(metadataFromChunks(whole, []), whole.metadata);
  const { chunks, done } = cubeChunks();
  assert.equal(metadataFromChunks(done, chunks), whole.metadata);
  const empty: RevitChunk = { ...chunks[1], metadataElements: '' };
  assert.equal(metadataFromChunks(done, [chunks[0], empty, chunks[1]]), whole.metadata);
  assert.equal(rawFromChunk(chunks[0]).kind, 'raw');
});

test('une lecture réussie du premier coup ne porte aucun avertissement de mode prudent', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  const worker = FakeWorker.instances[0];
  const output = cubeOutput();
  worker.message({ id: worker.requests[0].id, type: 'done', output });
  const read = await reading;
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(read.report, output.report);
  assert.ok(!read.report.warnings.includes(PRUDENT_WARNING));
});

test('si le mode prudent panique aussi, l’erreur est rendue après deux workers, tous deux jetés', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  const first = FakeWorker.instances[0];
  first.message({ id: first.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await settle();
  const second = FakeWorker.instances[1];
  second.message({ id: second.requests[0].id, type: 'error', name: 'Error', message: 'panique interne de la lecture Revit : autre panique' });
  await assert.rejects(reading, (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof RevitTooLargeError));
    assert.match(error.message, /^Impossible de lire « a\.rvt » : panique interne de la lecture Revit : autre panique\.$/);
    return true;
  });
  assert.equal(FakeWorker.instances.length, 2, 'une seule relecture, jamais plus');
  assert.equal(first.terminated && second.terminated, true);
});

test('ni un manque de mémoire, ni un fichier illisible, ni un worker mort ne font relire en mode prudent', async (t) => {
  withFakeWorker(t);
  const failures: { name: string; message: string; check: (error: unknown) => void }[] = [
    { name: 'RuntimeError', message: 'unreachable', check: (error) => assert.ok(error instanceof RevitTooLargeError) },
    { name: 'RangeError', message: 'Array buffer allocation failed', check: (error) => assert.ok(error instanceof RevitTooLargeError) },
    { name: 'Error', message: 'le fichier n\'est pas un fichier Revit lisible: Not a Revit file', check: (error) => assert.match((error as Error).message, /Impossible de lire/) },
    { name: 'NotReadableError', message: 'The requested file could not be read', check: (error) => assert.match((error as Error).message, /n’a pas pu accéder au fichier/) },
  ];
  for (const [index, { name, message, check }] of failures.entries()) {
    const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
    const worker = FakeWorker.instances[index];
    worker.message({ id: worker.requests[0].id, type: 'error', name, message });
    await assert.rejects(reading, (error: unknown) => (check(error), true));
    await settle();
    assert.equal(FakeWorker.instances.length, index + 1, `${name} : ${message} ne relance rien`);
    assert.equal(worker.terminated, true);
  }
  // Un worker qui meurt sans message, même avec le texte d'une panique, n'a rien attrapé.
  const dead = readRevit(new File([new Uint8Array(1)], 'b.rvt'), () => {});
  FakeWorker.instances[failures.length].emit('error', { message: PANIC });
  await assert.rejects(dead, /Le lecteur Revit s’est arrêté pendant la lecture de « b\.rvt »/);
  await settle();
  assert.equal(FakeWorker.instances.length, failures.length + 1);
});

test('interrompre pendant la relecture en mode prudent termine son worker, et aucune troisième lecture ne naît', async (t) => {
  withFakeWorker(t);
  const controller = new AbortController();
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, controller.signal);
  const first = FakeWorker.instances[0];
  first.message({ id: first.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await settle();
  const second = FakeWorker.instances[1];
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(second.terminated, true);
  assert.equal(FakeWorker.instances.length, 2);

  // Abandon pendant la première lecture, au moment où elle panique : pas de relecture.
  const controller2 = new AbortController();
  const aborted = readRevit(new File([new Uint8Array(1)], 'b.rvt'), () => {}, controller2.signal);
  const worker = FakeWorker.instances[2];
  controller2.abort();
  worker.message({ id: worker.requests[0].id, type: 'error', name: 'Error', message: PANIC });
  await assert.rejects(aborted, { name: 'AbortError' });
  await settle();
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.instances.length, 3);
});

test('un fichier qui n’est pas du Revit donne un message lisible avec le texte du lecteur', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'photo.rvt'), () => {});
  const worker = FakeWorker.instances[0];
  worker.message({ id: worker.requests[0].id, type: 'error', name: 'Error', message: 'le fichier n\'est pas un fichier Revit lisible: Not a Revit file (magic bytes did not match CFB/OLE)' });
  await assert.rejects(reading, (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof RevitTooLargeError));
    assert.match(error.message, /^Impossible de lire « photo\.rvt » : le fichier n'est pas un fichier Revit lisible/);
    return true;
  });
  assert.equal(worker.terminated, true);
});

test('un worker qui meurt sans message, ou dont le résultat est perdu, ne laisse pas la lecture pendre', async (t) => {
  withFakeWorker(t);
  const dead = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  FakeWorker.instances[0].emit('error', { message: '' });
  await assert.rejects(dead, /Le lecteur Revit s’est arrêté pendant la lecture de « a\.rvt » \(sans détail\)\. Si le fichier est volumineux/);
  assert.equal(FakeWorker.instances[0].terminated, true);

  const lost = readRevit(new File([new Uint8Array(1)], 'b.rvt'), () => {});
  FakeWorker.instances[1].emit('messageerror', {});
  await assert.rejects(lost, /s’est arrêté pendant la lecture de « b\.rvt »/);
  assert.equal(FakeWorker.instances[1].terminated, true);
});

test('interrompre une lecture termine son worker sur-le-champ', async (t) => {
  withFakeWorker(t);
  const controller = new AbortController();
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, controller.signal);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.terminated, false);
  controller.abort();
  await assert.rejects(reading, (error: unknown) => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(worker.terminated, true);

  // Déjà interrompue avant de commencer : aucun worker n'est même lancé.
  await assert.rejects(readRevit(new File([new Uint8Array(1)], 'b.rvt'), () => {}, controller.signal), { name: 'AbortError' });
  assert.equal(FakeWorker.instances.length, 1);
});

// --------------------------------------------------------------------- phrases du rapport
const report = (overrides: Omit<Partial<RevitReport>, 'sources'> & { sources?: Partial<RevitReport['sources']> } = {}): RevitReport => ({
  ...EMPTY_REPORT, elements: 970, seconds: 4.2, release: 2024, ...overrides,
  sources: { ...EMPTY_REPORT.sources, revit: 970, ...overrides.sources },
});

test('le rapport raconte les quatre sources de géométrie avec leurs pluriels', () => {
  const mixed = describeRevitReport(report({ sources: { revit: 958, partial: 8, rebuilt: 3, unknown: 1 } }));
  assert.equal(
    mixed.text,
    '970 éléments lus en 4,2 s (Revit 2024) : 958 formes Revit, 8 partielles, 3 reconstruites, 1 inconnue (boîte englobante). ' +
      'Regroupez par « Source de la géométrie » pour les retrouver.',
  );
  assert.equal(mixed.warning, true);

  // Singuliers, et les sources à zéro ne sont pas citées.
  const single = describeRevitReport(report({ elements: 3, seconds: 0.34, sources: { revit: 1, partial: 1, rebuilt: 1, unknown: 0 } }));
  assert.equal(
    single.text,
    '3 éléments lus en 0,3 s (Revit 2024) : 1 forme Revit, 1 partielle, 1 reconstruite. Regroupez par « Source de la géométrie » pour les retrouver.',
  );
  const unknowns = describeRevitReport(report({ sources: { revit: 0, unknown: 2 } }));
  assert.match(unknowns.text, /: 2 inconnues \(boîte englobante\)\./);
});

test('un rapport sans réserve est sobre : pas de consigne, pas d’alerte', () => {
  const clean = describeRevitReport(report({ elements: 1, seconds: 12, release: 2023, sources: { revit: 1 } }));
  assert.equal(clean.text, '1 élément lu en 12 s (Revit 2023) : 1 forme Revit.');
  assert.equal(clean.warning, false);
  // Les milliers à la française.
  const large = describeRevitReport(report({ elements: 12_345, seconds: 1234.5, sources: { revit: 12_345 } }));
  assert.equal(large.text, `${integer.format(12_345)} éléments lus en ${integer.format(1234.5)} s (Revit 2024) : ${integer.format(12_345)} formes Revit.`);
  assert.match(large.text, /^12\s345 éléments lus en 1\s234,5 s/);
});

test('le rapport signale les éléments sans géométrie, les avertissements du lecteur et la lecture expérimentale', () => {
  const some = describeRevitReport(report({ withoutGeometry: 12 }));
  assert.equal(some.text, '970 éléments lus en 4,2 s (Revit 2024) : 970 formes Revit. 12 éléments sans géométrie ne sont pas dessinés.');
  assert.equal(some.warning, false);
  assert.match(describeRevitReport(report({ withoutGeometry: 1 })).text, /1 élément sans géométrie n’est pas dessiné\.$/);

  const warned = describeRevitReport(report({ warnings: ['3 formes n’ont pas pu être tracées.', 'Les liens Revit ne sont pas lus.'] }));
  assert.match(warned.text, /970 formes Revit\. 3 formes n’ont pas pu être tracées\. Les liens Revit ne sont pas lus\.$/);
  assert.equal(warned.warning, true);

  const old = describeRevitReport(report({ release: 2019, experimental: true }));
  assert.match(old.text, /^970 éléments lus en 4,2 s \(Revit 2019\) : 970 formes Revit\. Lecture expérimentale : des éléments peuvent manquer/);
  assert.equal(old.warning, true);

  // Année inconnue : le lecteur la dit expérimentale, la phrase ne prétend rien.
  const unknownYear = describeRevitReport(report({ release: null, experimental: true }));
  assert.match(unknownYear.text, /\(version de Revit inconnue\)/);
});

test('un élément à forme illisible est compté une fois, parmi les inconnues, avec l’avertissement du lecteur', () => {
  // Core Interior : la topographie 21974 est dessinée par sa boîte englobante ; plus aucun élément « sans géométrie ».
  const boxed = '1 élément a une forme que Revit a enregistrée mais que ce lecteur ne sait pas encore lire : il est montré par sa boîte englobante et marqué « Inconnue ».';
  const core = describeRevitReport(report({ elements: 856, seconds: 2.2, sources: { revit: 855, unknown: 1 }, withoutGeometry: 0, warnings: [boxed] }));
  assert.equal(
    core.text,
    '856 éléments lus en 2,2 s (Revit 2024) : 855 formes Revit, 1 inconnue (boîte englobante). Regroupez par « Source de la géométrie » pour les retrouver. ' + boxed,
  );
  assert.equal(core.warning, true);
  assert.doesNotMatch(core.text, /sans géométrie/);
});

// ------------------------------------------------------------ de la sortie au modèle affiché
test('la sortie du lecteur donne un modèle, des liens avec les métadonnées et un GLB exportable', () => {
  const output = cubeOutput();
  const model = buildModel(rawFromOutput(output), select());
  const metadata = parseMetadata(JSON.parse(output.metadata));

  assert.equal(model.count, 2);
  assert.deepEqual(model.keys, output.keys);
  assert.deepEqual(model.names, output.names);
  assert.ok(model.keys.every((key) => metadata.elements.has(key)), 'chaque clé retrouve sa fiche');
  assert.equal(metadata.elements.get('rvt-4242')?.label, 'Niveau 1');
  assert.equal(model.triangleCount, 12);
  // Le centre du modèle, en mètres Y vers le haut, devient le décalage : la précision reste entière loin de l'origine.
  assert.deepEqual(model.offset.toArray(), output.origin);
  assert.equal(model.state.isVisible(1), true, 'un élément sans géométrie reste un élément');

  // « GLB ↓ » réécrit le modèle affiché : aucun GLB d'origine n'existe pour un .rvt.
  const glb = writeGlb(model, 'viewer-bim');
  assert.equal(new TextDecoder().decode(new Uint8Array(glb, 0, 4)), 'glTF');
  assert.ok(glb.byteLength > 24 * 3 * 4);
  model.dispose();
});

// --------------------------------------------- le vrai lecteur WebAssembly sur un vrai fichier
test('le lecteur WebAssembly lit une maquette Revit 2023 jusqu’au modèle affiché', () => {
  initSync({ module: readFileSync(new URL('../src/revit/pkg/revit_bg.wasm', import.meta.url)) });
  const bytes = readFileSync(new URL('../revit/tests/fixtures/Revit_IFC5_Einhoven.rvt', import.meta.url));
  const output = readRevitWasm(new Uint8Array(bytes));
  assert.ok(output.keys.length > 0, 'le lecteur rend des éléments');

  const model = buildModel(rawFromOutput(output), select());
  const parsed = JSON.parse(output.metadata);
  const metadata = parseMetadata(parsed);

  assert.equal(model.count, output.keys.length);
  assert.deepEqual(model.keys, output.keys);
  assert.deepEqual(model.names, output.names);
  assert.ok(model.triangleCount > 0 && model.triangleCount <= output.report.triangles);
  assert.deepEqual(model.offset.toArray(), output.origin);

  // Chaque élément retrouve ses métadonnées par sa clé, avec son nom pour libellé et sa source de géométrie.
  const sourceNames = ['Forme Revit', 'Forme Revit partielle', 'Forme reconstruite', 'Inconnue (boîte englobante)'];
  output.keys.forEach((key, i) => {
    const entry = metadata.elements.get(key);
    assert.ok(entry, `fiche manquante pour ${key}`);
    assert.equal(entry.label, output.names[i]);
    assert.equal(parsed.elements[key].properties['Source de la géométrie'], sourceNames[output.sources[i]], `source de ${key}`);
  });
  assert.equal(metadata.elements.size, output.keys.length);

  const glb = writeGlb(model, 'viewer-bim');
  assert.equal(new TextDecoder().decode(new Uint8Array(glb, 0, 4)), 'glTF');
  model.dispose();
});

test('les phases et les vues du lecteur WebAssembly se lisent comme le contrat les décrit, sur le modèle affiché', () => {
  initSync({ module: readFileSync(new URL('../src/revit/pkg/revit_bg.wasm', import.meta.url)) });
  const bytes = readFileSync(new URL('../revit/tests/fixtures/Revit_IFC5_Einhoven.rvt', import.meta.url));
  const output = readRevitWasm(new Uint8Array(bytes));
  const model = buildModel(rawFromOutput(output), select());
  const metadata = parseMetadata(JSON.parse(output.metadata));

  // Phases : l'ordre du projet, et les propriétés que les éléments portent vraiment (le viewer ne les connaît que par ce bloc).
  const phases = metadata.phases;
  assert.ok(phases, 'section phases');
  assert.deepEqual(phases.order, ['Existing', 'New Construction']);
  assert.equal(phases.filters.find((filter) => filter.default)?.name, 'Show All');
  const props = (i: number) => metadata.elements.get(model.keys[i])?.props;
  const created = model.keys.map((_, i) => ownValue(props(i), phases.created));
  assert.ok(created.every((value) => value === 'New Construction'), 'tous les éléments sont créés dans « New Construction »');
  // Dans « Existing », tout ce qui est créé plus tard est futur et masqué ; dans « New Construction », tout est nouveau.
  const valueOf = (i: number, property: string) => ownValue(props(i), property);
  assert.equal(evaluatePhases(phases, { phase: 'Existing' }, model.count, valueOf).hidden.every((flag) => flag === 1), true);
  const newConstruction = evaluatePhases(phases, { phase: 'New Construction' }, model.count, valueOf);
  assert.equal(newConstruction.counts.new, model.count);
  assert.equal(newConstruction.hidden.includes(1), false);

  // Vues : la vue par défaut {3D} est parallèle, et sa caméra se convertit pour le repère recentré du modèle.
  const views = metadata.views ?? [];
  assert.deepEqual(views.map((view) => view.name), ['{3D}']);
  const [view] = views;
  assert.equal(view.camera.projection, 'orthographic');
  assert.equal(view.phase, 'New Construction');
  assert.equal(view.phaseFilter, 'Show All');
  const sphere = model.box.getBoundingSphere(new Sphere());
  const pose = cameraPose(view.camera, model.offset.toArray(), { center: sphere.center.toArray(), radius: sphere.radius }, 1.6);
  // Cette vue parallèle n'a pas de fenêtre enregistrée : la maquette est cadrée, dans le repère recentré (centre autour de 0).
  assert.equal(view.camera.size, undefined);
  assert.deepEqual(pose.target, sphere.center.toArray());
  assert.ok(Math.hypot(...pose.target) < sphere.radius, 'le centre de la maquette est près de l’origine recentrée');
  assert.equal(hiddenByView(view, model.count, new Map(model.keys.map((key, i) => [key, i])), valueOf).includes(1), false);
  model.dispose();
});

test('la fin d’une lecture par morceaux porte les libellés des fiches et le JSON entier : les noms provisoires des morceaux s’effacent', async (t) => {
  withFakeWorker(t);
  const delivered: RawModel[] = [];
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {}, undefined, (raw) => delivered.push(raw));
  const worker = FakeWorker.instances[0];
  const { id } = worker.requests[0];
  const whole = cubeOutput();
  const { chunks, done } = cubeChunks();
  // Le lecteur d’aujourd’hui : des noms provisoires par morceau, rien du JSON, et à la fin les libellés et le JSON entier.
  const provisional = chunks.map((chunk) => ({ ...chunk, names: chunk.keys.map((key) => `SWall ${key}`), metadataElements: '' }));
  const final: RevitOutput = { ...done, names: whole.names, metadata: whole.metadata, metadataHead: undefined, metadataTail: undefined };
  worker.message({ id, type: 'chunk', chunk: provisional[0] });
  worker.message({ id, type: 'chunk', chunk: provisional[1] });
  worker.message({ id, type: 'done', output: final });
  const read = await reading;
  assert.deepEqual(read.names, whole.names, 'les libellés des fiches, dans l’ordre des morceaux');
  assert.equal(read.metadata, whole.metadata, 'le JSON entier de la fin, sans assemblage');
  assert.deepEqual(delivered.map((raw) => raw.names[0]), provisional.map((chunk) => chunk.names[0]), 'les morceaux remis gardent leur nom provisoire : l’appelant les renomme');
  assert.deepEqual(read.raw, [], 'les morceaux remis ne sont pas gardés');
});

test('sans rappel, les morceaux gardés reçoivent les libellés de la fin à la place de leurs noms provisoires', async (t) => {
  withFakeWorker(t);
  const reading = readRevit(new File([new Uint8Array(1)], 'a.rvt'), () => {});
  const worker = FakeWorker.instances[0];
  const { id } = worker.requests[0];
  const whole = cubeOutput();
  const { chunks, done } = cubeChunks();
  const provisional = chunks.map((chunk) => ({ ...chunk, names: chunk.keys.map((key) => `SWall ${key}`), metadataElements: '' }));
  worker.message({ id, type: 'chunk', chunk: provisional[0] });
  worker.message({ id, type: 'chunk', chunk: provisional[1] });
  worker.message({ id, type: 'done', output: { ...done, names: whole.names, metadata: whole.metadata, metadataHead: undefined, metadataTail: undefined } });
  const read = await reading;
  assert.ok(Array.isArray(read.raw));
  assert.deepEqual(read.raw.map((raw) => raw.names[0]), whole.names);
  assert.equal(read.metadata, whole.metadata);
  const model = buildModel(read.raw, select());
  assert.deepEqual(model.names, whole.names);
});
