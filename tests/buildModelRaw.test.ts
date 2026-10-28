import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Ray, Raycaster, Sphere, Vector2, Vector3, type Object3D } from 'three';
import { DEPTH_HOST, DEPTH_OVERLAY, DEPTH_POLYGON_OFFSET, MATERIAL_STRIDE, ModelBuilder, TRANSPARENT_LAYER, buildModel, type ModelSource, type RawModel } from '../src/engine/buildModel.ts';
import { Sections } from '../src/engine/Sections.ts';
import { Viewer } from '../src/engine/Viewer.ts';
import type { Model } from '../src/engine/Model.ts';

interface Shape {
  positions: number[];
  normals: number[];
  indices: number[];
}

/** Cube de 24 sommets (quatre par face), normales de face, triangles tournés vers l'extérieur. */
function cube(min: [number, number, number], size: number): Shape {
  const faces: [number[], number[][]][] = [
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
  ];
  const shape: Shape = { positions: [], normals: [], indices: [] };
  faces.forEach(([normal, corners], f) => {
    for (const corner of corners) {
      shape.positions.push(min[0] + corner[0] * size, min[1] + corner[1] * size, min[2] + corner[2] * size);
      shape.normals.push(...normal);
    }
    shape.indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return shape;
}

/** Rectangle dans le plan z = `z`, normale +Z, deux triangles. */
function quad(x0: number, y0: number, x1: number, y1: number, z: number): Shape {
  return {
    positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

interface Primitive {
  element: number;
  shape: Shape;
  material: number;
}

/** Assemble un modèle brut : un tampon commun, des indices locaux à chaque primitive. */
function rawModel(
  keys: string[], names: string[], origin: [number, number, number],
  primitives: Primitive[], materials: number[], extras?: RawModel['extras'],
): RawModel {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const table: number[] = [];
  for (const { element, shape, material } of primitives) {
    table.push(element, positions.length / 3, shape.positions.length / 3, indices.length, shape.indices.length, material);
    positions.push(...shape.positions);
    normals.push(...shape.normals);
    indices.push(...shape.indices);
  }
  return {
    kind: 'raw',
    keys, names, extras, origin,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    primitives: new Uint32Array(table),
    materials: new Uint8Array(materials),
  };
}

// Sept octets par matériau : r, g, b, a, transparent, double face, priorité de profondeur (0 ordinaire, 1 surcouche, 2 hôte).
const OPAQUE = [200, 100, 50, 255, 0, 0, 0];
const GLASS = [30, 120, 200, 128, 1, 1, 0];
/** La même couleur que OPAQUE, en surcouche (le voisin d'un imposteur RPC, un import CAD). */
const OVERLAY = [200, 100, 50, 255, 0, 0, 1];
/** La même couleur que OPAQUE, en hôte (un mur, un sol, une toiture). */
const HOST = [200, 100, 50, 255, 0, 0, 2];
const ORIGIN: [number, number, number] = [1000.5, 20, -300];

function threeElements(): RawModel {
  return rawModel(
    ['cube-guid', 'vitre-guid', 'vide-guid'],
    ['Cube', 'Vitre', 'Sans géométrie'],
    ORIGIN,
    [
      { element: 0, shape: cube([-0.5, -0.5, -0.5], 1), material: 0 },
      { element: 1, shape: quad(2, 0, 4, 2, 0), material: 1 },
    ],
    [...OPAQUE, ...GLASS],
    [undefined, { Famille: 'Vitrage' }, {}],
  );
}

const select = () => ({ value: new Color() });
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

/** Exerce le vrai chemin de clic CPU sans créer de contexte WebGL dans Node. */
function pickingViewer(model: Model, sections: Sections): Viewer {
  const camera = new PerspectiveCamera(45, 1, .01, 100);
  camera.position.set(2, 2, .1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return Object.assign(Object.create(Viewer.prototype) as Viewer, {
    model, sections, camera,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    raycaster: new Raycaster(), pointer: new Vector2(),
    sphere: model.box.getBoundingSphere(new Sphere()), scratch: new Vector3(), scratchBox: new Box3(),
  });
}

test('un modèle brut donne des éléments, des lots, des boîtes et un décalage comme un glTF', () => {
  const model = buildModel(threeElements(), select());
  assert.deepEqual(model.keys, ['cube-guid', 'vitre-guid', 'vide-guid']);
  assert.deepEqual(model.names, ['Cube', 'Vitre', 'Sans géométrie']);
  assert.deepEqual(model.extras, [undefined, { Famille: 'Vitrage' }, undefined]);
  assert.equal(model.count, 3);
  assert.equal(model.triangleCount, 12 + 2);

  // Un lot opaque et un lot transparent, ce dernier sur le calque des transparences et à double face.
  assert.equal(model.chunks.length, 2);
  const opaque = model.chunks.find((chunk) => !chunk.transparent)!;
  const glass = model.chunks.find((chunk) => chunk.transparent)!;
  assert.ok(glass.doubleSided);
  assert.ok(!opaque.doubleSided);
  assert.ok(glass.mesh.layers.isEnabled(TRANSPARENT_LAYER));
  assert.ok(!glass.mesh.layers.isEnabled(0));
  assert.ok(!opaque.mesh.layers.isEnabled(TRANSPARENT_LAYER));
  assert.equal(glass.mesh.renderOrder, 1);
  assert.equal(opaque.positions.length / 3, 24);
  assert.equal(glass.positions.length / 3, 4);
  assert.ok(opaque.index instanceof Uint16Array);

  // Boîtes relatives à l'origine ; un élément sans primitive a une boîte vide mais existe.
  const box = (i: number) => model.elementBox(i, new Box3());
  assert.deepEqual(box(0).min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(box(0).max.toArray(), [0.5, 0.5, 0.5]);
  assert.deepEqual(box(1).min.toArray(), [2, 0, 0]);
  assert.deepEqual(box(1).max.toArray(), [4, 2, 0]);
  assert.ok(box(2).isEmpty());
  assert.deepEqual(model.ranges[2], []);
  assert.deepEqual(model.box.min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(model.box.max.toArray(), [4, 2, 0.5]);

  // Les positions sont déjà relatives : le décalage du modèle est l'origine, sans autre retrait.
  assert.deepEqual(model.offset.toArray(), ORIGIN);
  assert.deepEqual(Array.from(opaque.positions.subarray(0, 3)), [0.5, -0.5, -0.5]);

  // Le cube est un solide fermé. Le quadrilatère est transparent : comme pour un glTF, une pièce
  // transparente n'entre jamais dans le remplissage des coupes, donc ne compte pas pour « ouvert ».
  assert.equal(model.state.isOpen(0), false);
  assert.equal(model.state.isOpen(1), false);
  assert.equal(model.state.isOpen(2), false);
  assert.equal(model.state.isVisible(2), true);
  // Priorité d'affichage posée comme pour un glTF : plus l'élément est petit devant le modèle, plus elle est haute.
  const priority = (i: number) => (model.state.data[i * 4 + 3] >> 4) & 7;
  assert.equal(priority(0), 1);
  assert.equal(priority(1), 0);
  model.dispose();
});

test('un quadrilatère opaque est marqué ouvert, un cube fermé non', () => {
  const model = buildModel(rawModel(
    ['plaque', 'cube'], ['Plaque', 'Cube'], [0, 0, 0],
    [
      { element: 0, shape: quad(2, 0, 4, 2, 0), material: 0 },
      { element: 1, shape: cube([0, 0, 0], 1), material: 0 },
    ],
    OPAQUE,
  ), select());
  assert.equal(model.state.isOpen(0), true);
  assert.equal(model.state.isOpen(1), false);
  model.dispose();
});

test('les couleurs de sommet sont les octets sRGB de la table des matériaux', () => {
  const model = buildModel(threeElements(), select());
  const colorOf = (transparent: boolean) => {
    const chunk = model.chunks.find((c) => c.transparent === transparent)!;
    return chunk.mesh.geometry.getAttribute('color').array as Uint8Array;
  };
  const opaque = colorOf(false);
  assert.equal(opaque.length, 24 * 4);
  for (let v = 0; v < 24; v++) assert.deepEqual(Array.from(opaque.subarray(v * 4, v * 4 + 4)), [200, 100, 50, 255]);
  const glass = colorOf(true);
  assert.equal(glass.length, 4 * 4);
  for (let v = 0; v < 4; v++) assert.deepEqual(Array.from(glass.subarray(v * 4, v * 4 + 4)), [30, 120, 200, 128]);
  // Chaque sommet porte le numéro de son élément.
  for (const chunk of model.chunks) {
    const ids = chunk.mesh.geometry.getAttribute('aElement').array as Float32Array;
    assert.ok(ids.every((id) => id === (chunk.transparent ? 1 : 0)));
  }
  model.dispose();
});

test('plusieurs matériaux de mêmes réglages partagent un lot, chacun avec sa couleur', () => {
  const model = buildModel(rawModel(
    ['a', 'b'], ['A', 'B'], [0, 0, 0],
    [
      { element: 0, shape: cube([0, 0, 0], 1), material: 0 },
      { element: 1, shape: cube([3, 0, 0], 1), material: 1 },
    ],
    [10, 20, 30, 255, 0, 0, 0, 40, 50, 60, 255, 0, 0, 0],
  ), select());
  assert.equal(model.chunks.length, 1);
  const colors = model.chunks[0].mesh.geometry.getAttribute('color').array as Uint8Array;
  assert.deepEqual(Array.from(colors.subarray(0, 4)), [10, 20, 30, 255]);
  assert.deepEqual(Array.from(colors.subarray(24 * 4, 24 * 4 + 4)), [40, 50, 60, 255]);
  assert.equal(model.ranges[0][0].chunk, model.ranges[1][0].chunk);
  assert.equal(model.ranges[1][0].start, 36);
  model.dispose();
});

test('un élément réparti sur deux primitives ouvertes qui se referment est un solide fermé', () => {
  // Les six faces du cube en deux primitives : aucune n'est fermée seule, l'ensemble l'est.
  const whole = cube([0, 0, 0], 1);
  const half = (from: number, to: number): Shape => ({
    positions: whole.positions.slice(from * 12, to * 12),
    normals: whole.normals.slice(from * 12, to * 12),
    // Indices locaux au premier sommet de la primitive.
    indices: whole.indices.slice(from * 6, to * 6).map((k) => k - from * 4),
  });
  const model = buildModel(rawModel(
    ['a'], ['A'], [0, 0, 0],
    [{ element: 0, shape: half(0, 3), material: 0 }, { element: 0, shape: half(3, 6), material: 0 }],
    OPAQUE,
  ), select());
  assert.equal(model.triangleCount, 12);
  assert.equal(model.ranges[0].length, 1, 'les deux plages contiguës sont fusionnées');
  assert.equal(model.state.isOpen(0), false);
  model.dispose();
});

test('le lancer de rayon et le clic traversent un modèle brut comme un glTF', () => {
  const model = buildModel(threeElements(), select());
  const down = model.raycast(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)));
  assert.ok(down);
  assert.equal(down.element, 0);
  near(down.distance, 4.5);
  near(down.point.z, 0.5);
  assert.deepEqual(down.normal.toArray(), [0, 0, 1]);
  assert.equal(down.backface, false);

  // Le quadrilatère est à double face : visible, donc cliquable, des deux côtés.
  const front = model.raycast(new Ray(new Vector3(3, 1, 5), new Vector3(0, 0, -1)));
  assert.ok(front);
  assert.equal(front.element, 1);
  assert.equal(front.backface, false);
  const behind = model.raycast(new Ray(new Vector3(3, 1, -5), new Vector3(0, 0, 1)));
  assert.ok(behind);
  assert.equal(behind.element, 1);
  assert.equal(behind.backface, true);

  // Un élément sans géométrie ne peut jamais être touché, un élément masqué non plus.
  assert.equal(model.raycast(new Ray(new Vector3(10, 10, 5), new Vector3(0, 0, -1))), null);
  model.state.setVisible(0, false);
  assert.equal(model.raycast(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1))), null);
  model.state.setVisible(0, true);

  // Le clic de l'application, avec une coupe oblique : le point se pose sur le plan de coupe
  // du solide fermé, ce que le quadrilatère ouvert n'aurait pas permis.
  const sections = new Sections();
  sections.setBounds(model.box);
  const viewer = pickingViewer(model, sections);
  const plain = viewer.pick(50, 50);
  assert.ok(plain);
  assert.equal(plain.element, 0);
  assert.equal(plain.cap, false);
  sections.set(0, { enabled: true });
  sections.setTransform(0, new Vector3(), new Vector3(1, 1, 0).normalize());
  const cut = viewer.pick(50, 50);
  assert.ok(cut);
  assert.equal(cut.element, 0);
  assert.equal(cut.cap, true);
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(cut.point)) < 1e-7);
  model.dispose();
});

test('un modèle brut sans aucune géométrie est refusé avec le message habituel', () => {
  const empty = rawModel(['a'], ['A'], [0, 0, 0], [], OPAQUE);
  assert.throws(() => buildModel(empty, select()), /aucune géométrie triangulée/);
  // Une primitive sans sommet ou sans triangle complet ne compte pas non plus.
  const degenerate = rawModel(['a'], ['A'], [0, 0, 0], [{ element: 0, shape: { positions: [0, 0, 0, 1, 0, 0], normals: [0, 1, 0, 0, 1, 0], indices: [0, 1] }, material: 0 }], OPAQUE);
  assert.throws(() => buildModel(degenerate, select()), /aucune géométrie triangulée/);
});

test('un modèle brut incohérent est refusé au lieu de lire hors des tampons', () => {
  const raw = threeElements();
  raw.primitives[2] = 1000; // plus de sommets que de positions
  assert.throws(() => buildModel(raw, select()), /incohérent/);
  const unknownMaterial = threeElements();
  unknownMaterial.primitives[5] = 9;
  assert.throws(() => buildModel(unknownMaterial, select()), /incohérent/);
  const unknownElement = threeElements();
  unknownElement.primitives[0] = 7;
  assert.throws(() => buildModel(unknownElement, select()), /incohérent/);
  // Une table de matériaux à six octets par ligne (l'ancien pas) n'est plus lisible : sept octets par ligne.
  assert.equal(MATERIAL_STRIDE, 7);
  const sixBytes = threeElements();
  sixBytes.materials = new Uint8Array([200, 100, 50, 255, 0, 0, 30, 120, 200, 128, 1, 1]);
  assert.throws(() => buildModel(sixBytes, select()), /incohérent/);
});

// ------------------------------------------------------------------------- priorité de profondeur

/** Le décalage de profondeur d'un lot : activé ou non, facteur et unités. */
const offsetOf = (chunk: { mesh: { material: unknown } }) => {
  const material = chunk.mesh.material as MeshLambertMaterial;
  return { offset: material.polygonOffset, factor: material.polygonOffsetFactor, units: material.polygonOffsetUnits };
};

test('chaque priorité de profondeur a son propre lot et son décalage, jamais fusionnée avec une face de la même couleur', () => {
  // Un mur (hôte), un poteau (ordinaire) et un plan importé (surcouche) de la même couleur, dans le même plan.
  const model = buildModel(rawModel(
    ['mur', 'poteau', 'plan'], ['Mur', 'Poteau', 'Plan DWG'], [0, 0, 0],
    [
      { element: 0, shape: quad(-5, -5, 5, 5, 0), material: 0 },
      { element: 1, shape: quad(-1, -1, 1, 1, 0), material: 1 },
      { element: 2, shape: quad(-2, -2, 2, 2, 0), material: 2 },
    ],
    [...HOST, ...OPAQUE, ...OVERLAY],
  ), select());
  assert.equal(model.chunks.length, 3, 'trois lots, malgré la même couleur');
  const chunkOf = (element: number) => model.chunks[model.ranges[element][0].chunk];
  assert.equal(new Set([chunkOf(0), chunkOf(1), chunkOf(2)]).size, 3);
  // Ordinaire : aucun décalage. Hôte et surcouche : un décalage négatif, plus fort pour la surcouche.
  assert.deepEqual(offsetOf(chunkOf(1)), { offset: false, factor: 0, units: 0 });
  assert.deepEqual(offsetOf(chunkOf(0)), { offset: true, factor: DEPTH_POLYGON_OFFSET[DEPTH_HOST].factor, units: DEPTH_POLYGON_OFFSET[DEPTH_HOST].units });
  assert.deepEqual(offsetOf(chunkOf(2)), { offset: true, factor: DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].factor, units: DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].units });
  const host = DEPTH_POLYGON_OFFSET[DEPTH_HOST];
  const overlay = DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY];
  assert.ok(host.factor < 0 && host.units < 0, 'le décalage d\'un hôte rapproche de la caméra');
  assert.ok(overlay.factor <= host.factor && overlay.units < host.units, 'la surcouche passe devant l\'hôte');
  // La couleur est celle des octets, comme pour tout matériau.
  const colors = chunkOf(2).mesh.geometry.getAttribute('color').array as Uint8Array;
  assert.deepEqual(Array.from(colors.subarray(0, 4)), [200, 100, 50, 255]);
  model.dispose();
});

