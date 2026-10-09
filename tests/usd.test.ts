import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Color, Vector3 } from 'three';
import { buildModel } from '../src/engine/buildModel.ts';
import { loadUsda, usdaFromUsdz } from '../src/usd/loadUsd.ts';
import { parseUsda } from '../src/usd/usda.ts';

const samples = new URL('../public/samples/', import.meta.url);
const usdz = readFileSync(new URL('ifc-demo.usdz', samples));
const text = usdaFromUsdz(usdz.buffer.slice(usdz.byteOffset, usdz.byteOffset + usdz.byteLength) as ArrayBuffer);

test('le paquet usdz livre un usda que le lecteur comprend', () => {
  assert.ok(text.startsWith('#usda 1.0'));
  const layer = parseUsda(text);
  assert.equal(layer.meta.upAxis, 'Z');
  assert.equal(layer.meta.metersPerUnit, 1);
  assert.equal(layer.prims.length, 1);
  const root = layer.prims[0];
  assert.deepEqual(root.children.map((child) => child.name), ['Materials', 'Prototypes', 'Elements']);
  const elements = root.children[2].children;
  assert.equal(elements.length, 26);
  const wall = elements.find((prim) => (prim.meta.customData as { name?: string }).name === 'Mur sud RDC');
  assert.ok(wall);
  const data = wall.meta.customData as { id: string; properties: Record<string, unknown> };
  assert.equal(data.id.length, 22);
  assert.equal(data.properties['Classe IFC'], 'IfcWall');
  assert.deepEqual(data.properties['Pset_WallCommon'], { IsExternal: true, LoadBearing: true, FireRating: 'REI 120' });
  // Les grands tableaux sont lus en bloc.
  const mesh = layer.byPath.get('/IFC/Prototypes/Mesh_0')!.children[0];
  assert.ok(mesh.attributes.get('points')!.value instanceof Float64Array);
  assert.ok(mesh.attributes.get('faceVertexIndices')!.value instanceof Int32Array);
});

test('un USD produit par le convertisseur donne le même modèle que le GLB', () => {
  const { source, metadata, warnings } = loadUsda(text);
  assert.deepEqual(warnings, []);
  const model = buildModel(source, { value: new Color() });
  assert.equal(model.count, 26);
  assert.ok(metadata);
  assert.equal(metadata.elements.size, 26);
  assert.ok(model.keys.every((key) => metadata.elements.has(key)));
  // Mêmes dimensions et même orientation que le GLB : 10 × 6 × 6 m, Y vers le haut.
  const size = model.box.getSize(new Vector3());
  assert.ok(Math.abs(size.x - 10) < 0.01, `largeur ${size.x}`);
  assert.ok(Math.abs(size.y - 6) < 0.01, `hauteur ${size.y}`);
  assert.ok(Math.abs(size.z - 6) < 0.01, `profondeur ${size.z}`);
  assert.ok(model.offset.length() > 6_000_000, 'géoréférencement conservé');
  // Les douze poteaux partagent un prototype : ils ont bien chacun leur géométrie.
  const columns = model.names.filter((name) => name.startsWith('Poteau'));
  assert.equal(columns.length, 12);
  assert.ok(model.chunks.some((chunk) => chunk.transparent), 'le vitrage est transparent');
  for (let i = 0; i < model.count; i++) assert.equal(model.state.isOpen(i), false, model.names[i]);
  const wall = metadata.elements.get(model.keys[model.names.indexOf('Mur sud RDC')]);
  assert.equal(wall?.props['Qto_WallBaseQuantities / NetVolume'], 5.6);
});

test('un usda étranger minimal est lisible, avec un élément par maillage', () => {
  const foreign = `#usda 1.0
(
    upAxis = "Y"
)

def Xform "Boite" {
    double3 xformOp:translate = (0, 0, 0)
    def Mesh "Geom" {
        int[] faceVertexCounts = [4, 4]
        int[] faceVertexIndices = [0, 1, 2, 3, 4, 5, 6, 7]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    }
}
`;
  const { source, metadata } = loadUsda(foreign);
  const model = buildModel(source, { value: new Color() });
  assert.equal(metadata, null);
  assert.equal(model.count, 1);
  assert.equal(model.keys[0], 'Boite');
  assert.equal(model.triangleCount, 4); // deux quadrilatères découpés en triangles
});

test('un usdz contenant un USD binaire est refusé avec un message clair', () => {
  const name = 'model.usdc';
  const body = new TextEncoder().encode('PXR-USDC\u0000\u0000');
  const header = new Uint8Array(30 + name.length + body.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, body.length, true);
  view.setUint16(26, name.length, true);
  header.set(new TextEncoder().encode(name), 30);
  header.set(body, 30 + name.length);
  assert.throws(() => usdaFromUsdz(header.buffer), /USD binaire/);
});

test('la liste readOnly du calque est lue avec les métadonnées', () => {
  const { metadata } = loadUsda(text);
  assert.ok(metadata);
  assert.ok(metadata.readOnly?.includes('Classe IFC'));
  assert.ok(metadata.readOnly?.includes('Qto_*'));
});

test('la position sur Terre du calque USD est lue comme celle du JSON', () => {
  const { metadata } = loadUsda(text);
  assert.ok(metadata?.georeference, 'georeference attendue dans customLayerData');
  assert.ok(Math.abs(metadata!.georeference!.latitude - 48.8584) < 1e-6);
  assert.ok(Math.abs(metadata!.georeference!.longitude - 2.2945) < 1e-6);
  assert.equal(metadata!.georeference!.elevation, 35);
  assert.ok(Math.abs(metadata!.georeference!.trueNorth[0] - 0.17364818) < 1e-6);
  assert.equal(metadata!.georeference!.source, 'IfcSite');
});
