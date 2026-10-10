// Les bâtiments voisins, lus dans OpenStreetMap par l'API Overpass (gratuite, sans clé, pour un
// usage léger : un quartier autour de la maquette, une fois par position). Chaque bâtiment est
// un contour (longitude, latitude) et une hauteur, tirée de `height`, sinon de `building:levels`,
// sinon d'une valeur usuelle.

export interface OsmBuilding {
  id: number;
  /** Contour extérieur, [longitude, latitude] en degrés. */
  outline: [number, number][];
  height: number;
}

export interface Bbox { south: number; west: number; north: number; east: number }

/**
 * Instances publiques d'Overpass acceptant les requêtes depuis un navigateur (en-têtes CORS),
 * essayées dans l'ordre : la principale est parfois saturée (504), ses deux serveurs répondent
 * alors souvent directement. Les autres miroirs connus refusent les navigateurs ou ne couvrent
 * qu'un pays.
 */
export const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
];
const RETRY_DELAY_MS = 3000;
const METRES_PER_LEVEL = 3;
const DEFAULT_HEIGHT = 8;

interface OverpassPoint { lat: number; lon: number }
interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OverpassPoint[];
  members?: { type: string; role?: string; geometry?: OverpassPoint[] }[];
}

/** Hauteur d'un bâtiment d'après ses attributs OSM. */
export function buildingHeight(tags: Record<string, string> | undefined): number {
  const explicit = parseFloat((tags?.height ?? '').replace(',', '.'));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const levels = parseFloat((tags?.['building:levels'] ?? '').replace(',', '.'));
  if (Number.isFinite(levels) && levels > 0) return levels * METRES_PER_LEVEL;
  return DEFAULT_HEIGHT;
}

function outlineOf(points: OverpassPoint[] | undefined): [number, number][] | null {
  if (!points || points.length < 4) return null;
  const outline = points.map((p): [number, number] => [p.lon, p.lat]);
  const [first, last] = [outline[0], outline[outline.length - 1]];
  if (first[0] === last[0] && first[1] === last[1]) outline.pop();
  return outline.length >= 3 ? outline : null;
}

/** Bâtiments d'une réponse Overpass (`out geom`) : chemins fermés et contours extérieurs des relations. */
export function parseOverpassBuildings(json: unknown): OsmBuilding[] {
  const elements = (json as { elements?: OverpassElement[] })?.elements;
  if (!Array.isArray(elements)) throw new Error('Réponse Overpass inattendue.');
  const out: OsmBuilding[] = [];
  for (const element of elements) {
    const height = buildingHeight(element.tags);
    if (element.type === 'way') {
      const outline = outlineOf(element.geometry);
      if (outline) out.push({ id: element.id, outline, height });
    } else if (element.type === 'relation') {
      for (const member of element.members ?? []) {
        if (member.type !== 'way' || (member.role ?? 'outer') !== 'outer') continue;
        const outline = outlineOf(member.geometry);
        if (outline) out.push({ id: element.id, outline, height });
      }
    }
  }
  return out;
}

export function overpassQuery(bbox: Bbox): string {
  const box = [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:25];(way["building"](${box});relation["building"]["type"="multipolygon"](${box}););out geom;`;
}

/** Deux tours sur les instances (une pause entre les deux) : la saturation d'Overpass est passagère. */
export async function fetchOsmBuildings(bbox: Bbox, signal?: AbortSignal, urls: readonly string[] = OVERPASS_URLS, retryDelayMs = RETRY_DELAY_MS): Promise<OsmBuilding[]> {
  const body = `data=${encodeURIComponent(overpassQuery(bbox))}`;
  let lastError: Error | null = null;
  for (let round = 0; round < 2; round++) {
    if (round > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    for (const url of urls) {
      signal?.throwIfAborted();
      try {
        const response = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal });
        if (!response.ok) throw new Error(`Overpass a répondu ${response.status}${response.status === 429 ? ' (trop de requêtes)' : response.status === 504 ? ' (serveur saturé)' : ''}.`);
        return parseOverpassBuildings(await response.json());
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }
  throw lastError ?? new Error('Overpass indisponible.');
}

/** Centre d'un contour (moyenne des sommets), [longitude, latitude]. */
export function outlineCentre(outline: [number, number][]): [number, number] {
  let lon = 0, lat = 0;
  for (const [x, y] of outline) { lon += x; lat += y; }
  return [lon / outline.length, lat / outline.length];
}