test('deux faces de même priorité et de même couleur partagent un lot et un matériau', () => {
  for (const [row, offset] of [[HOST, true], [OVERLAY, true], [OPAQUE, false]] as const) {
    const model = buildModel(rawModel(
      ['a', 'b'], ['A', 'B'], [0, 0, 0],
      [
        { element: 0, shape: quad(0, 0, 1, 1, 0), material: 0 },
        { element: 1, shape: quad(3, 0, 4, 1, 0), material: 0 },
      ],
      [...row],
    ), select());
    assert.equal(model.chunks.length, 1);
    assert.equal((model.chunks[0].mesh.material as MeshLambertMaterial).polygonOffset, offset);
    model.dispose();
  }
});

test('une priorité inconnue (octet hors de 0, 1, 2) est lue comme ordinaire', () => {
  const model = buildModel(rawModel(['a'], ['A'], [0, 0, 0], [{ element: 0, shape: quad(0, 0, 1, 1, 0), material: 0 }], [200, 100, 50, 255, 0, 0, 7]), select());
  assert.equal(offsetOf(model.chunks[0]).offset, false);
  model.dispose();
});

test('un modèle bâti morceau par morceau garde les priorités de profondeur d\'un morceau à l\'autre', () => {
  const builder = new ModelBuilder(select());
  builder.append(rawModel(['dalle'], ['Dalle'], ORIGIN, [{ element: 0, shape: quad(-5, -5, 5, 5, 0), material: 0 }], [...HOST]));
  builder.append(rawModel(['arbre'], ['Arbre'], ORIGIN, [{ element: 0, shape: quad(-1, -1, 1, 1, 0), material: 1 }], [...HOST, ...OVERLAY]));
  builder.append(rawModel(['poteau'], ['Poteau'], ORIGIN, [{ element: 0, shape: quad(-1, -1, 1, 1, 0), material: 2 }], [...HOST, ...OVERLAY, ...OPAQUE]));
  const model = builder.model;
  assert.equal(model.chunks.length, 3);
  assert.deepEqual(model.chunks.map((chunk) => offsetOf(chunk).factor).sort(), [0, DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].factor, DEPTH_POLYGON_OFFSET[DEPTH_HOST].factor].sort());
  model.dispose();
});

