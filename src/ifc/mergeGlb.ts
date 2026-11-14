// Réunit plusieurs GLB produits par pipeline/ifc_to_glb.py (un par tranche d'éléments, quand la
// conversion est répartie sur plusieurs cœurs) en un seul fichier.

import { align, encodeGlb, parseGlb } from '../engine/glbFile.ts';

interface Gltf {
  asset: unknown;
  extras?: Record<string, unknown>;
  scene?: number;
  scenes?: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number }[] }[];
  materials?: unknown[];
  accessors?: ({ bufferView: number } & Record<string, unknown>)[];
  bufferViews?: ({ buffer: number; byteOffset?: number; byteLength: number } & Record<string, unknown>)[];
  buffers?: { byteLength: number }[];
}

interface GltfNode extends Record<string, unknown> {
  mesh?: number;
  children?: number[];
}

function parse(glb: ArrayBuffer): { json: Gltf; bin: Uint8Array } {
  const { json, bin } = parseGlb(glb);
  return { json: json as Gltf, bin };
}

/**
 * Fusionne des GLB dont le nœud 0 est la racine commune (comme les produit le convertisseur).
 * Les éléments de toutes les parties se retrouvent sous une seule racine ; les matériaux
 * identiques sont mis en commun.
 */
export function mergeGlb(parts: ArrayBuffer[]): ArrayBuffer {
  if (parts.length === 1) return parts[0];
  const parsed = parts.map(parse);
  const first = parsed[0].json;
  const root: GltfNode = { ...first.nodes[0], children: [] };
  const merged = {
    asset: first.asset,
    ...(first.extras ? { extras: first.extras } : {}),
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [root],
    meshes: [] as NonNullable<Gltf['meshes']>,
    materials: [] as unknown[],
    accessors: [] as NonNullable<Gltf['accessors']>,
    bufferViews: [] as NonNullable<Gltf['bufferViews']>,
    buffers: [{ byteLength: 0 }],
  };
  const materialIndex = new Map<string, number>();
  let binLength = 0;

  for (const { json, bin } of parsed) {
    const binOffset = binLength;
    binLength += align(bin.byteLength);
    const viewBase = merged.bufferViews.length;
    const accessorBase = merged.accessors.length;
    const meshBase = merged.meshes.length;
    // Le nœud 0 de chaque partie (la racine) est remplacé par la racine commune.
    const nodeBase = merged.nodes.length - 1;
    const node = (index: number) => nodeBase + index;

    const materials = (json.materials ?? []).map((material) => {
      const key = JSON.stringify(material);
      let index = materialIndex.get(key);
      if (index === undefined) {
        index = merged.materials.push(material) - 1;
        materialIndex.set(key, index);
      }
      return index;
    });
    for (const view of json.bufferViews ?? []) merged.bufferViews.push({ ...view, buffer: 0, byteOffset: (view.byteOffset ?? 0) + binOffset });
    for (const accessor of json.accessors ?? []) merged.accessors.push({ ...accessor, bufferView: accessor.bufferView + viewBase });
    for (const mesh of json.meshes ?? []) {
      merged.meshes.push({
        ...mesh,
        primitives: mesh.primitives.map((primitive) => ({
          ...primitive,
          attributes: Object.fromEntries(Object.entries(primitive.attributes).map(([name, index]) => [name, index + accessorBase])),
          ...(primitive.indices === undefined ? {} : { indices: primitive.indices + accessorBase }),
          ...(primitive.material === undefined ? {} : { material: materials[primitive.material] }),
        })),
      });
    }
    for (const part of json.nodes.slice(1)) {
      merged.nodes.push({
        ...part,
        ...(part.mesh === undefined ? {} : { mesh: part.mesh + meshBase }),
        ...(part.children === undefined ? {} : { children: part.children.map(node) }),
      });
    }
    root.children!.push(...(json.nodes[0].children ?? []).map(node));
  }
  merged.buffers[0].byteLength = binLength;

  // Écriture : bloc JSON, puis les blocs binaires des parties bout à bout.
  const document: Record<string, unknown> = { ...merged };
  if (merged.meshes.length === 0) for (const key of ['meshes', 'materials', 'accessors', 'bufferViews', 'buffers']) delete document[key];
  return encodeGlb(document, parsed.map(({ bin }) => bin));
}

/** Réunit les métadonnées de plusieurs tranches en un seul document du contrat. */
export function mergeMetadata(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  const documents = parts.map((part) => JSON.parse(part) as { version: number; elements: Record<string, unknown>; readOnly?: string[] });
  const elements: Record<string, unknown> = {};
  for (const document of documents) Object.assign(elements, document.elements);
  const readOnly = [...new Set(documents.flatMap((document) => document.readOnly ?? []))];
  return JSON.stringify({ ...documents[0], elements, ...(readOnly.length ? { readOnly } : {}) });
}
