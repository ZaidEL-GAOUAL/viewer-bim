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

interface NodeDef {
  name?: string;
  extras?: Record<string, unknown>;
}

interface SourceMaterial {
  key: string;
  r: number;
  g: number;
  b: number;
  opacity: number;
  transparent: boolean;
  doubleSided: boolean;
  vertexColors: boolean;
  map: Texture | null;
  /** Attribut de coordonnées de texture utilisé par `map` (uv, uv1, uv2…). */
  uvAttribute: string;
  alphaTest: number;
}

interface Piece {
  geometry: BufferGeometry;
  matrix: Matrix4;
  material: SourceMaterial;
  element: number;
  vertexCount: number;
  indexCount: number;
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;

function validId(value: unknown): value is string | number {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value));
}

function linearToSRGBByte(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

const floatCache = new WeakMap<Attribute, ArrayLike<number>>();

/** Valeurs d'un attribut en flottants, sans copie quand le tampon source convient déjà. */
function readFloats(attribute: Attribute, itemSize: number): ArrayLike<number> {
  const direct =
    !(attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute &&
    !attribute.normalized &&
    attribute.itemSize === itemSize &&
    attribute.array instanceof Float32Array;
  if (direct) return attribute.array;
  let cached = floatCache.get(attribute);
  if (!cached) {
    const out = new Float32Array(attribute.count * itemSize);
    for (let i = 0; i < attribute.count; i++) {
      out[i * itemSize] = attribute.getX(i);
      if (itemSize > 1) out[i * itemSize + 1] = attribute.getY(i);
      if (itemSize > 2) out[i * itemSize + 2] = attribute.getZ(i);
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
 * Transforme la scène (glTF ou USD) en modèle optimisé pour l'affichage :
 * - chaque nœud portant un identifiant devient un « élément » ;
 * - toute la géométrie est fusionnée en quelques lots (un appel de dessin par lot), les
 *   transformations sont cuites dans les sommets et le modèle est recentré sur l'origine ;
 * - chaque sommet porte le numéro de son élément, ce qui permet de le masquer ou de le colorer
 *   depuis le GPU sans jamais reconstruire la géométrie.
 */
export function buildModel(input: GLTF | ModelSource, selectColor: IUniform<Color>): Model {
  const source = 'parser' in input ? gltfSource(input) : input;
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
      info = {
        key: `${map ? material.uuid : 'uni'}|${transparent ? 't' : 'o'}|${doubleSided ? 'd' : 's'}`,
        r: color ? color.r : 1,
        g: color ? color.g : 1,
        b: color ? color.b : 1,
        opacity: transparent || material.alphaTest > 0 ? material.opacity : 1,
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

    pieces.push({ geometry, matrix, material: describe(material), element, vertexCount: position.count, indexCount });
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

  if (pieces.length === 0) throw new Error('Le fichier ne contient aucune géométrie triangulée.');

  // Recentrage : les modèles géoréférencés sont loin de l'origine, ce qui fait trembler
  // l'affichage en simple précision. Le décalage est retiré ici, en double précision.
  const offset = modelBox.getCenter(new Vector3());
  const elementCount = keys.length;

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
  const state = new ElementState(elementCount);
  const boxes = new Float32Array(elementCount * 6);
  for (let i = 0; i < elementCount; i++) {
    boxes.fill(Infinity, i * 6, i * 6 + 3);
    boxes.fill(-Infinity, i * 6 + 3, i * 6 + 6);
  }
  const ranges: ElementRange[][] = Array.from({ length: elementCount }, () => []);
  const maybeOpen = new Uint8Array(elementCount);
  const pieceCount = new Uint32Array(elementCount);
  const closedCache = new WeakMap<BufferGeometry, boolean>();
  const chunks: Chunk[] = [];
  const materials = new Map<string, Material>();
  const keptTextures = new Set<Texture>();
  const group = new Group();
  group.name = 'modèle';
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
    const ids = new Float32Array(vertexTotal);
    const uvs = source.map ? new Float32Array(vertexTotal * 2) : null;
    const index = vertexTotal > 65535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal);
    const chunkIndex = chunks.length;
    let vBase = 0;
    let iBase = 0;

    for (const piece of batch) {
      const { geometry, matrix, material, element, vertexCount, indexCount } = piece;
      const srcPositions = readFloats(geometry.attributes.position, 3);
      const srcNormals = readFloats(geometry.attributes.normal, 3);
      const srcColors = material.vertexColors ? geometry.attributes.color : undefined;
      const uvSource = geometry.attributes[material.uvAttribute];
      const srcUvs = uvs && uvSource ? readFloats(uvSource, 2) : null;

      const e = matrix.elements;
      const n = normalMatrix.getNormalMatrix(matrix).elements;
      const baseR = linearToSRGBByte(material.r);
      const baseG = linearToSRGBByte(material.g);
      const baseB = linearToSRGBByte(material.b);
      const alpha = Math.round(Math.max(0, Math.min(1, material.opacity)) * 255);
      const boxAt = element * 6;

      for (let i = 0; i < vertexCount; i++) {
        const s = i * 3;
        const x = srcPositions[s], y = srcPositions[s + 1], z = srcPositions[s + 2];
        const o = (vBase + i) * 3;
        positions[o] = e[0] * x + e[4] * y + e[8] * z + e[12] - offset.x;
        positions[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13] - offset.y;
        positions[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14] - offset.z;
        // Relecture en simple précision : la boîte doit contenir exactement les sommets stockés.
        const px = positions[o], py = positions[o + 1], pz = positions[o + 2];
        if (px < boxes[boxAt]) boxes[boxAt] = px;
        if (py < boxes[boxAt + 1]) boxes[boxAt + 1] = py;
        if (pz < boxes[boxAt + 2]) boxes[boxAt + 2] = pz;
        if (px > boxes[boxAt + 3]) boxes[boxAt + 3] = px;
        if (py > boxes[boxAt + 4]) boxes[boxAt + 4] = py;
        if (pz > boxes[boxAt + 5]) boxes[boxAt + 5] = pz;

        const a = srcNormals[s], b = srcNormals[s + 1], c = srcNormals[s + 2];
        let nx = n[0] * a + n[3] * b + n[6] * c;
        let ny = n[1] * a + n[4] * b + n[7] * c;
        let nz = n[2] * a + n[5] * b + n[8] * c;
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
        normals[o] = Math.round(nx * 127);
        normals[o + 1] = Math.round(ny * 127);
        normals[o + 2] = Math.round(nz * 127);

        const col = (vBase + i) * 4;
        if (srcColors) {
          colors[col] = linearToSRGBByte(material.r * srcColors.getX(i));
          colors[col + 1] = linearToSRGBByte(material.g * srcColors.getY(i));
          colors[col + 2] = linearToSRGBByte(material.b * srcColors.getZ(i));
          colors[col + 3] = srcColors.itemSize === 4 ? Math.round(alpha * Math.max(0, Math.min(1, srcColors.getW(i)))) : alpha;
        } else {
          colors[col] = baseR;
          colors[col + 1] = baseG;
          colors[col + 2] = baseB;
          colors[col + 3] = alpha;
        }
        ids[vBase + i] = element;
        if (uvs && srcUvs) {
          uvs[(vBase + i) * 2] = srcUvs[i * 2];
          uvs[(vBase + i) * 2 + 1] = srcUvs[i * 2 + 1];
        }
      }

      // Une transformation en miroir inverse l'orientation des faces : on rétablit l'ordre des sommets.
      const flip = matrix.determinant() < 0;
      const srcIndex = geometry.index ? geometry.index.array : null;
      for (let k = 0; k < indexCount; k += 3) {
        const a = srcIndex ? srcIndex[k] : k;
        const b = srcIndex ? srcIndex[k + 1] : k + 1;
        const c = srcIndex ? srcIndex[k + 2] : k + 2;
        index[iBase + k] = a + vBase;
        index[iBase + k + 1] = (flip ? c : b) + vBase;
        index[iBase + k + 2] = (flip ? b : c) + vBase;
      }

      // La fermeture ne dépend que de la topologie : calculée une fois par géométrie source.
      let closed = closedCache.get(geometry);
      if (closed === undefined) {
        const part: MeshPart = {
          positions: srcPositions,
          index: srcIndex ?? Uint32Array.from({ length: indexCount }, (_, k) => k),
          start: 0,
          count: indexCount,
        };
        closed = isClosed([part]);
        closedCache.set(geometry, closed);
      }
      // Seules les pièces opaques comptent : ce sont elles que le remplissage des coupes dessine.
      if (!material.transparent) {
        if (!closed) maybeOpen[element] = 1;
        pieceCount[element]++;
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

    let material = materials.get(source.key);
    if (!material) {
      material = new MeshLambertMaterial({
        vertexColors: true,
        side: source.doubleSided ? DoubleSide : FrontSide,
        transparent: source.transparent,
        depthWrite: !source.transparent,
        map: source.map,
        alphaTest: source.alphaTest,
      });
      applyElementState(material, state, selectColor);
      materials.set(source.key, material);
      if (source.map) {
        // Les coordonnées de texture ont été recopiées dans l'attribut `uv` du lot, quel que soit
        // le jeu d'origine (TEXCOORD_1, _2…).
        source.map.channel = 0;
        keptTextures.add(source.map);
      }
    }

    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    if (source.transparent) {
      mesh.layers.set(TRANSPARENT_LAYER);
      mesh.renderOrder = 1;
    }
    group.add(mesh);
    chunks.push({ mesh, positions, index, transparent: source.transparent, doubleSided: source.doubleSided });
    triangleCount += indexTotal / 3;
  }

  // Les éléments très détaillés reçoivent des blocs de triangles pour accélérer le lancer de rayon.
  for (const list of ranges) {
    for (const range of list) {
      const chunk = chunks[range.chunk];
      range.blocks = buildBlocks(chunk.positions, chunk.index, range.start, range.count);
    }
  }

  // Un élément réparti sur plusieurs géométries ouvertes peut tout de même former un solide fermé.
  for (let i = 0; i < elementCount; i++) {
    if (!maybeOpen[i]) continue;
    if (pieceCount[i] === 1) {
      state.setOpen(i, true);
      continue;
    }
    const parts = ranges[i]
      .filter((range) => !chunks[range.chunk].transparent)
      .map((range) => ({
        positions: chunks[range.chunk].positions,
        index: chunks[range.chunk].index,
        start: range.start,
        count: range.count,
      }));
    state.setOpen(i, !isClosed(parts));
  }

  // Les textures que l'affichage n'utilise pas (normales, rugosité…) sont libérées tout de suite.
  for (const material of materialCache.keys()) {
    for (const value of Object.values(material)) {
      const texture = value as Texture | null;
      if (texture?.isTexture && !keptTextures.has(texture)) {
        (texture.image as { close?: () => void } | null)?.close?.();
        texture.dispose();
      }
    }
  }

  const box = new Box3();
  for (let i = 0; i < elementCount; i++) {
    const at = i * 6;
    if (boxes[at] > boxes[at + 3]) continue;
    box.min.set(Math.min(box.min.x, boxes[at]), Math.min(box.min.y, boxes[at + 1]), Math.min(box.min.z, boxes[at + 2]));
    box.max.set(Math.max(box.max.x, boxes[at + 3]), Math.max(box.max.y, boxes[at + 4]), Math.max(box.max.z, boxes[at + 5]));
  }

  // Priorité d'affichage : plus un élément est petit par rapport au modèle, plus il passe devant
  // quand ses faces se confondent avec celles d'un autre. Une poutre noyée reste ainsi visible
  // à la surface de la dalle qui la contient.
  const modelDiagonal = box.isEmpty() ? 1 : box.getSize(new Vector3()).length() || 1;
  for (let i = 0; i < elementCount; i++) {
    const at = i * 6;
    if (boxes[at] > boxes[at + 3]) continue;
    const diagonal = Math.hypot(boxes[at + 3] - boxes[at], boxes[at + 4] - boxes[at + 1], boxes[at + 5] - boxes[at + 2]);
    state.setPriority(i, diagonal > 0 ? -Math.log2(diagonal / modelDiagonal) : 7);
  }
  state.commit();

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

  return new Model({
    group,
    chunks,
    keys,
    names,
    extras,
    boxes,
    ranges,
    state,
    box,
    offset,
    triangleCount,
    materials: [...materials.values()],
    textures: [...keptTextures],
    stencilBack: stencilMaterial(BackSide, IncrementWrapStencilOp),
    stencilFront: stencilMaterial(FrontSide, DecrementWrapStencilOp),
    selectColor,
  });
}
