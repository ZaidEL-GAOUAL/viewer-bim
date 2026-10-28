import {
  AlwaysStencilFunc,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DecrementWrapStencilOp,
  DoubleSide,
  FrontSide,
  Group,
  IncrementWrapStencilOp,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
  type IUniform,
  type InstancedMesh,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
  type Side,
  type StencilOp,
  type Texture,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ElementState, applyElementState } from './elementState.ts';
import { isClosed, type MeshPart } from './meshMath.ts';
import { Model, type Chunk, type ElementRange } from './Model.ts';
import { buildBlocks } from './triangleBlocks.ts';

/** Calque des lots transparents : exclus des passes de remplissage des coupes. */
export const TRANSPARENT_LAYER = 1;

/** Octets d'une ligne de la table des matériaux d'un modèle brut (lecteur Revit) : r, g, b, a, transparent, double face, priorité de profondeur. */
export const MATERIAL_STRIDE = 7;

interface NodeDef {
  name?: string;
  extras?: Record<string, unknown>;
}

interface SourceMaterial {
  key: string;
  /** Couleur de base, en linéaire (sert à teinter les couleurs de sommet). */
  r: number;
  g: number;
  b: number;
  opacity: number;
  /** Couleur de base et opacité en octets sRGB, écrites telles quelles quand le sommet n'a pas de couleur propre. */
  baseR: number;
  baseG: number;
  baseB: number;
  baseA: number;
  /** Les quatre octets ci-dessus d'un seul mot : remplir un lot de sommets devient un `fill`. */
  packed: number;
  transparent: boolean;
  doubleSided: boolean;
  /**
   * Priorité de profondeur (`DEPTH_ORDINARY`, `DEPTH_OVERLAY`, `DEPTH_HOST`) : qui l'emporte quand des faces de deux éléments sont exactement dans
   * le même plan. Une priorité autre qu'ordinaire dessine ses triangles avec un décalage de profondeur négatif (`DEPTH_POLYGON_OFFSET`), plus fort
   * pour la surcouche que pour l'hôte. Chaque priorité a son propre lot : jamais de fusion avec des triangles de même couleur d'une autre.
   */
  depth: number;
  vertexColors: boolean;
  map: Texture | null;
  /** Attribut de coordonnées de texture utilisé par `map` (uv, uv1, uv2…). */
  uvAttribute: string;
  alphaTest: number;
}

/** Les trois priorités de profondeur de l'octet 6 de la table des matériaux d'un modèle brut (`revit/src/geometry/pack.rs`, `Depth`). */
export const DEPTH_ORDINARY = 0;
/** L'image d'un contenu RPC et les imports CAD du projet : devant les hôtes. */
export const DEPTH_OVERLAY = 1;
/** Les hôtes système (murs, sols, toitures, plafonds, topographie, plateformes) : devant ce qui leur est coplanaire. */
export const DEPTH_HOST = 2;

/**
 * Décalage de profondeur (facteur, unités) de chaque priorité : négatif, il rapproche les triangles de la caméra, qui gagnent contre une face
 * coplanaire (le sol d'un arbre, le dessus d'une dalle sur celui d'un poteau) sans traverser ce qui est vraiment devant eux. La surcouche
 * dépasse l'hôte : un plan importé posé sur une dalle, une silhouette posée sur le sol, se voient par-dessus.
 */
export const DEPTH_POLYGON_OFFSET = {
  [DEPTH_OVERLAY]: { factor: -2, units: -6 },
  [DEPTH_HOST]: { factor: -1, units: -2 },
} as const;

/**
 * Un morceau de géométrie à fusionner, quelle que soit son origine (maillage glTF ou USD, primitive
 * d'un modèle brut) : de simples tableaux, lus tels quels par la cuisson des lots.
 */
interface Piece {
  /** Tampons sources (xyz) ; la pièce en occupe `vertexCount` sommets à partir de `vertexStart`. */
  positions: Float32Array;
  normals: Float32Array;
  vertexStart: number;
  vertexCount: number;
  /** Indices des triangles, locaux au premier sommet de la pièce ; null : sommets pris dans l'ordre (alors `vertexStart` vaut 0). */
  index: ArrayLike<number> | null;
  indexStart: number;
  indexCount: number;
  /** Transformation à cuire dans les sommets ; null : sommets déjà en coordonnées du modèle, recopiés tels quels. */
  matrix: Matrix4 | null;
  material: SourceMaterial;
  element: number;
  /** Couleurs de sommet (linéaire, `colorSize` composantes par sommet), si le matériau les utilise. */
  colors: Float32Array | null;
  colorSize: number;
  /** Coordonnées de texture (uv) du jeu utilisé par le matériau, un jeu par sommet. */
  uvs: Float32Array | null;
  /** Clé de partage de la fermeture : les pièces d'une même forme source ont la même topologie. Null : pas de partage. */
  shape: object | null;
}

/** Ce que la collecte (scène ou modèle brut) remet à la cuisson des lots. */
interface Collected {
  keys: string[];
  names: string[];
  extras: (Record<string, unknown> | undefined)[];
  pieces: Piece[];
  /** Boîtes approximatives des éléments (minX, minY, minZ, maxX, maxY, maxZ), dans les coordonnées des pièces. */
  roughBoxes: Float64Array;
  modelBox: Box3;
  totalVertices: number;
  /**
   * Point retiré des coordonnées pour recentrer le modèle : c'est `Model.offset`. Les pièces à
   * matrice sont décalées de ce point à la cuisson ; les pièces sans matrice le sont déjà.
   */
  offset: Vector3;
  /** Matériaux three.js lus pour construire les pièces ; leurs textures inutiles sont libérées après la cuisson. */
  sourceMaterials: Iterable<Material>;
}

/**
 * Modèle décodé hors du thread principal (Revit natif) : de simples tableaux typés, sans objet
 * three.js par élément. Les positions sont en mètres, Y vers le haut, déjà relatives à `origin`.
 */
