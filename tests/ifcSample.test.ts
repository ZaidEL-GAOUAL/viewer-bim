import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Color, Vector3 } from 'three';
import { parseMetadata } from '../src/data/metadata.ts';
import { buildModel } from '../src/engine/buildModel.ts';
import { loadModelFiles } from '../src/engine/loadModel.ts';

// Fichiers produits par pipeline/ifc_to_glb.py à partir de public/samples/ifc-demo.ifc.
const samples = new URL('../public/samples/', import.meta.url);
const file = new File([readFileSync(new URL('ifc-demo.glb', samples))], 'ifc-demo.glb');
const { gltf } = await loadModelFiles({ file, path: file.name }, []);
const model = buildModel(gltf, { value: new Color() });
const metadata = parseMetadata(JSON.parse(readFileSync(new URL('ifc-demo.json', samples), 'utf8')));

test('la sortie du convertisseur IFC respecte le contrat du viewer', () => {
  assert.equal(model.count, 26);
  // Chaque élément 3D retrouve ses métadonnées par son identifiant IFC, et rien n'est en trop.
  assert.ok(model.keys.every((key) => metadata.elements.has(key)));
  assert.equal(metadata.elements.size, 26);
  assert.ok(model.keys.every((key) => key.length === 22));
});

test('le bâtiment converti est en mètres, vertical selon Y, et recentré', () => {
  const size = model.box.getSize(new Vector3());
  assert.ok(Math.abs(size.x - 10) < 0.01, `largeur ${size.x}`);
  assert.ok(Math.abs(size.y - 6) < 0.01, `hauteur ${size.y}`);
  assert.ok(Math.abs(size.z - 6) < 0.01, `profondeur ${size.z}`);
  // Le site est à plus de 6 000 km de l'origine : le décalage est retiré, la précision conservée.
  assert.ok(model.offset.length() > 6_000_000);
  assert.ok(model.box.getCenter(new Vector3()).length() < 0.01);
});

test('les éléments convertis sont des solides fermés, le vitrage est transparent', () => {
  for (let i = 0; i < model.count; i++) assert.equal(model.state.isOpen(i), false, model.names[i]);
  assert.ok(model.chunks.some((chunk) => chunk.transparent));
  assert.ok(model.chunks.every((chunk) => !chunk.doubleSided));
});

test('les propriétés IFC arrivent dans le viewer', () => {
  const wall = [...metadata.elements.values()].find((entry) => entry.label === 'Mur sud RDC');
  assert.ok(wall);
  assert.equal(wall.props['Classe IFC'], 'IfcWall');
  assert.equal(wall.props['Niveau'], 'RDC');
  assert.equal(wall.props['Pset_WallCommon / FireRating'], 'REI 120');
  assert.equal(wall.props['Qto_WallBaseQuantities / NetVolume'], 5.6);
});
