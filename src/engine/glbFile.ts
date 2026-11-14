// Le conteneur GLB, en un seul endroit : lire (en-tête, bloc JSON, bloc binaire éventuel),
// écrire, et empiler des tampons dans un seul buffer glTF. Les modules qui lisent ou écrivent un
// GLB (export, carte, fusion IFC, mise à jour des métadonnées) passent tous par ici.

const MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export const FLOAT = 5126;
export const UNSIGNED_BYTE = 5121;
export const UNSIGNED_SHORT = 5123;
export const UNSIGNED_INT = 5125;
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;

/** Arrondi au multiple de 4 supérieur : les blocs GLB et les vues glTF sont alignés sur 4 octets. */
export function align(length: number): number {
  return (length + 3) & ~3;
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
}

interface GlbContent {
  json: unknown;
  /** Bloc binaire ; vide si le fichier n'en a pas (maquette sans géométrie) ou s'il est vide. */
  bin: Uint8Array;
  /** Où commence ce qui suit le bloc JSON (bloc binaire compris), pour le recopier tel quel. */
  afterJson: number;
}

/** Lit l'en-tête et le bloc JSON ; tolère l'absence de bloc binaire et un bloc binaire vide. */
export function parseGlb(glb: ArrayBuffer): GlbContent {
  const view = new DataView(glb);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 2 || view.getUint32(16, true) !== JSON_CHUNK) throw new Error('Fichier GLB invalide.');
  const jsonLength = view.getUint32(12, true), afterJson = 20 + jsonLength;
  if (afterJson > glb.byteLength) throw new Error('Fichier GLB incomplet.');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  const bin = afterJson + 8 <= glb.byteLength ? new Uint8Array(glb, afterJson + 8, Math.min(view.getUint32(afterJson, true), glb.byteLength - afterJson - 8)) : new Uint8Array(0);
  return { json, bin, afterJson };
}

/** Bloc JSON complété par des espaces, puis les morceaux binaires bout à bout (chacun aligné). Sans binaire, pas de bloc binaire. */
export function encodeGlb(json: object, parts: readonly ArrayBufferView[] = []): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align(text.byteLength);
  const binLength = parts.reduce((sum, part) => sum + align(part.byteLength), 0);
  const total = 12 + 8 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new ArrayBuffer(total);
  const bytes = new Uint8Array(out), header = new DataView(out);
  header.setUint32(0, MAGIC, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(text, 20);
  if (binLength > 0) {
    let at = 20 + jsonLength;
    header.setUint32(at, binLength, true);
    header.setUint32(at + 4, BIN_CHUNK, true);
    at += 8;
    for (const part of parts) {
      bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at);
      at += align(part.byteLength);
    }
  }
  return out;
}

/** Remplace le seul bloc JSON d'un GLB ; le reste (géométrie, images) est recopié tel quel. */
export function replaceGlbJson(source: ArrayBuffer, afterJson: number, json: object): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(json)), aligned = align(text.byteLength);
  const out = new ArrayBuffer(20 + aligned + source.byteLength - afterJson), view = new DataView(out), bytes = new Uint8Array(out);
  bytes.set(new Uint8Array(source, 0, 12));
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, aligned, true);
  view.setUint32(16, JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + aligned);
  bytes.set(text, 20);
  bytes.set(new Uint8Array(source, afterJson), 20 + aligned);
  return out;
}

/** Un seul buffer glTF rempli au fur et à mesure : les vues (bufferViews) et accesseurs qui le décrivent. */
export class GlbBuffer {
  readonly bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: number }[] = [];
  readonly accessors: Accessor[] = [];
  readonly parts: ArrayBufferView[] = [];
  byteLength = 0;

  /** Ajoute des données au buffer ; renvoie l'indice de la vue. */
  view(data: ArrayBufferView, target: number): number {
    this.bufferViews.push({ buffer: 0, byteOffset: this.byteLength, byteLength: data.byteLength, target });
    this.parts.push(data);
    this.byteLength = align(this.byteLength + data.byteLength);
    return this.bufferViews.length - 1;
  }

  /** Ajoute une vue et son accesseur ; renvoie l'indice de l'accesseur. */
  add(data: ArrayBufferView, target: number, accessor: Omit<Accessor, 'bufferView'>): number {
    return this.accessors.push({ bufferView: this.view(data, target), ...accessor }) - 1;
  }
}
