/// <reference lib="webworker" />
// Conversion IFC → GLB + JSON dans le navigateur, hors du fil principal.
// Le script Python exécuté ici est exactement celui de la ligne de commande
// (pipeline/ifc_to_glb.py) : il tourne sur IfcOpenShell compilé en WebAssembly, via Pyodide.

import converterSource from '../../pipeline/ifc_to_glb.py?raw';
import usdWriterSource from '../../pipeline/usd_writer.py?raw';
import sceneSource from '../../pipeline/scene.py?raw';
import { loadWheel } from './wheelCache.ts';
import { missingRequirements } from './wheelRequires.ts';
import type { ShardTimings, StartupTimings } from './timings.ts';

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/';

export interface ConvertRequest {
  kind: 'convert';
  id: number;
  buffer: ArrayBuffer;
  /** Adresse absolue du paquet IfcOpenShell pour le navigateur, sur le site d'IfcOpenShell. */
  wheelUrl: string;
  /** Empreinte SHA-256 (hexadécimale) attendue du paquet : un autre fichier est refusé. */
  wheelSha256: string;
  /** Tranche des éléments à convertir : [indice, nombre de tranches]. */
  shard: [number, number];
}

/**
 * Emballage d'un GLB (déjà fusionné) et de ses métadonnées en paquet USDZ. Il ne demande que Python
 * et numpy : IfcOpenShell n'est ni téléchargé ni installé pour lui.
 */
export interface UsdRequest {
  kind: 'usd';
  id: number;
  glb: ArrayBuffer;
  metadata: string;
}

/**
 * Prépare le moteur sans rien convertir. `python` : Python et numpy seulement ; `ifc` : et
 * IfcOpenShell. Répond `ready` avec la durée de chaque étape (vide si c'était déjà prêt).
 */
export interface PrepareRequest {
  kind: 'prepare';
  id: number;
  level: 'python' | 'ifc';
  wheelUrl: string;
  wheelSha256: string;
}


export type ConvertMessage =
  | { id: number; type: 'status'; message: string }
  | { id: number; type: 'progress'; percent: number }
  | { id: number; type: 'ready'; startup: StartupTimings }
  | { id: number; type: 'done'; glb: ArrayBuffer; metadata: string; report: Record<string, unknown>; timings: ShardTimings }
  | { id: number; type: 'usd'; usdz: ArrayBuffer; startup: StartupTimings }
  | { id: number; type: 'error'; message: string };

