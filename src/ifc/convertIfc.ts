import type { ConvertMessage, ConvertRequest, PrepareRequest, UsdRequest } from './ifcWorker.ts';
import { mayPreload, settle } from './enginePolicy.ts';
import { combineTimings, type IfcTimings, type ShardTimings } from './timings.ts';
import { mergeGlb, mergeMetadata } from './mergeGlb.ts';
import { megabytes } from '../data/text.ts';
import { ASSUMED_MEMORY_GB, deviceMemoryGB } from '../engine/deviceMemory.ts';

interface FailedElement {
  id: string;
  class: string;
  name: string;
}

interface IfcReport {
  elements: number;
  triangles: number;
  /** Axes de trame et annotations : des lignes sans volume, laissées de côté. */
  linework: number;
  /** Éléments dont la géométrie n'a pas pu être calculée, et les premiers d'entre eux. */
  without_geometry: number;
  failed: FailedElement[];
  /** Durée totale de la conversion, en secondes. */
  seconds: number;
  /** Nombre de convertisseurs lancés en parallèle. */
  workers: number;
  /** Durée de chaque phase, pour voir où va le temps. */
  timings: IfcTimings;
}

interface IfcConversion {
  glb: ArrayBuffer;
  /** Métadonnées au format du contrat (docs/contrat-metadonnees.md), en texte JSON. */
  metadata: string;
  report: IfcReport;
}

// IfcOpenShell compilé pour le navigateur, téléchargé depuis le site d'IfcOpenShell. La 0.8.5 est
// la dernière version complète : à partir de la 0.8.6, le paquet pour navigateur n'est plus qu'un
// noyau dont les schémas IFC et le moteur géométrique sont des modules séparés, pas encore tous
// publiés.
// Le fichier officiel n'est pas hébergé ici : son binaire inclut du code GPL (CGAL), que ce site
// ne distribue donc pas lui-même. L'empreinte SHA-256 épingle le fichier exact : le convertisseur
// refuse un paquet qui ne correspond pas.
const WHEEL = 'https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';
const WHEEL_SHA256 = 'fbebb7a7144277be213d156ed9b77de30de1d92b0b2b0c815e4a07555bfb929c';

const MAX_WORKERS = 4;

/** Taille d'IFC au-delà de laquelle la conversion dans le navigateur est refusée. */
export const MAX_IFC_BYTES = 100e6;

/** Le fichier dépasse ce que le navigateur peut convertir : le message s'adresse à l'utilisateur. */
export class IfcTooLargeError extends Error {}

function tooLarge(file: File, reason: string): IfcTooLargeError {
  return new IfcTooLargeError(
    `« ${file.name} » (${megabytes(file.size)} Mo) ${reason} ` +
      'Essayez un fichier plus léger (un seul lot ou un seul bâtiment, par exemple), ou convertissez-le hors du navigateur avec pipeline/ifc_to_glb.py, puis ouvrez le GLB et le JSON obtenus.',
  );
}

/** Vrai si l'erreur vient d'un manque de mémoire dans le convertisseur. */
function isMemoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /memory|allocation|out of bounds|cannot enlarge|fatally failed|rangeerror/i.test(message);
}
const pool: Worker[] = [];
let nextId = 1;
let operations: Promise<unknown> = Promise.resolve();
let running = false;
let lastUsed = 0;
let hiddenSince: number | null = null;
let watching = false;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

const newWorker = () => new Worker(new URL('./ifcWorker.ts', import.meta.url), { type: 'module' });

/** Arrête les convertisseurs en trop, selon la règle de enginePolicy.ts, et programme la prochaine échéance. */
function applyPolicy(): void {
  clearTimeout(settleTimer);
  if (running || pool.length === 0) return; // jamais en plein travail : les opérations en file la relancent
  const { keep, recheckIn } = settle({ size: pool.length, lastUsed, hiddenSince, memoryGB: deviceMemoryGB() }, performance.now());
  for (const worker of pool.splice(keep)) worker.terminate();
  if (recheckIn !== null && pool.length > 0) settleTimer = setTimeout(applyPolicy, recheckIn);
}

