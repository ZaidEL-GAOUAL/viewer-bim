// Réunit plusieurs GLB produits par pipeline/ifc_to_glb.py (un par tranche d'éléments, quand la
// conversion est répartie sur plusieurs cœurs) en un seul fichier.

interface Gltf {
  asset: unknown;
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

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function parse(glb: ArrayBuffer): { json: Gltf; bin: Uint8Array } {
  const view = new DataView(glb);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('Fichier GLB invalide.');
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as Gltf;
  const binHeader = 20 + jsonLength;
  const bin = binHeader + 8 <= glb.byteLength ? new Uint8Array(glb, binHeader + 8, view.getUint32(binHeader, true)) : new Uint8Array(0);
  return { json, bin };
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
    binLength += bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
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

  // Écriture : en-tête, bloc JSON complété par des espaces, bloc binaire.
  const document: Record<string, unknown> = { ...merged };
  if (merged.meshes.length === 0) for (const key of ['meshes', 'materials', 'accessors', 'bufferViews', 'buffers']) delete document[key];
  const text = new TextEncoder().encode(JSON.stringify(document));
  const jsonLength = text.byteLength + ((4 - (text.byteLength % 4)) % 4);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(text, 20);
  if (binLength > 0) {
    let at = 20 + jsonLength;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, BIN_CHUNK, true);
    at += 8;
    for (const { bin } of parsed) {
      out.set(bin, at);
      at += bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
    }
  }
  return out.buffer;
}

/** Réunit les métadonnées de plusieurs tranches en un seul document du contrat. */
export function mergeMetadata(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  const documents = parts.map((part) => JSON.parse(part) as { version: number; elements: Record<string, unknown> });
  const elements: Record<string, unknown> = {};
  for (const document of documents) Object.assign(elements, document.elements);
  return JSON.stringify({ version: documents[0].version, elements });
}
