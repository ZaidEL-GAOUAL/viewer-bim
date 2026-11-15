// Lecture du format USD binaire (crate, .usdc) vers le même UsdLayer que le lecteur texte : le
// décodage du format (jetons, chaînes, champs, chemins, entiers compressés) est celui de three.js,
// complété ici là où il est incomplet. Chargé à la demande (import dynamique) depuis loadUsd.ts.

import { USDCParser, type CrateSpec, type CrateValueRep } from 'three/examples/jsm/loaders/usd/USDCParser.js';
import type { UsdDictionary, UsdLayer, UsdPath, UsdPrim, UsdValue } from './usda.ts';

// Numéros de type de valeur du format crate (crateDataTypes.h).
const T = {
  Bool: 1, UChar: 2, Int: 3, UInt: 4, Int64: 5, UInt64: 6, Half: 7, Float: 8, Double: 9, String: 10, Token: 11, AssetPath: 12,
  Matrix2d: 13, Matrix3d: 14, Matrix4d: 15, Quatd: 16, Quatf: 17, Quath: 18,
  Vec2d: 19, Vec2f: 20, Vec2h: 21, Vec2i: 22, Vec3d: 23, Vec3f: 24, Vec3h: 25, Vec3i: 26, Vec4d: 27, Vec4f: 28, Vec4h: 29, Vec4i: 30,
  Dictionary: 31, TokenListOp: 32, StringListOp: 33, PathListOp: 34, ReferenceListOp: 35,
  IntListOp: 36, Int64ListOp: 37, UIntListOp: 38, UInt64ListOp: 39,
  Payload: 47, LayerOffsetVector: 49, StringVector: 50, ValueBlock: 51, PayloadListOp: 55, TimeCode: 56,
} as const;

type Scalar = 'd' | 'f' | 'h' | 'i' | 'u' | 'l' | 'L' | 'b';
const SIZE: Record<Scalar, number> = { d: 8, f: 4, h: 2, i: 4, u: 4, l: 8, L: 8, b: 1 };

/** Types numériques : nombre de composantes et type de chaque composante. */
const NUMERIC: Record<number, [number, Scalar]> = {
  [T.Bool]: [1, 'b'], [T.UChar]: [1, 'b'], [T.Int]: [1, 'i'], [T.UInt]: [1, 'u'], [T.Int64]: [1, 'l'], [T.UInt64]: [1, 'L'],
  [T.Half]: [1, 'h'], [T.Float]: [1, 'f'], [T.Double]: [1, 'd'], [T.TimeCode]: [1, 'd'],
  [T.Matrix2d]: [4, 'd'], [T.Matrix3d]: [9, 'd'], [T.Matrix4d]: [16, 'd'],
  [T.Quatd]: [4, 'd'], [T.Quatf]: [4, 'f'], [T.Quath]: [4, 'h'],
  [T.Vec2d]: [2, 'd'], [T.Vec2f]: [2, 'f'], [T.Vec2h]: [2, 'h'], [T.Vec2i]: [2, 'i'],
  [T.Vec3d]: [3, 'd'], [T.Vec3f]: [3, 'f'], [T.Vec3h]: [3, 'h'], [T.Vec3i]: [3, 'i'],
  [T.Vec4d]: [4, 'd'], [T.Vec4f]: [4, 'f'], [T.Vec4h]: [4, 'h'], [T.Vec4i]: [4, 'i'],
};
const QUATERNIONS = new Set<number>([T.Quatd, T.Quatf, T.Quath]);
const MATRICES = new Set<number>([T.Matrix2d, T.Matrix3d, T.Matrix4d]);

/** Types que la classe de three.js lit correctement en valeur isolée. */
const SUPER_SCALARS = new Set<number>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 40, 41, 45, 48]);

interface CrateReference {
  assetPath: string;
  primPath: string;
}