export interface RawModel {
  kind: 'raw';
  /** Identifiant de liaison et nom de chaque élément ; un élément sans primitive reste un élément (boîte vide). */
  keys: string[];
  names: string[];
  extras?: (Record<string, unknown> | undefined)[];
  /** Point (mètres, Y vers le haut) à ajouter aux positions pour retrouver les coordonnées du projet : devient `Model.offset`. */
  origin: [number, number, number];
  positions: Float32Array;
  normals: Float32Array;
  /** Coins des triangles, locaux au premier sommet de leur primitive. */
  indices: Uint32Array;
  /** Six entiers par primitive : élément, premier sommet, nombre de sommets, premier indice, nombre d'indices, matériau. */
  primitives: Uint32Array;
  /** Sept octets par matériau : r, g, b, a (sRGB), transparent (0/1), double face (0/1), priorité de profondeur (0 ordinaire, 1 surcouche, 2 hôte). */
  materials: Uint8Array;
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;

/** Un modèle brut, en un seul morceau ou en plusieurs (la sortie du lecteur Revit arrive par morceaux). */
export type RawInput = RawModel | RawModel[];

function isRaw(input: GLTF | ModelSource | RawInput): input is RawInput {
  return Array.isArray(input) || (input as { kind?: unknown }).kind === 'raw';
}

function validId(value: unknown): value is string | number {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value));
}

