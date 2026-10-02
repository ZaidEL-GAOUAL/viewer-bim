// Génère un bâtiment de démonstration : un .glb (géométrie) et un .json (métadonnées)
// conformes au contrat décrit dans docs/contrat-metadonnees.md.
//
//   node scripts/make-sample.mjs            → public/samples/demo.glb + demo.json
//   node scripts/make-sample.mjs --large    → public/samples/demo-large.glb + demo-large.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const large = process.argv.includes('--large');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
const baseName = large ? 'demo-large' : 'demo';

const STOREYS = large ? 60 : 3;
const BAYS = large ? 20 : 5;
const BAY = 4;
const DEPTH = large ? 24 : 12;
const STOREY_HEIGHT = 3;
const WALL_HEIGHT = 2.75;
const WALL_THICKNESS = 0.2;
const SLAB_THICKNESS = 0.25;
const LENGTH = BAYS * BAY;

// ---------------------------------------------------------------- géométries

function boxGeometry() {
  const positions = [];
  const normals = [];
  const indices = [];
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  for (const { n, u, v } of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(
        0.5 * (n[0] + su * u[0] + sv * v[0]),
        0.5 * (n[1] + su * u[1] + sv * v[1]),
        0.5 * (n[2] + su * u[2] + sv * v[2]),
      );
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

function cylinderGeometry(segments = 24) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a);
    const z = Math.sin(a);
    positions.push(x, -0.5, z, x, 0.5, z);
    normals.push(x, 0, z, x, 0, z);
  }
  for (let i = 0; i < segments; i++) {
    const b0 = i * 2;
    const t0 = b0 + 1;
    const b1 = ((i + 1) % segments) * 2;
    const t1 = b1 + 1;
    indices.push(b0, t0, t1, b0, t1, b1);
  }
  for (const [y, ny] of [[0.5, 1], [-0.5, -1]]) {
    const center = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, ny, 0);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a), y, Math.sin(a));
      normals.push(0, ny, 0);
    }
    for (let i = 0; i < segments; i++) {
      const p = center + 1 + i;
      const q = center + 1 + ((i + 1) % segments);
      if (ny > 0) indices.push(center, q, p);
      else indices.push(center, p, q);
    }
  }
  return { positions, normals, indices };
}

// ------------------------------------------------------------------ matériaux

const MATERIALS = {
  beton: { name: 'Béton', color: [0.62, 0.62, 0.6, 1] },
  enduit: { name: 'Enduit', color: [0.87, 0.84, 0.76, 1] },
  platre: { name: 'Plâtre', color: [0.93, 0.93, 0.9, 1] },
  alu: { name: 'Aluminium', color: [0.25, 0.27, 0.3, 1] },
  verre: { name: 'Verre', color: [0.45, 0.7, 0.85, 0.35], blend: true },
  bois: { name: 'Bois', color: [0.5, 0.33, 0.18, 1] },
  etancheite: { name: 'Étanchéité', color: [0.28, 0.3, 0.33, 1] },
};
const materialKeys = Object.keys(MATERIALS);

// --------------------------------------------------------------- assemblage

const nodes = [];
const rootChildren = [];
const metadata = {};
let seed = 20261001;

function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}

// Identifiant de 22 caractères, dans l'esprit des GlobalId IFC.
function makeId() {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let id = '';
  for (let i = 0; i < 22; i++) id += alphabet[Math.floor(random() * 64)];
  return id;
}

const round = (value, digits = 3) => Number(value.toFixed(digits));

function addNode(node, parent) {
  const index = nodes.length;
  nodes.push(node);
  if (parent === undefined) rootChildren.push(index);
  else (nodes[parent].children ??= []).push(index);
  return index;
}

const meshIndex = (shape, material) =>
  (shape === 'box' ? 0 : materialKeys.length) + materialKeys.indexOf(material);

function shapeNode(shape, material, center, size, extra = {}) {
  return { mesh: meshIndex(shape, material), translation: center, scale: size, ...extra };
}

// Ajoute un élément simple (une boîte ou un cylindre) avec ses métadonnées.
function addElement(parent, { name, shape = 'box', material, center, size, properties, skipMetadata = false }) {
  const id = makeId();
  addNode({ name, extras: { id }, ...shapeNode(shape, material, center, size) }, parent);
  if (!skipMetadata) metadata[id] = { label: name, properties };
  return id;
}

