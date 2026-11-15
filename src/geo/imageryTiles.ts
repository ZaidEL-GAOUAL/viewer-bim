// Les fonds de carte en tuiles Web Mercator (256 px, rangée 0 au nord) que la page « Étude de site » pose elle-même,
// sans globe : la carte du monde (images dans la page) et le sol de la scène three.js (textures). Mêmes sources et mêmes
// crédits que le globe du viewer (GlobeView.ts) : OpenStreetMap partout, IGN en France. Usage léger, comme un visiteur :
// les tuiles vues sont gardées le temps de la session, jamais téléchargées en masse.

export type ImageryId = 'osm' | 'ign-ortho' | 'ign-plan';

export interface ImagerySource {
  id: ImageryId;
  label: string;
  /** Crédit à montrer sous la carte. */
  credit: string;
  /** Lien vers la page des droits de la source. */
  creditUrl: string;
  maxZoom: number;
  /** Vrai si la source ne couvre que la France. */
  franceOnly: boolean;
  url(z: number, x: number, y: number): string;
}

const ign = (layer: string, format: string) => (z: number, x: number, y: number) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=${format}`;

export const IMAGERY_SOURCES: readonly ImagerySource[] = [
  {
    id: 'osm', label: 'Plan (OpenStreetMap)', credit: '© les contributeurs d’OpenStreetMap', creditUrl: 'https://www.openstreetmap.org/copyright',
    maxZoom: 19, franceOnly: false, url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
  {
    id: 'ign-ortho', label: 'Photo aérienne (IGN, France)', credit: '© IGN – Géoplateforme', creditUrl: 'https://geoservices.ign.fr/cgu-licences',
    maxZoom: 20, franceOnly: true, url: ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'),
  },
  {
    id: 'ign-plan', label: 'Plan IGN (France)', credit: '© IGN – Géoplateforme', creditUrl: 'https://geoservices.ign.fr/cgu-licences',
    maxZoom: 19, franceOnly: true, url: ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'),
  },
];

export const imagerySource = (id: ImageryId): ImagerySource => IMAGERY_SOURCES.find((source) => source.id === id) ?? IMAGERY_SOURCES[0];

/** La projection Web Mercator s'arrête à cette latitude (°) : au-delà, aucune tuile. */
export const MERCATOR_MAX_LATITUDE = 85.0511287798;

const RAD = Math.PI / 180;

/** Position (en tuiles, fractionnaire) d'un point au niveau `z` ; x n'est pas ramené dans [0, 2^z[ (antiméridien). */
export function lonLatToTile(longitude: number, latitude: number, z: number): [number, number] {
  const scale = 2 ** z;
  const phi = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, latitude)) * RAD;
  return [((longitude + 180) / 360) * scale, ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale];
}

/** Inverse de `lonLatToTile` : [longitude, latitude] en degrés (longitude non ramenée). */
export function tileToLonLat(x: number, y: number, z: number): [number, number] {
  const scale = 2 ** z;
  return [(x / scale) * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) / RAD];
}
