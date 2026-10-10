// GLB donné à Cesium en mode carte : exactement la géométrie que le viewer dessine (ses lots
// fusionnés), avec l'indice d'élément par sommet comme identifiant de feature (EXT_mesh_features)
// rattaché à une table de features vide (EXT_structural_metadata) : Cesium tient alors, par
// élément, un affichage et une opacité que le viewer lui recopie (voir GlobeModel). Quelle que soit
// l'origine du modèle (IFC, GLB, USD), c'est ce fichier qui part vers le globe.

import type { BufferAttribute } from 'three';
import type { Model } from '../engine/Model.ts';

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

function align(length: number): number {
  return (length + 3) & ~3;
}

/** GLB à un maillage par lot du viewer, sommets en coordonnées locales recentrées. */
export function writeCesiumGlb(model: Model): ArrayBuffer {
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: Accessor[] = [];
  const parts: ArrayBufferView[] = [];
  let byteLength = 0;
  const view = (data: ArrayBufferView, target: number): number => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target });
    parts.push(data);
    byteLength = align(byteLength + data.byteLength);
    return bufferViews.length - 1;
  };
  const accessor = (entry: Accessor): number => accessors.push(entry) - 1;

  const materials: Record<string, unknown>[] = [];
  const primitives: Record<string, unknown>[] = [];
  for (const chunk of model.chunks) {
    const geometry = chunk.mesh.geometry;
    const positions = chunk.positions;
    const vertexCount = positions.length / 3;
    if (vertexCount === 0 || chunk.index.length === 0) continue;
    const normalAttribute = geometry.getAttribute('normal') as BufferAttribute;
    const colorAttribute = geometry.getAttribute('color') as BufferAttribute | undefined;
    const elementAttribute = geometry.getAttribute('aElement') as BufferAttribute;

    // Normales : quantifiées sur 8 bits dans le viewer, flottantes pour le glTF.
    const normals = new Float32Array(vertexCount * 3);
    const source = normalAttribute.array as ArrayLike<number>;
    const scale = normalAttribute.normalized && normalAttribute.array instanceof Int8Array ? 1 / 127 : 1;
    for (let i = 0; i < normals.length; i++) normals[i] = Math.max(-1, Math.min(1, source[i] * scale));

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }

    const attributes: Record<string, number> = {
      POSITION: accessor({ bufferView: view(positions, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max }),
      NORMAL: accessor({ bufferView: view(normals, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: 'VEC3' }),
      // Indice d'élément par sommet : le même que celui que lisent nos shaders.
      _FEATURE_ID_0: accessor({ bufferView: view(elementAttribute.array as Float32Array, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: 'SCALAR' }),
    };
    if (colorAttribute && colorAttribute.array instanceof Uint8Array) {
      // Couleurs gardées en octets sRGB (le shader Cesium les convertit, comme le nôtre).
      attributes.COLOR_0 = accessor({ bufferView: view(colorAttribute.array, ARRAY_BUFFER), componentType: UNSIGNED_BYTE, count: vertexCount, type: colorAttribute.itemSize === 4 ? 'VEC4' : 'VEC3', normalized: true });
    }
    const index = chunk.index;
    const indices = accessor({
      bufferView: view(index, ELEMENT_ARRAY_BUFFER),
      componentType: index instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
      count: index.length,
      type: 'SCALAR',
    });
    materials.push({
      name: chunk.transparent ? 'Transparent' : 'Opaque',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      doubleSided: chunk.doubleSided,
      ...(chunk.transparent ? { alphaMode: 'BLEND' } : {}),
    });
    primitives.push({
      attributes,
      indices,
      material: materials.length - 1,
      extensions: { EXT_mesh_features: { featureIds: [{ featureCount: model.count, attribute: 0, label: 'element', propertyTable: 0 }] } },
    });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'viewer-bim (carte)' },
    extensionsUsed: ['EXT_mesh_features', 'EXT_structural_metadata'],
    extensions: {
      // Une classe sans propriété : seule la table (un enregistrement par élément) importe.
      EXT_structural_metadata: {
        schema: { id: 'viewer-bim', classes: { element: { name: 'Élément', properties: {} } } },
        propertyTables: [{ name: 'Éléments', class: 'element', count: model.count }],
      },
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Maquette', mesh: 0 }],
    meshes: [{ name: 'Maquette', primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = align(json.byteLength);
  const total = 12 + 8 + jsonLength + 8 + byteLength;
  const out = new ArrayBuffer(total);
  const bytes = new Uint8Array(out);
  const header = new DataView(out);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  bytes.fill(0x20, 20 + json.byteLength, 20 + jsonLength);
  let at = 20 + jsonLength;
  header.setUint32(at, byteLength, true);
  header.setUint32(at + 4, 0x004e4942, true);
  at += 8;
  for (const part of parts) {
    bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
    at = align(at + part.byteLength);
  }
  return out;
}