function boxQuantities(size) {
  const [x, y, z] = size;
  return {
    'Volume (m³)': round(x * y * z),
    'Surface (m²)': round(2 * (x * y + y * z + x * z)),
  };
}

function addWall(parent, level, name, center, size, { lot = 'Gros œuvre', material = 'enduit', bearing = true, type = 'Mur' } = {}) {
  const length = Math.max(size[0], size[2]);
  const thickness = Math.min(size[0], size[2]);
  addElement(parent, {
    name,
    material,
    center,
    size,
    properties: {
      Catégorie: 'Mur',
      Type: type,
      Niveau: level,
      Lot: lot,
      Matériau: MATERIALS[material].name,
      Porteur: bearing,
      'Résistance au feu': bearing ? 'REI 120' : 'EI 30',
      Phase: 'Neuf',
      Dimensions: { 'Longueur (m)': round(length), 'Hauteur (m)': round(size[1]), 'Épaisseur (m)': round(thickness) },
      Quantités: boxQuantities(size),
    },
  });
}

// Fenêtre : un seul élément composé de quatre profilés et d'un vitrage (deux matériaux).
function addWindow(parent, level, name, center, width, height, alongX) {
  const id = makeId();
  const frame = 0.06;
  const depth = 0.12;
  const node = addNode({ name, extras: { id }, translation: center, ...(alongX ? {} : { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }) }, parent);
  const bars = [
    [[0, height / 2 - frame / 2, 0], [width, frame, depth]],
    [[0, -height / 2 + frame / 2, 0], [width, frame, depth]],
    [[-width / 2 + frame / 2, 0, 0], [frame, height - 2 * frame, depth]],
    [[width / 2 - frame / 2, 0, 0], [frame, height - 2 * frame, depth]],
  ];
  for (const [c, s] of bars) addNode(shapeNode('box', 'alu', c, s), node);
  addNode(shapeNode('box', 'verre', [0, 0, 0], [width - 2 * frame, height - 2 * frame, 0.03]), node);
  metadata[id] = {
    label: name,
    properties: {
      Catégorie: 'Fenêtre',
      Type: 'Châssis fixe',
      Niveau: level,
      Lot: 'Menuiseries extérieures',
      Matériau: 'Aluminium / verre',
      Porteur: false,
      Phase: 'Neuf',
      Dimensions: { 'Longueur (m)': round(width), 'Hauteur (m)': round(height), 'Épaisseur (m)': depth },
      Thermique: { 'Uw (W/m²K)': 1.3, 'Facteur solaire': 0.42 },
    },
  };
}

function addFacade(parent, level, z, label) {
  const sill = 0.9;
  const windowHeight = 1.5;
  const lintel = WALL_HEIGHT - sill - windowHeight;
  for (let bay = 0; bay < BAYS; bay++) {
    const x0 = bay * BAY;
    const tag = `${label} ${bay + 1}`;
    addWall(parent, level, `Mur ${tag} gauche`, [x0 + 0.5, WALL_HEIGHT / 2, z], [1, WALL_HEIGHT, WALL_THICKNESS], { type: 'Trumeau' });
    addWall(parent, level, `Mur ${tag} droit`, [x0 + 3.5, WALL_HEIGHT / 2, z], [1, WALL_HEIGHT, WALL_THICKNESS], { type: 'Trumeau' });
    addWall(parent, level, `Allège ${tag}`, [x0 + 2, sill / 2, z], [2, sill, WALL_THICKNESS], { type: 'Allège', bearing: false });
    addWall(parent, level, `Linteau ${tag}`, [x0 + 2, WALL_HEIGHT - lintel / 2, z], [2, lintel, WALL_THICKNESS], { type: 'Linteau' });
    addWindow(parent, level, `Fenêtre ${tag}`, [x0 + 2, sill + windowHeight / 2, z], 2, windowHeight, true);
  }
}