function valueRep(lo: number, hi: number): CrateValueRep {
  return {
    isArray: (hi & 0x80000000) !== 0,
    isInlined: (hi & 0x40000000) !== 0,
    isCompressed: (hi & 0x20000000) !== 0,
    typeEnum: (hi >> 16) & 0xff,
    payload: lo + (hi & 0xffff) * 0x100000000,
    getInlinedValue: () => lo,
  };
}

/**
 * Complète USDCParser de three.js 0.186.1 (examples/jsm/loaders/usd/USDCParser.js). Corrigé ici :
 * - les dictionnaires (customData, customLayerData) revenaient vides : la lecture utilisait
 *   `reader.position`, qui n'existe pas (le lecteur a `offset`), puis construisait le ValueRep
 *   avec un seul entier de 64 bits au lieu de ses deux moitiés : chaque valeur sortait de type 0
 *   (invalide) et était jetée ; les clés étaient en plus lues comme jetons et non comme chaînes ;
 * - les listes d'opérations de références, de charges (payload), de jetons, de chaînes et
 *   d'entiers n'étaient pas lues ;
 * - les valeurs « string » non en ligne, les tableaux de chaînes, les vecteurs double et half
 *   (en ligne, isolés ou en tableau), les tableaux compressés de double et de half ;
 * - l'ordre des quaternions : en mémoire (i, j, k, réel), rendu ici comme le texte (réel, i, j, k).
 * Les types encore inconnus sont signalés avec le prim concerné, au lieu d'un console.warn.
 */
class CrateParser extends USDCParser {
  readonly unsupported = new Map<number, string>();
  private specPath = '';

  private get byteLength(): number {
    return (this as unknown as { buffer: ArrayBuffer }).buffer.byteLength;
  }

  private unknown(type: number): null {
    if (!this.unsupported.has(type)) this.unsupported.set(type, this.specPath);
    return null;
  }

  private string(): string {
    return this.tokens[this.strings[this.reader.readUint32()]] ?? '';
  }

  private scalar(kind: Scalar): number | boolean {
    const reader = this.reader;
    switch (kind) {
      case 'd': return reader.readFloat64();
      case 'f': return reader.readFloat32();
      case 'h': return this._readHalf();
      case 'i': return reader.readInt32();
      case 'u': return reader.readUint32();
      case 'l': return reader.readInt64();
      case 'L': return reader.readUint64();
      case 'b': return reader.readUint8();
    }
  }

  /** Le format écrit les quaternions (i, j, k, réel) ; le texte et notre lecteur, (réel, i, j, k). */
  private static realFirst(values: number[]): number[] {
    return [values[3], values[0], values[1], values[2]];
  }

  protected override _getFieldsForSpec(spec: CrateSpec): Record<string, unknown> {
    this.specPath = this.paths[spec.pathIndex] ?? '';
    return super._getFieldsForSpec(spec);
  }

  protected override _readInlinedValue(rep: CrateValueRep): unknown {
    const type = rep.typeEnum;
    const bits = rep.getInlinedValue();
    if (type === T.Half) return this._halfToFloat(bits & 0xffff);
    if (type === T.Int64) return bits | 0;
    if (type === T.UInt64) return bits >>> 0;
    if (type === T.TimeCode) return new Float32Array(new Uint32Array([bits]).buffer)[0];
    if (type === T.String) return this.tokens[this.strings[bits]] ?? '';
    const numeric = NUMERIC[type];
    if (!numeric || numeric[0] === 1 || type === T.Vec2h) return super._readInlinedValue(rep);
    // Vecteurs à composantes entières dans [-128, 127] : un octet signé par composante ;
    // matrices diagonales : un octet par élément de la diagonale.
    const bytes = new Int8Array(new Uint32Array([bits]).buffer);
    const [count] = numeric;
    if (!MATRICES.has(type)) return Array.from(bytes.subarray(0, count));
    const size = Math.sqrt(count);
    const out = new Array<number>(count).fill(0);
    for (let i = 0; i < size; i++) out[i * size + i] = bytes[i];
    return out;
  }

