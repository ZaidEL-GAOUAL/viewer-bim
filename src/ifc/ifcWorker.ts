/// <reference lib="webworker" />
// Conversion IFC → GLB + JSON dans le navigateur, hors du fil principal.
// Le script Python exécuté ici est exactement celui de la ligne de commande
// (pipeline/ifc_to_glb.py) : il tourne sur IfcOpenShell compilé en WebAssembly, via Pyodide.

import converterSource from '../../pipeline/ifc_to_glb.py?raw';
import usdWriterSource from '../../pipeline/usd_writer.py?raw';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';

export interface ConvertRequest {
  kind: 'convert';
  id: number;
  buffer: ArrayBuffer;
  /** Adresse absolue du paquet IfcOpenShell pour le navigateur, servi avec le viewer. */
  wheelUrl: string;
  /** Tranche des éléments à convertir : [indice, nombre de tranches]. */
  shard: [number, number];
}

/** Emballage d'un GLB (déjà fusionné) et de ses métadonnées en paquet USDZ. */
export interface UsdRequest {
  kind: 'usd';
  id: number;
  glb: ArrayBuffer;
  metadata: string;
  wheelUrl: string;
}


export type ConvertMessage =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'progress'; percent: number }
  | { id: number; type: 'done'; glb: ArrayBuffer; metadata: string; report: Record<string, unknown> }
  | { id: number; type: 'usd'; usdz: ArrayBuffer }
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

/** Télécharge et prépare Python, IfcOpenShell et le convertisseur pour ce worker. */
async function prepare(id: number, wheelUrl: string): Promise<Pyodide> {
  post({ id, type: 'status', message: 'Chargement du moteur de conversion…' });
  const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
    loadPyodide(options: { indexURL: string }): Promise<Pyodide>;
  };
  const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
  await pyodide.loadPackage('micropip');
  post({ id, type: 'status', message: 'Installation d’IfcOpenShell…' });
  await pyodide.pyimport('micropip').install(wheelUrl);
  pyodide.FS.mkdirTree('/pipeline');
  pyodide.FS.writeFile('/pipeline/ifc_to_glb.py', converterSource);
  pyodide.FS.writeFile('/pipeline/usd_writer.py', usdWriterSource);
  pyodide.runPython("import sys\nsys.path.insert(0, '/pipeline')\nimport ifc_to_glb\nimport usd_writer");
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

const PACKAGE_USD = `
import json
import usd_writer
with open('/tmp/merged.glb', 'rb') as _in:
    _scene = usd_writer.scene_from_glb(_in.read())
with open('/tmp/merged.json', 'r', encoding='utf-8') as _in:
    _metadata = json.load(_in)
with open('/tmp/model.usdz', 'wb') as _out:
    _out.write(usd_writer.write_usdz(usd_writer.write_usda(_scene, _metadata, 'viewer-bim ifc_to_glb (IfcOpenShell, navigateur)')))
del _scene, _metadata
`;

async function handle(event: MessageEvent<ConvertRequest | UsdRequest>): Promise<void> {
  const { id, wheelUrl } = event.data;
  try {
    runtime ??= prepare(id, wheelUrl);
    const pyodide = await runtime.catch((error: unknown) => {
      runtime = null; // un échec de téléchargement ne doit pas bloquer l'essai suivant
      throw error;
    });

    if (event.data.kind === 'usd') {
      post({ id, type: 'status', message: 'Écriture du fichier USD…' });
      pyodide.FS.writeFile('/tmp/merged.glb', new Uint8Array(event.data.glb));
      pyodide.FS.writeFile('/tmp/merged.json', event.data.metadata);
      pyodide.runPython(PACKAGE_USD);
      const output = (pyodide.FS.readFile('/tmp/model.usdz') as Uint8Array).slice().buffer as ArrayBuffer;
      post({ id, type: 'usd', usdz: output }, [output]);
      return;
    }
    const { buffer, shard } = event.data;

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
  } finally {
    // A failed job must not retain its IFC/mesh buffers in the WebAssembly filesystem.
    const pyodide = await runtime?.catch(() => null);
    if (pyodide) {
      for (const path of ['/tmp/model.ifc', '/tmp/model.glb', '/tmp/model.json', '/tmp/merged.glb', '/tmp/merged.json', '/tmp/model.usdz']) {
        try { pyodide.FS.unlink(path); } catch { /* already removed / not produced */ }
      }
      pyodide.runPython("import gc\nfor _name in ('_result', '_scene', '_metadata', '_glb'):\n    globals().pop(_name, None)\ngc.collect()");
    }
  }
}

// Runtime preparation is asynchronous: serialise messages before they can share /tmp paths.
let jobs = Promise.resolve();
scope.onmessage = (event: MessageEvent<ConvertRequest | UsdRequest>) => {
  jobs = jobs.then(() => handle(event)).catch((error: unknown) => {
    post({ id: event.data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
};
