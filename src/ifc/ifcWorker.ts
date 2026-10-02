/// <reference lib="webworker" />
// Conversion IFC → GLB + JSON dans le navigateur, hors du fil principal.
// Le script Python exécuté ici est exactement celui de la ligne de commande
// (pipeline/ifc_to_glb.py) : il tourne sur IfcOpenShell compilé en WebAssembly, via Pyodide.

import converterSource from '../../pipeline/ifc_to_glb.py?raw';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';

export interface ConvertRequest {
  id: number;
  buffer: ArrayBuffer;
  /** Adresse absolue du paquet IfcOpenShell pour le navigateur, servi avec le viewer. */
  wheelUrl: string;
  /** Tranche des éléments à convertir : [indice, nombre de tranches]. */
  shard: [number, number];
}

export type ConvertMessage =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'progress'; percent: number }
  | { id: number; type: 'done'; glb: ArrayBuffer; metadata: string; report: Record<string, unknown> }
  | { id: number; type: 'error'; message: string };

interface Pyodide {
  loadPackage(name: string): Promise<void>;
  pyimport(name: string): { install(url: string): Promise<void> };
  runPython(code: string): unknown;
  globals: { set(name: string, value: unknown): void };
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, data: Uint8Array | string): void;
    readFile(path: string, options?: { encoding: 'utf8' }): Uint8Array | string;
    unlink(path: string): void;
  };
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: ConvertMessage, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

let runtime: Promise<Pyodide> | null = null;

/** Télécharge et prépare Python, IfcOpenShell et le convertisseur : une seule fois par session. */
async function prepare(id: number, wheelUrl: string): Promise<Pyodide> {
  post({ id, type: 'status', message: 'Téléchargement du convertisseur IFC (une seule fois)…' });
  const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
    loadPyodide(options: { indexURL: string }): Promise<Pyodide>;
  };
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  await pyodide.loadPackage('micropip');
  post({ id, type: 'status', message: 'Installation d’IfcOpenShell…' });
  await pyodide.pyimport('micropip').install(wheelUrl);
  pyodide.FS.mkdirTree('/pipeline');
  pyodide.FS.writeFile('/pipeline/ifc_to_glb.py', converterSource);
  pyodide.runPython("import sys\nsys.path.insert(0, '/pipeline')\nimport ifc_to_glb");
  return pyodide;
}

const CONVERT = `
import json
import ifcopenshell
import ifc_to_glb

_result = ifc_to_glb.convert(ifcopenshell.open('/tmp/model.ifc'), shard=(shard_index, shard_count), progress=report_progress)
with open('/tmp/model.glb', 'wb') as _out:
    _out.write(_result.glb)
with open('/tmp/model.json', 'w', encoding='utf-8') as _out:
    _out.write(_result.metadata_json())
_report = json.dumps(_result.report)
del _result
_report
`;

scope.onmessage = async (event: MessageEvent<ConvertRequest>) => {
  const { id, buffer, wheelUrl, shard } = event.data;
  try {
    runtime ??= prepare(id, wheelUrl);
    const pyodide = await runtime.catch((error: unknown) => {
      runtime = null; // un échec de téléchargement ne doit pas bloquer l'essai suivant
      throw error;
    });

    post({ id, type: 'status', message: 'Lecture de l’IFC…' });
    pyodide.FS.writeFile('/tmp/model.ifc', new Uint8Array(buffer));
    pyodide.globals.set('report_progress', (percent: number) => post({ id, type: 'progress', percent }));
    pyodide.globals.set('shard_index', shard[0]);
    pyodide.globals.set('shard_count', shard[1]);
    const report = JSON.parse(pyodide.runPython(CONVERT) as string) as Record<string, unknown>;

    const glb = pyodide.FS.readFile('/tmp/model.glb') as Uint8Array;
    const metadata = pyodide.FS.readFile('/tmp/model.json', { encoding: 'utf8' }) as string;
    for (const path of ['/tmp/model.ifc', '/tmp/model.glb', '/tmp/model.json']) pyodide.FS.unlink(path);

    const copy = glb.slice().buffer as ArrayBuffer;
    post({ id, type: 'done', glb: copy, metadata, report }, [copy]);
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
