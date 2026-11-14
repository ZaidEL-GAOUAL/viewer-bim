// Le contexte d'une étude : bâtiments voisins avec leur hauteur, et relief en grille, lus une seule fois (sur demande de
// l'utilisateur) puis gardés dans l'étude, dans le repère local (est, nord en mètres depuis l'origine du site).
//
// Les bâtiments viennent d'un `ContextProvider`. Les fournisseurs nationaux (hauteurs mesurées) sont essayés dans
// l'ordre ; s'ils échouent ou ne couvrent pas le lieu, la base mondiale (OpenStreetMap par Overpass, geo/osmBuildings.ts)
// prend le relais. Le relief vient des tuiles terrarium (geo/terrain.ts), rééchantillonnées sur une grille de 30 m.
// Près de l'antiméridien, la zone est lue en deux boîtes ; les longitudes sont ramenées autour de l'origine.

import { fetchOsmBuildings, type OsmBuilding } from '../geo/osmBuildings.ts';
import { GRID, TERRAIN_CREDIT, TILE_URL, decodeTerrarium } from '../geo/terrain.ts';
import { MAX_NEIGHBOURS, MAX_OUTLINE_POINTS, type HeightSource, type Neighbour, type Study, type StudyContext, type TerrainGrid, type XY } from './study.ts';

export interface GeoBox { south: number; west: number; north: number; east: number }
type Origin = { latitude: number; longitude: number };

export interface ProviderBuilding {
  id: string;
  /** Contour, [longitude, latitude] en degrés. */
  outline: [number, number][];
  height: number;
  heightSource: HeightSource;
}

/** Une source de bâtiments avec hauteurs pour une boîte ; `null` : pas de couverture ici. */
export interface ContextProvider {
  readonly name: string;
  /** Attribution, écrite dans l'étude. */
  readonly credit: string;
  buildings(box: GeoBox, signal?: AbortSignal): Promise<ProviderBuilding[] | null>;
}

/** Une source de relief en tuiles Web Mercator : une grille GRID × GRID de hauteurs (m) par tuile, rangée 0 au nord. */
export interface TerrainSource {
  readonly credit: string;
  readonly zoom: number;
  tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array>;
}

export const OSM_CREDIT = 'Bâtiments : © les contributeurs d’OpenStreetMap (ODbL), lus par Overpass';
/** Pas de la grille de relief (m) : les tuiles gratuites valent environ 30 m. */
const TERRAIN_STEP = 30;

// Ellipsoïde WGS84 : rayons de courbure méridien et du premier vertical à la latitude de l'origine.
const A = 6378137, E2 = 0.00669437999014;
function radii(latitude: number): { meridian: number; parallel: number } {
  const s = Math.sin((latitude * Math.PI) / 180), w = 1 - E2 * s * s;
  const normal = A / Math.sqrt(w);
  return { meridian: (A * (1 - E2)) / (w * Math.sqrt(w)), parallel: normal * Math.max(1e-6, Math.cos((latitude * Math.PI) / 180)) };
}
const RAD = Math.PI / 180;
const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

/** [longitude, latitude] → est, nord (m) depuis l'origine (plan tangent ; erreur sous le centimètre à 1 km). */
export function toEnu(origin: Origin, longitude: number, latitude: number): XY {
  const { meridian, parallel } = radii(origin.latitude);
  return [wrap(longitude - origin.longitude) * RAD * parallel + 0, (latitude - origin.latitude) * RAD * meridian + 0];
}

/** Inverse de `toEnu` : [longitude, latitude]. */
export function toGeo(origin: Origin, east: number, north: number): [number, number] {
  const { meridian, parallel } = radii(origin.latitude);
  return [wrap(origin.longitude + east / parallel / RAD), origin.latitude + north / meridian / RAD];
}

/** Les boîtes (degrés) qui couvrent le carré de `radius` m autour de l'origine : deux si l'antiméridien le coupe. */
export function geoBoxes(origin: Origin, radius: number): GeoBox[] {
  const { meridian, parallel } = radii(origin.latitude);
  const dLat = radius / meridian / RAD, dLon = radius / parallel / RAD;
  const south = Math.max(-90, origin.latitude - dLat), north = Math.min(90, origin.latitude + dLat);
  if (dLon >= 180) return [{ south, west: -180, north, east: 180 }];
  const west = origin.longitude - dLon, east = origin.longitude + dLon;
  if (west < -180) return [{ south, west: west + 360, north, east: 180 }, { south, west: -180, north, east }];
  if (east > 180) return [{ south, west, north, east: 180 }, { south, west: -180, north, east: east - 360 }];
  return [{ south, west, north, east }];
}

