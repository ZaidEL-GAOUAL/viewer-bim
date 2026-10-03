import { BufferAttribute, BufferGeometry, DoubleSide, FrontSide, Mesh, MeshLambertMaterial, Vector3, type Box3, type Color, type Group, type IUniform, type Material, type Ray, type Texture } from 'three';
import { FLAG_OPEN, applyElementState, depthPriority, type ElementState } from './elementState.ts';
import type { IndexArray, MeshPart } from './meshMath.ts';
import { BLOCK_TRIANGLES } from './triangleBlocks.ts';

/** Un lot de géométrie fusionnée : un seul appel de dessin pour de nombreux éléments. */
export interface Chunk {
  mesh: Mesh;
  positions: Float32Array;
  index: IndexArray;
  transparent: boolean;
  /** Matériau à double face : l'envers des triangles est affiché, donc cliquable. */
  doubleSided: boolean;
}

/** Plage de triangles d'un élément dans le tampon d'index d'un lot. */
export interface ElementRange {
  chunk: number;
  start: number;
  count: number;
  /** Boîtes englobantes par bloc de triangles, pour les plages très détaillées (voir triangleBlocks). */
  blocks: Float32Array | null;
}

export interface PickHit {
  element: number;
  distance: number;
  point: Vector3;
  /** Normale de la face touchée, orientée vers l'observateur. */
  normal: Vector3;
  chunk: number;
  /** Position du triangle touché dans le tampon d'index du lot. */
  tri: number;
  /** Vrai si le rayon a touché l'envers d'une face (intérieur d'un solide coupé, par exemple). */
  backface: boolean;
  /** Vrai si le point a été ramené sur la section d'un plan de coupe (voir Viewer.pick). */
  cap: boolean;
}

/** Une pièce de géométrie d'un élément ajouté au modèle (voir Model.addElement). */
export interface NewPart {
  /** Positions recentrées (coordonnées du projet moins `Model.offset`). */
  positions: Float32Array;
  /** Normales unitaires, en flottants ou déjà quantifiées sur 8 bits. */
  normals: Float32Array | Int8Array;
  /** Couleur sRGB (RVBA, 0 à 255) par sommet ; une seule couleur vaut pour tous. */
  colors: Uint8Array;
  index: IndexArray;
  transparent: boolean;
  doubleSided: boolean;
}

export interface NewElement {
  key: string;
  name: string;
  extras?: Record<string, unknown>;
  parts: NewPart[];
  /** Vrai si le maillage est un solide fermé (remplissage des coupes). */
  closed: boolean;
}

export interface ModelData {
  group: Group;
  chunks: Chunk[];
  keys: string[];
  names: string[];
  extras: (Record<string, unknown> | undefined)[];
  boxes: Float32Array;
  ranges: ElementRange[][];
  state: ElementState;
  box: Box3;
  offset: Vector3;
  triangleCount: number;
  materials: Material[];
  textures: Texture[];
  stencilBack: Material;
  stencilFront: Material;
  selectColor: IUniform<Color>;
}

export interface RaycastOptions {
  /** Renvoie vrai pour un point retiré par un plan de coupe. */
  clipped?: (x: number, y: number, z: number) => boolean;
  /**
   * L'envers d'une face n'est pas affiché sur un matériau à simple face : il est donc ignoré.
   * Exception, activée ici : l'envers des solides fermés, vu à travers une section remplie.
   */
  capBackfaces?: boolean;
  /** Ignore tout ce qui est plus proche que cette distance. */
  minDistance?: number;
}

interface Candidate {
  element: number;
  t: number;
}

const DET_EPSILON = 1e-14;
const BLOCK_INDICES = BLOCK_TRIANGLES * 3;

/**
 * Intersection d'un rayon avec une boîte (minX, minY, minZ, maxX, maxY, maxZ rangés à `at`).
 * Renvoie la distance d'entrée (0 si l'origine est dans la boîte), ou -1 si le rayon la manque.
 * `ix`, `iy`, `iz` sont les inverses de la direction.
 */
