import type { ConvertMessage, ConvertRequest } from './ifcWorker.ts';
import { mergeGlb, mergeMetadata } from './mergeGlb.ts';

export interface FailedElement {
  id: string;
  class: string;
  name: string;
}

export interface IfcReport {
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
}

export interface IfcConversion {
  glb: ArrayBuffer;
  /** Métadonnées au format du contrat (docs/contrat-metadonnees.md), en texte JSON. */
  metadata: string;
  report: IfcReport;
}

// IfcOpenShell compilé pour le navigateur, servi avec le viewer. La 0.8.5 est la dernière version
// complète : à partir de la 0.8.6, le paquet pour navigateur n'est plus qu'un noyau dont les
// schémas IFC et le moteur géométrique sont des modules séparés, pas encore tous publiés.
const WHEEL = 'wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';

const MAX_WORKERS = 4;

/** Taille d'IFC au-delà de laquelle la conversion dans le navigateur est refusée. */
export const MAX_IFC_BYTES = 100e6;

/** Le fichier dépasse ce que le navigateur peut convertir : le message s'adresse à l'utilisateur. */
export class IfcTooLargeError extends Error {}

const megabytes = (bytes: number) => Math.round(bytes / 1e6).toLocaleString('fr-FR');

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

export function isIfcFile(name: string): boolean {
  return /\.ifc$/i.test(name);
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
        resolve({ glb: message.glb, metadata: message.metadata, report: message.report as Part['report'] });
      } else {
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
    const request: ConvertRequest = { id, buffer, shard, wheelUrl: new URL(WHEEL, document.baseURI).href };
    worker.postMessage(request, [buffer]);
  });
}

/**
 * Convertit un fichier IFC en GLB + métadonnées, dans le navigateur. Le convertisseur (Python et
 * IfcOpenShell en WebAssembly) n'est téléchargé qu'au premier IFC ouvert, puis reste en mémoire.
 * Le fichier n'est envoyé à aucun serveur.
 *
 * Les éléments sont répartis entre plusieurs convertisseurs, chacun dans son fil d'exécution :
 * l'interface reste fluide et tous les cœurs disponibles travaillent. Si la mémoire vient à
 * manquer, la conversion est retentée avec un seul convertisseur avant d'abandonner.
 */
export async function convertIfc(file: File, onStatus: (message: string) => void): Promise<IfcConversion> {
  if (file.size > MAX_IFC_BYTES) {
    throw tooLarge(file, `dépasse la limite de ${megabytes(MAX_IFC_BYTES)} Mo pour une conversion dans le navigateur.`);
  }
  const started = performance.now();
  const memoryGB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  let count = workerCount(file.size, navigator.hardwareConcurrency || 2, memoryGB);
  const source = await file.arrayBuffer();

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
  const sum = (key: string) => parts.reduce((total, part) => total + (part.report[key] ?? 0), 0);
  return {
    glb: mergeGlb(parts.map((part) => part.glb)),
    metadata: mergeMetadata(parts.map((part) => part.metadata)),
    report: {
      elements: sum('elements'),
      triangles: sum('triangles'),
      linework: sum('linework'),
      without_geometry: sum('without_geometry'),
      failed: parts.flatMap((part) => part.report.failed ?? []),
      seconds: Math.round((performance.now() - started) / 100) / 10,
      workers: count,
    },
  };
}

/** Convertit le fichier avec `count` convertisseurs en parallèle, chacun traitant une tranche. */
async function convertWith(count: number, source: ArrayBuffer, onStatus: (message: string) => void): Promise<Part[]> {
  while (pool.length < count) pool.push(new Worker(new URL('./ifcWorker.ts', import.meta.url), { type: 'module' }));
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
          onStatus(`Conversion de la géométrie : ${average} %${count > 1 ? ` (${count} cœurs)` : ''}`);
        },
      ),
    ),
  );
}