  protected override _readScalarValue(type: number): unknown {
    const reader = this.reader;
    const numeric = NUMERIC[type];
    if (numeric && numeric[0] > 1) {
      const values = Array.from({ length: numeric[0] }, () => this.scalar(numeric[1]) as number);
      return QUATERNIONS.has(type) ? CrateParser.realFirst(values) : values;
    }
    switch (type) {
      case T.String:
        return this.string();
      case T.TimeCode:
        return reader.readFloat64();
      case T.ValueBlock:
        return null;
      case T.StringVector:
        return Array.from({ length: reader.readUint64() }, () => this.string());
      case T.Dictionary: {
        // Clé : indice de chaîne. Valeur : décalage relatif (int64) vers son ValueRep ; la valeur
        // imbriquée est écrite avant son ValueRep, et l'entrée suivante commence après lui.
        const out: Record<string, unknown> = {};
        const count = reader.readUint64();
        for (let i = 0; i < count; i++) {
          const key = this.string();
          const start = reader.tell();
          reader.seek(start + reader.readInt64());
          const lo = reader.readUint32();
          const hi = reader.readUint32();
          out[key] = this._readValue(valueRep(lo, hi));
        }
        return out;
      }
      case T.TokenListOp:
        return this.listOp(() => this.tokens[reader.readUint32()] ?? '');
      case T.StringListOp:
        return this.listOp(() => this.string());
      case T.PathListOp:
        return this.listOp(() => this.paths[reader.readUint32()] ?? '');
      case T.IntListOp:
        return this.listOp(() => reader.readInt32());
      case T.UIntListOp:
        return this.listOp(() => reader.readUint32());
      case T.Int64ListOp:
        return this.listOp(() => reader.readInt64());
      case T.UInt64ListOp:
        return this.listOp(() => reader.readUint64());
      case T.ReferenceListOp:
        return this.listOp(() => this.reference(true));
      case T.PayloadListOp:
        return this.listOp(() => this.reference(false));
      case T.Payload:
        return [this.reference(false)];
      case T.LayerOffsetVector:
        return null;
    }
    return SUPER_SCALARS.has(type) ? super._readScalarValue(type) : this.unknown(type);
  }

  /** Référence (chemin de fichier, prim, décalage temporel, customData) ou charge (sans customData). */
  private reference(withCustomData: boolean): CrateReference {
    const assetPath = this.string();
    const primPath = this.paths[this.reader.readUint32()] ?? '';
    if (withCustomData || this.version.major > 0 || this.version.minor >= 8) {
      this.reader.readFloat64(); // décalage
      this.reader.readFloat64(); // échelle
    }
    if (withCustomData) this._readScalarValue(T.Dictionary);
    return { assetPath, primPath };
  }

  /** Liste d'opérations : tout ce qui est ajouté (explicite, ajouté, au début, à la fin), sans les retraits. */
  private listOp<V>(item: () => V): V[] {
    const reader = this.reader;
    const header = reader.readUint8();
    const out: V[] = [];
    // Ordre d'écriture : explicite, ajoutés, au début, à la fin, retirés, réordonnés.
    for (const bit of [0x02, 0x04, 0x20, 0x40, 0x08, 0x10]) {
      if (!(header & bit)) continue;
      const count = reader.readUint64();
      for (let i = 0; i < count; i++) {
        const value = item();
        if (bit !== 0x08 && bit !== 0x10) out.push(value);
      }
    }
    return out;
  }