// ----------------------------------------------------------------- parité avec le chemin glTF / USD
test('le même modèle en scène et en modèle brut donne exactement les mêmes tampons', () => {
  // Cube de 1 m et vitre, placés loin de l'origine (géoréférencement) par la matrice des nœuds.
  const place: [number, number, number] = [100000.25, 50.5, -20000.75];
  const solid = cube([0, 0, 0], 1);
  const pane = quad(2, 0, 4, 2, 0);
  const cubeColor = new Color('rgb(200, 100, 50)');
  const glassColor = new Color('rgb(30, 120, 200)');

  const nodes = new Map<Object3D, { id: string; name: string; extras?: Record<string, unknown> }>();
  const scene = new Group();
  const addNode = (id: string, name: string, shape: Shape, material: MeshBasicMaterial, extras?: Record<string, unknown>) => {
    const node = new Group();
    node.position.set(...place);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(shape.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(shape.normals), 3));
    geometry.setIndex(new BufferAttribute(new Uint32Array(shape.indices), 1));
    node.add(new Mesh(geometry, material));
    nodes.set(node, { id, name, extras });
    scene.add(node);
  };
  addNode('cube-guid', 'Cube', solid, new MeshBasicMaterial({ color: cubeColor }));
  addNode('vitre-guid', 'Vitre', pane, new MeshBasicMaterial({ color: glassColor, transparent: true, opacity: 128 / 255, side: DoubleSide }), { Famille: 'Vitrage' });
  const source: ModelSource = {
    scene,
    useIds: true,
    isNode: (object) => nodes.has(object),
    idOf: (object) => nodes.get(object)?.id,
    nameOf: (object) => nodes.get(object)?.name,
    extrasOf: (object) => nodes.get(object)?.extras,
  };
  const fromScene = buildModel(source, select());

  // Le chemin glTF retire le centre de la boîte du modèle : le modèle brut donne les positions
  // déjà décalées, et ce centre pour origine.
  const centre = fromScene.offset.toArray() as [number, number, number];
  assert.deepEqual(centre, [place[0] + 2, place[1] + 1, place[2] + 0.5]);
  const shift = (shape: Shape): Shape => ({
    ...shape,
    positions: shape.positions.map((value, i) => value + place[i % 3] - centre[i % 3]),
  });
  const fromRaw = buildModel(rawModel(
    ['cube-guid', 'vitre-guid'], ['Cube', 'Vitre'], centre,
    [{ element: 0, shape: shift(solid), material: 0 }, { element: 1, shape: shift(pane), material: 1 }],
    [...OPAQUE, ...GLASS],
    [undefined, { Famille: 'Vitrage' }],
  ), select());

  assert.deepEqual(fromRaw.offset.toArray(), fromScene.offset.toArray());
  assert.deepEqual(fromRaw.keys, fromScene.keys);
  assert.deepEqual(fromRaw.names, fromScene.names);
  assert.deepEqual(fromRaw.extras, fromScene.extras);
  assert.equal(fromRaw.triangleCount, fromScene.triangleCount);
  assert.deepEqual(fromRaw.boxes, fromScene.boxes);
  assert.deepEqual(fromRaw.box.min.toArray(), fromScene.box.min.toArray());
  assert.deepEqual(fromRaw.box.max.toArray(), fromScene.box.max.toArray());
  assert.deepEqual(fromRaw.state.data, fromScene.state.data);
  assert.deepEqual(fromRaw.ranges, fromScene.ranges);
  assert.equal(fromRaw.chunks.length, fromScene.chunks.length);
  fromRaw.chunks.forEach((chunk, c) => {
    const other = fromScene.chunks[c];
    assert.equal(chunk.transparent, other.transparent);
    assert.equal(chunk.doubleSided, other.doubleSided);
    assert.equal(chunk.mesh.layers.mask, other.mesh.layers.mask);
    assert.equal(chunk.mesh.renderOrder, other.mesh.renderOrder);
    assert.deepEqual(chunk.positions, other.positions);
    assert.deepEqual(chunk.index, other.index);
    const attributes = Object.keys(other.mesh.geometry.attributes).sort();
    assert.deepEqual(Object.keys(chunk.mesh.geometry.attributes).sort(), attributes);
    for (const name of attributes) {
      assert.deepEqual(chunk.mesh.geometry.getAttribute(name).array, other.mesh.geometry.getAttribute(name).array, name);
    }
  });
  fromRaw.dispose();
  fromScene.dispose();
});

