import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { initSync, readRevit } from '../src/revit/pkg/revit.js';

// Le module WebAssembly livré avec le viewer (compilé depuis revit/, voir npm run build:revit),
// lu sur un fichier d'essai Revit 2023 (licence MIT, voir revit/tests/fixtures).
initSync({ module: readFileSync(new URL('../src/revit/pkg/revit_bg.wasm', import.meta.url)) });
const fixture = readFileSync(new URL('../revit/tests/fixtures/Revit_IFC5_Einhoven.rvt', import.meta.url));

test('le lecteur Revit rend des tableaux typés cohérents entre eux', () => {
  const output = readRevit(new Uint8Array(fixture));

  assert.ok(output.positions instanceof Float32Array);
  assert.ok(output.normals instanceof Float32Array);
  assert.ok(output.indices instanceof Uint32Array);
  assert.ok(output.primitives instanceof Uint32Array);
  assert.ok(output.materials instanceof Uint8Array);
  assert.ok(output.sources instanceof Uint8Array);
  assert.ok(Array.isArray(output.keys) && Array.isArray(output.names));
  assert.equal(output.origin.length, 3);
  assert.ok(output.origin.every((value) => typeof value === 'number'));

  const count = output.keys.length;
  assert.equal(output.names.length, count);
  assert.equal(output.sources.length, count);
  assert.equal(new Set(output.keys).size, count, 'les clés sont uniques');
  assert.equal(output.normals.length, output.positions.length);
  assert.equal(output.positions.length % 3, 0);
  assert.equal(output.indices.length % 3, 0);
  assert.equal(output.primitives.length % 6, 0);
  assert.equal(output.materials.length % 7, 0);
});

test('le rapport donne l’année de Revit et des compteurs cohérents', () => {
  const { report, keys, indices, sources } = readRevit(new Uint8Array(fixture));
  assert.equal(report.release, 2023);
  assert.equal(typeof report.experimental, 'boolean');
  assert.equal(report.elements, keys.length);
  assert.equal(report.triangles, indices.length / 3);
  assert.ok(report.seconds >= 0);
  assert.ok(report.withoutGeometry >= 0);
  assert.ok(Array.isArray(report.warnings));
  assert.ok(report.stages.length > 0 && report.stages.every((stage) => typeof stage.name === 'string' && stage.seconds >= 0), 'chaque étape a sa durée');
  assert.equal(report.sources.revit + report.sources.partial + report.sources.rebuilt + report.sources.unknown, sources.length);
});

test('les métadonnées suivent le contrat JSON du viewer', () => {
  const { metadata, keys } = readRevit(new Uint8Array(fixture));
  const parsed = JSON.parse(metadata);
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.readOnly));
  assert.equal(typeof parsed.elements, 'object');
  for (const key of keys) assert.ok(key in parsed.elements, `fiche manquante pour ${key}`);
});

test('chaque nom rendu est le libellé de la fiche du même élément, avec l’origine de sa forme', () => {
  const { metadata, keys, names, sources } = readRevit(new Uint8Array(fixture));
  const parsed = JSON.parse(metadata);
  const origins = ['Forme Revit', 'Forme Revit partielle', 'Forme reconstruite', 'Inconnue (boîte englobante)'];
  keys.forEach((key, i) => {
    assert.equal(parsed.elements[key].label, names[i], `libellé de ${key}`);
    assert.equal(parsed.elements[key].properties['Source de la géométrie'], origins[sources[i]], `origine de la forme de ${key}`);
    // Juste après les matériaux, quand l'élément en a (l'ordre des propriétés est celui du JSON).
    const properties = Object.keys(parsed.elements[key].properties);
    const materials = properties.indexOf('Matériaux');
    if (materials >= 0) assert.equal(properties[materials + 1], 'Source de la géométrie', `ordre des propriétés de tête de ${key}`);
  });
});

test('un fichier qui n’est pas du Revit est refusé avec un message lisible', () => {
  assert.throws(() => readRevit(new TextEncoder().encode('ceci n’est pas un fichier Revit')), (error: unknown) => error instanceof Error && /Revit/.test(error.message));
});