/** Suit la visibilité de l'onglet : un onglet caché longtemps libère le dernier convertisseur. */
function watchVisibility(): void {
  if (watching || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  watching = true;
  const update = () => {
    hiddenSince = document.visibilityState === 'hidden' ? (hiddenSince ?? performance.now()) : null;
    applyPolicy();
  };
  document.addEventListener('visibilitychange', update);
  update();
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  watchVisibility();
  const next = operations.then(async () => {
    clearTimeout(settleTimer);
    running = true;
    try { return await operation(); }
    catch (error) {
      // A worker error may leave a dead runtime which cannot answer the next queued job.
      for (const worker of pool.splice(0)) worker.terminate();
      throw error;
    }
    finally {
      running = false;
      lastUsed = performance.now();
      applyPolicy();
    }
  });
  // Keep only completion in the queue, never the last model's large buffers.
  operations = next.then(() => undefined, () => undefined);
  return next;
}

let preloadQueued = false;

/**
 * Prépare un convertisseur d'avance (Python, IfcOpenShell), pour que la prochaine conversion démarre
 * tout de suite. Passe par la même file que les conversions, ne fait rien en économie de données ou
 * avec peu de mémoire, et ne signale jamais d'échec : un préchargement raté (hors ligne) laisse
 * simplement le moteur à préparer au moment de la conversion.
 */
export function preloadIfc(): void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (preloadQueued || !mayPreload({ saveData: connection?.saveData, memoryGB: deviceMemoryGB() })) return;
  preloadQueued = true;
  void enqueue(async () => {
    preloadQueued = false;
    const worker = pool[0] ?? (pool[0] = newWorker());
    try { await prepareWorker(worker, 'ifc'); }
    catch {
      // Silencieux, et sans toucher aux autres convertisseurs : seul celui-ci est jeté.
      const index = pool.indexOf(worker);
      if (index >= 0) pool.splice(index, 1);
      worker.terminate();
    }
  }).catch(() => undefined);
}

/** Demande à un convertisseur de se préparer, sans rien convertir. */
function prepareWorker(worker: Worker, level: PrepareRequest['level']): Promise<void> {
  const id = nextId++;
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ConvertMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'ready') { finish(); resolve(); }
      else if (message.type === 'error') { finish(); reject(new Error(message.message)); }
    };
    const onError = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'Le convertisseur IFC s’est arrêté.'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const request: PrepareRequest = { kind: 'prepare', id, level, wheelUrl: WHEEL, wheelSha256: WHEEL_SHA256 };
    worker.postMessage(request);
  });
}

/**
 * Nombre de convertisseurs à lancer en parallèle. Chacun charge l'IFC en entier (environ quinze
 * fois sa taille en mémoire, plus le moteur) : on s'adapte donc aux cœurs et à la mémoire de la
 * machine, et un petit fichier n'en mérite qu'un seul.
 */
export function workerCount(fileBytes: number, cores: number, memoryGB: number): number {
  const megabytes = fileBytes / 1e6;
  if (megabytes < 2) return 1;
  const perWorkerMB = 250 + megabytes * 15;
  const byMemory = Math.floor((memoryGB * 1024 * 0.4) / perWorkerMB);
  const byCores = Math.max(1, cores - 1); // un cœur reste libre pour l'interface
  return Math.max(1, Math.min(MAX_WORKERS, byCores, byMemory));
}

interface Part {
  glb: ArrayBuffer;
  metadata: string;
  report: Record<string, number> & { failed?: FailedElement[] };
  timings: ShardTimings;
}

/** Lance la conversion d'une tranche sur un convertisseur du groupe. */
function convertShard(
  worker: Worker,
  buffer: ArrayBuffer,
  shard: [number, number],
  onStatus: (message: string) => void,
  onProgress: (percent: number) => void,
): Promise<Part> {
  const id = nextId++;
  return new Promise<Part>((resolve, reject) => {
    const finish = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ConvertMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'status') onStatus(message.message);
      else if (message.type === 'progress') onProgress(message.percent);
      else if (message.type === 'done') {
        finish();
        resolve({ glb: message.glb, metadata: message.metadata, report: message.report as Part['report'], timings: message.timings });
      } else if (message.type === 'error') {
        finish();
        reject(new Error(message.message));
      }
    };
    const onError = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'Le convertisseur IFC s’est arrêté.'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const request: ConvertRequest = { kind: 'convert', id, buffer, shard, wheelUrl: WHEEL, wheelSha256: WHEEL_SHA256 };
    worker.postMessage(request, [buffer]);
  });
}

/**
 * Emballe un GLB et ses métadonnées en paquet USDZ, dans le convertisseur (même script que la
 * ligne de commande : pipeline/usd_writer.py).
 */
export function packageUsd(glb: ArrayBuffer, metadata: string, onStatus: (message: string) => void): Promise<ArrayBuffer> {
  return enqueue(() => packageModel(glb, metadata, onStatus));
}