test('un modèle brut en deux morceaux donne exactement les lots et les boîtes du modèle d’un bloc', () => {
  const whole = buildModel(threeElements(), select());
  // Même origine pour les deux morceaux, comme la sortie du lecteur : les sommets sont recopiés tels quels.
  const first = rawModel(['cube-guid'], ['Cube'], ORIGIN, [{ element: 0, shape: cube([-0.5, -0.5, -0.5], 1), material: 0 }], [...OPAQUE], [undefined]);
  const second = rawModel(['vitre-guid', 'vide-guid'], ['Vitre', 'Sans géométrie'], ORIGIN, [{ element: 0, shape: quad(2, 0, 4, 2, 0), material: 1 }], [...OPAQUE, ...GLASS], [{ Famille: 'Vitrage' }, {}]);
  const split = buildModel([first, second], select());
  assert.deepEqual(split.keys, whole.keys);
  assert.deepEqual(split.names, whole.names);
  assert.deepEqual(split.extras, whole.extras);
  assert.equal(split.count, whole.count);
  assert.equal(split.triangleCount, whole.triangleCount);
  assert.equal(split.chunks.length, whole.chunks.length);
  for (const [i, chunk] of whole.chunks.entries()) {
    assert.deepEqual([...split.chunks[i].positions], [...chunk.positions]);
    assert.deepEqual([...(split.chunks[i].index ?? [])], [...(chunk.index ?? [])]);
    assert.equal(split.chunks[i].transparent, chunk.transparent);
  }
  for (let i = 0; i < whole.count; i++) {
    assert.deepEqual(split.elementBox(i, new Box3()).min.toArray(), whole.elementBox(i, new Box3()).min.toArray());
    assert.deepEqual(split.elementBox(i, new Box3()).max.toArray(), whole.elementBox(i, new Box3()).max.toArray());
  }
  assert.deepEqual(split.offset.toArray(), whole.offset.toArray());
  assert.deepEqual(split.box.min.toArray(), whole.box.min.toArray());

  // Un morceau qui a sa propre origine est déplacé de la différence : mêmes coordonnées de projet.
  const moved = rawModel(['vitre-guid', 'vide-guid'], ['Vitre', 'Sans géométrie'], [ORIGIN[0] + 10, ORIGIN[1] - 5, ORIGIN[2] + 1], [{ element: 0, shape: quad(-8, 5, -6, 7, -1), material: 1 }], [...OPAQUE, ...GLASS], [{ Famille: 'Vitrage' }, {}]);
  const shifted = buildModel([first, moved], select());
  assert.deepEqual(shifted.offset.toArray(), whole.offset.toArray());
  assert.deepEqual(shifted.elementBox(1, new Box3()).min.toArray(), whole.elementBox(1, new Box3()).min.toArray());
  assert.deepEqual(shifted.elementBox(1, new Box3()).max.toArray(), whole.elementBox(1, new Box3()).max.toArray());
});

