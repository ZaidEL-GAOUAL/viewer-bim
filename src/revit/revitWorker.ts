/// <reference lib="webworker" />
// Lecture d'un fichier Revit (.rvt) hors du fil principal. Le lecteur est du Rust compilé en
// WebAssembly (dossier revit/, glue et module dans ./pkg) : rvt-rs décode le fichier, puis la
// géométrie et les propriétés sortent en tableaux typés, que l'on transfère au fil principal sans
// les copier.
//
// Le fichier n'est jamais copié dans la mémoire du module : le lecteur lui demande des fenêtres
// d'octets (`readRevitFile`), servies ici par `FileReaderSync` sur `file.slice` (un worker dédié y a
// droit). Ses petits flux passent dans un mini conteneur, ses partitions se lisent par tranches
// (revit/src/native/document.rs) : la mémoire du module ne grandit plus avec la taille du fichier.
// La sortie, elle, part par morceaux (messages `chunk`), transférés au fil principal dès qu'ils sont
// assemblés : le module ne tient jamais tous les tableaux à la fois.
//
// Un worker ne sert qu'à un fichier : après une lecture, ou une erreur, la mémoire d'une instance
// WebAssembly ne se rend plus et une panique la laisse dans un état douteux. Le fil principal le
// termine donc dès qu'il a le résultat (voir readRevit.ts).

import init, { readRevitFile, type RevitChunk, type RevitOutput } from './pkg/revit.js';
// Adresse du module WebAssembly : Vite l'émet comme fichier à part, avec un chemin relatif au
// script du worker, donc valable sous le sous-dossier de GitHub Pages.
import wasmUrl from './pkg/revit_bg.wasm?url';

/** Réglages de la lecture, tels que `readRevitFile` du module WebAssembly les reçoit. */
export interface RevitReadOptions {
  /**
   * Mode prudent : seul le maillage de rvt-rs lit les formes, sans le code du lecteur qui pourrait
   * paniquer ; des formes peuvent sortir incomplètes. Sert à relire un fichier dont la première
   * lecture a paniqué (voir `readRevit` dans readRevit.ts).
   */
  prudent?: boolean;
  /**
   * Budget de triangles du fichier entier, d'après la mémoire de l'appareil (`deviceTriangleBudget` dans
   * readRevit.ts) : au-delà, le lecteur montre les éléments qui ne tiennent plus par leur boîte, marqués « Inconnue ».
   * À défaut, 3 millions.
   */
  triangleBudget?: number;
}

export interface RevitRequest {
  id: number;
  /** Le fichier lui-même : il passe au worker sans être copié, qui le lit par tranches. */
  file: File;
  /** Réglages de la lecture ; absents, la lecture est celle par défaut. */
  options?: RevitReadOptions;
}

export type RevitMessage =
  | { id: number; type: 'status'; message: string }
  /** Un morceau de la sortie, dans l'ordre des éléments, transféré dès qu'il est assemblé. */
  | { id: number; type: 'chunk'; chunk: RevitChunk }
  /** La fin : le rapport, le début et la fin du JSON de métadonnées (les tableaux sont partis par morceaux). */
  | { id: number; type: 'done'; output: RevitOutput }
  | { id: number; type: 'error'; name: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: RevitMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

/** Les tampons des tableaux typés d'une sortie ou d'un morceau, chacun une seule fois : ils changent de propriétaire sans copie. */
function buffersOf(output: RevitOutput | RevitChunk): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const value of Object.values(output)) {
    if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer) buffers.add(value.buffer);
  }
  return [...buffers];
}

/**
 * Les octets `offset..offset + length` du fichier, lus sur place : ce que le lecteur demande, fenêtre par fenêtre.
 * Une erreur de lecture (`NotReadableError`, `NotFoundError` : fichier déplacé ou modifié depuis son choix) remonte
 * telle quelle à travers le lecteur, avec son nom.
 */
function sliceReader(file: File): (offset: number, length: number) => Uint8Array {
  const sync = new FileReaderSync();
  return (offset, length) => new Uint8Array(sync.readAsArrayBuffer(file.slice(offset, offset + length)));
}

async function handle({ id, file, options }: RevitRequest): Promise<void> {
  const started = performance.now();
  try {
    post({ id, type: 'status', message: 'Chargement du lecteur Revit…' });
    await init({ module_or_path: wasmUrl });
    post({ id, type: 'status', message: 'Lecture du fichier Revit…' });
    // La sortie part par morceaux (quelques centaines de milliers de triangles chacun), chacun transféré au fil
    // principal dès qu'il est assemblé : la mémoire du module ne tient jamais tous les tableaux à la fois.
    const output = readRevitFile(file.size, sliceReader(file), options, (chunk: RevitChunk) => post({ id, type: 'chunk', chunk }, buffersOf(chunk)));
    // Côté Rust, la durée reste à 0 en WebAssembly (pas d'horloge) : on la mesure ici, de la mise
    // en route du lecteur à la fin de la lecture, comme la conversion d'un IFC.
    output.report.seconds = Math.round((performance.now() - started) / 100) / 10;
    post({ id, type: 'done', output }, buffersOf(output));
  } catch (error) {
    // Le nom compte : un manque de mémoire se reconnaît à `RuntimeError: unreachable` (l'allocation
    // qui échoue arrête le module) ou à une `RangeError`, une panique à son message (« panique
    // interne… »), qui déclenche la relecture en mode prudent côté fil principal.
    post({
      id,
      type: 'error',
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

scope.onmessage = (event: MessageEvent<RevitRequest>) => {
  void handle(event.data);
};