function linearToSRGBByte(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function srgbByteToLinear(byte: number): number {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Quatre octets de couleur lus comme un seul mot, dans l'ordre d'octets de la machine.
const wordBytes = new Uint8Array(4);
const wordView = new Uint32Array(wordBytes.buffer);
function packColor(r: number, g: number, b: number, a: number): number {
  wordBytes[0] = r;
  wordBytes[1] = g;
  wordBytes[2] = b;
  wordBytes[3] = a;
  return wordView[0];
}

const floatCache = new WeakMap<Attribute, Float32Array>();

/** Valeurs d'un attribut en flottants, sans copie quand le tampon source convient déjà. */
function readFloats(attribute: Attribute, itemSize: number): Float32Array {
  if (
    !(attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    !attribute.normalized &&
    attribute.itemSize === itemSize &&
    attribute.array instanceof Float32Array
  ) {
    return attribute.array;
  }
  let cached = floatCache.get(attribute);
  if (!cached) {
    const out = new Float32Array(attribute.count * itemSize);
    for (let i = 0; i < attribute.count; i++) {
      out[i * itemSize] = attribute.getX(i);
      if (itemSize > 1) out[i * itemSize + 1] = attribute.getY(i);
      if (itemSize > 2) out[i * itemSize + 2] = attribute.getZ(i);
      if (itemSize > 3) out[i * itemSize + 3] = attribute.getW(i);
    }
    cached = out;
    floatCache.set(attribute, cached);
  }
  return cached;
}

/**
 * Ce que buildModel a besoin de savoir d'une scène, quel que soit le format d'origine
 * (glTF, USD…) : quels objets sont des nœuds du fichier, et l'identifiant, le nom et les
 * propriétés que chacun porte.
 */
export interface ModelSource {
  scene: Object3D;
  /** Vrai si au moins un nœud porte un identifiant d'élément. */
  useIds: boolean;
  isNode(object: Object3D): boolean;
  idOf(object: Object3D): string | number | undefined;
  nameOf(object: Object3D): string | undefined;
  /** Autres propriétés portées par le nœud (hors identifiant). */
  extrasOf(object: Object3D): Record<string, unknown> | undefined;
  /** Association au nœud source, signalée une seule fois par élément créé. */
  onElement?(object: Object3D, key: string): void;
}

/** Adaptateur pour une scène lue par GLTFLoader : l'identifiant est `extras.id` du nœud glTF. */
export function gltfSource(gltf: GLTF): ModelSource {
  const nodeDefs: NodeDef[] = (gltf.parser.json.nodes as NodeDef[] | undefined) ?? [];
  const associations = gltf.parser.associations;
  const nodeIndexOf = (object: Object3D): number | undefined => (associations.get(object) as { nodes?: number } | undefined)?.nodes;
  const defOf = (object: Object3D): NodeDef | undefined => {
    const index = nodeIndexOf(object);
    return index === undefined ? undefined : nodeDefs[index];
  };
  return {
    scene: gltf.scene,
    useIds: nodeDefs.some((node) => validId(node.extras?.id)),
    isNode: (object) => nodeIndexOf(object) !== undefined,
    idOf: (object) => defOf(object)?.extras?.id as string | number | undefined,
    nameOf: (object) => defOf(object)?.name,
    extrasOf: (object) => {
      const { id, ...rest } = defOf(object)?.extras ?? {};
      void id;
      return rest;
    },
  };
}
/**
 * Transforme une scène (glTF ou USD) ou un modèle brut en modèle optimisé pour l'affichage :
 * - chaque nœud portant un identifiant devient un « élément » (un modèle brut les liste lui-même) ;
 * - toute la géométrie est fusionnée en quelques lots (un appel de dessin par lot), les
 *   transformations sont cuites dans les sommets et le modèle est recentré sur l'origine ;
 * - chaque sommet porte le numéro de son élément, ce qui permet de le masquer ou de le colorer
 *   depuis le GPU sans jamais reconstruire la géométrie.
 *
 * Les deux entrées se contentent de produire des `Piece` ; la fusion en lots, la cuisson des
 * sommets, les plages, les boîtes, les blocs de picking et le reste sont communs (`ModelBuilder`).
 */
export function buildModel(input: GLTF | ModelSource | RawInput, selectColor: IUniform<Color>): Model {
  const collected = isRaw(input) ? collectRaw(input) : collectScene('parser' in input ? gltfSource(input) : input);
  if (collected.pieces.length === 0) throw new Error('Le fichier ne contient aucune géométrie triangulée.');
  const builder = new ModelBuilder(selectColor);
  builder.bake(collected);
  return builder.model;
}

// ------------------------------------------------------------------ collecte d'une scène
function collectScene(source: ModelSource): Collected {
  const scene = source.scene;
  scene.updateMatrixWorld(true);
  const useIds = source.useIds;

  // ------------------------------------------------------------ éléments
  const elementOf = new Map<Object3D, number>();
  const keys: string[] = [];
  const names: string[] = [];
  const extras: (Record<string, unknown> | undefined)[] = [];

  const elementFor = (mesh: Object3D): number => {
    let owner: Object3D | null = null; // nœud le plus proche portant un identifiant
    let holder: Object3D | null = null; // nœud du fichier le plus proche
    for (let object: Object3D | null = mesh; object; object = object.parent) {
      if (!source.isNode(object)) continue;
      holder ??= object;
      if (!useIds) break;
      if (validId(source.idOf(object))) {
        owner = object;
        break;
      }
    }
    const target = owner ?? holder ?? mesh;
    let index = elementOf.get(target);
    if (index === undefined) {
      index = keys.length;
      elementOf.set(target, index);
      const id = source.idOf(target);
      const name = source.nameOf(target) ?? target.name ?? '';
      const key = validId(id) ? String(id) : name || `node-${index}`;
      keys.push(key);
      source.onElement?.(target, key);
      names.push(name || key);
      const rest = source.extrasOf(target);
      extras.push(rest && Object.keys(rest).length > 0 ? rest : undefined);
    }
    return index;
  };

  // -------------------------------------------------------------- pièces
  const materialCache = new Map<Material, SourceMaterial>();
  const describe = (material: Material): SourceMaterial => {
    let info = materialCache.get(material);
    if (!info) {
      const source = material as Material & { color?: Color; map?: Texture | null };
      const color = source.color?.isColor ? source.color : null;
      const map = source.map ?? null;
      // Seul le mode BLEND du glTF rend un matériau transparent. En mode OPAQUE, une opacité
      // inférieure à 1 dans la couleur de base doit être ignorée.
      const transparent = material.transparent;
      const doubleSided = material.side === DoubleSide;
      const r = color ? color.r : 1;
      const g = color ? color.g : 1;
      const b = color ? color.b : 1;
      const opacity = transparent || material.alphaTest > 0 ? material.opacity : 1;
      const baseR = linearToSRGBByte(r);
      const baseG = linearToSRGBByte(g);
      const baseB = linearToSRGBByte(b);
      const baseA = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
      info = {
        key: `${map ? material.uuid : 'uni'}|${transparent ? 't' : 'o'}|${doubleSided ? 'd' : 's'}`,
        depth: DEPTH_ORDINARY,
        r,
        g,
        b,
        opacity,
        baseR,
        baseG,
        baseB,
        baseA,
        packed: packColor(baseR, baseG, baseB, baseA),
        transparent,
        doubleSided,
        vertexColors: material.vertexColors,
        map,
        uvAttribute: map && map.channel > 0 ? `uv${map.channel}` : 'uv',
        alphaTest: material.alphaTest,
      };
      materialCache.set(material, info);
    }
    return info;
  };

  const pieces: Piece[] = [];
  const roughBoxes: number[] = []; // boîtes approximatives par élément, en coordonnées d'origine
  const pieceBox = new Box3();
  const modelBox = new Box3();
  const instanceMatrix = new Matrix4();
  let totalVertices = 0;

  // Sans normales dans le fichier, le glTF demande un ombrage à facettes : chaque triangle reçoit
  // ses propres sommets et sa propre normale. Lisser les normales arrondirait les arêtes des boîtes.
  const flatCache = new WeakMap<BufferGeometry, BufferGeometry>();
  const withNormals = (geometry: BufferGeometry): BufferGeometry => {
    if (geometry.attributes.normal) return geometry;
    let flat = flatCache.get(geometry);
    if (!flat) {
      flat = geometry.index ? geometry.toNonIndexed() : geometry;
      flat.computeVertexNormals();
      flatCache.set(geometry, flat);
    }
    return flat;
  };

  const addPiece = (mesh: Mesh, matrix: Matrix4, element: number) => {
    if (!mesh.geometry.attributes.position) return;
    const geometry = withNormals(mesh.geometry);
    const position = geometry.attributes.position;
    if (!position || position.count === 0) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const rawCount = geometry.index ? geometry.index.count : position.count;
    const indexCount = rawCount - (rawCount % 3);
    if (indexCount === 0 || !material) return;

    if (!geometry.boundingBox) geometry.computeBoundingBox();
    pieceBox.copy(geometry.boundingBox!).applyMatrix4(matrix);
    if (pieceBox.isEmpty() || !Number.isFinite(pieceBox.min.x + pieceBox.max.x + pieceBox.min.y + pieceBox.max.y + pieceBox.min.z + pieceBox.max.z)) return;
    modelBox.union(pieceBox);
    const at = element * 6;
    while (roughBoxes.length < at + 6) roughBoxes.push(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity);
    roughBoxes[at] = Math.min(roughBoxes[at], pieceBox.min.x);
    roughBoxes[at + 1] = Math.min(roughBoxes[at + 1], pieceBox.min.y);
    roughBoxes[at + 2] = Math.min(roughBoxes[at + 2], pieceBox.min.z);
    roughBoxes[at + 3] = Math.max(roughBoxes[at + 3], pieceBox.max.x);
    roughBoxes[at + 4] = Math.max(roughBoxes[at + 4], pieceBox.max.y);
    roughBoxes[at + 5] = Math.max(roughBoxes[at + 5], pieceBox.max.z);

    const info = describe(material);
    const color = info.vertexColors ? geometry.attributes.color : undefined;
    const colored = color !== undefined && (color.itemSize === 3 || color.itemSize === 4);
    const uvSource = info.map ? geometry.attributes[info.uvAttribute] : undefined;
    pieces.push({
      positions: readFloats(position, 3),
      normals: readFloats(geometry.attributes.normal, 3),
      vertexStart: 0,
      vertexCount: position.count,
      index: geometry.index ? geometry.index.array : null,
      indexStart: 0,
      indexCount,
      matrix,
      material: info,
      element,
      colors: colored ? readFloats(color, color.itemSize) : null,
      colorSize: colored ? color.itemSize : 0,
      uvs: uvSource ? readFloats(uvSource, 2) : null,
      shape: geometry,
    });
    totalVertices += position.count;
  };

  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const element = elementFor(mesh);
    const instanced = mesh as InstancedMesh;
    if (instanced.isInstancedMesh) {
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, instanceMatrix);
        addPiece(mesh, new Matrix4().multiplyMatrices(mesh.matrixWorld, instanceMatrix), element);
      }
    } else {
      addPiece(mesh, mesh.matrixWorld, element);
    }
  });

  const rough = emptyBoxes(keys.length);
  rough.set(roughBoxes);
  return {
    keys,
    names,
    extras,
    pieces,
    roughBoxes: rough,
    modelBox,
    totalVertices,
    // Recentrage : les modèles géoréférencés sont loin de l'origine, ce qui fait trembler
    // l'affichage en simple précision. Le décalage est retiré à la cuisson, en double précision.
    offset: modelBox.getCenter(new Vector3()),
    sourceMaterials: materialCache.keys(),
  };
}

