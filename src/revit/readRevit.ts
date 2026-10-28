import type { RawModel } from '../engine/buildModel.ts';
import type { RevitChunk, RevitOutput } from './pkg/revit.js';
import type { RevitMessage, RevitReadOptions, RevitRequest } from './revitWorker.ts';

/** Bilan de la lecture, tel que le lecteur le rend (voir docs/lecture-revit.md). */
export type RevitReport = RevitOutput['report'];

export interface RevitRead {
  /**
   * Géométrie, prête pour `buildModel` : aucun GLB entre les deux. Un morceau par message `chunk` du worker (la
   * sortie du lecteur part par morceaux, dans l'ordre des éléments, à mesure qu'elle est assemblée), ou le modèle
   * d'un bloc quand le worker n'a rien envoyé d'autre que `done`. Avec un `onChunk` (voir `readRevit`), les
   * morceaux sont remis au fur et à mesure et ne sont pas gardés : la liste est alors vide. Ce choix est celui de la
   * lecture qui a rendu le résultat : un modèle seul (pas une liste) dit que cette lecture n'a remis aucun morceau,
   * donc que ceux qu'une lecture précédente, interrompue par une panique, avait remis ne sont pas les siens.
   */
  raw: RawModel | RawModel[];
  /** Métadonnées au format du contrat (docs/contrat-metadonnees.md), en texte JSON. */
  metadata: string;
  /**
   * Les libellés des fiches, un par élément dans l'ordre des morceaux, quand la lecture est arrivée par morceaux : les
   * morceaux ne portent qu'un nom provisoire (classe et identifiant), les fiches n'étant lues qu'après la géométrie.
   * Absent quand le lecteur a tout rendu d'un bloc (`raw` porte alors les libellés).
   */
  names?: string[];
  report: RevitReport;
}

/**
 * Reçoit chaque morceau dès que le worker l'a transmis, dans l'ordre des éléments. `first` est vrai pour le premier
 * morceau d'une lecture : après une panique, la relecture en mode prudent recommence du début, et ce qui avait été
 * construit des morceaux précédents est à jeter. Une erreur levée ici interrompt la lecture.
 */
export type RevitChunkListener = (raw: RawModel, first: boolean) => void;

/**
 * Le budget de triangles d'une lecture, d'après la mémoire de l'appareil (`navigator.deviceMemory`, en Go, que les
 * navigateurs plafonnent à 8 ; absent sur Firefox et Safari : 4 Go supposés, comme pour l'IFC). Le lecteur lui-même
 * ne garde plus en mémoire ni le fichier (lu par tranches) ni le modèle (parti par morceaux pendant le maillage) : ce
 * qui grandit avec les triangles est au fil principal, mesuré sur la maquette de 759 Mo et 12,4 millions de
 * triangles (docs/lecture-revit.md) : ≈ 56 octets de tas JavaScript par triangle (tableaux du modèle, copiés une fois
 * à la cuisson) et ≈ 27 octets de mémoire graphique, soit ≈ 100 octets avec three.js. Un quart de la mémoire de
 * l'appareil va au modèle : 2,5 millions de triangles par Go, entre 2 millions (un appareil de 1 Go lit encore les
 * fichiers d'essai, tous sous 1,7 million) et 20 millions (8 Go : la maquette de 12,4 millions passe entière). Au-delà
 * du budget, le lecteur montre les éléments qui ne tiennent plus par leur boîte, marqués « Inconnue », et le dit.
 */
export function triangleBudgetFor(deviceMemoryGB: number | undefined): number {
  const gb = deviceMemoryGB !== undefined && Number.isFinite(deviceMemoryGB) && deviceMemoryGB > 0 ? deviceMemoryGB : 4;
  return Math.min(20e6, Math.max(2e6, Math.round(gb * 2.5e6)));
}

/** Le budget de triangles de cet appareil (voir `triangleBudgetFor`). */
export function deviceTriangleBudget(): number {
  return triangleBudgetFor((navigator as Navigator & { deviceMemory?: number }).deviceMemory);
}

/** Le fichier dépasse ce que le navigateur peut lire : le message s'adresse à l'utilisateur. */
export class RevitTooLargeError extends Error {}

/** Projet (.rvt), famille (.rfa), gabarit de projet (.rte), gabarit de famille (.rft) : même conteneur, même lecteur. */
const REVIT_EXTENSION = /\.(rvt|rfa|rte|rft)$/i;

/** Un fichier Revit : projet, famille ou gabarit de l'un ou de l'autre. */
export function isRevitFile(name: string): boolean {
  return REVIT_EXTENSION.test(name);
}

