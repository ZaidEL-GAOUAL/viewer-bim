// Calculs géométriques purs sur des triangles indexés : surface, volume, fermeture d'un maillage,
// et recherche de la face plane autour d'un triangle. Aucune dépendance.

export type IndexArray = Uint16Array | Uint32Array;

/** Une plage de triangles dans un tampon de positions indexé. */
export interface MeshPart {
  positions: ArrayLike<number>;
  index: ArrayLike<number>;
  start: number;
  count: number;
}

export interface SolidInfo {
  volume: number;
  area: number;
  /** Vrai si le maillage est une enveloppe fermée et orientée de façon cohérente. */
  closed: boolean;
  triangles: number;
}

export interface PlanarRegion {
  area: number;
  normal: [number, number, number];
  centroid: [number, number, number];
  /** Sommets des triangles de la région, 9 nombres par triangle. */
  positions: Float32Array;
}

// Les sommets sont soudés sur une grille de 100 000 pas le long de la plus grande dimension.
// Trois coordonnées de 17 bits tiennent dans un entier exact en double précision.
const GRID = 100000;
const K1 = 2 ** 17;
const K2 = 2 ** 34;

interface Welded {
  /** Identifiant de sommet soudé pour chaque coin de triangle, dans l'ordre des parties. */
  ids: Uint32Array;
  vertexCount: number;
  extent: number;
}

function weld(parts: MeshPart[]): Welded {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let corners = 0;
  for (const { positions, index, start, count } of parts) {
    corners += count;
    for (let k = start, end = start + count; k < end; k++) {
      const v = index[k] * 3;
      const x = positions[v], y = positions[v + 1], z = positions[v + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const extent = corners > 0 ? Math.max(maxX - minX, maxY - minY, maxZ - minZ) : 0;
  const scale = extent > 0 ? GRID / extent : 0;
  const ids = new Uint32Array(corners);
  const lookup = new Map<number, number>();
  let vertexCount = 0;
  let c = 0;
  for (const { positions, index, start, count } of parts) {
    for (let k = start, end = start + count; k < end; k++) {
      const v = index[k] * 3;
      const key =
        Math.round((positions[v] - minX) * scale) * K2 +
        Math.round((positions[v + 1] - minY) * scale) * K1 +
        Math.round((positions[v + 2] - minZ) * scale);
      let id = lookup.get(key);
      if (id === undefined) {
        id = vertexCount++;
        lookup.set(key, id);
      }
      ids[c++] = id;
    }
  }
  return { ids, vertexCount, extent };
}

function isClosedShell(ids: Uint32Array, vertexCount: number): boolean {
  // Chaque arête doit être parcourue autant de fois dans un sens que dans l'autre.
  const balance = new Map<number, number>();
  let valid = 0;
  const add = (a: number, b: number) => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a;
    balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1));
  };
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t], b = ids[t + 1], c = ids[t + 2];
    if (a === b || b === c || a === c) continue;
    valid++;
    add(a, b);
    add(b, c);
    add(c, a);
  }
  if (valid === 0) return false;
  for (const value of balance.values()) if (value !== 0) return false;
  return true;
}

export function isClosed(parts: MeshPart[]): boolean {
  const { ids, vertexCount } = weld(parts);
  return isClosedShell(ids, vertexCount);
}

/** Volume (somme des tétraèdres signés), surface totale et fermeture d'un ensemble de triangles. */
export function analyzeSolid(parts: MeshPart[]): SolidInfo {
  let volume = 0;
  let area = 0;
  let triangles = 0;
  let ox = 0, oy = 0, oz = 0;
  let hasOrigin = false;
  for (const { positions, index, start, count } of parts) {
    for (let k = start, end = start + count; k + 2 < end; k += 3) {
      const a = index[k] * 3, b = index[k + 1] * 3, c = index[k + 2] * 3;
      if (!hasOrigin) {
        // Origine locale : limite les erreurs d'arrondi loin de l'origine du modèle.
        ox = positions[a];
        oy = positions[a + 1];
        oz = positions[a + 2];
        hasOrigin = true;
      }
      const ax = positions[a] - ox, ay = positions[a + 1] - oy, az = positions[a + 2] - oz;
      const bx = positions[b] - ox, by = positions[b + 1] - oy, bz = positions[b + 2] - oz;
      const cx = positions[c] - ox, cy = positions[c + 1] - oy, cz = positions[c + 2] - oz;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
      volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
      triangles++;
    }
  }
  return { volume: Math.abs(volume) / 6, area, closed: isClosed(parts), triangles };
}

