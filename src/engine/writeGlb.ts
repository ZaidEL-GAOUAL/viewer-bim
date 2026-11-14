// Écriture d'un GLB à partir du modèle affiché, avec les propriétés actuelles.
// Un nœud par élément, avec `extras.id` pour le lien avec les métadonnées ;
// les coordonnées du projet sont rendues par la translation des nœuds (voir Model.offset).
// Les textures ne sont pas réécrites : la couleur de chaque sommet l'est.

import { srgbByteToLinear } from './buildModel.ts';
import { ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, FLOAT, GlbBuffer, UNSIGNED_INT, UNSIGNED_SHORT, encodeGlb } from './glbFile.ts';
import type { Model } from './Model.ts';

interface Primitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
  mode?: number;
}

interface GlbExportOptions {
  /** Propriétés actuelles par identifiant stable, en remplacement des extras du fichier source. */
  properties?: ReadonlyMap<string, Record<string, unknown>> | Record<string, Record<string, unknown>>;
}

export function writeGlb(model: Model, generator = 'viewer-bim', options: GlbExportOptions = {}): ArrayBuffer {
  const buffer = new GlbBuffer();

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
      // Le renderer conserve le sRGB en octets ; glTF exige des couleurs de sommet linéaires.
      const colors = new Float32Array(vertexCount * 4);
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
        for (let channel = 0; channel < 3; channel++) {
          colors[local * 4 + channel] = srgbByteToLinear(srcColors[v * 4 + channel]);
        }
        colors[local * 4 + 3] = srcColors[v * 4 + 3] / 255;
      });
      const indexData = vertexCount <= 65535 ? Uint16Array.from(indices) : indices;

      const attributes: Record<string, number> = {
        POSITION: buffer.add(positions, ARRAY_BUFFER, { componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max }),
        NORMAL: buffer.add(normals, ARRAY_BUFFER, { componentType: FLOAT, count: vertexCount, type: 'VEC3' }),
        COLOR_0: buffer.add(colors, ARRAY_BUFFER, { componentType: FLOAT, count: vertexCount, type: 'VEC4' }),
      };
      const indicesAccessor = buffer.add(indexData, ELEMENT_ARRAY_BUFFER, {
        componentType: indexData instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT,
        count: indexData.length,
        type: 'SCALAR',
      });
      primitives.push({ attributes, indices: indicesAccessor, material: materialFor(chunk.transparent, chunk.doubleSided) });
    }

    const key = model.keys[element];
    const properties = options.properties instanceof Map
      ? options.properties.get(key)
      : options.properties && Object.hasOwn(options.properties, key)
        ? (options.properties as Record<string, Record<string, unknown>>)[key]
        : undefined;
    const node: Record<string, unknown> = { name: model.names[element], translation, extras: { ...(properties ?? model.extras[element] ?? {}), id: key } };
    if (primitives.length > 0) {
      meshes.push({ name: model.names[element], primitives });
      node.mesh = meshes.length - 1;
    }
    nodes.push(node);
  }

  const { byteLength, accessors, bufferViews } = buffer;
  const gltf = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [nodes.length > 0 ? { nodes: nodes.map((_, i) => i) } : {}],
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(byteLength > 0 ? { meshes, materials, accessors, bufferViews, buffers: [{ byteLength }] } : {}),
  };
  return encodeGlb(gltf, buffer.parts);
}