function addPartition(parent, level, x, mirrored) {
  const doorWidth = 0.9;
  const doorHeight = 2.1;
  const zDoor = DEPTH / 2;
  const span = DEPTH - WALL_THICKNESS;
  const half = (span - doorWidth) / 2;
  const options = { lot: 'Cloisons', material: 'platre', bearing: false, type: 'Cloison' };
  addWall(parent, level, `Cloison ${x} A`, [x, WALL_HEIGHT / 2, WALL_THICKNESS / 2 + half / 2], [0.1, WALL_HEIGHT, half], options);
  addWall(parent, level, `Cloison ${x} B`, [x, WALL_HEIGHT / 2, DEPTH - WALL_THICKNESS / 2 - half / 2], [0.1, WALL_HEIGHT, half], options);
  addWall(parent, level, `Imposte ${x}`, [x, (WALL_HEIGHT + doorHeight) / 2, zDoor], [0.1, WALL_HEIGHT - doorHeight, doorWidth], { ...options, type: 'Imposte' });
  // Une porte sur deux est posée en miroir (échelle négative) pour vérifier l'orientation des faces.
  const id = makeId();
  addNode({
    name: `Porte ${x}`,
    extras: { id },
    mesh: meshIndex('box', 'bois'),
    translation: [x, doorHeight / 2, zDoor],
    scale: [mirrored ? -0.04 : 0.04, doorHeight, doorWidth],
  }, parent);
  metadata[id] = {
    label: `Porte ${x}`,
    properties: {
      Catégorie: 'Porte',
      Type: mirrored ? 'Poussant gauche' : 'Poussant droit',
      Niveau: level,
      Lot: 'Menuiseries intérieures',
      Matériau: 'Bois',
      Porteur: false,
      'Résistance au feu': 'EI 30',
      Phase: 'Neuf',
      Dimensions: { 'Longueur (m)': doorWidth, 'Hauteur (m)': doorHeight, 'Épaisseur (m)': 0.04 },
    },
  };
}

function levelName(index) {
  return index === 0 ? 'RDC' : `R+${index}`;
}

let skippedOne = false;
for (let s = 0; s < STOREYS; s++) {
  const level = levelName(s);
  const storey = addNode({ name: `Niveau ${level}`, translation: [0, s * STOREY_HEIGHT, 0] });

  const slabSize = [LENGTH + WALL_THICKNESS, SLAB_THICKNESS, DEPTH + WALL_THICKNESS];
  addElement(storey, {
    name: `Dalle ${level}`,
    material: 'beton',
    center: [LENGTH / 2, -SLAB_THICKNESS / 2, DEPTH / 2],
    size: slabSize,
    properties: {
      Catégorie: 'Dalle',
      Type: s === 0 ? 'Dallage' : 'Plancher',
      Niveau: level,
      Lot: 'Gros œuvre',
      Matériau: 'Béton',
      Porteur: true,
      'Résistance au feu': 'REI 120',
      Phase: s === 0 ? 'Existant' : 'Neuf',
      Dimensions: { 'Longueur (m)': round(slabSize[0]), 'Hauteur (m)': SLAB_THICKNESS, 'Épaisseur (m)': SLAB_THICKNESS },
      Quantités: boxQuantities(slabSize),
    },
  });

  const radius = 0.2;
  for (let ix = 1; ix < BAYS; ix++) {
    for (let z = 3; z < DEPTH; z += 3) {
      const skip = !skippedOne && s === 0 && ix === 1 && z === 3;
      if (skip) skippedOne = true;
      addElement(storey, {
        name: `Poteau ${ix}-${z}`,
        shape: 'cylinder',
        material: 'beton',
        center: [ix * BAY, WALL_HEIGHT / 2, z],
        size: [radius, WALL_HEIGHT, radius],
        skipMetadata: skip, // un élément volontairement absent du JSON
        properties: {
          Catégorie: 'Poteau',
          Type: 'Circulaire Ø40',
          Niveau: level,
          Lot: 'Gros œuvre',
          Matériau: 'Béton',
          Porteur: true,
          'Résistance au feu': 'R 90',
          Phase: 'Neuf',
          Dimensions: { 'Diamètre (m)': radius * 2, 'Hauteur (m)': WALL_HEIGHT },
          Quantités: { 'Volume (m³)': round(Math.PI * radius * radius * WALL_HEIGHT) },
        },
      });
    }
  }

  addFacade(storey, level, 0, 'façade sud');
  addFacade(storey, level, DEPTH, 'façade nord');
  addWall(storey, level, 'Mur pignon ouest', [0, WALL_HEIGHT / 2, DEPTH / 2], [WALL_THICKNESS, WALL_HEIGHT, DEPTH - WALL_THICKNESS]);
  addWall(storey, level, 'Mur pignon est', [LENGTH, WALL_HEIGHT / 2, DEPTH / 2], [WALL_THICKNESS, WALL_HEIGHT, DEPTH - WALL_THICKNESS]);

  for (let ix = 1; ix < BAYS; ix += 2) addPartition(storey, level, ix * BAY + 2, (s + ix) % 2 === 0);
}