// ------------------------------------------------------------------ construction par morceaux
/** Les triangles d'un élément (coordonnées de leurs sommets), triés : indépendants du découpage en lots. */
function trianglesOf(model: Model, element: number): string[] {
  const out: string[] = [];
  for (const { positions, index, start, count } of model.parts(element)) {
    for (let k = start; k < start + count; k += 3) {
      out.push([index[k], index[k + 1], index[k + 2]].map((v) => `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`).join('|'));
    }
  }
  return out.sort();
}

const firstChunk = () => rawModel(['cube-guid'], ['Cube'], ORIGIN, [{ element: 0, shape: cube([-0.5, -0.5, -0.5], 1), material: 0 }], [...OPAQUE], [undefined]);
const secondChunk = () => rawModel(['vitre-guid', 'vide-guid'], ['Vitre', 'Sans géométrie'], ORIGIN, [{ element: 0, shape: quad(2, 0, 4, 2, 0), material: 1 }], [...OPAQUE, ...GLASS], [{ Famille: 'Vitrage' }, {}]);

test('un modèle construit morceau par morceau s’affiche dès le premier, et finit avec les éléments, boîtes et triangles du bloc', () => {
  const whole = buildModel(threeElements(), select());
  const builder = new ModelBuilder(select());
  const model = builder.model;
  assert.equal(model.count, 0);
  assert.equal(model.chunks.length, 0);
  assert.ok(model.box.isEmpty());

  // Dès le premier morceau : un lot dans le groupe, l'élément visible et cliquable, la boîte du cube, l'origine fixée.
  builder.append(firstChunk());
  assert.equal(model.count, 1);
  assert.equal(model.state.count, 1);
  assert.equal(model.chunks.length, 1);
  assert.equal(model.group.children.length, 1);
  assert.equal(model.triangleCount, 12);
  assert.deepEqual(model.box.min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(model.box.max.toArray(), [0.5, 0.5, 0.5]);
  assert.deepEqual(model.offset.toArray(), ORIGIN);
  assert.ok(model.state.isVisible(0));
  assert.equal(model.raycast(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)))?.element, 0);

  // Ce qui est réglé entre deux morceaux (masquage, couleur, opacité, planning) survit au suivant.
  model.state.setVisible(0, false);
  model.state.setColor(0, 1, 2, 3);
  model.state.setOpacity(0, 0.5);
  model.state.setSchedule(new Uint8Array([2]));
  model.state.commit();
  assert.equal(model.group.children.length, 2, 'l’opacité imposée a créé le double translucide du lot');
  const textureBefore = model.state.texture;

  builder.append(secondChunk());
  assert.equal(model.count, 3);
  assert.equal(model.state.count, 3);
  assert.equal(model.chunks.length, 2);
  assert.equal(model.group.children.length, 3, 'le lot de verre, transparent, n’a pas de double');
  assert.notEqual(model.state.texture, textureBefore, 'la texture d’état a été réallouée');
  assert.equal(model.state.uniform.value, model.state.texture, 'les matériaux la suivent par l’uniforme partagé');
  assert.equal(model.state.isVisible(0), false);
  assert.deepEqual([...model.state.data.subarray(0, 3)], [1, 2, 3]);
  assert.equal(model.state.opacityOf(0), 0.5);
  assert.equal(model.state.scheduleStateOf(0), 2);
  assert.equal(model.state.hasTranslucency, true);
  assert.ok(model.state.isVisible(1) && model.state.isVisible(2), 'les nouveaux éléments sont visibles');
  assert.equal(model.state.opacityOf(1), null);
  assert.equal(model.state.scheduleStateOf(2), 0);
  // Le planning s'étend au nouveau nombre d'éléments.
  model.state.setSchedule(new Uint8Array([3, 1, 0]));
  assert.equal(model.state.scheduleStateOf(0), 3);
  assert.equal(model.state.isRendered(1), false);
  model.state.setSchedule(null);
  model.state.setVisible(0, true);
  model.state.commit();

  // Même modèle qu'en un bloc : éléments, numéros, boîtes, triangles, décalage, drapeaux « ouvert » et priorités.
  assert.deepEqual(model.keys, whole.keys);
  assert.deepEqual(model.names, whole.names);
  assert.deepEqual(model.extras, whole.extras);
  assert.equal(model.count, whole.count);
  assert.equal(model.triangleCount, whole.triangleCount);
  assert.deepEqual(model.boxes, whole.boxes);
  assert.deepEqual(model.box.min.toArray(), whole.box.min.toArray());
  assert.deepEqual(model.box.max.toArray(), whole.box.max.toArray());
  assert.deepEqual(model.offset.toArray(), whole.offset.toArray());
  for (let i = 0; i < whole.count; i++) {
    assert.equal(model.state.isOpen(i), whole.state.isOpen(i), `ouvert ${i}`);
    assert.equal((model.state.data[i * 4 + 3] >> 4) & 7, (whole.state.data[i * 4 + 3] >> 4) & 7, `priorité ${i}`);
    assert.deepEqual(trianglesOf(model, i), trianglesOf(whole, i), `triangles ${i}`);
  }
  // Les lots sont ceux des morceaux (un par morceau ici), sur les bons calques, avec le bon numéro d'élément par sommet.
  const glass = model.chunks[1];
  assert.ok(glass.transparent && glass.doubleSided);
  assert.ok(glass.mesh.layers.isEnabled(TRANSPARENT_LAYER));
  assert.ok((glass.mesh.geometry.getAttribute('aElement').array as Float32Array).every((id) => id === 1));
  assert.equal(model.ranges[1][0].chunk, 1);
  assert.equal(model.raycast(new Ray(new Vector3(3, 1, 5), new Vector3(0, 0, -1)))?.element, 1);
  assert.equal(model.raycast(new Ray(new Vector3(0, 0, 5), new Vector3(0, 0, -1)))?.element, 0);
  model.dispose();
  whole.dispose();
});

