// Les fonds de carte en tuiles Web Mercator (256 px, rangée 0 au nord) : un registre de sources, chacune avec sa zone
// couverte (des pays), son crédit et sa licence, pour la carte de choix du lieu (Leaflet), le sol de la scène three.js
// de l'étude de site et le globe du viewer. Le plan OpenStreetMap couvre le monde ; une photo vient d'un service national
// ouvert là où il en existe un (sources vérifiées : tuiles lisibles en texture depuis notre origine, CORS), sinon de la
// photo mondiale que l'utilisateur branche avec sa propre clé (`customSatellite`). Usage léger, comme un visiteur :
// les tuiles vues sont gardées le temps de la session, jamais téléchargées en masse.

export type ImageryId = string;

export interface ImagerySource {
  id: ImageryId;
  kind: 'photo' | 'plan';
  /** Crédit à montrer sous la vue (fournisseur, licence). */
  credit: string;
  /** Lien vers la page des droits de la source. */
  creditUrl: string;
  maxZoom: number;
  /** Pays couverts (codes ISO en minuscules, ceux que donne Nominatim) ; absent : le monde entier. */
  countries?: readonly string[];
  /** Adresse d'une tuile : {z}, {x}, {y} (ou {-y} : rangée comptée depuis le sud). */
  template: string;
}

const ign = (layer: string, format: string) =>
  `https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;
/** La France et ses départements et régions d'outre-mer (Nominatim les nomme parfois par leur propre code). */
const FRANCE = ['fr', 're', 'gp', 'mq', 'gf', 'yt', 'pm', 'bl', 'mf'];

/**
 * Plan mondial, puis les photos ouvertes, vérifiées le 15/11/2026 : texture lisible depuis notre origine aux zooms 17 et
 * 18 (ceux du sol de l'étude), licence lue sur la page du fournisseur. Hors de leur pays, ces services répondent une
 * erreur ou une tuile vide : la scène pose alors le plan à la place (voir SiteScene).
 */
export const IMAGERY_SOURCES: readonly ImagerySource[] = [
  { id: 'osm', kind: 'plan', credit: '© les contributeurs d’OpenStreetMap', creditUrl: 'https://www.openstreetmap.org/copyright', maxZoom: 19, template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
  // Licence ouverte Etalab 2.0.
  { id: 'ign-ortho', kind: 'photo', credit: '© IGN – Géoplateforme', creditUrl: 'https://geoservices.ign.fr/cgu-licences', maxZoom: 20, countries: FRANCE, template: ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg') },
  { id: 'ign-plan', kind: 'plan', credit: '© IGN – Géoplateforme', creditUrl: 'https://geoservices.ign.fr/cgu-licences', maxZoom: 19, countries: FRANCE, template: ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png') },
  // CC BY 4.0 (scne.es).
  { id: 'es-pnoa', kind: 'photo', credit: 'PNOA cedido por © Instituto Geográfico Nacional de España (CC BY 4.0)', creditUrl: 'https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf', maxZoom: 19, countries: ['es'], template: 'https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}' },
  // CC BY 4.0, Beeldmateriaal Nederland.
  { id: 'nl-pdok', kind: 'photo', credit: 'Luchtfoto : Beeldmateriaal Nederland, PDOK (CC BY 4.0)', creditUrl: 'https://www.pdok.nl/', maxZoom: 19, countries: ['nl'], template: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg' },
  // Données libres de l'administration fédérale (usage équitable : pas de lecture en masse).
  { id: 'ch-swissimage', kind: 'photo', credit: '© Données : swisstopo', creditUrl: 'https://www.geo.admin.ch/fr/conditions-generales-dutilisation-ifdg', maxZoom: 19, countries: ['ch', 'li'], template: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg' },
  // CC BY 4.0 (Open Government Data Österreich).
  { id: 'at-basemap', kind: 'photo', credit: 'Datenquelle : basemap.at (CC BY 4.0)', creditUrl: 'https://basemap.at/', maxZoom: 19, countries: ['at'], template: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg' },
  // CC0.
  { id: 'lu-ortho', kind: 'photo', credit: 'Orthophoto : © ACT Luxembourg (CC0)', creditUrl: 'https://data.public.lu/', maxZoom: 19, countries: ['lu'], template: 'https://wmts1.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/{z}/{x}/{y}.jpeg' },
  // CC BY 4.0 depuis le 1er juillet 2023.
  { id: 'cz-ortofoto', kind: 'photo', credit: 'Ortofoto ČR : © ČÚZK (CC BY 4.0)', creditUrl: 'https://geoportal.cuzk.gov.cz/', maxZoom: 19, countries: ['cz'], template: 'https://ags.cuzk.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}' },
  // Licence de données ouvertes du Maa- ja Ruumiamet (usage commercial permis, attribution).
  { id: 'ee-ortofoto', kind: 'photo', credit: 'Ortofoto : Republic of Estonia Land and Spatial Development Board', creditUrl: 'https://geoportaal.maaamet.ee/opendata-licence', maxZoom: 18, countries: ['ee'], template: 'https://tiles.maaamet.ee/tm/tms/1.0.0/foto@GMC/{z}/{x}/{-y}.jpg' },
  // Domaine public ; crédit demandé.
  { id: 'us-usgs', kind: 'photo', credit: 'Imagery : U.S. Geological Survey, The National Map', creditUrl: 'https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map', maxZoom: 16, countries: ['us', 'pr', 'vi', 'gu', 'as', 'mp'], template: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}' },
  // Tuiles du GSI affichées en direct : le crédit suffit, sans demande (FAQ du GSI).
  { id: 'jp-gsi', kind: 'photo', credit: '地理院タイル（全国最新写真）: 国土地理院', creditUrl: 'https://maps.gsi.go.jp/development/ichiran.html', maxZoom: 18, countries: ['jp'], template: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg' },
];

export const OSM: ImagerySource = IMAGERY_SOURCES[0];

/** Identifiant de la photo mondiale branchée par l'utilisateur (sa clé, son fournisseur). */
export const CUSTOM_ID = 'satellite';

/** La photo mondiale de ce build (VITE_SATELLITE_TILES, VITE_SATELLITE_CREDIT) ; null sans adresse. */
// Écrit tel quel pour que Vite remplace ces deux noms au build ; hors de Vite (tests), `import.meta.env` n'existe pas.
const BUILD_SATELLITE = typeof import.meta.env === 'object'
  ? { template: String(import.meta.env.VITE_SATELLITE_TILES ?? ''), credit: String(import.meta.env.VITE_SATELLITE_CREDIT ?? '') }
  : { template: '', credit: '' };
const STORAGE_KEY = 'viewer-bim.satellite';
/** `localStorage`, ou null là où le navigateur le refuse (le lire peut lever). */
function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** L'adresse de tuiles collée par l'utilisateur, validée : `https://`, avec {z}, {x} et {y} (ou {-y}) ; sinon la raison. */
export function checkTemplate(text: string): { template: string } | { error: string } {
  const template = text.trim();
  if (!/^https:\/\/[^\s/]+\/\S*$/.test(template)) return { error: 'L’adresse doit commencer par https:// et ne pas contenir d’espace.' };
  const missing = ['{z}', '{x}'].filter((part) => !template.includes(part));
  if (!template.includes('{y}') && !template.includes('{-y}')) missing.push('{y}');
  if (missing.length > 0) return { error: `Il manque ${missing.join(', ')} dans l’adresse : collez l’adresse de tuiles complète de votre fournisseur.` };
  return { template };
}

