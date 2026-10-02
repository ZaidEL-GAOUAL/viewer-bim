import type { ConvertMessage, ConvertRequest } from './ifcWorker.ts';

export interface IfcConversion {
  glb: ArrayBuffer;
  /** Métadonnées au format du contrat (docs/contrat-metadonnees.md), en texte JSON. */
  metadata: string;
  report: { elements?: number; triangles?: number; seconds?: number; without_geometry?: number };
}

// IfcOpenShell compilé pour le navigateur, servi avec le viewer. La 0.8.5 est la dernière version
// vérifiée : le paquet 0.9.0 plante à la lecture d'un IFC (accès mémoire hors limites).
const WHEEL = 'wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';

let worker: Worker | null = null;
let nextId = 1;

export function isIfcFile(name: string): boolean {
  return /\.ifc$/i.test(name);
}

/**
 * Convertit un fichier IFC en GLB + métadonnées, dans le navigateur. Le convertisseur (Python et
 * IfcOpenShell en WebAssembly) n'est téléchargé qu'au premier IFC ouvert, puis reste en mémoire.
 * Le fichier n'est envoyé à aucun serveur.
 */
export function convertIfc(file: File, onStatus: (message: string) => void): Promise<IfcConversion> {
  // Le convertisseur vit dans un fil d'exécution séparé : l'interface reste fluide pendant le calcul.
  worker ??= new Worker(new URL('./ifcWorker.ts', import.meta.url), { type: 'module' });
  const current = worker;
  const id = nextId++;

  return file.arrayBuffer().then(
    (buffer) =>
      new Promise<IfcConversion>((resolve, reject) => {
        const finish = () => {
          current.removeEventListener('message', onMessage);
          current.removeEventListener('error', onError);
        };
        const onMessage = (event: MessageEvent<ConvertMessage>) => {
          const message = event.data;
          if (message.id !== id) return;
          if (message.type === 'status') onStatus(message.message);
          else if (message.type === 'progress') onStatus(`Conversion de la géométrie : ${message.percent} %`);
          else if (message.type === 'done') {
            finish();
            resolve({ glb: message.glb, metadata: message.metadata, report: message.report });
          } else {
            finish();
            reject(new Error(message.message));
          }
        };
        const onError = (event: ErrorEvent) => {
          finish();
          worker = null; // le prochain essai repart d'un convertisseur neuf
          reject(new Error(event.message || 'Le convertisseur IFC s’est arrêté.'));
        };
        current.addEventListener('message', onMessage);
        current.addEventListener('error', onError);
        const request: ConvertRequest = { id, buffer, wheelUrl: new URL(WHEEL, document.baseURI).href };
        current.postMessage(request, [buffer]);
      }),
  );
}