test('un morceau qui a sa propre origine est ramené à celle du modèle ; un morceau sans géométrie ajoute ses éléments', () => {
  const whole = buildModel(threeElements(), select());
  const builder = new ModelBuilder(select());
  const model = builder.model;
  // Premier morceau sans forme (un niveau) : l'élément existe, boîte vide, et l'origine du modèle est la sienne.
  builder.append(rawModel(['vide-guid'], ['Sans géométrie'], ORIGIN, [], [...OPAQUE], [{}]));
  assert.equal(model.count, 1);
  assert.equal(model.chunks.length, 0);
  assert.ok(model.box.isEmpty());
  assert.ok(model.elementBox(0, new Box3()).isEmpty());
  assert.deepEqual(model.ranges[0], []);
  assert.deepEqual(model.offset.toArray(), ORIGIN);
  assert.ok(model.state.isVisible(0));

  // Morceau à sa propre origine : déplacé de la différence, mêmes coordonnées de projet que le bloc.
  const moved = rawModel(['vitre-guid'], ['Vitre'], [ORIGIN[0] + 10, ORIGIN[1] - 5, ORIGIN[2] + 1], [{ element: 0, shape: quad(-8, 5, -6, 7, -1), material: 1 }], [...OPAQUE, ...GLASS], [{ Famille: 'Vitrage' }]);
  builder.append(moved);
  assert.deepEqual(model.offset.toArray(), ORIGIN, 'l’origine du modèle ne change pas');
  assert.deepEqual(model.elementBox(1, new Box3()).min.toArray(), whole.elementBox(1, new Box3()).min.toArray());
  assert.deepEqual(model.elementBox(1, new Box3()).max.toArray(), whole.elementBox(1, new Box3()).max.toArray());
  assert.deepEqual(trianglesOf(model, 1), trianglesOf(whole, 1));
  assert.deepEqual(model.box.min.toArray(), [2, 0, 0]);
  assert.deepEqual(model.box.max.toArray(), [4, 2, 0]);
  // Puis le cube, à l'origine du modèle : recopié tel quel.
  builder.append(firstChunk());
  assert.deepEqual(model.elementBox(2, new Box3()).min.toArray(), [-0.5, -0.5, -0.5]);
  assert.deepEqual(model.box.min.toArray(), whole.box.min.toArray());
  assert.deepEqual(model.box.max.toArray(), whole.box.max.toArray());
  assert.equal(model.triangleCount, whole.triangleCount);
  assert.deepEqual(model.keys, ['vide-guid', 'vitre-guid', 'cube-guid']);
  // Priorités recalculées sur le modèle entier : le cube, petit devant le modèle, passe devant la vitre, comme dans le bloc.
  const priority = (m: Model, i: number) => (m.state.data[i * 4 + 3] >> 4) & 7;
  assert.equal(priority(model, 2), priority(whole, 0));
  assert.equal(priority(model, 1), priority(whole, 1));
  model.dispose();
  whole.dispose();
});

