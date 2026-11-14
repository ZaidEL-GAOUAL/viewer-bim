import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionOf, fileKind, isIfcFile, isJsonFile, isModelFile, isUsdFile, withoutExtension } from '../src/engine/fileKinds.ts';

test('la sorte d’un fichier vient de son extension, sans tenir compte de la casse', () => {
  assert.equal(fileKind('maquette.GLB'), 'gltf');
  assert.equal(fileKind('scene.gltf'), 'gltf');
  assert.equal(fileKind('Projet.IFC'), 'ifc');
  assert.equal(fileKind('a.usdz'), 'usd');
  assert.equal(fileKind('a.usdc'), 'usd');
  assert.equal(fileKind('gabarit.RTE'), 'revit');
  assert.equal(fileKind('meta.json'), 'json');
  assert.equal(fileKind('scene.bin'), undefined);
  assert.equal(fileKind('image.png'), undefined);
  assert.equal(fileKind('toString'), undefined, 'une clé de l’objet n’est pas une extension');
  assert.equal(fileKind('model.glb.txt'), undefined);
  assert.equal(fileKind('glb'), undefined, 'sans point, pas d’extension');
});

test('les prédicats se répartissent les sortes', () => {
  assert.equal(isModelFile('a.glb'), true);
  assert.equal(isModelFile('a.usdz'), false);
  assert.equal(isIfcFile('a.ifc'), true);
  assert.equal(isIfcFile('a.ifcZIP'), false);
  assert.equal(isUsdFile('dossier.v2/a.usda'), true);
  assert.equal(isJsonFile('A.JSON'), true);
});

test('extensionOf et withoutExtension coupent au dernier point du nom', () => {
  assert.equal(extensionOf('Projet.v2.RFA'), 'rfa');
  assert.equal(extensionOf('sans-extension'), undefined);
  assert.equal(extensionOf('dossier.v2/fichier'), undefined);
  assert.equal(withoutExtension('Projet.v2.RFA'), 'Projet.v2');
  assert.equal(withoutExtension('maquette.ifc'), 'maquette');
  assert.equal(withoutExtension('sans-extension'), 'sans-extension');
  assert.equal(withoutExtension('Famille métrique.RFT'), 'Famille métrique');
});
