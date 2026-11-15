// Une maquette BIM posée sur le site de l'étude : sa géométrie déjà cuite par le viewer (les lots de `Model`, tableaux
// tels quels, sans texture), gardée dans ce navigateur (IndexedDB) et redessinée ici sans relire le fichier ; et où la
// poser : par sa géoréférence quand elle en a une, sinon au centre du terrain. Repère de la scène de l'étude : x = est,
// y = haut, z = −nord ; celui de la maquette est le repère glTF recentré du viewer (x, y vers le haut, z), à `offset` près.

import type { Model } from '../engine/Model.ts';
import { azimuthOf, type Georeference } from '../geo/georeference.ts';
import { groundAt, toEnu } from './context.ts';
import { centroid } from './massing.ts';
import type { Study } from './study.ts';

type Floats = Float32Array;
type Ints = Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array;

export interface ModelPart {
  positions: Floats;
  /** Normales et couleurs (RVBA) telles que les lots les portent : entiers normalisés ou flottants. */
  normals: Floats | Ints;
  colors: Floats | Ints | null;
  index: Uint16Array | Uint32Array;
  transparent: boolean;
  doubleSided: boolean;
}

export interface ModelSnapshot {
  id: string;
  name: string;
  parts: ModelPart[];
  /** Boîte de la maquette dans son repère (minX, minY, minZ, maxX, maxY, maxZ). */
  box: [number, number, number, number, number, number];
  /** `Model.offset` : ce qui a été retiré des coordonnées pour recentrer la maquette. */
  offset: [number, number, number];
  georeference: Georeference | null;
  triangles: number;
}

/** La géométrie d'un modèle du viewer, sans copie (les tableaux des lots sont repris tels quels). */
export function snapshotOf(model: Model, name: string, georeference: Georeference | null, id: string = crypto.randomUUID()): ModelSnapshot {
  const parts: ModelPart[] = model.chunks.map((chunk) => {
    const geometry = chunk.mesh.geometry;
    const color = geometry.getAttribute('color');
    return {
      positions: chunk.positions,
      normals: geometry.getAttribute('normal').array as Floats | Ints,
      colors: color ? (color.array as Floats | Ints) : null,
      index: chunk.index as Uint16Array | Uint32Array,
      transparent: chunk.transparent,
      doubleSided: chunk.doubleSided,
    };
  });
  const { min, max } = model.box;
  return {
    id, name, parts,
    box: [min.x, min.y, min.z, max.x, max.y, max.z],
    offset: [model.offset.x, model.offset.y, model.offset.z],
    georeference: georeference ? { ...georeference, origin: [...georeference.origin], trueNorth: [...georeference.trueNorth] } : null,
    triangles: model.triangleCount,
  };
}

export interface Placement {
  east: number;
  north: number;
  up: number;
  /** Degrés, sens trigonométrique vu du dessus. */
  rotation: number;
}

/** Au-delà de cette distance de l'origine du site (m), une géoréférence est jugée hors sujet : la maquette va au centre. */
export const MAX_GEOREFERENCE_DISTANCE = 5000;

/**
 * Où poser la maquette. Par sa géoréférence : un point p du repère de la maquette est, en est-nord-haut autour de son
 * origine géoréférencée, la rotation du nord vrai appliquée à (p + offset − origine) — voir `localToEnu` —, puis cette
 * origine est ramenée dans le repère du site. Sans géoréférence (ou trop loin) : le centre de sa boîte au-dessus du
 * centre du terrain (de l'origine du site tant qu'il n'est pas tracé), son dessous au sol.
 */
export function placementFor(snapshot: Pick<ModelSnapshot, 'box' | 'offset' | 'georeference'>, study: Pick<Study, 'site' | 'context'>): { placement: Placement; georeferenced: boolean; distance: number } {
  const g = snapshot.georeference;
  const [minX, minY, minZ, maxX, , maxZ] = snapshot.box;
  const [ce, cn] = study.site.limit.length >= 3 ? centroid(study.site.limit) : [0, 0];
  // « + 0 » : jamais de zéro négatif.
  const centred: Placement = { east: ce - (minX + maxX) / 2 + 0, north: cn + (minZ + maxZ) / 2 + 0, up: groundAt(study, ce, cn) - minY + 0, rotation: 0 };
  if (!g) return { placement: centred, georeferenced: false, distance: 0 };
  const [ox, oy, oz] = snapshot.offset;
  const rotation = azimuthOf(g.trueNorth);
  const [nx, ny] = g.trueNorth;
  // Repère du projet (IFC) : x vers l'est du projet, y vers son nord, z vers le haut ; glTF (x, y, z) = (x, z, −y).
  const dx = ox - g.origin[0], dy = -oz - g.origin[1], dz = oy - g.origin[2];
  const [de, dn] = toEnu(study.site.origin, g.longitude, g.latitude);
  const placement: Placement = {
    east: dx * ny - dy * nx + de,
    north: dx * nx + dy * ny + dn,
    up: dz + g.elevation - study.site.origin.altitude,
    rotation,
  };
  const distance = Math.hypot(placement.east, placement.north);
  return distance > MAX_GEOREFERENCE_DISTANCE ? { placement: centred, georeferenced: false, distance } : { placement, georeferenced: true, distance };
}