test('un morceau incohérent est refusé et le modèle reste tel qu’il était', () => {
  const builder = new ModelBuilder(select());
  builder.append(firstChunk());
  const bad = secondChunk();
  bad.primitives[2] = 1000;
  assert.throws(() => builder.append(bad), /incohérent/);
  assert.equal(builder.model.count, 1);
  assert.equal(builder.model.state.count, 1);
  assert.equal(builder.model.chunks.length, 1);
  builder.model.dispose();
});

test('les doubles translucides suivent les lots ajoutés après la première opacité imposée', () => {
  const builder = new ModelBuilder(select());
  const model = builder.model;
  builder.append(firstChunk());
  model.state.setOpacity(0, 0.3);
  assert.equal(model.group.children.length, 2);
  builder.append(rawModel(['b'], ['B'], ORIGIN, [{ element: 0, shape: cube([3, 0, 0], 1), material: 0 }], OPAQUE, [undefined]));
  assert.equal(model.chunks.length, 2);
  assert.equal(model.group.children.length, 4, 'le lot opaque ajouté a son double');
  const doubles = model.group.children.filter((child) => !model.chunks.some((chunk) => chunk.mesh === child)) as Mesh[];
  assert.equal(doubles.length, 2);
  assert.ok(doubles.every((mesh) => mesh.visible && (mesh.material as { transparent: boolean }).transparent));
  model.state.setOpacity(0, null);
  assert.ok(doubles.every((mesh) => !mesh.visible), 'sans translucidité, les doubles se cachent');
  model.dispose();
});