/** Le nom d'un fichier Revit sans son extension, et cette extension en minuscules (« rvt » à défaut). */
export function splitRevitName(name: string): { base: string; extension: string } {
  const match = REVIT_EXTENSION.exec(name);
  return match ? { base: name.slice(0, match.index), extension: match[1].toLowerCase() } : { base: name, extension: 'rvt' };
}

const megabytes = (bytes: number) => Math.round(bytes / 1e6).toLocaleString('fr-FR');

/** Ce que dit l'erreur d'un worker, tel quel : son nom et son texte. */
export interface RevitFailure {
  name: string;
  message: string;
}

/** Début du message que le crochet de panique du lecteur donne à toute panique de Rust (revit/src/wasm.rs). */
const PANIC_PREFIX = 'panique interne';

/**
 * Vrai si l'échec est une panique de Rust : le lecteur l'a attrapée, lui a donné son message et l'a
 * levée en vraie erreur. Un manque de mémoire n'en est jamais une (voir `isMemoryFailure`) : une
 * allocation qui échoue arrête le module sans passer par ce crochet.
 */
export function isPanicFailure({ name, message }: RevitFailure): boolean {
  return name !== 'WorkerError' && message.trimStart().startsWith(PANIC_PREFIX);
}

/** La trappe `unreachable` de WebAssembly, nue, dans les mots de Chrome, Firefox et Safari : rien d'autre que ce texte. */
const WASM_UNREACHABLE = /^\s*(?:unreachable(?: executed)?|unreachable code should(?: be)? not (?:be )?executed(?: \(evaluating .*\))?)\s*$/is;

/**
 * Vrai si l'échec vient d'un manque de mémoire. Une allocation qui échoue arrête le module
 * WebAssembly : `RuntimeError: unreachable`, rien d'autre que cette trappe nue. Une panique de Rust,
 * elle, arrive en vraie erreur avec son texte (« panique interne… ») et n'en est jamais un, même si
 * ce texte parle de `unreachable` (« entered unreachable code », un `unreachable!()` du code) ou de
 * `capacity overflow` (un nombre mal formé dans le fichier, pas un fichier trop gros). Une pile
 * d'appels épuisée est aussi une `RangeError`, mais pas un problème de taille de fichier.
 */
export function isMemoryFailure(failure: RevitFailure): boolean {
  const { name, message } = failure;
  if (isPanicFailure(failure)) return false;
  if (/call stack/i.test(message)) return false;
  if (name === 'RangeError') return true;
  if (name === 'RuntimeError' && WASM_UNREACHABLE.test(message)) return true;
  return /out of memory|memory allocation|allocation (of \d+ bytes )?failed|cannot enlarge|memory\.grow|invalid (typed )?array length|array buffer allocation|mémoire insuffisante/i.test(message);
}

function tooLarge(file: { name: string; size: number }, reason: string): RevitTooLargeError {
  return new RevitTooLargeError(
    `« ${file.name} » (${megabytes(file.size)} Mo) ${reason} ` +
      'Réessayez sur un appareil qui a plus de mémoire, enregistrez un modèle plus léger (un seul bâtiment ou un seul lot, sans liens), ou exportez-le en IFC depuis Revit : le viewer ouvre aussi les IFC.',
  );
}

/** L'échec d'une lecture, en message pour l'utilisateur. */
export function revitFailureToError(file: { name: string; size: number }, failure: RevitFailure): Error {
  if (isMemoryFailure(failure)) {
    return tooLarge(file, 'est trop volumineux pour être lu dans le navigateur : la mémoire disponible ne suffit pas.');
  }
  if (failure.name === 'NotReadableError' || failure.name === 'NotFoundError') {
    return new Error(`Impossible de lire « ${file.name} » : le navigateur n’a pas pu accéder au fichier (il a peut-être été déplacé ou modifié depuis son choix).`);
  }
  // Le texte du lecteur est déjà en français pour l'essentiel (« le fichier n'est pas un fichier Revit lisible : … »).
  return new Error(`Impossible de lire « ${file.name} » : ${failure.message.trim().replace(/\.$/, '')}.`);
}

