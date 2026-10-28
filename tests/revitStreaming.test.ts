import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Color } from 'three';
import { ModelBuilder, buildModel } from '../src/engine/buildModel.ts';
import type { Model } from '../src/engine/Model.ts';
import { initSync, readRevit, readRevitFile, type RevitChunk } from '../src/revit/pkg/revit.js';
import { metadataFromChunks, rawFromChunk, rawFromOutput, triangleBudgetFor } from '../src/revit/readRevit.ts';

// Le chemin de production : revitWorker.ts appelle `readRevitFile` avec un lecteur par tranches (FileReaderSync sur
// file.slice) et un rappel par morceau. Ici le lecteur est une copie de la tranche demandée, comme celle du worker.
initSync({ module: readFileSync(new URL('../src/revit/pkg/revit_bg.wasm', import.meta.url)) });

/** Les réglages que le fil principal envoie au worker (sur un appareil qui ne dit pas sa mémoire, comme Node). */
const OPTIONS = { triangleBudget: triangleBudgetFor(undefined) };
const WINDOW_BYTES = 1 << 20;
const select = () => ({ value: new Color() });

interface Streamed {
  output: ReturnType<typeof readRevitFile>;
  chunks: RevitChunk[];
  windows: [offset: number, length: number][];
}

function stream(bytes: Uint8Array): Streamed {
  const chunks: RevitChunk[] = [];
  const windows: [number, number][] = [];
  const output = readRevitFile(
    bytes.length,
    (offset: number, length: number) => {
      windows.push([offset, length]);
      return bytes.slice(offset, offset + length);
    },
    OPTIONS,
    (chunk: RevitChunk) => chunks.push(chunk),
  );
  return { output, chunks, windows };
}

/** Les octets d'un tableau typé, pour comparer de gros tableaux sans parcours en JavaScript. */
const bytesOf = (array: ArrayBufferView) => Buffer.from(array.buffer, array.byteOffset, array.byteLength);

/** Mis bout à bout, les tableaux typés des morceaux : ce que la sortie d'un bloc porte d'un seul tenant. */
function concat<T extends Float32Array | Uint32Array | Uint8Array>(arrays: T[]): T {
  const result = new (arrays[0].constructor as new (length: number) => T)(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    result.set(array, at);
    at += array.length;
  }
  return result;
}

function assertSameBytes(actual: ArrayBufferView, expected: ArrayBufferView, what: string): void {
  assert.equal(actual.byteLength, expected.byteLength, `${what} : même longueur`);
  assert.equal(Buffer.compare(bytesOf(actual), bytesOf(expected)), 0, `${what} : mêmes valeurs`);
}

function assertSameModel(actual: Model, expected: Model, what: string): void {
  assert.equal(actual.count, expected.count, `${what} : même nombre d’éléments`);
  assert.equal(actual.triangleCount, expected.triangleCount, `${what} : même nombre de triangles`);
  assert.deepEqual(actual.keys, expected.keys, `${what} : mêmes clés`);
  assert.deepEqual(actual.box.min.toArray(), expected.box.min.toArray(), `${what} : même boîte`);
  assert.deepEqual(actual.box.max.toArray(), expected.box.max.toArray(), `${what} : même boîte`);
  assert.deepEqual(actual.offset.toArray(), expected.offset.toArray(), `${what} : même origine`);
}