/** La photo mondiale d'une adresse de tuiles (déjà vérifiée) et de son crédit. */
export const customSource = (template: string, credit: string): ImagerySource =>
  ({ id: CUSTOM_ID, kind: 'photo', credit: credit.trim() || 'Photo : votre fournisseur', creditUrl: template.replace(/^(https:\/\/[^/]+).*$/, '$1'), maxZoom: 19, template });

/** La photo mondiale de l'utilisateur : celle gardée dans ce navigateur, sinon celle du build ; null sans adresse valide. */
export function customSatellite(storage: Pick<Storage, 'getItem'> | null = browserStorage()): ImagerySource | null {
  let saved: { template?: unknown; credit?: unknown } | null = null;
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null') as typeof saved;
  } catch {
    // Stockage bloqué ou valeur abîmée : comme s'il n'y avait rien.
  }
  for (const { template, credit } of [saved ?? {}, BUILD_SATELLITE]) {
    const checked = typeof template === 'string' ? checkTemplate(template) : null;
    if (checked && 'template' in checked) return customSource(checked.template, typeof credit === 'string' ? credit : '');
  }
  return null;
}

/** Garde (ou efface, avec null) la photo mondiale de l'utilisateur dans ce navigateur ; faux si le stockage refuse. */
export function saveCustomSatellite(value: { template: string; credit: string } | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = browserStorage()): boolean {
  try {
    if (value) storage?.setItem(STORAGE_KEY, JSON.stringify(value));
    else storage?.removeItem(STORAGE_KEY);
    return storage !== null;
  } catch {
    return false;
  }
}

/** La meilleure photo du lieu : celle du service national du pays, sinon la photo mondiale de l'utilisateur, sinon null. */
export function photoFor(country: string | null | undefined, custom: ImagerySource | null = customSatellite()): ImagerySource | null {
  return IMAGERY_SOURCES.find((source) => source.kind === 'photo' && country && source.countries?.includes(country)) ?? custom;
}

/** Une source par son identifiant (la photo de l'utilisateur comprise) ; le plan OpenStreetMap si elle n'existe pas. */
export const imagerySource = (id: ImageryId, custom: ImagerySource | null = customSatellite()): ImagerySource =>
  (id === CUSTOM_ID ? custom : IMAGERY_SOURCES.find((source) => source.id === id)) ?? OSM;

/** L'adresse d'une tuile ; `y` compté depuis le nord. */
export function tileUrl(source: Pick<ImagerySource, 'template'>, z: number, x: number, y: number): string {
  return source.template.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{-y}', String(2 ** z - 1 - y)).replaceAll('{y}', String(y));
}

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

/**
 * Vrai si les pixels RVBA d'une tuile ne montrent rien : tout transparent, ou presque une seule couleur (la tuile « vide »
 * que certains services renvoient hors de leur pays). Une vraie photo compte des milliers de teintes.
 */
export function blankTile(pixels: ArrayLike<number>): boolean {
  const colours = new Set<number>();
  let opaque = false;
  for (let i = 0; i < pixels.length; i += 4 * 7) {
    if (pixels[i + 3] > 0) opaque = true;
    colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    if (opaque && colours.size >= 16) return false;
  }
  return true;
}