/** Erreur arrivée du worker, avant d'être traduite pour l'utilisateur. */
class WorkerFailure extends Error {
  readonly failure: RevitFailure;
  constructor(failure: RevitFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/** Les tableaux d'un morceau de la sortie du lecteur, tels quels, en modèle brut pour `buildModel`. */
export function rawFromChunk(chunk: RevitChunk): RawModel {
  return {
    kind: 'raw',
    keys: chunk.keys,
    names: chunk.names,
    origin: chunk.origin,
    positions: chunk.positions,
    normals: chunk.normals,
    indices: chunk.indices,
    primitives: chunk.primitives,
    materials: chunk.materials,
  };
}

/**
 * Le JSON de métadonnées d'une lecture arrivée par morceaux : le début et la fin que porte la sortie, les fragments des
 * morceaux entre les deux, séparés par des virgules. Exactement le texte qu'une lecture d'un bloc aurait donné.
 */
export function metadataFromChunks(output: RevitOutput, chunks: Pick<RevitChunk, 'metadataElements'>[]): string {
  // Le lecteur rend désormais le JSON entier à la fin de la lecture, avec les morceaux ou sans ; les trois parts
  // restent lues pour un module qui les enverrait encore.
  if (output.metadata) return output.metadata;
  if (chunks.length === 0 && output.metadataHead === undefined) return output.metadata;
  const fragments = chunks.map((chunk) => chunk.metadataElements).filter((fragment) => fragment.length > 0);
  return `${output.metadataHead ?? ''}${fragments.join(',')}${output.metadataTail ?? ''}`;
}

/** Les tableaux de la sortie du lecteur, tels quels, en modèle brut pour `buildModel`. */
export function rawFromOutput(output: RevitOutput): RawModel {
  return {
    kind: 'raw',
    keys: output.keys,
    names: output.names,
    origin: output.origin,
    positions: output.positions,
    normals: output.normals,
    indices: output.indices,
    primitives: output.primitives,
    materials: output.materials,
  };
}

let nextId = 1;

/**
 * Ce que le fil principal dit à l'utilisateur quand une panique de Rust a forcé la relecture en mode
 * prudent (« Source de la géométrie » dit ensuite quelles formes n'ont que leur approximation).
 */
export const PRUDENT_WARNING = 'Une erreur interne a interrompu la première lecture ; le fichier a été relu en mode prudent : certaines formes peuvent être incomplètes.';
const PRUDENT_STATUS = 'Une erreur interne a interrompu la lecture : nouvelle lecture en mode prudent…';

/** Ce qu'une lecture rend : la fin, et ses morceaux (entiers, ou réduits à leur fragment de JSON s'ils ont été remis à `onChunk`). */
interface ReadResult {
  output: RevitOutput;
  chunks: Pick<RevitChunk, 'metadataElements'>[];
  raws: RawModel[];
}

/**
 * Une lecture, dans un worker neuf, terminé dès le résultat ou l'erreur : une instance qui a atteint
 * plusieurs gigaoctets, ou dont la lecture s'est arrêtée net, ne doit pas resservir. L'échec du
 * worker est levé tel quel (`WorkerFailure`), traduit par l'appelant. Avec `onChunk`, chaque morceau lui est remis
 * dès son arrivée et n'est pas gardé (seul son fragment de JSON l'est) ; une erreur levée par `onChunk` fait
 * échouer la lecture, telle quelle.
 */
async function readOnce(file: File, onStatus: (message: string) => void, signal: AbortSignal | undefined, options: RevitReadOptions | undefined, onChunk: ((raw: RawModel) => void) | undefined): Promise<ReadResult> {
  const worker = new Worker(new URL('./revitWorker.ts', import.meta.url), { type: 'module' });
  const id = nextId++;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<ReadResult>((resolve, reject) => {
      const chunks: Pick<RevitChunk, 'metadataElements'>[] = [];
      const raws: RawModel[] = [];
      worker.addEventListener('message', (event: MessageEvent<RevitMessage>) => {
        const message = event.data;
        if (message.id !== id) return;
        if (message.type === 'status') onStatus(message.message);
        else if (message.type === 'chunk') {
          const { chunk } = message;
          if (!onChunk) {
            chunks.push(chunk);
            raws.push(rawFromChunk(chunk));
            return;
          }
          chunks.push({ metadataElements: chunk.metadataElements });
          try {
            onChunk(rawFromChunk(chunk));
          } catch (error) {
            reject(error);
          }
        } else if (message.type === 'done') resolve({ output: message.output, chunks, raws });
        else reject(new WorkerFailure({ name: message.name, message: message.message }));
      });
      // Un worker qui meurt sans rien dire (module introuvable, mémoire épuisée) arrive ici.
      worker.addEventListener('error', (event: ErrorEvent) => {
        reject(new WorkerFailure({ name: 'WorkerError', message: event.message }));
      });
      worker.addEventListener('messageerror', () => {
        reject(new WorkerFailure({ name: 'WorkerError', message: 'le résultat du lecteur n’a pas pu être transmis' }));
      });
      if (signal) {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const request: RevitRequest = options ? { id, file, options } : { id, file };
      worker.postMessage(request);
    });
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    worker.terminate();
  }
}

/**
 * Lit un fichier Revit dans le navigateur : géométrie, matériaux et propriétés. Le lecteur
 * (WebAssembly, environ 5 Mo) n'est téléchargé qu'au premier .rvt ouvert. Le fichier n'est envoyé
 * à aucun serveur.
 *
 * Chaque lecture a son propre worker (voir `readOnce`). Un `signal` interrompt la lecture en cours
 * (le worker est alors terminé sur-le-champ).
 *
 * En WebAssembly (wasm32), une panique de Rust n'est pas rattrapable : elle interrompt toute la
 * lecture. Quand c'est elle qui l'a interrompue (ni manque de mémoire, ni abandon), la lecture
 * recommence une fois dans un worker neuf en mode prudent (`{ prudent: true }` : seul le maillage de
 * rvt-rs, sans le code du lecteur qui a paniqué ; des formes peuvent être incomplètes) et le rapport
 * en porte l'avertissement. Si le mode prudent panique à son tour, l'erreur est rendue telle quelle.
 *
 * `onChunk` reçoit les morceaux à mesure qu'ils arrivent (voir `RevitChunkListener`) : le modèle peut être construit
 * et affiché pendant la lecture. Ils ne sont alors pas gardés dans le résultat.
 */
export async function readRevit(file: File, onStatus: (message: string) => void, signal?: AbortSignal, onChunk?: RevitChunkListener): Promise<RevitRead> {
  // Plus de limite de taille : le fichier n'entre pas dans la mémoire du lecteur, et le budget de triangles borne le
  // modèle. Le lecteur refuse lui-même, en « mémoire insuffisante », un fichier de plus de 4 millions d'éléments
  // indexés, ou de plus de 150 Mo s'il faut le reconstruire par l'export IFC (revit/src/lib.rs).
  signal?.throwIfAborted();
  const options: RevitReadOptions = { triangleBudget: deviceTriangleBudget() };

  // Chaque lecture (la première, la relecture prudente) remet ses morceaux du début : `first` le dit à l'appelant.
  const listener = (): ((raw: RawModel) => void) | undefined => {
    if (!onChunk) return undefined;
    let delivered = 0;
    return (raw) => onChunk(raw, delivered++ === 0);
  };

  let result: ReadResult;
  let prudent = false;
  try {
    try {
      result = await readOnce(file, onStatus, signal, options, listener());
    } catch (error) {
      if (!(error instanceof WorkerFailure) || !isPanicFailure(error.failure)) throw error;
      signal?.throwIfAborted();
      onStatus(PRUDENT_STATUS);
      prudent = true;
      // Les messages du nouveau worker (« Lecture du fichier Revit… ») ne doivent pas faire oublier le mode.
      result = await readOnce(file, (message) => onStatus(`${message} (mode prudent)`), signal, { ...options, prudent: true }, listener());
    }
  } catch (error) {
    if (!(error instanceof WorkerFailure)) throw error;
    const { failure } = error;
    if (failure.name === 'WorkerError') {
      throw new Error(`Le lecteur Revit s’est arrêté pendant la lecture de « ${file.name} » (${failure.message || 'sans détail'}). Si le fichier est volumineux, la mémoire du navigateur ne suffit peut-être pas.`);
    }
    throw revitFailureToError(file, failure);
  }
  const { output, chunks, raws } = result;
  const report = prudent ? { ...output.report, warnings: [PRUDENT_WARNING, ...output.report.warnings] } : output.report;
  if (chunks.length === 0) return { raw: rawFromOutput(output), metadata: metadataFromChunks(output, chunks), report };
  // Les libellés des fiches arrivent avec la fin : les morceaux gardés les reçoivent à la place de leurs noms
  // provisoires ; ceux remis à `onChunk` sont déjà construits, l'appelant les renomme par `names`.
  const names = output.names.length > 0 ? output.names : undefined;
  if (names) {
    let next = 0;
    for (const raw of raws) {
      if (next + raw.keys.length <= names.length) raw.names = names.slice(next, next + raw.keys.length);
      next += raw.keys.length;
    }
  }
  return { raw: raws, metadata: metadataFromChunks(output, chunks), report, names };
}