/** Boîtes vides (minimum à +∞, maximum à −∞) pour `count` éléments. */
function emptyBoxes(count: number): Float64Array {
  const boxes = new Float64Array(count * 6);
  for (let i = 0; i < boxes.length; i += 6) {
    boxes.fill(Infinity, i, i + 3);
    boxes.fill(-Infinity, i + 3, i + 6);
  }
  return boxes;
}

// --------------------------------------------------------------- collecte d'un modèle brut
/**
 * Collecte d'un modèle brut, en un ou plusieurs morceaux (`RawModel[]`) : les éléments et les primitives se
 * suivent dans l'ordre des morceaux, comme s'ils étaient d'un seul. Un morceau dont l'origine est celle du modèle
 * (`origin` : par défaut celle du premier morceau ; c'est le cas de la sortie du lecteur Revit, une seule origine
 * pour le modèle entier) est recopié tel quel, sans aucun calcul : le résultat est exactement celui du modèle d'un
 * bloc. Un morceau qui a sa propre origine est déplacé de la différence à la cuisson (une matrice de translation,
 * comme les pièces d'une scène). Les numéros d'élément sont locaux à la collecte (de 0) : la cuisson les décale.
 */
function collectRaw(input: RawInput, origin?: Vector3): Collected {
  const chunks = Array.isArray(input) ? input : [input];
  if (chunks.length === 0) throw new Error('Modèle brut incohérent : aucun morceau.');
  let elementCount = 0;
  for (const raw of chunks) {
    if (raw.names.length !== raw.keys.length || (raw.extras && raw.extras.length > raw.keys.length)) {
      throw new Error('Modèle brut incohérent : les clés, noms et propriétés des éléments ne correspondent pas.');
    }
    if (raw.primitives.length % 6 !== 0 || raw.materials.length % MATERIAL_STRIDE !== 0) {
      throw new Error('Modèle brut incohérent : les tables de primitives et de matériaux sont mal formées.');
    }
    elementCount += raw.keys.length;
  }

  // Une description par ligne distincte de la table des matériaux : la couleur se lit dans les octets, jamais dans
  // un objet three.js. Chaque morceau porte sa table (dans la sortie du lecteur, celle d'un morceau prolonge la
  // précédente) ; les lignes sont reliées par leur contenu, pour qu'un même matériau ne fasse qu'une source.
  const sources: SourceMaterial[] = [];
  const sourceByRow = new Map<string, SourceMaterial>();
  const sourceOf = (materials: Uint8Array, m: number): SourceMaterial => {
    const row = `${materials[m]},${materials[m + 1]},${materials[m + 2]},${materials[m + 3]},${materials[m + 4]},${materials[m + 5]},${materials[m + 6]}`;
    let source = sourceByRow.get(row);
    if (source) return source;
    const transparent = materials[m + 4] !== 0;
    const doubleSided = materials[m + 5] !== 0;
    const depth = materials[m + 6] === DEPTH_OVERLAY || materials[m + 6] === DEPTH_HOST ? materials[m + 6] : DEPTH_ORDINARY;
    source = {
      key: `uni|${transparent ? 't' : 'o'}|${doubleSided ? 'd' : 's'}${depth === DEPTH_OVERLAY ? '|v' : depth === DEPTH_HOST ? '|h' : ''}`,
      depth,
      r: srgbByteToLinear(materials[m]),
      g: srgbByteToLinear(materials[m + 1]),
      b: srgbByteToLinear(materials[m + 2]),
      opacity: materials[m + 3] / 255,
      baseR: materials[m],
      baseG: materials[m + 1],
      baseB: materials[m + 2],
      baseA: materials[m + 3],
      packed: packColor(materials[m], materials[m + 1], materials[m + 2], materials[m + 3]),
      transparent,
      doubleSided,
      vertexColors: false,
      map: null,
      uvAttribute: 'uv',
      alphaTest: 0,
    };
    sourceByRow.set(row, source);
    sources.push(source);
    return source;
  };

  const ox = origin ? origin.x : chunks[0].origin[0];
  const oy = origin ? origin.y : chunks[0].origin[1];
  const oz = origin ? origin.z : chunks[0].origin[2];
  const keys: string[] = [];
  const names: string[] = [];
  const extras: (Record<string, unknown> | undefined)[] = [];
  const pieces: Piece[] = [];
  const rough = emptyBoxes(elementCount);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalVertices = 0;
  let elementBase = 0;

  for (const raw of chunks) {
    const { positions, normals, indices, primitives, materials } = raw;
    const local: SourceMaterial[] = [];
    for (let m = 0; m < materials.length; m += MATERIAL_STRIDE) local.push(sourceOf(materials, m));
    for (let i = 0; i < raw.keys.length; i++) {
      keys.push(raw.keys[i]);
      names.push(raw.names[i] || raw.keys[i]);
      const rest = raw.extras?.[i];
      extras.push(rest && Object.keys(rest).length > 0 ? rest : undefined);
    }
    // Le décalage du morceau par rapport à l'origine du modèle : nul pour la sortie du lecteur (une seule origine).
    const dx = raw.origin[0] - ox, dy = raw.origin[1] - oy, dz = raw.origin[2] - oz;
    const shifted = dx !== 0 || dy !== 0 || dz !== 0;
    const matrix = shifted ? new Matrix4().makeTranslation(raw.origin[0], raw.origin[1], raw.origin[2]) : null;

    for (let p = 0; p < primitives.length; p += 6) {
      const element = elementBase + primitives[p];
      const vertexStart = primitives[p + 1];
      const vertexCount = primitives[p + 2];
      const indexStart = primitives[p + 3];
      const indexCount = primitives[p + 4] - (primitives[p + 4] % 3);
      const material = local[primitives[p + 5]];
      if (primitives[p] >= raw.keys.length || !material) {
        throw new Error('Modèle brut incohérent : une primitive désigne un élément ou un matériau inconnu.');
      }
      if (
        (vertexStart + vertexCount) * 3 > positions.length ||
        (vertexStart + vertexCount) * 3 > normals.length ||
        indexStart + primitives[p + 4] > indices.length
      ) {
        throw new Error('Modèle brut incohérent : une primitive dépasse les tampons de sommets ou d’indices.');
      }
      if (vertexCount === 0 || indexCount === 0) continue;

      // Boîte de la primitive : les positions sont déjà en simple précision, elle contient exactement les sommets
      // stockés (déplacés du décalage du morceau, s'il en a un).
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let s = vertexStart * 3, end = s + vertexCount * 3; s < end; s += 3) {
        const x = positions[s] + dx, y = positions[s + 1] + dy, z = positions[s + 2] + dz;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      if (x0 > x1 || y0 > y1 || z0 > z1 || !Number.isFinite(x0 + x1 + y0 + y1 + z0 + z1)) continue;
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (z0 < minZ) minZ = z0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
      if (z1 > maxZ) maxZ = z1;
      const at = element * 6;
      if (x0 < rough[at]) rough[at] = x0;
      if (y0 < rough[at + 1]) rough[at + 1] = y0;
      if (z0 < rough[at + 2]) rough[at + 2] = z0;
      if (x1 > rough[at + 3]) rough[at + 3] = x1;
      if (y1 > rough[at + 4]) rough[at + 4] = y1;
      if (z1 > rough[at + 5]) rough[at + 5] = z1;

      pieces.push({
        positions,
        normals,
        vertexStart,
        vertexCount,
        index: indices,
        indexStart,
        indexCount,
        matrix,
        material,
        element,
        colors: null,
        colorSize: 0,
        uvs: null,
        shape: null,
      });
      totalVertices += vertexCount;
    }
    elementBase += raw.keys.length;
  }

  const modelBox = new Box3();
  if (pieces.length > 0) modelBox.set(new Vector3(minX, minY, minZ), new Vector3(maxX, maxY, maxZ));
  return {
    keys,
    names,
    extras,
    pieces,
    roughBoxes: rough,
    modelBox,
    totalVertices,
    // Les positions sont déjà relatives à l'origine : rien à retirer à la cuisson, mais c'est bien
    // le point que `Model.offset` doit rendre (positions + offset = coordonnées du projet).
    offset: new Vector3(ox, oy, oz),
    sourceMaterials: [],
  };
}

