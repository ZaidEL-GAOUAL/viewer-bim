// La parcelle cadastrale sous un point, en France seulement : l'API Carto de l'IGN (module cadastre, gratuit, sans clé,
// Licence Ouverte), une demande par clic. Ailleurs, l'utilisateur trace la limite à la main.

export const PARCEL_CREDIT = 'Parcelle : cadastre (DGFiP), lu par l’API Carto de l’IGN (Licence Ouverte)';
const ENDPOINT = 'https://apicarto.ign.fr/api/cadastre/parcelle';

export interface Parcel {
  /** Identifiant cadastral (« 75104000AE0003 »). */
  id: string;
  /** « Parcelle AE 0003, Paris ». */
  label: string;
  /** Contour extérieur, [longitude, latitude], sans point de fermeture répété. */
  ring: [number, number][];
}

const isPoint = (p: unknown): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** La première parcelle d'une réponse GeoJSON de l'API Carto ; null s'il n'y en a pas. */
export function parseParcel(json: unknown): Parcel | null {
  const feature = (json as { features?: unknown[] } | null)?.features?.[0] as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> } | undefined;
  const geometry = feature?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) return null;
  // Polygone : [anneau extérieur, trous…] ; multipolygone : [[anneau extérieur, trous…], …] : on garde le premier extérieur.
  const polygon = geometry.type === 'MultiPolygon' ? geometry.coordinates[0] : geometry.type === 'Polygon' ? geometry.coordinates : null;
  const outer = Array.isArray(polygon) ? polygon[0] : null;
  if (!Array.isArray(outer)) return null;
  const ring = outer.filter(isPoint).map(([lon, lat]): [number, number] => [lon, lat]);
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
  if (ring.length < 3) return null;
  const props = feature?.properties ?? {};
  const text = (key: string) => (typeof props[key] === 'string' ? (props[key] as string) : '');
  const id = text('idu') || text('id');
  const label = [`Parcelle ${[text('section'), text('numero')].filter(Boolean).join(' ')}`.trim(), text('nom_com')].filter(Boolean).join(', ');
  return { id, label: label || 'Parcelle', ring };
}

/** La parcelle sous le point (degrés), ou null s'il n'y en a pas (hors de France, sur la voirie…). */
export async function fetchParcel(longitude: number, latitude: number, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Parcel | null> {
  const geom = JSON.stringify({ type: 'Point', coordinates: [Number(longitude.toFixed(7)), Number(latitude.toFixed(7))] });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${ENDPOINT}?geom=${encodeURIComponent(geom)}`, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('le cadastre (API Carto de l’IGN) est injoignable');
  }
  if (!response.ok) throw new Error(`le cadastre a répondu ${response.status}`);
  return parseParcel(await response.json());
}