  protected override _readArrayValue(rep: CrateValueRep): unknown {
    const reader = this.reader;
    const type = rep.typeEnum;
    const size = this.version.major === 0 && this.version.minor < 7 ? reader.readUint32() : reader.readUint64();
    if (size === 0) return [];
    if (type === T.String || type === T.Token || type === T.AssetPath) {
      return Array.from({ length: size }, () => (type === T.String ? this.string() : (this.tokens[reader.readUint32()] ?? '')));
    }
    const numeric = NUMERIC[type];
    if (!numeric) return this.unknown(type);
    const [count, kind] = numeric;
    const length = size * count;
    if (rep.isCompressed) return this.compressed(type, kind, length);
    if (reader.tell() + length * SIZE[kind] > this.byteLength) throw new RangeError(`tableau de ${size} valeurs hors du fichier`);
    const out = kind === 'i' || kind === 'u' || kind === 'b' ? new Int32Array(length) : new Float64Array(length);
    for (let i = 0; i < length; i++) out[i] = this.scalar(kind) as number;
    if (QUATERNIONS.has(type)) {
      for (let i = 0; i < length; i += 4) out.set(CrateParser.realFirst(Array.from(out.subarray(i, i + 4))), i);
    }
    return out;
  }

  /** Tableaux compressés : entiers 32 bits, et réels (float, double, half) codés en entiers ou par table. */
  private compressed(type: number, kind: Scalar, size: number): unknown {
    if (kind === 'i' || kind === 'u') return super._readCompressedArray(T.Int, size);
    if (kind !== 'f' && kind !== 'd' && kind !== 'h') return this.unknown(type);
    const reader = this.reader;
    const code = reader.readInt8();
    const out = new Float64Array(size);
    if (code === 0x69 /* i */) {
      out.set(super._readCompressedArray(T.Int, size) as Int32Array);
    } else if (code === 0x74 /* t */) {
      const table = Array.from({ length: reader.readUint32() }, () => this.scalar(kind) as number);
      const indices = super._readCompressedArray(T.Int, size) as Int32Array;
      for (let i = 0; i < size; i++) out[i] = table[indices[i]];
    } else throw new RangeError(`compression de réels inconnue (${code})`);
    return out;
  }
}

// ------------------------------------------------------------- vers UsdLayer

const SPEC_ATTRIBUTE = 1;
const SPEC_PRIM = 6;
const SPEC_RELATIONSHIP = 8;
const SPECIFIERS = ['def', 'over', 'class'] as const;
const PRIM_STRUCTURE = new Set(['specifier', 'typeName', 'primChildren', 'properties']);
const ATTRIBUTE_STRUCTURE = new Set(['typeName', 'default', 'timeSamples']);

/** Valeur du crate vers la forme que produit le lecteur texte (réels en Float64Array, entiers en Int32Array). */
function toValue(value: unknown): UsdValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Float64Array || value instanceof Int32Array) return value;
  if (value instanceof Float32Array) return Float64Array.from(value);
  if (ArrayBuffer.isView(value)) return Int32Array.from(value as Uint32Array);
  if (Array.isArray(value)) return value.map(toValue);
  if (typeof value === 'object') {
    const out: UsdDictionary = {};
    for (const [key, item] of Object.entries(value)) out[key] = toValue(item);
    return out;
  }
  return value as string | number | boolean;
}

/** Une matrice isolée devient des lignes, comme `( (…), (…), … )` dans le texte. */
function shaped(type: string, value: unknown): UsdValue {
  const size = /^matrix([234])d$/.exec(type)?.[1];
  if (size && Array.isArray(value) && value.length === Number(size) ** 2) {
    const n = Number(size);
    return Array.from({ length: n }, (_, row) => value.slice(row * n, row * n + n) as number[]);
  }
  return toValue(value);
}

function asPaths(value: unknown): UsdPath[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '').map((path) => ({ path })) : [];
}

/** Références et charges internes au fichier ; celles vers un autre fichier sont signalées. */
function internalArcs(owner: string, value: unknown, warnings: string[]): UsdPath[] {
  if (!Array.isArray(value)) return [];
  const out: UsdPath[] = [];
  for (const arc of value as CrateReference[]) {
    if (arc.assetPath) warnings.push(`« ${owner} » renvoie vers un autre fichier (« ${arc.assetPath} ») : cette partie n’est pas lue.`);
    else if (arc.primPath) out.push({ path: arc.primPath });
  }
  return out;
}

