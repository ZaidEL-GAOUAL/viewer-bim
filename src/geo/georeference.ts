// Position de la maquette sur Terre. Le modèle est en coordonnées du projet (IFC : X vers l'est
// du projet, Y vers son nord, Z vers le haut, en mètres) ; le géoréférencement dit où est un point
// de ce repère (l'origine du site) en latitude/longitude, et où pointe le nord vrai.
// Le viewer, lui, travaille dans le repère glTF recentré : (x, y, z) glTF = (x, z, −y) IFC, moins
// un décalage (voir Model.offset). Les fonctions ci-dessous font ces conversions.

export interface Georeference {
  latitude: number;
  longitude: number;
  /** Altitude de l'origine du site, en mètres. */
  elevation: number;
  /** Point du repère du projet (IFC, mètres) qui est à cette latitude/longitude. */
  origin: [number, number, number];
  /** Direction du nord vrai dans le plan XY du projet (vecteur unitaire). */
  trueNorth: [number, number];
  /** D'où vient la position : « IfcSite », « manuel »… */
  source?: string;
}

export type Enu = [number, number, number];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function triple(value: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(finite) ? [value[0], value[1], value[2]] : fallback;
}

/** Lecture tolérante du bloc `georeference` du JSON ; null s'il est absent ou inutilisable. */
export function parseGeoreference(raw: unknown): Georeference | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const latitude = record.latitude, longitude = record.longitude;
  if (!finite(latitude) || !finite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  let trueNorth: [number, number] = [0, 1];
  if (Array.isArray(record.trueNorth) && record.trueNorth.length === 2 && record.trueNorth.every(finite)) {
    const [x, y] = record.trueNorth as [number, number];
    const length = Math.hypot(x, y);
    if (length > 0) trueNorth = [x / length, y / length];
  } else if (finite(record.rotation)) {
    trueNorth = trueNorthFromAzimuth(record.rotation);
  }
  return {
    latitude,
    longitude,
    elevation: finite(record.elevation) ? record.elevation : 0,
    origin: triple(record.origin, [0, 0, 0]),
    trueNorth,
    ...(typeof record.source === 'string' ? { source: record.source } : {}),
  };
}

export function georeferenceToJson(georeference: Georeference): Record<string, unknown> {
  const out: Record<string, unknown> = {
    latitude: georeference.latitude,
    longitude: georeference.longitude,
    elevation: georeference.elevation,
    origin: georeference.origin,
    trueNorth: georeference.trueNorth,
    rotation: azimuthOf(georeference.trueNorth),
  };
  if (georeference.source) out.source = georeference.source;
  return out;
}

/** Angle du nord vrai mesuré depuis le +Y du projet, en degrés, positif dans le sens horaire. */
export function azimuthOf(trueNorth: [number, number]): number {
  const degrees = (Math.atan2(trueNorth[0], trueNorth[1]) * 180) / Math.PI;
  return Number(degrees.toFixed(6));
}

export function trueNorthFromAzimuth(degrees: number): [number, number] {
  const angle = (degrees * Math.PI) / 180;
  return [Math.sin(angle), Math.cos(angle)];
}

/** Point du repère du viewer (glTF recentré) → est, nord, haut en mètres depuis l'origine du site. */
export function localToEnu(point: ArrayLike<number>, offset: ArrayLike<number>, georeference: Georeference): Enu {
  const [nx, ny] = georeference.trueNorth;
  const dx = point[0] + offset[0] - georeference.origin[0];
  const dy = -(point[2] + offset[2]) - georeference.origin[1];
  const dz = point[1] + offset[1] - georeference.origin[2];
  // « + 0 » : jamais de zéro négatif dans les résultats.
  return [dx * ny - dy * nx + 0, dx * nx + dy * ny + 0, dz + 0];
}

/** Inverse de `localToEnu`. */
export function enuToLocal(enu: ArrayLike<number>, offset: ArrayLike<number>, georeference: Georeference): [number, number, number] {
  const [nx, ny] = georeference.trueNorth;
  const dx = enu[0] * ny + enu[1] * nx + georeference.origin[0];
  const dy = -enu[0] * nx + enu[1] * ny + georeference.origin[1];
  const dz = enu[2] + georeference.origin[2];
  return [dx - offset[0] + 0, dz - offset[1] + 0, -dy - offset[2] + 0];
}

/** Vecteur (direction) du repère est-nord-haut → repère du viewer. */
export function enuVectorToLocal(enu: ArrayLike<number>, georeference: Georeference): [number, number, number] {
  const [nx, ny] = georeference.trueNorth;
  const dx = enu[0] * ny + enu[1] * nx;
  const dy = -enu[0] * nx + enu[1] * ny;
  return [dx + 0, enu[2] + 0, -dy + 0];
}

/** Lecture d'une latitude ou longitude IFC : (degrés, minutes, secondes, millionièmes de seconde). */
export function degreesFromIfc(parts: ArrayLike<number> | null | undefined): number | null {
  if (!parts || parts.length < 3 || !Array.from(parts).every(finite)) return null;
  const sign = parts[0] < 0 || Object.is(parts[0], -0) ? -1 : 1;
  const [d, m, s] = [Math.abs(parts[0]), Math.abs(parts[1]), Math.abs(parts[2])];
  const micro = parts.length > 3 ? Math.abs(parts[3]) : 0;
  return sign * (d + m / 60 + (s + micro / 1e6) / 3600);
}