const roof = addNode({ name: 'Niveau Toiture', translation: [0, STOREYS * STOREY_HEIGHT, 0] });
const roofSize = [LENGTH + 0.6, 0.3, DEPTH + 0.6];
addElement(roof, {
  name: 'Toiture-terrasse',
  material: 'etancheite',
  center: [LENGTH / 2, -SLAB_THICKNESS + 0.15, DEPTH / 2],
  size: roofSize,
  properties: {
    Catégorie: 'Toiture',
    Type: 'Terrasse inaccessible',
    Niveau: 'Toiture',
    Lot: 'Étanchéité',
    Matériau: 'Béton + étanchéité',
    Porteur: true,
    'Résistance au feu': 'REI 60',
    Phase: 'Neuf',
    Dimensions: { 'Longueur (m)': round(roofSize[0]), 'Hauteur (m)': 0.3, 'Épaisseur (m)': 0.3 },
    Quantités: boxQuantities(roofSize),
  },
});

// ------------------------------------------------------------- écriture GLB

const box = boxGeometry();
const cylinder = cylinderGeometry();
const chunks = [];
const bufferViews = [];
const accessors = [];
let byteLength = 0;

function pushView(typed, target) {
  const bytes = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const padding = (4 - (bytes.length % 4)) % 4;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
  chunks.push(bytes, Buffer.alloc(padding));
  byteLength += bytes.length + padding;
  return bufferViews.length - 1;
}

function pushGeometry({ positions, normals, indices }) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  const count = positions.length / 3;
  const position = accessors.push({ bufferView: pushView(new Float32Array(positions), 34962), componentType: 5126, count, type: 'VEC3', min, max }) - 1;
  const normal = accessors.push({ bufferView: pushView(new Float32Array(normals), 34962), componentType: 5126, count, type: 'VEC3' }) - 1;
  const index = accessors.push({ bufferView: pushView(new Uint16Array(indices), 34963), componentType: 5123, count: indices.length, type: 'SCALAR' }) - 1;
  return { attributes: { POSITION: position, NORMAL: normal }, indices: index };
}

const boxPrimitive = pushGeometry(box);
const cylinderPrimitive = pushGeometry(cylinder);
const meshes = [
  ...materialKeys.map((key, i) => ({ name: `Boîte ${MATERIALS[key].name}`, primitives: [{ ...boxPrimitive, material: i }] })),
  ...materialKeys.map((key, i) => ({ name: `Cylindre ${MATERIALS[key].name}`, primitives: [{ ...cylinderPrimitive, material: i }] })),
];

const gltf = {
  asset: { version: '2.0', generator: 'viewer-bim make-sample' },
  scene: 0,
  scenes: [{ name: 'Bâtiment de démonstration', nodes: rootChildren }],
  nodes,
  meshes,
  materials: materialKeys.map((key) => {
    const { name, color, blend } = MATERIALS[key];
    return {
      name,
      pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.9 },
      ...(blend ? { alphaMode: 'BLEND' } : {}),
    };
  }),
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
};

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${baseName}.glb`), Buffer.concat([header, jsonHeader, json, binHeader, bin]));
writeFileSync(join(outDir, `${baseName}.json`), JSON.stringify({ version: 1, elements: metadata }, null, large ? 0 : 2));

const elementCount = nodes.filter((node) => node.extras?.id).length;
console.log(`${baseName}.glb : ${elementCount} éléments, ${Object.keys(metadata).length} entrées de métadonnées`);