/** La base mondiale : OpenStreetMap par Overpass. Hauteur renseignée (`height`, `building:levels`) ou supposée. */
export function osmProvider(fetcher: (box: GeoBox, signal?: AbortSignal) => Promise<OsmBuilding[]> = fetchOsmBuildings): ContextProvider {
  return {
    name: 'OpenStreetMap',
    credit: OSM_CREDIT,
    async buildings(box, signal) {
      return (await fetcher(box, signal)).map((b) => ({ id: `osm-${b.id}`, outline: b.outline, height: b.height, heightSource: b.tagged ? 'tagged' : 'assumed' }));
    },
  };
}

/** Une tuile terrarium décodée dans le navigateur (image PNG → hauteurs). */
async function fetchTerrariumTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Float32Array> {
  const response = await fetch(TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal });
  if (!response.ok) throw new Error(`tuile de relief ${z}/${x}/${y} : ${response.status}`);
  const image = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D indisponible : relief illisible.');
  context.drawImage(image, 0, 0);
  return decodeTerrarium(context.getImageData(0, 0, image.width, image.height).data, image.width);
}

export const terrariumSource = (): TerrainSource => ({ credit: TERRAIN_CREDIT, zoom: 15, tile: fetchTerrariumTile });

async function collect(provider: ContextProvider, boxes: readonly GeoBox[], signal?: AbortSignal): Promise<ProviderBuilding[] | null> {
  const out: ProviderBuilding[] = [];
  for (const box of boxes) {
    const found = await provider.buildings(box, signal);
    if (!found) return null;
    out.push(...found);
  }
  return out;
}