// ------------------------------------------------------------------ cuisson des sommets
// Ces fonctions tournent sur des millions de sommets : tableaux typés uniquement, aucune
// allocation, aucun objet intermédiaire dans les boucles.

/** Normale unitaire quantifiée sur 8 bits signés ; un vecteur nul devient la verticale. */
function writeNormal(out: Int8Array, o: number, nx: number, ny: number, nz: number): void {
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (length > 0) {
    nx /= length;
    ny /= length;
    nz /= length;
  } else {
    nx = 0;
    ny = 1;
    nz = 0;
  }
  out[o] = Math.round(nx * 127);
  out[o + 1] = Math.round(ny * 127);
  out[o + 2] = Math.round(nz * 127);
}

/**
 * Sommets d'une pièce à matrice : transformation, retrait du décalage, normales, et boîte de
 * l'élément `element` (numéro dans le modèle ; relue en simple précision : elle doit contenir exactement les
 * sommets stockés).
 */
function bakeTransformed(
  piece: Piece, element: number, e: number[], n: number[], offset: Vector3,
  positions: Float32Array, normals: Int8Array, vBase: number, boxes: Float32Array,
): void {
  const srcPositions = piece.positions, srcNormals = piece.normals;
  const first = piece.vertexStart * 3;
  const ox = offset.x, oy = offset.y, oz = offset.z;
  const boxAt = element * 6;
  let minX = boxes[boxAt], minY = boxes[boxAt + 1], minZ = boxes[boxAt + 2];
  let maxX = boxes[boxAt + 3], maxY = boxes[boxAt + 4], maxZ = boxes[boxAt + 5];

  for (let i = 0, count = piece.vertexCount; i < count; i++) {
    const s = first + i * 3;
    const x = srcPositions[s], y = srcPositions[s + 1], z = srcPositions[s + 2];
    const o = (vBase + i) * 3;
    positions[o] = e[0] * x + e[4] * y + e[8] * z + e[12] - ox;
    positions[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13] - oy;
    positions[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14] - oz;
    const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;

    const a = srcNormals[s], b = srcNormals[s + 1], c = srcNormals[s + 2];
    writeNormal(normals, o, n[0] * a + n[3] * b + n[6] * c, n[1] * a + n[4] * b + n[7] * c, n[2] * a + n[5] * b + n[8] * c);
  }
  boxes[boxAt] = minX;
  boxes[boxAt + 1] = minY;
  boxes[boxAt + 2] = minZ;
  boxes[boxAt + 3] = maxX;
  boxes[boxAt + 4] = maxY;
  boxes[boxAt + 5] = maxZ;
}