function slab(
  boxes: Float32Array, at: number,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ix: number, iy: number, iz: number,
): number {
  let tmin = 0;
  let tmax = Infinity;
  if (dx !== 0) {
    const t1 = (boxes[at] - ox) * ix, t2 = (boxes[at + 3] - ox) * ix;
    if (t1 < t2) { if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
    else { if (t2 > tmin) tmin = t2; if (t1 < tmax) tmax = t1; }
  } else if (ox < boxes[at] || ox > boxes[at + 3]) return -1;
  if (dy !== 0) {
    const t1 = (boxes[at + 1] - oy) * iy, t2 = (boxes[at + 4] - oy) * iy;
    if (t1 < t2) { if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
    else { if (t2 > tmin) tmin = t2; if (t1 < tmax) tmax = t1; }
  } else if (oy < boxes[at + 1] || oy > boxes[at + 4]) return -1;
  if (dz !== 0) {
    const t1 = (boxes[at + 2] - oz) * iz, t2 = (boxes[at + 5] - oz) * iz;
    if (t1 < t2) { if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
    else { if (t2 > tmin) tmin = t2; if (t1 < tmax) tmax = t1; }
  } else if (oz < boxes[at + 2] || oz > boxes[at + 5]) return -1;
  return tmin <= tmax ? tmin : -1;
}

export class Model {
  readonly group: Group;
  readonly chunks: Chunk[];
  /** Nombre d'éléments ; grandit avec `addElement`, revient en arrière avec `removeFrom`. */
  count: number;
  /** Nombre d'éléments du fichier chargé : ceux d'après ont été ajoutés dans le viewer. */
  readonly originalCount: number;
  /** Identifiant de liaison avec les métadonnées, pour chaque élément. */
  readonly keys: string[];
  readonly names: string[];
  /** `extras` du nœud glTF (hors identifiant), utilisés si aucun JSON n'est fourni. */
  readonly extras: (Record<string, unknown> | undefined)[];
  /** Boîtes englobantes des éléments : minX, minY, minZ, maxX, maxY, maxZ. */
  boxes: Float32Array;
  readonly ranges: ElementRange[][];
  readonly state: ElementState;
  readonly box: Box3;
  /** Décalage retiré aux coordonnées d'origine pour recentrer le modèle (précision des flottants). */
  readonly offset: Vector3;
  triangleCount: number;
  readonly stencilBack: Material;
  readonly stencilFront: Material;
  private readonly materials: Material[];
  private readonly textures: Texture[];
  private readonly selectColor: IUniform<Color>;
  private readonly candidates: Candidate[] = [];
  /** Diagonale du modèle au chargement : référence des priorités d'affichage. */
  private readonly diagonal: number;

  constructor(data: ModelData) {
    this.group = data.group;
    this.chunks = data.chunks;
    this.count = data.keys.length;
    this.originalCount = this.count;
    this.keys = data.keys;
    this.names = data.names;
    this.extras = data.extras;
    this.boxes = data.boxes;
    this.ranges = data.ranges;
    this.state = data.state;
    this.box = data.box;
    this.offset = data.offset;
    this.triangleCount = data.triangleCount;
    this.materials = data.materials;
    this.textures = data.textures;
    this.stencilBack = data.stencilBack;
    this.stencilFront = data.stencilFront;
    this.selectColor = data.selectColor;
    this.diagonal = data.box.isEmpty() ? 1 : data.box.getSize(new Vector3()).length() || 1;
  }

  // ------------------------------------------------------------- modifications

  /** Déplace des éléments d'un même vecteur : sommets, boîtes et blocs suivent. */
  translate(indices: Iterable<number>, dx: number, dy: number, dz: number): void {
    const touched = new Set<number>();
    for (const index of indices) {
      const at = index * 6;
      if (this.boxes[at] > this.boxes[at + 3]) continue;
      for (const range of this.ranges[index]) {
        const chunk = this.chunks[range.chunk];
        const { positions, index: indexArray } = chunk;
        // Un sommet partagé par plusieurs triangles ne bouge qu'une fois.
        const moved = touched.has(range.chunk) ? this.movedOf(range.chunk) : this.movedOf(range.chunk, true);
        for (let k = range.start, end = range.start + range.count; k < end; k++) {
          const v = indexArray[k];
          if (moved[v]) continue;
          moved[v] = 1;
          positions[v * 3] += dx;
          positions[v * 3 + 1] += dy;
          positions[v * 3 + 2] += dz;
        }
        if (range.blocks) {
          for (let b = 0; b < range.blocks.length; b += 6) {
            range.blocks[b] += dx;
            range.blocks[b + 1] += dy;
            range.blocks[b + 2] += dz;
            range.blocks[b + 3] += dx;
            range.blocks[b + 4] += dy;
            range.blocks[b + 5] += dz;
          }
        }
        touched.add(range.chunk);
      }
      this.boxes[at] += dx;
      this.boxes[at + 1] += dy;
      this.boxes[at + 2] += dz;
      this.boxes[at + 3] += dx;
      this.boxes[at + 4] += dy;
      this.boxes[at + 5] += dz;
    }
    for (const chunkIndex of touched) {
      const geometry = this.chunks[chunkIndex].mesh.geometry;
      (geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      this.movedScratch.delete(chunkIndex);
    }
    this.recomputeBox();
  }

  private readonly movedScratch = new Map<number, Uint8Array>();

  private movedOf(chunk: number, reset = false): Uint8Array {
    let moved = this.movedScratch.get(chunk);
    const size = this.chunks[chunk].positions.length / 3;
    if (!moved || moved.length !== size) {
      moved = new Uint8Array(size);
      this.movedScratch.set(chunk, moved);
    } else if (reset) moved.fill(0);
    return moved;
  }

  /** Matériau du modèle pour une pièce ajoutée : celui des lots équivalents, ou un nouveau. */
  materialFor(transparent: boolean, doubleSided: boolean): Material {
    for (const chunk of this.chunks) {
      const material = chunk.mesh.material as MeshLambertMaterial;
      if (chunk.transparent === transparent && chunk.doubleSided === doubleSided && !material.map) return material;
    }
    const material = new MeshLambertMaterial({
      vertexColors: true,
      side: doubleSided ? DoubleSide : FrontSide,
      transparent,
      depthWrite: !transparent,
    });
    applyElementState(material, this.state, this.selectColor);
    this.materials.push(material);
    return material;
  }

  /** Ajoute un élément (un lot par pièce) à la fin du modèle et renvoie son indice. */
  addElement(element: NewElement): number {
    const index = this.count;
    if ((index + 1) * 6 > this.boxes.length) {
      const grown = new Float32Array(Math.max((index + 1) * 6, this.boxes.length * 2));
      grown.set(this.boxes);
      this.boxes = grown;
    }
    this.state.grow(index + 1);
    const at = index * 6;
    this.boxes.fill(Infinity, at, at + 3);
    this.boxes.fill(-Infinity, at + 3, at + 6);
    const ranges: ElementRange[] = [];
    for (const part of element.parts) {
      const vertexCount = part.positions.length / 3;
      const normals = part.normals instanceof Int8Array ? part.normals : Int8Array.from(part.normals, (n) => Math.round(n * 127));
      const colors = part.colors.length === vertexCount * 4 ? part.colors : new Uint8Array(vertexCount * 4);
      if (colors !== part.colors) for (let i = 0; i < vertexCount; i++) colors.set(part.colors.subarray(0, 4), i * 4);
      const ids = new Float32Array(vertexCount).fill(index);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(part.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(normals, 3, true));
      geometry.setAttribute('color', new BufferAttribute(colors, 4, true));
      geometry.setAttribute('aElement', new BufferAttribute(ids, 1));
      geometry.setIndex(new BufferAttribute(part.index, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, this.materialFor(part.transparent, part.doubleSided));
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.chunks.push({ mesh, positions: part.positions, index: part.index, transparent: part.transparent, doubleSided: part.doubleSided });
      ranges.push({ chunk: this.chunks.length - 1, start: 0, count: part.index.length, blocks: null });
      this.triangleCount += part.index.length / 3;
      for (let i = 0; i < part.positions.length; i += 3) {
        const x = part.positions[i], y = part.positions[i + 1], z = part.positions[i + 2];
        if (x < this.boxes[at]) this.boxes[at] = x;
        if (y < this.boxes[at + 1]) this.boxes[at + 1] = y;
        if (z < this.boxes[at + 2]) this.boxes[at + 2] = z;
        if (x > this.boxes[at + 3]) this.boxes[at + 3] = x;
        if (y > this.boxes[at + 4]) this.boxes[at + 4] = y;
        if (z > this.boxes[at + 5]) this.boxes[at + 5] = z;
      }
    }
    this.keys.push(element.key);
    this.names.push(element.name);
    this.extras.push(element.extras);
    this.ranges.push(ranges);
    this.count = index + 1;
    this.state.setOpen(index, !element.closed);
    const diagonal = Math.hypot(this.boxes[at + 3] - this.boxes[at], this.boxes[at + 4] - this.boxes[at + 1], this.boxes[at + 5] - this.boxes[at + 2]);
    this.state.setPriority(index, diagonal > 0 ? -Math.log2(diagonal / this.diagonal) : 7);
    this.state.commit();
    this.recomputeBox();
    return index;
  }

  /** Retire les éléments ajoutés à partir de `count` (jamais ceux du fichier chargé). */
  removeFrom(count: number): void {
    const from = Math.max(count, this.originalCount);
    if (from >= this.count) return;
    const firstChunk = this.ranges[from][0]?.chunk ?? this.chunks.length;
    for (const chunk of this.chunks.splice(firstChunk)) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      this.triangleCount -= chunk.index.length / 3;
    }
    this.keys.length = from;
    this.names.length = from;
    this.extras.length = from;
    this.ranges.length = from;
    this.count = from;
    this.state.shrink(from);
    this.recomputeBox();
  }

  /** Copie la géométrie d'un élément, décalée, sous la forme attendue par `addElement`. */
  copyParts(index: number, dx: number, dy: number, dz: number): NewPart[] {
    const parts: NewPart[] = [];
    for (const range of this.ranges[index]) {
      const chunk = this.chunks[range.chunk];
      const geometry = chunk.mesh.geometry;
      const srcNormals = geometry.getAttribute('normal').array as Int8Array;
      const srcColors = geometry.getAttribute('color').array as Uint8Array;
      const remap = new Map<number, number>();
      const order: number[] = [];
      const indexArray = new Uint32Array(range.count);
      for (let k = 0; k < range.count; k++) {
        const v = chunk.index[range.start + k];
        let local = remap.get(v);
        if (local === undefined) {
          local = order.length;
          remap.set(v, local);
          order.push(v);
        }
        indexArray[k] = local;
      }
      const positions = new Float32Array(order.length * 3);
      const normals = new Int8Array(order.length * 3);
      const colors = new Uint8Array(order.length * 4);
      order.forEach((v, local) => {
        positions[local * 3] = chunk.positions[v * 3] + dx;
        positions[local * 3 + 1] = chunk.positions[v * 3 + 1] + dy;
        positions[local * 3 + 2] = chunk.positions[v * 3 + 2] + dz;
        normals.set(srcNormals.subarray(v * 3, v * 3 + 3), local * 3);
        colors.set(srcColors.subarray(v * 4, v * 4 + 4), local * 4);
      });
      parts.push({ positions, normals, colors, index: indexArray, transparent: chunk.transparent, doubleSided: chunk.doubleSided });
    }
    return parts;
  }

  recomputeBox(): void {
    const box = this.box;
    box.makeEmpty();
    for (let i = 0; i < this.count; i++) {
      const at = i * 6;
      if (this.boxes[at] > this.boxes[at + 3]) continue;
      if (this.boxes[at] < box.min.x) box.min.x = this.boxes[at];
      if (this.boxes[at + 1] < box.min.y) box.min.y = this.boxes[at + 1];
      if (this.boxes[at + 2] < box.min.z) box.min.z = this.boxes[at + 2];
      if (this.boxes[at + 3] > box.max.x) box.max.x = this.boxes[at + 3];
      if (this.boxes[at + 4] > box.max.y) box.max.y = this.boxes[at + 4];
      if (this.boxes[at + 5] > box.max.z) box.max.z = this.boxes[at + 5];
    }
  }

  elementBox(index: number, target: Box3): Box3 {
    const b = this.boxes;
    const at = index * 6;
    target.min.set(b[at], b[at + 1], b[at + 2]);
    target.max.set(b[at + 3], b[at + 4], b[at + 5]);
    return target;
  }

  /** Boîte englobante d'un ensemble d'éléments. */
  boxOf(indices: Iterable<number>, target: Box3): Box3 {
    const b = this.boxes;
    target.makeEmpty();
    for (const index of indices) {
      const at = index * 6;
      if (b[at] > b[at + 3]) continue; // élément sans géométrie
      if (b[at] < target.min.x) target.min.x = b[at];
      if (b[at + 1] < target.min.y) target.min.y = b[at + 1];
      if (b[at + 2] < target.min.z) target.min.z = b[at + 2];
      if (b[at + 3] > target.max.x) target.max.x = b[at + 3];
      if (b[at + 4] > target.max.y) target.max.y = b[at + 4];
      if (b[at + 5] > target.max.z) target.max.z = b[at + 5];
    }
    return target;
  }

  /** Triangles d'un élément, sous la forme attendue par les calculs de meshMath. */
  parts(index: number): MeshPart[] {
    return this.ranges[index].map((range) => {
      const chunk = this.chunks[range.chunk];
      return { positions: chunk.positions, index: chunk.index, start: range.start, count: range.count };
    });
  }

  /** Sommets d'un triangle désigné par un `PickHit`. */
  triangle(chunk: number, tri: number, a: Vector3, b: Vector3, c: Vector3): void {
    const { positions, index } = this.chunks[chunk];
    a.fromArray(positions, index[tri] * 3);
    b.fromArray(positions, index[tri + 1] * 3);
    c.fromArray(positions, index[tri + 2] * 3);
  }

  /**
   * Lancer de rayon sans bibliothèque externe : les boîtes des éléments visibles filtrent d'abord
   * (quelques nanosecondes par élément), puis seuls les triangles des éléments traversés,
   * du plus proche au plus lointain, sont testés. Pour un élément très détaillé, ses blocs de
   * triangles filtrent une seconde fois.
   * Seul ce qui est réellement affiché peut être touché : voir `RaycastOptions`.
   */
  raycast(ray: Ray, options: RaycastOptions = {}): PickHit | null {
    const clipped = options.clipped;
    const capBackfaces = options.capBackfaces === true;
    const minDistance = Math.max(1e-9, options.minDistance ?? 0);
    const ox = ray.origin.x, oy = ray.origin.y, oz = ray.origin.z;
    const dx = ray.direction.x, dy = ray.direction.y, dz = ray.direction.z;
    const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
    const boxes = this.boxes;
    const flags = this.state.data;
    const candidates = this.candidates;
    let used = 0;

    for (let i = 0, n = this.count; i < n; i++) {
      if ((flags[i * 4 + 3] & 1) === 0) continue;
      const tmin = slab(boxes, i * 6, ox, oy, oz, dx, dy, dz, ix, iy, iz);
      if (tmin < 0) continue;
      if (used === candidates.length) candidates.push({ element: i, t: tmin });
      else {
        candidates[used].element = i;
        candidates[used].t = tmin;
      }
      used++;
    }
    if (used === 0) return null;

    const sorted = used === candidates.length ? candidates : candidates.slice(0, used);
    sorted.sort((a, b) => a.t - b.t);

    let best = Infinity;
    let bestElement = -1, bestChunk = -1, bestTri = -1;
    let bestPriority = 0;
    for (let c = 0; c < used; c++) {
      const candidate = sorted[c];
      if (candidate.t > best) break;
      for (const range of this.ranges[candidate.element]) {
        const { positions, index, doubleSided, transparent } = this.chunks[range.chunk];
        // det < 0 : le rayon arrive par l'envers du triangle. Les sections ne sont remplies que
        // pour les pièces opaques des solides fermés.
        const skipBackfaces = !doubleSided && (!capBackfaces || transparent || (flags[candidate.element * 4 + 3] & FLAG_OPEN) !== 0);
        const blocks = range.blocks;
        const end = range.start + range.count;
        const blockCount = blocks ? blocks.length / 6 : 1;
        for (let block = 0; block < blockCount; block++) {
          let from = range.start;
          let to = end;
          if (blocks) {
            // Seuls les blocs traversés par le rayon, et plus proches que le meilleur point connu.
            const entry = slab(blocks, block * 6, ox, oy, oz, dx, dy, dz, ix, iy, iz);
            if (entry < 0 || entry > best) continue;
            from = range.start + block * BLOCK_INDICES;
            to = Math.min(end, from + BLOCK_INDICES);
          }
        for (let k = from; k < to; k += 3) {
          const a = index[k] * 3, b = index[k + 1] * 3, cc = index[k + 2] * 3;
          const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
          const e1x = positions[b] - ax, e1y = positions[b + 1] - ay, e1z = positions[b + 2] - az;
          const e2x = positions[cc] - ax, e2y = positions[cc + 1] - ay, e2z = positions[cc + 2] - az;
          // Möller–Trumbore, faces avant et arrière.
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det < DET_EPSILON && (skipBackfaces || det > -DET_EPSILON)) continue;
          const inv = 1 / det;
          const sx = ox - ax, sy = oy - ay, sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (t <= minDistance) continue;
          let priority = bestPriority;
          if (bestElement >= 0) {
            const tolerance = best * 2e-6 + 1e-6;
            if (t > best + tolerance) continue;
            if (t > best - tolerance) {
              // Faces confondues de deux éléments : celui que l'affichage met devant l'emporte.
              if (candidate.element === bestElement) continue;
              priority = depthPriority(flags[candidate.element * 4 + 3], candidate.element);
              if (priority <= bestPriority) continue;
            }
          }
          if (clipped && clipped(ox + dx * t, oy + dy * t, oz + dz * t)) continue;
          if (candidate.element !== bestElement) bestPriority = depthPriority(flags[candidate.element * 4 + 3], candidate.element);
          best = t;
          bestElement = candidate.element;
          bestChunk = range.chunk;
          bestTri = k;
        }
        }
      }
    }
    if (bestElement < 0) return null;

    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    this.triangle(bestChunk, bestTri, a, b, c);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    const backface = normal.dot(ray.direction) > 0;
    if (backface) normal.negate();
    return {
      element: bestElement,
      distance: best,
      point: new Vector3(ox + dx * best, oy + dy * best, oz + dz * best),
      normal,
      chunk: bestChunk,
      tri: bestTri,
      backface,
      cap: false,
    };
  }

  dispose(): void {
    for (const chunk of this.chunks) chunk.mesh.geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.stencilBack.dispose();
    this.stencilFront.dispose();
    this.state.dispose();
    this.group.removeFromParent();
  }
}