/** Relief sur une grille régulière autour de l'origine, lu dans les tuiles (chacune une fois), et l'altitude à l'origine. */
async function loadTerrain(origin: Origin, radius: number, source: TerrainSource, signal?: AbortSignal): Promise<{ grid: TerrainGrid; altitude: number }> {
  const half = Math.max(1, Math.ceil(radius / TERRAIN_STEP));
  const columns = 2 * half + 1, rows = columns, west = -half * TERRAIN_STEP, south = west;
  const scale = 2 ** source.zoom;
  // Position Web Mercator (en tuiles) d'un point ; les nœuds de la tuile décodée sont pris tous les 1/(GRID − 1) de tuile
  // (à un demi-pixel près, bien moins que la précision du relief).
  const tileCoordinates = (east: number, north: number) => {
    const [longitude, latitude] = toGeo(origin, east, north);
    const phi = Math.max(-85.05, Math.min(85.05, latitude)) * RAD;
    return [((longitude + 180) / 360) * scale, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale];
  };
  const tiles = new Map<string, Promise<Float32Array>>();
  const sample = async (east: number, north: number): Promise<number> => {
    const [fx, fy] = tileCoordinates(east, north);
    const tx = Math.floor(fx), ty = Math.min(scale - 1, Math.max(0, Math.floor(fy)));
    const key = `${((tx % scale) + scale) % scale}/${ty}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = source.tile(source.zoom, ((tx % scale) + scale) % scale, ty, signal);
      tiles.set(key, tile);
    }
    const heights = await tile;
    const u = Math.min(GRID - 1, Math.max(0, (fx - tx) * (GRID - 1))), v = Math.min(GRID - 1, Math.max(0, (fy - ty) * (GRID - 1)));
    const c = Math.min(GRID - 2, Math.floor(u)), r = Math.min(GRID - 2, Math.floor(v)), du = u - c, dv = v - r;
    const at = (row: number, col: number) => heights[row * GRID + col];
    return (at(r, c) * (1 - du) + at(r, c + 1) * du) * (1 - dv) + (at(r + 1, c) * (1 - du) + at(r + 1, c + 1) * du) * dv;
  };
  const heights: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) heights.push(Math.round((await sample(west + col * TERRAIN_STEP, south + row * TERRAIN_STEP)) * 10) / 10);
  }
  return { grid: { west, south, step: TERRAIN_STEP, columns, rows, heights }, altitude: Math.round((await sample(0, 0)) * 10) / 10 };
}

export interface LoadedContext {
  context: StudyContext;
  /** Altitude du sol à l'origine (m), lue dans le relief ; null sans relief. */
  altitude: number | null;
  /** Ce qui s'est mal passé sans tout empêcher (fournisseur en panne, relief absent), en phrases. */
  notes: string[];
}

/**
 * Lit le contexte autour de l'origine : bâtiments (fournisseurs dans l'ordre, puis la base mondiale) et relief. Une panne
 * de la base mondiale fait échouer le tout (rien n'est inventé) ; une panne du relief laisse un sol plat, et le dit.
 */
export async function loadContext(origin: Origin, radius: number, options: { providers?: readonly ContextProvider[]; base?: ContextProvider; terrain?: TerrainSource | null; signal?: AbortSignal } = {}): Promise<LoadedContext> {
  const { providers = [], base = osmProvider(), terrain = terrariumSource(), signal } = options;
  const boxes = geoBoxes(origin, radius);
  const notes: string[] = [];
  let chosen: { provider: ContextProvider; buildings: ProviderBuilding[] } | null = null;
  for (const provider of providers) {
    try {
      const buildings = await collect(provider, boxes, signal);
      if (buildings) {
        chosen = { provider, buildings };
        break;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      notes.push(`${provider.name} indisponible (${error instanceof Error ? error.message : String(error)}) : base mondiale utilisée.`);
    }
  }
  chosen ??= { provider: base, buildings: (await collect(base, boxes, signal)) ?? [] };

  const seen = new Map<string, number>();
  // Les mêmes bornes qu'à la lecture d'une étude : ce qui est gardé ici se relit tel quel.
  const kept = chosen.buildings.filter((b) => b.outline.length <= MAX_OUTLINE_POINTS);
  if (kept.length > MAX_NEIGHBOURS) notes.push(`Plus de ${MAX_NEIGHBOURS.toLocaleString('fr-FR')} bâtiments voisins : seuls les premiers sont gardés.`);
  const buildings: Neighbour[] = kept.slice(0, MAX_NEIGHBOURS).map((b) => {
    const count = (seen.get(b.id) ?? 0) + 1;
    seen.set(b.id, count);
    return { id: count > 1 ? `${b.id}-${count}` : b.id, footprint: b.outline.map(([lon, lat]) => toEnu(origin, lon, lat)), height: b.height, heightSource: b.heightSource };
  });

  const credits = [chosen.provider.credit];
  let grid: TerrainGrid | null = null, altitude: number | null = null;
  if (terrain) {
    try {
      ({ grid, altitude } = await loadTerrain(origin, radius, terrain, signal));
      credits.push(terrain.credit);
    } catch (error) {
      if (signal?.aborted) throw error;
      notes.push(`Relief indisponible (${error instanceof Error ? error.message : String(error)}) : sol plat.`);
    }
  }
  return { context: { buildings, terrain: grid, credits, radius, fetchedAt: new Date().toISOString() }, altitude, notes };
}

/** Hauteur du sol (m, repère local : 0 à l'altitude de l'origine) ; sol plat sans relief, bord prolongé hors de la grille. */
export function groundAt(study: Study, east: number, north: number): number {
  const grid = study.context.terrain;
  if (!grid) return 0;
  const u = Math.min(grid.columns - 1, Math.max(0, (east - grid.west) / grid.step));
  const v = Math.min(grid.rows - 1, Math.max(0, (north - grid.south) / grid.step));
  const c = Math.min(grid.columns - 2, Math.floor(u)), r = Math.min(grid.rows - 2, Math.floor(v)), du = u - c, dv = v - r;
  const at = (row: number, col: number) => grid.heights[row * grid.columns + col];
  const altitude = (at(r, c) * (1 - du) + at(r, c + 1) * du) * (1 - dv) + (at(r + 1, c) * (1 - du) + at(r + 1, c + 1) * du) * dv;
  return altitude - study.site.origin.altitude + 0;
}

/** Pied d'un voisin : le point le plus bas du sol sous son contour (il ne flotte pas sur une pente). */
export const neighbourBase = (study: Study, footprint: readonly XY[]): number => Math.min(...footprint.map(([e, n]) => groundAt(study, e, n)));

export function heightCounts(buildings: readonly Neighbour[]): Record<HeightSource, number> {
  const counts: Record<HeightSource, number> = { measured: 0, tagged: 0, assumed: 0 };
  for (const b of buildings) counts[b.heightSource]++;
  return counts;
}