interface Pyodide {
  loadPackage(names: string | string[]): Promise<unknown>;
  loadedPackages: Record<string, unknown>;
  toPy(value: unknown): { destroy(): void };
  pyimport(name: string): { install: { (names: unknown): Promise<void>; callKwargs(url: string, options: { deps: boolean }): Promise<void> } };
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

/**
 * Paquets dont IfcOpenShell 0.8.5 a besoin, lus dans le METADATA du paquet officiel (empreinte
 * fbebb7a7…) : shapely, numpy, isodate, python-dateutil, lark, typing-extensions (et six, que
 * python-dateutil demande). Fait mesuré : Pyodide 0.29.3 fournit numpy, shapely, python-dateutil,
 * six et typing-extensions ; isodate et lark viennent de PyPI, par micropip. `loadPackage` ignore
 * sans erreur les noms inconnus : on regarde donc ce qui est vraiment chargé.
 */
const WHEEL_REQUIRES = ['numpy', 'shapely', 'isodate', 'python-dateutil', 'six', 'lark', 'typing-extensions'];

let base: Promise<Pyodide> | null = null; // Python et numpy, scripts sans IfcOpenShell
let engine: Promise<Pyodide> | null = null; // et IfcOpenShell
let startup: StartupTimings = {};

/** Durées de préparation accumulées depuis la dernière réponse : seule la tâche qui a préparé le moteur les reçoit. */
function takeStartup(): StartupTimings {
  const taken = startup;
  startup = {};
  return taken;
}

async function timed<T>(phase: 'boot' | 'packages' | 'install' | 'import', work: () => Promise<T> | T): Promise<T> {
  const began = performance.now();
  try { return await work(); }
  finally { startup[phase] = Math.round((startup[phase] ?? 0) + performance.now() - began); }
}

/** Démarre Python et charge numpy, puis l'écriture USD : tout ce qui ne demande pas IfcOpenShell. */
async function preparePython(id: number): Promise<Pyodide> {
  const began = performance.now();
  post({ id, type: 'status', message: 'Chargement du moteur de conversion…' });
  const pyodide = await timed('boot', async () => {
    const { loadPyodide } = (await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`)) as {
      loadPyodide(options: { indexURL: string }): Promise<Pyodide>;
    };
    return loadPyodide({ indexURL: PYODIDE_URL });
  });
  await timed('packages', () => pyodide.loadPackage('numpy'));
  await timed('import', () => {
    pyodide.FS.mkdirTree('/pipeline');
    pyodide.FS.writeFile('/pipeline/scene.py', sceneSource);
    pyodide.FS.writeFile('/pipeline/usd_writer.py', usdWriterSource);
    pyodide.runPython("import sys\nsys.path.insert(0, '/pipeline')\nimport usd_writer");
  });
  startup.total = Math.round((startup.total ?? 0) + performance.now() - began);
  return pyodide;
}

/**
 * Charge les dépendances de Pyodide en parallèle du fichier IfcOpenShell (cache ou réseau, empreinte
 * vérifiée), installe depuis PyPI celles que Pyodide ne fournit pas (comptées dans « install »),
 * puis le paquet sans résolution. Si cette installation échoue (hors ligne), le paquet est installé
 * avec résolution complète, comme avant.
 */
async function installWheel(pyodide: Pyodide, wheelUrl: string, wheelSha256: string): Promise<void> {
  const packages = timed('packages', async () => {
    try { await pyodide.loadPackage(['micropip', ...WHEEL_REQUIRES]); return true; }
    catch { await pyodide.loadPackage('micropip'); return false; }
  });
  const fetching = (async () => {
    const began = performance.now();
    const wheel = await loadWheel(wheelUrl, wheelSha256);
    startup.wheelFetch = Math.round(performance.now() - began);
    startup.wheelSource = wheel.source;
    return wheel.bytes;
  })();
  const [loaded, bytes] = await Promise.all([packages, fetching]);
  // micropip lit le nom du fichier pour en déduire la version et la plateforme : on garde le nom officiel.
  const path = `/tmp/${new URL(wheelUrl).pathname.split('/').pop()}`;
  pyodide.FS.writeFile(path, new Uint8Array(bytes));
  try {
    await timed('install', async () => {
      const micropip = pyodide.pyimport('micropip');
      let deps = !loaded;
      const missing = loaded ? missingRequirements(WHEEL_REQUIRES, pyodide.loadedPackages) : [];
      if (missing.length > 0) {
        const names = pyodide.toPy(missing);
        try { await micropip.install(names); }
        catch { deps = true; } // PyPI injoignable : résolution complète, comme avant
        finally { names.destroy(); }
      }
      await micropip.install.callKwargs(`emfs:${path}`, { deps });
    });
  } finally {
    pyodide.FS.unlink(path);
  }
}

async function prepareEngine(pyodide: Pyodide, id: number, wheelUrl: string, wheelSha256: string): Promise<Pyodide> {
  const began = performance.now();
  post({ id, type: 'status', message: 'Installation d’IfcOpenShell…' });
  await installWheel(pyodide, wheelUrl, wheelSha256);
  await timed('import', () => {
    pyodide.FS.writeFile('/pipeline/ifc_to_glb.py', converterSource);
    pyodide.runPython('import ifc_to_glb');
  });
  startup.total = Math.round((startup.total ?? 0) + performance.now() - began);
  return pyodide;
}

/** Le moteur au niveau demandé. Un échec de téléchargement ne bloque pas l'essai suivant. */
async function ensure(level: 'python' | 'ifc', id: number, wheelUrl: string, wheelSha256: string): Promise<Pyodide> {
  base ??= preparePython(id).catch((error: unknown) => { base = engine = null; throw error; });
  const python = await base;
  if (level === 'python') return python;
  engine ??= prepareEngine(python, id, wheelUrl, wheelSha256).catch((error: unknown) => { engine = null; throw error; });
  return engine;
}

const CONVERT = `
import json
import time
import ifcopenshell
import ifc_to_glb

_began = time.perf_counter()
_model = ifcopenshell.open('/tmp/model.ifc')
_parsed = time.perf_counter()
_result = ifc_to_glb.convert(_model, shard=(shard_index, shard_count), progress=report_progress)
with open('/tmp/model.glb', 'wb') as _out:
    _out.write(_result.glb)
with open('/tmp/model.json', 'w', encoding='utf-8') as _out:
    _out.write(_result.metadata_json())
_report = json.dumps({'report': _result.report, 'parse': _parsed - _began, 'geometry': time.perf_counter() - _parsed})
del _result, _model
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

async function handle(event: MessageEvent<ConvertRequest | UsdRequest | PrepareRequest>): Promise<void> {
  const request = event.data;
  const { id } = request;
  try {
    if (request.kind === 'prepare') {
      await ensure(request.level, id, request.wheelUrl, request.wheelSha256);
      post({ id, type: 'ready', startup: takeStartup() });
      return;
    }
    if (request.kind === 'usd') {
      const pyodide = await ensure('python', id, '', '');
      post({ id, type: 'status', message: 'Écriture du fichier USD…' });
      pyodide.FS.writeFile('/tmp/merged.glb', new Uint8Array(request.glb));
      pyodide.FS.writeFile('/tmp/merged.json', request.metadata);
      pyodide.runPython(PACKAGE_USD);
      const output = (pyodide.FS.readFile('/tmp/model.usdz') as Uint8Array).slice().buffer as ArrayBuffer;
      post({ id, type: 'usd', usdz: output, startup: takeStartup() }, [output]);
      return;
    }
    const pyodide = await ensure('ifc', id, request.wheelUrl, request.wheelSha256);
    const { buffer, shard } = request;

    post({ id, type: 'status', message: 'Lecture de l’IFC…' });
    pyodide.FS.writeFile('/tmp/model.ifc', new Uint8Array(buffer));
    pyodide.globals.set('report_progress', (percent: number) => post({ id, type: 'progress', percent }));
    pyodide.globals.set('shard_index', shard[0]);
    pyodide.globals.set('shard_count', shard[1]);
    const run = JSON.parse(pyodide.runPython(CONVERT) as string) as { report: Record<string, unknown>; parse: number; geometry: number };

    const glb = pyodide.FS.readFile('/tmp/model.glb') as Uint8Array;
    const metadata = pyodide.FS.readFile('/tmp/model.json', { encoding: 'utf8' }) as string;
    for (const path of ['/tmp/model.ifc', '/tmp/model.glb', '/tmp/model.json']) pyodide.FS.unlink(path);

    const copy = glb.slice().buffer as ArrayBuffer;
    const timings: ShardTimings = { startup: takeStartup(), parse: Math.round(run.parse * 1000), geometry: Math.round(run.geometry * 1000) };
    post({ id, type: 'done', glb: copy, metadata, report: run.report, timings }, [copy]);
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    // A failed job must not retain its IFC/mesh buffers in the WebAssembly filesystem.
    const pyodide = await base?.catch(() => null);
    if (pyodide) {
      for (const path of ['/tmp/model.ifc', '/tmp/model.glb', '/tmp/model.json', '/tmp/merged.glb', '/tmp/merged.json', '/tmp/model.usdz']) {
        try { pyodide.FS.unlink(path); } catch { /* already removed / not produced */ }
      }
      pyodide.runPython("import gc\nfor _name in ('_result', '_model', '_scene', '_metadata', '_glb'):\n    globals().pop(_name, None)\ngc.collect()");
    }
  }
}

// Runtime preparation is asynchronous: serialise messages before they can share /tmp paths.
let jobs = Promise.resolve();
scope.onmessage = (event: MessageEvent<ConvertRequest | UsdRequest | PrepareRequest>) => {
  jobs = jobs.then(() => handle(event)).catch((error: unknown) => {
    post({ id: event.data.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
};
