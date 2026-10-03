// Boîte paramétrique (mur provisoire, réservation, zone…) : six faces à normales plates,
// orientée par une rotation autour de la verticale, en coordonnées du projet.

export interface BoxSpec {
  /** Dimensions en mètres : X, Y (hauteur), Z. */
  size: [number, number, number];
  /** Centre en coordonnées du projet. */
  center: [number, number, number];
  /** Rotation autour de l'axe vertical, en degrés (sens trigonométrique vu de dessus). */
  rotation?: number;
}

export interface BoxMesh {
  positions: Float32Array;
  normals: Float32Array;
  index: Uint16Array;
}

// Chaque face : sa normale et ses quatre coins (dans le repère unitaire), dans l'ordre antihoraire vu de l'extérieur.
const FACES: { normal: [number, number, number]; corners: [number, number, number][] }[] = [
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

/** Maillage d'une boîte, positions déjà décalées de `offset` (le recentrage du modèle). */
export function boxMesh(spec: BoxSpec, offset: [number, number, number] = [0, 0, 0]): BoxMesh {
  const [sx, sy, sz] = spec.size.map((value) => Math.max(1e-4, Math.abs(value)) / 2);
  const angle = ((spec.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const positions = new Float32Array(24 * 3);
  const normals = new Float32Array(24 * 3);
  const index = new Uint16Array(36);
  let v = 0;
  let i = 0;
  for (const face of FACES) {
    const base = v;
    // Rotation autour de Y : (x, z) → (x cos + z sin, -x sin + z cos).
    const nx = face.normal[0] * cos + face.normal[2] * sin;
    const nz = -face.normal[0] * sin + face.normal[2] * cos;
    for (const [cx, cy, cz] of face.corners) {
      const x = cx * sx;
      const z = cz * sz;
      positions[v * 3] = x * cos + z * sin + spec.center[0] - offset[0];
      positions[v * 3 + 1] = cy * sy + spec.center[1] - offset[1];
      positions[v * 3 + 2] = -x * sin + z * cos + spec.center[2] - offset[2];
      normals[v * 3] = nx;
      normals[v * 3 + 1] = face.normal[1];
      normals[v * 3 + 2] = nz;
      v++;
    }
    index[i++] = base;
    index[i++] = base + 1;
    index[i++] = base + 2;
    index[i++] = base;
    index[i++] = base + 2;
    index[i++] = base + 3;
  }
  return { positions, normals, index };
}