const TYPE_NAMES: Record<number, string> = { 52: 'valeur générique', 53: 'valeur non déclarée', 54: 'liste de valeurs non déclarées', 57: 'expression de chemins', 58: 'relocalisations', 59: 'courbe d’animation', 60: 'bloc d’animation' };

/** Lit un fichier USD binaire (crate) en calque, avec les avertissements de lecture. */
export function parseUsdc(buffer: ArrayBuffer): { layer: UsdLayer; warnings: string[] } {
  const parser = new CrateParser();
  let specs: ReturnType<CrateParser['parseData']>['specsByPath'];
  try {
    specs = parser.parseData(buffer).specsByPath;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Fichier USD binaire illisible : il est tronqué ou endommagé (${detail}).`);
  }
  const warnings: string[] = [];
  for (const [type, path] of parser.unsupported) {
    warnings.push(`Une valeur de type « ${TYPE_NAMES[type] ?? `n° ${type}`} » (première rencontre : « ${path || '/'} ») n’est pas lue.`);
  }

  const root = specs['/'];
  const meta: UsdDictionary = {};
  for (const [key, value] of Object.entries(root?.fields ?? {})) if (key !== 'primChildren') meta[key] = toValue(value);

  const byPath = new Map<string, UsdPrim>();
  const order = new Map<string, string[]>();
  for (const [path, spec] of Object.entries(specs)) {
    if (spec.specType !== SPEC_PRIM || path.includes('{')) continue;
    const fields = spec.fields;
    const primMeta: UsdDictionary = {};
    for (const [key, value] of Object.entries(fields)) if (!PRIM_STRUCTURE.has(key)) primMeta[key] = toValue(value);
    if ('references' in fields) primMeta.references = internalArcs(path, fields.references, warnings);
    if ('payload' in fields) primMeta.payload = internalArcs(path, fields.payload, warnings);
    if (Array.isArray(fields.primChildren)) order.set(path, fields.primChildren as string[]);
    byPath.set(path, {
      specifier: SPECIFIERS[fields.specifier as number] ?? 'def',
      type: typeof fields.typeName === 'string' ? fields.typeName : '',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      meta: primMeta,
      attributes: new Map(),
      relationships: new Map(),
      children: [],
    });
  }

  for (const [path, spec] of Object.entries(specs)) {
    if (spec.specType !== SPEC_ATTRIBUTE && spec.specType !== SPEC_RELATIONSHIP) continue;
    const dot = path.indexOf('.', path.lastIndexOf('/'));
    const prim = byPath.get(path.slice(0, dot));
    if (dot < 0 || !prim) continue;
    const name = path.slice(dot + 1);
    const fields = spec.fields;
    if (spec.specType === SPEC_RELATIONSHIP) {
      prim.relationships.set(name, asPaths(fields.targetPaths));
      continue;
    }
    const type = typeof fields.typeName === 'string' ? fields.typeName : '';
    // Une valeur animée sans valeur par défaut : on prend son premier échantillon.
    const samples = fields.timeSamples as { values?: unknown[] } | undefined;
    const raw = 'default' in fields ? fields.default : samples?.values?.[0];
    const attributeMeta: UsdDictionary = {};
    for (const [key, value] of Object.entries(fields)) if (!ATTRIBUTE_STRUCTURE.has(key)) attributeMeta[key] = toValue(value);
    prim.attributes.set(name, { type, value: raw === undefined ? undefined : shaped(type, raw), meta: attributeMeta });
  }

  const prims: UsdPrim[] = [];
  for (const prim of byPath.values()) {
    const parent = prim.path.slice(0, prim.path.lastIndexOf('/'));
    (parent ? (byPath.get(parent)?.children ?? []) : prims).push(prim);
  }
  const sort = (list: UsdPrim[], names: unknown): void => {
    if (!Array.isArray(names)) return;
    list.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  };
  sort(prims, root?.fields.primChildren);
  for (const [path, names] of order) sort(byPath.get(path)!.children, names);
  return { layer: { meta, prims, byPath }, warnings };
}
