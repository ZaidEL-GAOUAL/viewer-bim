import type { IndexArray } from './meshMath.ts';

/** Nombre de triangles par bloc. */
export const BLOCK_TRIANGLES = 256;
/** En dessous de ce nombre de triangles, la boîte de l'élément suffit à filtrer les rayons. */
const MIN_TRIANGLES = BLOCK_TRIANGLES * 2;

// Écarte les 10 bits d'un entier pour en intercaler deux autres (code de Morton à 30 bits).
function spread(value: number): number {
  let x = value & 0x3ff;
  x = (x | (x << 16)) & 0x30000ff;
  x = (x | (x << 8)) & 0x300f00f;
  x = (x | (x << 4)) & 0x30c30c3;
  x = (x | (x << 2)) & 0x9249249;
  return x;
}

/** Tri par base (trois passes de 10 bits) : renvoie l'ordre des indices, en temps linéaire. */
function sortByKey(keys: Uint32Array): Uint32Array {
  const n = keys.length;
  let order = new Uint32Array(n);
  let next = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const counts = new Uint32Array(1024);
  for (let shift = 0; shift < 30; shift += 10) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[(keys[order[i]] >>> shift) & 1023]++;
    let sum = 0;
    for (let bucket = 0; bucket < 1024; bucket++) {
      const count = counts[bucket];
      counts[bucket] = sum;
      sum += count;
    }
    for (let i = 0; i < n; i++) {
      const item = order[i];
      next[counts[(keys[item] >>> shift) & 1023]++] = item;
    }
    [order, next] = [next, order];
  }
  return order;
}

/**
 * Accélère le lancer de rayon sur un élément très détaillé. Les triangles de la plage sont
 * réordonnés pour que des triangles voisins dans l'espace le soient aussi dans le tampon (courbe
 * de Morton), puis regroupés par blocs de 256 dont on garde la boîte englobante. Un rayon ne
 * teste alors que les triangles des quelques blocs qu'il traverse.
 *
 * Modifie l'ordre des triangles dans `index` (sans effet sur l'affichage) et renvoie les boîtes
 * des blocs (minX, minY, minZ, maxX, maxY, maxZ), ou `null` si la plage est trop petite.
 */
export function buildBlocks(positions: Float32Array, index: IndexArray, start: number, count: number): Float32Array | null {
  const triCount = Math.floor(count / 3);
  if (triCount < MIN_TRIANGLES) return null;

  // Centres des triangles (multipliés par 3, ce qui ne change pas leur ordre) et leurs bornes.
  const centres = new Float32Array(triCount * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const k = start + t * 3;
    const a = index[k] * 3, b = index[k + 1] * 3, c = index[k + 2] * 3;
    const x = positions[a] + positions[b] + positions[c];
    const y = positions[a + 1] + positions[b + 1] + positions[c + 1];
    const z = positions[a + 2] + positions[b + 2] + positions[c + 2];
    centres[t * 3] = x;
    centres[t * 3 + 1] = y;
    centres[t * 3 + 2] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  // Même échelle sur les trois axes : les cellules restent cubiques, et un objet plat (dalle,
  // mur, terrain) est découpé dans son plan plutôt que dans son épaisseur.
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const scale = extent > 0 ? 1023 / extent : 0;

  const keys = new Uint32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const qx = Math.round((centres[t * 3] - minX) * scale);
    const qy = Math.round((centres[t * 3 + 1] - minY) * scale);
    const qz = Math.round((centres[t * 3 + 2] - minZ) * scale);
    keys[t] = (spread(qx) | (spread(qy) << 1) | (spread(qz) << 2)) >>> 0;
  }
  const order = sortByKey(keys);

  const source = index.slice(start, start + triCount * 3);
  const blockCount = Math.ceil(triCount / BLOCK_TRIANGLES);
  const boxes = new Float32Array(blockCount * 6);
  for (let block = 0; block < blockCount; block++) {
    boxes.fill(Infinity, block * 6, block * 6 + 3);
    boxes.fill(-Infinity, block * 6 + 3, block * 6 + 6);
  }
  for (let i = 0; i < triCount; i++) {
    const from = order[i] * 3;
    const to = start + i * 3;
    const at = Math.floor(i / BLOCK_TRIANGLES) * 6;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = source[from + corner];
      index[to + corner] = vertex;
      const v = vertex * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      if (x < boxes[at]) boxes[at] = x;
      if (y < boxes[at + 1]) boxes[at + 1] = y;
      if (z < boxes[at + 2]) boxes[at + 2] = z;
      if (x > boxes[at + 3]) boxes[at + 3] = x;
      if (y > boxes[at + 4]) boxes[at + 4] = y;
      if (z > boxes[at + 5]) boxes[at + 5] = z;
    }
  }
  return boxes;
}