function packageModel(glb: ArrayBuffer, metadata: string, onStatus: (message: string) => void): Promise<ArrayBuffer> {
  if (pool.length === 0) pool.push(newWorker());
  const worker = pool[0];
  const id = nextId++;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const finish = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ConvertMessage>) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.type === 'status') onStatus(message.message);
      else if (message.type === 'usd') {
        finish();
        resolve(message.usdz);
      } else if (message.type === 'error') {
        finish();
        reject(new Error(message.message));
      }
    };
    const onError = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'Le convertisseur IFC s’est arrêté.'));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    const request: UsdRequest = { kind: 'usd', id, glb: glb.slice(0), metadata };
    worker.postMessage(request, [request.glb]);
  });
}

/**
 * Convertit un fichier IFC en GLB + métadonnées, dans le navigateur. Le convertisseur (Python et
 * IfcOpenShell en WebAssembly) est chargé à la demande et libéré après une période d'inactivité.
 * Le fichier n'est envoyé à aucun serveur.
 *
 * Les éléments sont répartis entre plusieurs convertisseurs, chacun dans son fil d'exécution :
 * l'interface reste disponible, dans la limite de quatre tâches simultanées. Si la mémoire vient à
 * manquer, la conversion est retentée avec un seul convertisseur avant d'abandonner.
 */
export async function convertIfc(file: File, onStatus: (message: string) => void): Promise<IfcConversion> {
  if (file.size > MAX_IFC_BYTES) {
    throw tooLarge(file, `dépasse la limite de ${megabytes(MAX_IFC_BYTES)} Mo pour une conversion dans le navigateur.`);
  }
  return enqueue(() => convertIfcNow(file, onStatus));
}

async function convertIfcNow(file: File, onStatus: (message: string) => void): Promise<IfcConversion> {
  const started = performance.now();
  const memoryGB = deviceMemoryGB() ?? ASSUMED_MEMORY_GB;
  let count = workerCount(file.size, navigator.hardwareConcurrency || 2, memoryGB);
  const source = await file.arrayBuffer();
  const read = Math.round(performance.now() - started);

  let parts: Part[];
  for (;;) {
    try {
      parts = await convertWith(count, source, onStatus);
      break;
    } catch (error) {
      // Après un échec, on repart de convertisseurs neufs.
      for (const worker of pool.splice(0)) worker.terminate();
      if (!isMemoryError(error)) throw error;
      if (count === 1) throw tooLarge(file, 'est trop lourd ou trop détaillé pour la mémoire dont dispose le navigateur.');
      count = 1;
      onStatus('Mémoire insuffisante : nouvelle tentative avec un seul convertisseur…');
    }
  }

  onStatus('Assemblage du modèle…');
  const merging = performance.now();
  const sum = (key: string) => parts.reduce((total, part) => total + (part.report[key] ?? 0), 0);
  const glb = mergeGlb(parts.map((part) => part.glb));
  const metadata = mergeMetadata(parts.map((part) => part.metadata));
  const merge = Math.round(performance.now() - merging);
  return {
    glb,
    metadata,
    report: {
      elements: sum('elements'),
      triangles: sum('triangles'),
      linework: sum('linework'),
      without_geometry: sum('without_geometry'),
      failed: parts.flatMap((part) => part.report.failed ?? []),
      seconds: Math.round((performance.now() - started) / 100) / 10,
      workers: count,
      timings: combineTimings(parts.map((part) => part.timings), merge, read),
    },
  };
}

/** Convertit le fichier avec `count` convertisseurs en parallèle, chacun traitant une tranche. */
async function convertWith(count: number, source: ArrayBuffer, onStatus: (message: string) => void): Promise<Part[]> {
  while (pool.length < count) pool.push(newWorker());
  const progress = new Array<number>(count).fill(0);
  let converting = false;
  return Promise.all(
    pool.slice(0, count).map((worker, index) =>
      convertShard(
        worker,
        source.slice(0), // chaque convertisseur reçoit sa propre copie du fichier
        [index, count],
        (message) => {
          if (!converting) onStatus(message);
        },
        (percent) => {
          converting = true;
          progress[index] = percent;
          const average = Math.round(progress.reduce((total, value) => total + value, 0) / count);
          onStatus(`Conversion de la géométrie : ${average} %${count > 1 ? ` (${count} tâches parallèles)` : ''}`);
        },
      ),
    ),
  );
}
