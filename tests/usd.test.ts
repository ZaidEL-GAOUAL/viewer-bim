import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Color, Matrix4, Mesh, Vector3, type Object3D } from 'three';
import { buildModel } from '../src/engine/buildModel.ts';
import { loadUsda, loadUsdData, loadUsdFile, rootLayerOfUsdz } from '../src/usd/loadUsd.ts';
import { parseUsda } from '../src/usd/usda.ts';

const samples = new URL('./fixtures/', import.meta.url);
const read = (name: string): ArrayBuffer => {
  const bytes = readFileSync(new URL(name, samples));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};
const text = new TextDecoder().decode(rootLayerOfUsdz(read('ifc-demo.usdz')));

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

/** Maillages d'une scène, avec leur matrice monde et leurs sommets, dans l'ordre du parcours. */
function meshes(scene: Object3D): { path: string; matrix: Matrix4; points: ArrayLike<number> }[] {
  scene.updateMatrixWorld(true);
  const out: { path: string; matrix: Matrix4; points: ArrayLike<number> }[] = [];
  scene.traverse((object) => {
    if (!(object as Mesh).isMesh) return;
    const names: string[] = [];
    for (let at: Object3D | null = object; at; at = at.parent) names.unshift(at.name);
    out.push({ path: names.join('/'), matrix: object.matrixWorld, points: (object as Mesh).geometry.getAttribute('position').array });
  });
  return out;
}

function assertSameScene(a: Object3D, b: Object3D): void {
  const left = meshes(a);
  const right = meshes(b);
  assert.deepEqual(right.map((mesh) => mesh.path), left.map((mesh) => mesh.path));
  left.forEach((mesh, i) => {
    const other = right[i];
    mesh.matrix.elements.forEach((value, k) => assert.ok(Math.abs(value - other.matrix.elements[k]) < 1e-6, `${mesh.path} : matrice ${k}`));
    assert.equal(other.points.length, mesh.points.length, mesh.path);
    for (let k = 0; k < mesh.points.length; k++) assert.ok(Math.abs(mesh.points[k] - other.points[k]) < 1e-5, `${mesh.path} : sommet ${k}`);
  });
}

test('un usdz binaire (usdc) donne exactement le même modèle que le même fichier en texte', async () => {
  const textual = loadUsda(text);
  const binary = await loadUsdFile(new File([read('ifc-demo-binary.usdz')], 'ifc-demo-binary.usdz'));
  assert.deepEqual(binary.warnings, []);
  const a = buildModel(textual.source, { value: new Color() });
  const b = buildModel(binary.source, { value: new Color() });
  assert.equal(b.count, 26);
  assert.deepEqual(b.keys, a.keys);
  assert.deepEqual(b.names, a.names);
  assert.equal(b.triangleCount, a.triangleCount);
  assert.ok(b.offset.distanceTo(a.offset) < 1e-6);
  // Les douze poteaux partagent un prototype par référence interne : chacun a sa géométrie.
  assert.equal(b.names.filter((name) => name.startsWith('Poteau')).length, 12);
  assertSameScene(textual.source.scene, binary.source.scene);
  // Mêmes métadonnées : identifiants, propriétés (un dictionnaire binaire est trié par clé, d'où la
  // comparaison sans ordre), liste readOnly, position sur Terre.
  assert.ok(binary.metadata && textual.metadata);
  assert.deepEqual([...binary.metadata.elements.keys()].sort(), [...textual.metadata.elements.keys()].sort());
  for (const [id, entry] of textual.metadata.elements) assert.deepEqual(binary.metadata.elements.get(id), entry, id);
  assert.deepEqual(binary.metadata.readOnly, textual.metadata.readOnly);
  assert.deepEqual(binary.metadata.georeference, textual.metadata.georeference);
  assert.ok(b.chunks.some((chunk) => chunk.transparent), 'le vitrage est transparent');
});

test('un usdc avec instances, dictionnaires imbriqués et opérations de transformation se lit comme son texte', async () => {
  const textual = loadUsda(new TextDecoder().decode(read('usd-ops.usda')));
  const binary = await loadUsdData(read('usd-ops.usdc'));
  assertSameScene(textual.source.scene, binary.source.scene);
  assert.deepEqual(binary.warnings, textual.warnings);
  assert.match(binary.warnings.join('\n'), /« Sphere » non affichée.*\/World\/Ball/);
  // Dictionnaire de deux niveaux dans customData : propriétés aplaties comme pour le texte.
  assert.deepEqual(binary.metadata?.elements.get('a'), { label: undefined, props: { 'Pset / Sub / deep': 'x', 'Pset / v': 1.25 } });
  assert.deepEqual(binary.metadata?.elements.get('a'), textual.metadata?.elements.get('a'));
  // Translate, rotateXYZ (90° autour de Y), scale 2 ; centimètres ; référence vers le prototype.
  const boxes = new Map(meshes(binary.source.scene).map((mesh) => [mesh.path.split('/').at(-2), mesh.matrix]));
  const corner = (name: string): number[] => new Vector3(1, 1, 1).applyMatrix4(boxes.get(name)!).toArray().map((v) => Math.round(v * 1e4) / 1e4);
  assert.deepEqual(corner('A'), [1.02, 0.02, -0.02]);
  // Quaternion de 45° autour de X (réel en premier, comme dans le texte), au-dessus d'une translation.
  assert.deepEqual(corner('B'), [0.01, 3, 0.0141]);
  // Valeur animée sans valeur par défaut : premier échantillon, puis translation imbriquée.
  assert.deepEqual(corner('Nested'), [0.025, 0.01, 5.01]);
  assert.equal(meshes(binary.source.scene).length, 4);
});

test('un fichier USD binaire tronqué donne un message clair', async () => {
  const whole = read('usd-ops.usdc');
  await assert.rejects(loadUsdData(whole.slice(0, whole.byteLength / 2)), /USD binaire illisible : il est tronqué ou endommagé/);
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
