// Recherche d'un lieu (adresse, ville, lieu-dit, dans tout pays) et nom d'un point cliqué, par Nominatim, le service
// public d'OpenStreetMap. Sa règle d'usage : une demande par seconde au plus, aucune demande à chaque frappe (la page
// cherche sur Entrée seulement), l'attribution affichée. Les demandes de cette page passent donc l'une après l'autre,
// espacées d'une seconde. `fetch` est injectable : les tests n'appellent jamais le réseau.

export const MIN_QUERY_LENGTH = 3;
export const GEOCODER_CREDIT = 'Recherche de lieux : Nominatim, © les contributeurs d’OpenStreetMap (ODbL)';
const ENDPOINT = 'https://nominatim.openstreetmap.org';

export interface Place {
  /** Nom complet, tel que le service le donne (« Wadduwa, Kalutara, …, Sri Lanka »). */
  label: string;
  /** Nom court (« Wadduwa »), pour nommer l'étude. */
  name: string;
  latitude: number;
  longitude: number;
  /** Code ISO du pays en minuscules (« lk »), s'il est connu. */
  country: string | null;
}

export interface GeocodeOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Écart minimal entre deux demandes (ms) : 1 s, la règle de Nominatim. */
  spacingMs?: number;
}

let gate: Promise<unknown> = Promise.resolve();

/** Passe les demandes l'une après l'autre, chacune au moins `spacing` ms après la fin de la précédente. */
function polite<T>(spacing: number, run: () => Promise<T>): Promise<T> {
  const result = gate.then(run);
  gate = result.then(() => undefined, () => undefined).then(() => new Promise((resolve) => setTimeout(resolve, spacing)));
  return result;
}

const finite = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN);

/** Un résultat de Nominatim (format jsonv2) en lieu ; null s'il n'a pas de position lisible. */
export function parsePlace(raw: unknown): Place | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const latitude = finite(item.lat), longitude = finite(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const label = typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : label.split(',')[0].trim();
  const address = item.address && typeof item.address === 'object' ? (item.address as Record<string, unknown>) : {};
  const country = typeof address.country_code === 'string' && /^[a-z]{2}$/i.test(address.country_code) ? address.country_code.toLowerCase() : null;
  return { label, name, latitude, longitude, country };
}

async function request(url: string, options: GeocodeOptions): Promise<unknown> {
  const run = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await polite(options.spacingMs ?? 1000, () => run(url, { signal: options.signal, headers: { Accept: 'application/json' } }));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('le service de recherche est injoignable (pas de réseau ?)');
  }
  if (!response.ok) throw new Error(`le service de recherche a répondu ${response.status}${response.status === 429 ? ' (trop de demandes : réessayez dans un instant)' : ''}`);
  try {
    return await response.json();
  } catch {
    throw new Error('réponse illisible du service de recherche');
  }
}

/** Les lieux qui répondent à `query` (cinq au plus, en français si possible) ; rien sans trois caractères. */
export async function searchPlaces(query: string, options: GeocodeOptions = {}): Promise<Place[]> {
  const text = query.trim();
  if (text.length < MIN_QUERY_LENGTH) return [];
  const json = await request(`${ENDPOINT}/search?format=jsonv2&addressdetails=1&limit=5&accept-language=fr&q=${encodeURIComponent(text)}`, options);
  if (!Array.isArray(json)) throw new Error('réponse inattendue du service de recherche');
  return json.flatMap((item) => parsePlace(item) ?? []);
}

/** Le lieu sous un point (nom, pays) ; null si le service ne connaît rien ici (en mer, par exemple). */
export async function reversePlace(latitude: number, longitude: number, options: GeocodeOptions = {}): Promise<Place | null> {
  const json = await request(`${ENDPOINT}/reverse?format=jsonv2&addressdetails=1&zoom=14&accept-language=fr&lat=${latitude.toFixed(6)}&lon=${longitude.toFixed(6)}`, options);
  if (json && typeof json === 'object' && 'error' in json) return null;
  const place = parsePlace(json);
  // Le nom vient du service, la position reste celle du clic.
  return place ? { ...place, latitude, longitude } : null;
}