function checkStreaming(path: URL, severalChunks: boolean): void {
  const bytes = new Uint8Array(readFileSync(path));
  const { output, chunks, windows } = stream(bytes);
  const whole = readRevit(bytes, OPTIONS);
  assert.ok(chunks.length >= 1, 'au moins un morceau');
  if (severalChunks) assert.ok(chunks.length > 1, `plusieurs morceaux attendus, ${chunks.length} reçus`);

  // Le lecteur ne demande que des fenêtres du fichier, jamais plus de 1 Mio à la fois.
  assert.ok(windows.length > 0);
  for (const [offset, length] of windows) {
    assert.ok(offset >= 0 && length > 0 && offset + length <= bytes.length, `fenêtre ${offset}+${length} hors du fichier`);
    assert.ok(length <= WINDOW_BYTES, `fenêtre de ${length} octets`);
  }

  // Chaque morceau est cohérent en lui-même : indices d'élément, de sommet et de matériau locaux à ce morceau.
  let previousMaterials: Uint8Array | null = null;
  for (const [i, chunk] of chunks.entries()) {
    const label = `morceau ${i}`;
    assert.equal(chunk.names.length, chunk.keys.length, `${label} : un nom provisoire par élément`);
    assert.ok(chunk.names.every((name) => typeof name === 'string' && name !== ''), `${label} : noms provisoires non vides`);
    assert.equal(chunk.sources.length, chunk.keys.length, `${label} : une origine de forme par élément`);
    assert.equal(chunk.positions.length % 3, 0);
    assert.equal(chunk.normals.length, chunk.positions.length);
    assert.equal(chunk.indices.length % 3, 0);
    assert.equal(chunk.primitives.length % 6, 0);
    assert.equal(chunk.materials.length % 7, 0);
    assert.deepEqual(chunk.origin, whole.origin, `${label} : l'origine du modèle entier`);
    const vertices = chunk.positions.length / 3;
    for (let p = 0; p < chunk.primitives.length; p += 6) {
      const [element, vertexStart, vertexCount, indexStart, indexCount, material] = chunk.primitives.subarray(p, p + 6);
      assert.ok(element < chunk.keys.length, `${label} : l'élément ${element} d'une primitive est local (${chunk.keys.length} éléments)`);
      assert.ok(vertexStart + vertexCount <= vertices, `${label} : sommets de la primitive dans le morceau`);
      assert.ok(indexStart + indexCount <= chunk.indices.length, `${label} : indices de la primitive dans le morceau`);
      assert.ok(material * 7 < chunk.materials.length, `${label} : matériau de la primitive dans sa table`);
    }
    // La table de matériaux d'un morceau prolonge celle du précédent.
    if (previousMaterials) {
      assert.ok(chunk.materials.length >= previousMaterials.length, `${label} : la table de matériaux ne rétrécit pas`);
      assertSameBytes(chunk.materials.subarray(0, previousMaterials.length), previousMaterials, `${label} : début de la table de matériaux`);
    }
    previousMaterials = chunk.materials;
  }

  // Σ des clés des morceaux = éléments du rapport = libellés rendus à la fin ; le rendu final ne porte plus de tableaux.
  const elements = chunks.reduce((sum, chunk) => sum + chunk.keys.length, 0);
  assert.equal(output.report.elements, elements);
  assert.equal(output.names.length, elements, 'un libellé de fiche par élément, dans l’ordre des morceaux');
  assert.equal(output.keys.length, 0);
  assert.equal(output.positions.length, 0);

  // Mis bout à bout, les morceaux redonnent la sortie d'un bloc.
  assert.deepEqual(chunks.flatMap((chunk) => chunk.keys), whole.keys, 'mêmes clés, dans le même ordre');
  assert.deepEqual(output.names, whole.names, 'mêmes libellés');
  assertSameBytes(concat(chunks.map((chunk) => chunk.positions)), whole.positions, 'positions');
  assertSameBytes(concat(chunks.map((chunk) => chunk.normals)), whole.normals, 'normales');
  assertSameBytes(concat(chunks.map((chunk) => chunk.indices)), whole.indices, 'indices');
  assertSameBytes(concat(chunks.map((chunk) => chunk.sources)), whole.sources, 'origines des formes');
  assertSameBytes(chunks[chunks.length - 1].materials, whole.materials, 'table de matériaux du dernier morceau');
  // Les primitives, une fois leurs éléments, sommets et indices recalés sur le bloc entier.
  const primitives: number[] = [];
  let elementBase = 0;
  let vertexBase = 0;
  let indexBase = 0;
  for (const chunk of chunks) {
    for (let p = 0; p < chunk.primitives.length; p += 6) {
      const row = chunk.primitives;
      primitives.push(row[p] + elementBase, row[p + 1] + vertexBase, row[p + 2], row[p + 3] + indexBase, row[p + 4], row[p + 5]);
    }
    elementBase += chunk.keys.length;
    vertexBase += chunk.positions.length / 3;
    indexBase += chunk.indices.length;
  }
  assert.deepEqual(primitives, [...whole.primitives], 'mêmes primitives, une fois recalées');
  // Le bilan et le JSON de métadonnées sont ceux d'un bloc (la durée mise à part).
  assert.equal(output.metadata, whole.metadata);
  assert.equal(metadataFromChunks(output, chunks), whole.metadata);
  const { seconds: _seconds, stages: _stages, ...report } = output.report;
  const { seconds: _wholeSeconds, stages: _wholeStages, ...wholeReport } = whole.report;
  assert.deepEqual(report, wholeReport);

  // Construits avec le buildModel de l'application, morceaux ou bloc : mêmes éléments et mêmes triangles.
  const reference = buildModel(rawFromOutput(whole), select());
  const together = buildModel(chunks.map(rawFromChunk), select());
  assertSameModel(together, reference, 'buildModel sur les morceaux');
  together.dispose();
  // Et morceau après morceau, comme l'affichage progressif de la lecture, avec les libellés rendus à la fin.
  const builder = new ModelBuilder(select());
  for (const chunk of chunks) builder.append(rawFromChunk(chunk));
  assertSameModel(builder.model, reference, 'ModelBuilder morceau après morceau');
  assert.equal(builder.model.names.length, output.names.length);
  const names = builder.model.names.map((_, i) => output.names[i] || builder.model.keys[i]);
  assert.deepEqual(names, reference.names, 'les libellés rendus à la fin sont ceux d’un bloc');
  builder.model.dispose();
  reference.dispose();
}

const committed: [name: string, path: URL][] = [
  ['la fixture de revit/tests/fixtures (Revit 2023)', new URL('../revit/tests/fixtures/Revit_IFC5_Einhoven.rvt', import.meta.url)],
  ['l’exemple public/samples/revit-demo.rvt', new URL('../public/samples/revit-demo.rvt', import.meta.url)],
];
for (const [name, path] of committed) {
  test(`la lecture par morceaux (readRevitFile, comme le worker) sur ${name} redonne la sortie d’un bloc`, () => {
    checkStreaming(path, false);
  });
}

// Les fichiers d'essai de revit/samples/ ne sont pas versionnés (.gitignore) : sans eux, ces essais n'ont pas lieu.
for (const file of ['SampleModel.rvt', 'rac_advanced_sample_project.rvt']) {
  const path = new URL(`../revit/samples/${file}`, import.meta.url);
  if (!existsSync(path)) continue;
  test(`la lecture par morceaux sur revit/samples/${file} (plusieurs morceaux) redonne la sortie d’un bloc`, { timeout: 120_000 }, () => {
    checkStreaming(path, true);
  });
}