/**
 * Face plane contenant un triangle : tous les triangles coplanaires reliés de proche en proche
 * au triangle de départ (par au moins un sommet commun).
 * `seedOffset` est la position du triangle dans le tampon d'index de la partie `seedPart`.
 */
export function coplanarRegion(parts: MeshPart[], seedPart: number, seedOffset: number): PlanarRegion | null {
  const { ids, vertexCount, extent } = weld(parts);
  const triCount = Math.floor(ids.length / 3);
  if (triCount === 0) return null;

  const triPart = new Uint32Array(triCount);
  const triOffset = new Uint32Array(triCount);
  let seed = -1;
  let t = 0;
  for (let p = 0; p < parts.length; p++) {
    const { start, count } = parts[p];
    for (let k = start, end = start + count; k + 2 < end; k += 3) {
      if (p === seedPart && k === seedOffset) seed = t;
      triPart[t] = p;
      triOffset[t] = k;
      t++;
    }
  }
  if (seed < 0) return null;

  // Table sommet → triangles, au format compact (décalages + liste).
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < triCount * 3; i++) offsets[ids[i] + 1]++;
  for (let i = 0; i < vertexCount; i++) offsets[i + 1] += offsets[i];
  const cursor = offsets.slice(0, vertexCount);
  const adjacency = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) adjacency[cursor[ids[i]]++] = Math.floor(i / 3);

  const tri = new Float64Array(9);
  const normal = new Float64Array(3);
  // Charge le triangle dans `tri`, sa normale unitaire dans `normal`, et renvoie le double de son aire.
  const load = (index: number): number => {
    const { positions, index: indices } = parts[triPart[index]];
    const k = triOffset[index];
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[k + corner] * 3;
      tri[corner * 3] = positions[v];
      tri[corner * 3 + 1] = positions[v + 1];
      tri[corner * 3 + 2] = positions[v + 2];
    }
    const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2];
    const vx = tri[6] - tri[0], vy = tri[7] - tri[1], vz = tri[8] - tri[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 0) {
      normal[0] = nx / length;
      normal[1] = ny / length;
      normal[2] = nz / length;
    }
    return length;
  };

  if (load(seed) === 0) return null;
  const n0x = normal[0], n0y = normal[1], n0z = normal[2];
  const d0 = n0x * tri[0] + n0y * tri[1] + n0z * tri[2];
  const cosTolerance = 0.99996; // environ 0,5°
  const distTolerance = Math.max(extent * 1e-4, 1e-9);

  const visited = new Uint8Array(triCount);
  const stack = [seed];
  visited[seed] = 1;
  const out: number[] = [];
  let area = 0;
  let cx = 0, cy = 0, cz = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const doubleArea = load(current);
    if (doubleArea === 0) continue;
    if (normal[0] * n0x + normal[1] * n0y + normal[2] * n0z < cosTolerance) continue;
    let onPlane = true;
    for (let corner = 0; corner < 9; corner += 3) {
      if (Math.abs(n0x * tri[corner] + n0y * tri[corner + 1] + n0z * tri[corner + 2] - d0) > distTolerance) onPlane = false;
    }
    if (!onPlane) continue;

    const triArea = doubleArea / 2;
    area += triArea;
    cx += (triArea * (tri[0] + tri[3] + tri[6])) / 3;
    cy += (triArea * (tri[1] + tri[4] + tri[7])) / 3;
    cz += (triArea * (tri[2] + tri[5] + tri[8])) / 3;
    for (let i = 0; i < 9; i++) out.push(tri[i]);

    for (let corner = 0; corner < 3; corner++) {
      const vertex = ids[current * 3 + corner];
      for (let a = offsets[vertex]; a < offsets[vertex + 1]; a++) {
        const neighbour = adjacency[a];
        if (!visited[neighbour]) {
          visited[neighbour] = 1;
          stack.push(neighbour);
        }
      }
    }
  }

  if (area === 0) return null;
  return {
    area,
    normal: [n0x, n0y, n0z],
    centroid: [cx / area, cy / area, cz / area],
    positions: new Float32Array(out),
  };
}
