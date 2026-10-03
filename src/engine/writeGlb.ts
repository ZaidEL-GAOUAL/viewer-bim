// Écriture d'un GLB à partir du modèle affiché, modifications comprises (éléments déplacés,
// dupliqués, ajoutés). Un nœud par élément, avec `extras.id` pour le lien avec les métadonnées ;
// les coordonnées du projet sont rendues par la translation des nœuds (voir Model.offset).
// Les textures ne sont pas réécrites : la couleur de chaque sommet l'est.

import type { Model } from './Model.ts';

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

interface Primitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
  mode?: number;
}

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function align(length: number): number {
  return (length + 3) & ~3;
}

export function writeGlb(model: Model, generator = 'viewer-bim'): ArrayBuffer {
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

  // Un matériau par lot : couleur blanche multipliée par la couleur des sommets.
  const materials: Record<string, unknown>[] = [];
  const materialOf = new Map<string, number>();
  const materialFor = (transparent: boolean, doubleSided: boolean): number => {
    const key = `${transparent}|${doubleSided}`;
    let index = materialOf.get(key);
    if (index === undefined) {
      index = materials.length;
      materialOf.set(key, index);
      materials.push({
        name: transparent ? 'Transparent' : 'Opaque',
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
        doubleSided,
        ...(transparent ? { alphaMode: 'BLEND' } : {}),
      });
    }
    return index;
  };

  const meshes: { name: string; primitives: Primitive[] }[] = [];
  const nodes: Record<string, unknown>[] = [];
  const translation = [model.offset.x, model.offset.y, model.offset.z];

  for (let element = 0; element < model.count; element++) {
    const primitives: Primitive[] = [];
    for (const range of model.ranges[element]) {
      if (range.count === 0) continue;
      const chunk = model.chunks[range.chunk];
      const geometry = chunk.mesh.geometry;
      const srcNormals = geometry.getAttribute('normal').array as Int8Array;
      const srcColors = geometry.getAttribute('color').array as Uint8Array;
      // Les sommets de la plage sont renumérotés à partir de zéro.
      const remap = new Map<number, number>();
      const order: number[] = [];
      const indices = new Uint32Array(range.count);
      for (let k = 0; k < range.count; k++) {
        const v = chunk.index[range.start + k];
        let local = remap.get(v);
        if (local === undefined) {
          local = order.length;
          remap.set(v, local);
          order.push(v);
        }
        indices[k] = local;
      }
      const vertexCount = order.length;
      const positions = new Float32Array(vertexCount * 3);
      const normals = new Float32Array(vertexCount * 3);
      const colors = new Uint8Array(vertexCount * 4);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      order.forEach((v, local) => {
        for (let axis = 0; axis < 3; axis++) {
          const value = chunk.positions[v * 3 + axis];
          positions[local * 3 + axis] = value;
          if (value < min[axis]) min[axis] = value;
          if (value > max[axis]) max[axis] = value;
          normals[local * 3 + axis] = Math.max(-1, srcNormals[v * 3 + axis] / 127);
        }
        colors.set(srcColors.subarray(v * 4, v * 4 + 4), local * 4);
      });
      const indexData = vertexCount <= 65535 ? Uint16Array.from(indices) : indices;

      const attributes: Record<string, number> = {};
      accessors.push({ bufferView: view(positions, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max });
      attributes.POSITION = accessors.length - 1;
      accessors.push({ bufferView: view(normals, ARRAY_BUFFER), componentType: FLOAT, count: vertexCount, type: 'VEC3' });
      attributes.NORMAL = accessors.length - 1;
      accessors.push({ bufferView: view(colors, ARRAY_BUFFER), componentType: UNSIGNED_BYTE, count: vertexCount, type: 'VEC4', normalized: true });
      attributes.COLOR_0 = accessors.length - 1;
      accessors.push({
        bufferView: view(indexData, ELEMENT_ARRAY_BUFFER),
        componentType: indexData instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
        count: indexData.length,
        type: 'SCALAR',
      });
      primitives.push({ attributes, indices: accessors.length - 1, material: materialFor(chunk.transparent, chunk.doubleSided) });
    }

    const node: Record<string, unknown> = { name: model.names[element], translation, extras: { ...(model.extras[element] ?? {}), id: model.keys[element] } };
    if (primitives.length > 0) {
      meshes.push({ name: model.names[element], primitives });
      node.mesh = meshes.length - 1;
    }
    nodes.push(node);
  }

  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
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