/** Sommets d'une pièce sans matrice (modèle brut) : positions recopiées en bloc, aucun calcul matriciel. */
function bakeCopied(piece: Piece, element: number, positions: Float32Array, normals: Int8Array, vBase: number, boxes: Float32Array): void {
  const srcNormals = piece.normals;
  const first = piece.vertexStart * 3;
  const count = piece.vertexCount;
  const start = vBase * 3;
  positions.set(piece.positions.subarray(first, first + count * 3), start);
  const boxAt = element * 6;
  let minX = boxes[boxAt], minY = boxes[boxAt + 1], minZ = boxes[boxAt + 2];
  let maxX = boxes[boxAt + 3], maxY = boxes[boxAt + 4], maxZ = boxes[boxAt + 5];

  for (let i = 0; i < count; i++) {
    const o = start + i * 3;
    const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
    const s = first + i * 3;
    writeNormal(normals, o, srcNormals[s], srcNormals[s + 1], srcNormals[s + 2]);
  }
  boxes[boxAt] = minX;
  boxes[boxAt + 1] = minY;
  boxes[boxAt + 2] = minZ;
  boxes[boxAt + 3] = maxX;
  boxes[boxAt + 4] = maxY;
  boxes[boxAt + 5] = maxZ;
}

/** Numéro d'élément (dans le modèle), couleur et coordonnées de texture des sommets d'une pièce. */
function bakeAttributes(
  piece: Piece, element: number, vBase: number,
  colors: Uint8Array, words: Uint32Array, ids: Float32Array, uvs: Float32Array | null,
): void {
  const { vertexStart, vertexCount, material } = piece;
  ids.fill(element, vBase, vBase + vertexCount);

  const source = piece.colors;
  if (!source) {
    words.fill(material.packed, vBase, vBase + vertexCount);
  } else {
    const size = piece.colorSize;
    const { r, g, b, baseA } = material;
    for (let i = 0; i < vertexCount; i++) {
      const s = (vertexStart + i) * size;
      const col = (vBase + i) * 4;
      colors[col] = linearToSRGBByte(r * source[s]);
      colors[col + 1] = linearToSRGBByte(g * source[s + 1]);
      colors[col + 2] = linearToSRGBByte(b * source[s + 2]);
      colors[col + 3] = size === 4 ? Math.round(baseA * Math.max(0, Math.min(1, source[s + 3]))) : baseA;
    }
  }

  const srcUvs = piece.uvs;
  if (uvs && srcUvs) {
    for (let i = 0; i < vertexCount; i++) {
      uvs[(vBase + i) * 2] = srcUvs[(vertexStart + i) * 2];
      uvs[(vBase + i) * 2 + 1] = srcUvs[(vertexStart + i) * 2 + 1];
    }
  }
}

/** Indices de la pièce, renumérotés dans le lot. Un miroir inverse l'orientation des faces : on rétablit l'ordre des sommets. */
function bakeIndices(dst: Uint16Array | Uint32Array, iBase: number, piece: Piece, vBase: number, flip: boolean): void {
  const src = piece.index;
  const start = piece.indexStart;
  const count = piece.indexCount;
  if (src && !flip) {
    for (let k = 0; k < count; k++) dst[iBase + k] = src[start + k] + vBase;
    return;
  }
  for (let k = 0; k < count; k += 3) {
    const a = src ? src[start + k] : k;
    const b = src ? src[start + k + 1] : k + 1;
    const c = src ? src[start + k + 2] : k + 2;
    dst[iBase + k] = a + vBase;
    dst[iBase + k + 1] = (flip ? c : b) + vBase;
    dst[iBase + k + 2] = (flip ? b : c) + vBase;
  }
}

/** La fermeture ne dépend que de la topologie de la pièce (avant transformation). */
function isPieceClosed(piece: Piece): boolean {
  let index = piece.index;
  if (!index) {
    const sequence = new Uint32Array(piece.indexCount);
    for (let k = 0; k < sequence.length; k++) sequence[k] = k;
    index = sequence;
  }
  const part: MeshPart = {
    positions: piece.vertexStart === 0 ? piece.positions : piece.positions.subarray(piece.vertexStart * 3),
    index,
    start: piece.index ? piece.indexStart : 0,
    count: piece.indexCount,
  };
  return isClosed([part]);
}

// ------------------------------------------------------------------ fusion et cuisson des lots
/**
 * Construit un modèle en une ou plusieurs fois : `buildModel` cuit tout d'un coup, la lecture Revit cuit chaque
 * morceau dès qu'il arrive (`append`). Le modèle (`model`) existe dès la création, vide, et reste affichable et
 * cliquable entre deux morceaux : chaque cuisson lui ajoute ses lots et ses éléments (`Model.grow`), prolonge son
 * état, ses plages et sa boîte, puis recalcule les priorités d'affichage de tous les éléments (elles dépendent de
 * la taille du modèle entier).
 *
 * Les éléments se suivent dans l'ordre des morceaux ; un élément est entier dans son morceau (ses primitives n'en
 * désignent pas un autre). Les lots d'un morceau sont les siens (un lot par matériau et par cellule de sa grille) :
 * un modèle cuit en plusieurs fois a les mêmes éléments, numéros, boîtes et triangles que d'un bloc, pas les mêmes
 * lots. Les matériaux three.js (un par réglage : transparence, double face, texture) sont partagés par tous les
 * morceaux.
 */
export class ModelBuilder {
  readonly model: Model;
  private readonly selectColor: IUniform<Color>;
  private readonly materials = new Map<string, Material>();
  private readonly keptTextures = new Set<Texture>();
  private readonly closedCache = new WeakMap<object, boolean>();
  /** Vrai dès la première cuisson : l'origine du modèle est alors fixée, même si ce morceau n'avait pas de géométrie. */
  private started = false;

  constructor(selectColor: IUniform<Color>) {
    this.selectColor = selectColor;
    const state = new ElementState(0);
    const group = new Group();
    group.name = 'modèle';
    const stencilMaterial = (side: Side, operation: StencilOp): Material => {
      const material = new MeshBasicMaterial({
        side,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        stencilWrite: true,
        stencilFunc: AlwaysStencilFunc,
        stencilFail: operation,
        stencilZFail: operation,
        stencilZPass: operation,
      });
      material.defines = { BIM_SOLID_ONLY: '' };
      applyElementState(material, state, selectColor);
      return material;
    };
    this.model = new Model({
      group,
      ranges: [],
      state,
      box: new Box3(),
      offset: new Vector3(),
      stencilBack: stencilMaterial(BackSide, IncrementWrapStencilOp),
      stencilFront: stencilMaterial(FrontSide, DecrementWrapStencilOp),
      selectColor,
    });
  }

  /**
   * Ajoute un morceau de modèle brut (un `chunk` du lecteur Revit) : ses éléments prennent les numéros suivants, ses
   * positions sont ramenées à l'origine du modèle (celle du premier morceau) s'il a la sienne. Un morceau sans
   * géométrie (des niveaux, des éléments sans forme) ajoute ses éléments, avec une boîte vide.
   */
  append(raw: RawModel): void {
    this.bake(collectRaw(raw, this.started ? this.model.offset : undefined));
  }

  /** Cuit des pièces collectées (scène ou modèle brut) dans le modèle, à la suite de ce qu'il contient déjà. */
  bake(collected: Collected): void {
    const { keys, names, extras, pieces, roughBoxes, modelBox, totalVertices } = collected;
    const model = this.model;
    const { state, ranges } = model;
    const base = model.count;
    const added = keys.length;
    const total = base + added;
    if (!this.started) {
      model.offset.copy(collected.offset);
      this.started = true;
    }
    const offset = model.offset;

    // --------------------------------------------------- découpage en lots
    // Un lot par matériau et par cellule d'une grille grossière : three.js peut ainsi écarter
    // d'un seul test les lots situés hors du champ de la caméra.
    const size = modelBox.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const grid = Math.max(1, Math.min(6, Math.round(Math.cbrt(totalVertices / 250000))));
    const cellSize = maxDim / grid;
    const cellAxis = (value: number, min: number) => Math.max(0, Math.min(grid - 1, Math.floor((value - min) / cellSize)));
    const cellOf = (element: number): number => {
      const at = element * 6;
      const cx = cellAxis((roughBoxes[at] + roughBoxes[at + 3]) / 2, modelBox.min.x);
      const cy = cellAxis((roughBoxes[at + 1] + roughBoxes[at + 4]) / 2, modelBox.min.y);
      const cz = cellAxis((roughBoxes[at + 2] + roughBoxes[at + 5]) / 2, modelBox.min.z);
      return cx + grid * (cy + grid * cz);
    };

    const batches = new Map<string, Piece[]>();
    for (const piece of pieces) {
      const key = `${piece.material.key}#${cellOf(piece.element)}`;
      const batch = batches.get(key);
      if (batch) batch.push(piece);
      else batches.set(key, [piece]);
    }

    // ----------------------------------------------------- cuisson des lots
    // Les tableaux par élément sont prolongés d'abord : les nouveaux éléments sont visibles, sans plage ni boîte.
    state.grow(total);
    const boxes = new Float32Array(total * 6);
    boxes.set(model.boxes);
    for (let i = base; i < total; i++) {
      boxes.fill(Infinity, i * 6, i * 6 + 3);
      boxes.fill(-Infinity, i * 6 + 3, i * 6 + 6);
    }
    for (let i = 0; i < added; i++) ranges.push([]);
    const maybeOpen = new Uint8Array(added);
    const pieceCount = new Uint32Array(added);
    const chunks: Chunk[] = [];
    const newMaterials: Material[] = [];
    const newTextures: Texture[] = [];
    const normalMatrix = new Matrix3();
    let triangleCount = 0;

    for (const batch of batches.values()) {
      batch.sort((a, b) => a.element - b.element);
      const source = batch[0].material;
      let vertexTotal = 0;
      let indexTotal = 0;
      for (const piece of batch) {
        vertexTotal += piece.vertexCount;
        indexTotal += piece.indexCount;
      }
      const positions = new Float32Array(vertexTotal * 3);
      const normals = new Int8Array(vertexTotal * 3);
      const colors = new Uint8Array(vertexTotal * 4);
      const words = new Uint32Array(colors.buffer);
      const ids = new Float32Array(vertexTotal);
      const uvs = source.map ? new Float32Array(vertexTotal * 2) : null;
      const index = vertexTotal > 65535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal);
      const chunkIndex = model.chunks.length + chunks.length;
      let vBase = 0;
      let iBase = 0;

      for (const piece of batch) {
        const { matrix, material, vertexCount, indexCount } = piece;
        const element = base + piece.element;
        let flip = false;
        if (matrix) {
          bakeTransformed(piece, element, matrix.elements, normalMatrix.getNormalMatrix(matrix).elements, offset, positions, normals, vBase, boxes);
          flip = matrix.determinant() < 0;
        } else {
          bakeCopied(piece, element, positions, normals, vBase, boxes);
        }
        bakeAttributes(piece, element, vBase, colors, words, ids, uvs);
        bakeIndices(index, iBase, piece, vBase, flip);

        // Seules les pièces opaques comptent : ce sont elles que le remplissage des coupes dessine.
        if (!material.transparent) {
          // Calculée une fois par forme source (les instances d'un même maillage la partagent).
          let closed = piece.shape ? this.closedCache.get(piece.shape) : undefined;
          if (closed === undefined) {
            closed = isPieceClosed(piece);
            if (piece.shape) this.closedCache.set(piece.shape, closed);
          }
          if (!closed) maybeOpen[piece.element] = 1;
          pieceCount[piece.element]++;
        }

        const list = ranges[element];
        const last = list[list.length - 1];
        if (last && last.chunk === chunkIndex && last.start + last.count === iBase) last.count += indexCount;
        else list.push({ chunk: chunkIndex, start: iBase, count: indexCount, blocks: null });

        vBase += vertexCount;
        iBase += indexCount;
      }

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(normals, 3, true));
      geometry.setAttribute('color', new BufferAttribute(colors, 4, true));
      geometry.setAttribute('aElement', new BufferAttribute(ids, 1));
      if (uvs) geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
      geometry.setIndex(new BufferAttribute(index, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      let material = this.materials.get(source.key);
      if (!material) {
        material = new MeshLambertMaterial({
          vertexColors: true,
          side: source.doubleSided ? DoubleSide : FrontSide,
          transparent: source.transparent,
          depthWrite: !source.transparent,
          map: source.map,
          alphaTest: source.alphaTest,
          // Une priorité de profondeur gagne contre les faces coplanaires de priorité moindre (voir `SourceMaterial.depth`).
          polygonOffset: source.depth !== DEPTH_ORDINARY,
          polygonOffsetFactor: source.depth === DEPTH_OVERLAY ? DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].factor : source.depth === DEPTH_HOST ? DEPTH_POLYGON_OFFSET[DEPTH_HOST].factor : 0,
          polygonOffsetUnits: source.depth === DEPTH_OVERLAY ? DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].units : source.depth === DEPTH_HOST ? DEPTH_POLYGON_OFFSET[DEPTH_HOST].units : 0,
        });
        applyElementState(material, state, this.selectColor);
        this.materials.set(source.key, material);
        newMaterials.push(material);
        if (source.map) {
          // Les coordonnées de texture ont été recopiées dans l'attribut `uv` du lot, quel que soit
          // le jeu d'origine (TEXCOORD_1, _2…).
          source.map.channel = 0;
          if (!this.keptTextures.has(source.map)) {
            this.keptTextures.add(source.map);
            newTextures.push(source.map);
          }
        }
      }

      const mesh = new Mesh(geometry, material);
      mesh.matrixAutoUpdate = false;
      if (source.transparent) {
        mesh.layers.set(TRANSPARENT_LAYER);
        mesh.renderOrder = 1;
      }
      chunks.push({ mesh, positions, index, transparent: source.transparent, doubleSided: source.doubleSided });
      triangleCount += indexTotal / 3;
    }

    // Les éléments très détaillés reçoivent des blocs de triangles pour accélérer le lancer de rayon.
    const chunkOf = (range: ElementRange): Chunk => chunks[range.chunk - model.chunks.length];
    for (let i = base; i < total; i++) {
      for (const range of ranges[i]) {
        const chunk = chunkOf(range);
        range.blocks = buildBlocks(chunk.positions, chunk.index, range.start, range.count);
      }
    }

    // Un élément réparti sur plusieurs géométries ouvertes peut tout de même former un solide fermé.
    for (let i = 0; i < added; i++) {
      if (!maybeOpen[i]) continue;
      if (pieceCount[i] === 1) {
        state.setOpen(base + i, true);
        continue;
      }
      const parts = ranges[base + i]
        .filter((range) => !chunkOf(range).transparent)
        .map((range) => ({
          positions: chunkOf(range).positions,
          index: chunkOf(range).index,
          start: range.start,
          count: range.count,
        }));
      state.setOpen(base + i, !isClosed(parts));
    }

    // Les textures que l'affichage n'utilise pas (normales, rugosité…) sont libérées tout de suite.
    for (const material of collected.sourceMaterials) {
      for (const value of Object.values(material)) {
        const texture = value as Texture | null;
        if (texture?.isTexture && !this.keptTextures.has(texture)) {
          (texture.image as { close?: () => void } | null)?.close?.();
          texture.dispose();
        }
      }
    }

    const box = model.box;
    for (let i = base; i < total; i++) {
      const at = i * 6;
      if (boxes[at] > boxes[at + 3]) continue;
      box.min.set(Math.min(box.min.x, boxes[at]), Math.min(box.min.y, boxes[at + 1]), Math.min(box.min.z, boxes[at + 2]));
      box.max.set(Math.max(box.max.x, boxes[at + 3]), Math.max(box.max.y, boxes[at + 4]), Math.max(box.max.z, boxes[at + 5]));
    }

    // Priorité d'affichage : plus un élément est petit par rapport au modèle, plus il passe devant
    // quand ses faces se confondent avec celles d'un autre. Une poutre noyée reste ainsi visible
    // à la surface de la dalle qui la contient. Le modèle a pu grandir : tous les éléments sont repris.
    const modelDiagonal = box.isEmpty() ? 1 : box.getSize(new Vector3()).length() || 1;
    for (let i = 0; i < total; i++) {
      const at = i * 6;
      if (boxes[at] > boxes[at + 3]) continue;
      const diagonal = Math.hypot(boxes[at + 3] - boxes[at], boxes[at + 4] - boxes[at + 1], boxes[at + 5] - boxes[at + 2]);
      state.setPriority(i, diagonal > 0 ? -Math.log2(diagonal / modelDiagonal) : 7);
    }
    state.commit();

    model.grow({ keys, names, extras, chunks, boxes, triangleCount, materials: newMaterials, textures: newTextures });
  }
}
