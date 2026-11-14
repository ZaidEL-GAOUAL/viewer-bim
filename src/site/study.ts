// Le contrat de l'étude de site (docs/contrat-etude.md, version 1) : un fichier JSON qui tient le site, son contexte
// (voisins et relief, lus une fois puis gardés) et les propositions. Repère local : est, nord, haut en mètres depuis
// l'origine du site ; les hauteurs « haut » comptent depuis l'altitude de l'origine. Les champs inconnus sont gardés tels
// quels, à tous les niveaux : chaque objet lu reprend ses champs bruts, puis ses champs connus vérifiés par-dessus.

import { isRecord } from '../data/json.ts';

export const STUDY_FORMAT = 'etude-de-site';
export const STUDY_VERSION = 1;

/** Un point du plan : est, nord (m) depuis l'origine du site. */
export type XY = [number, number];
export type HeightSource = 'measured' | 'tagged' | 'assumed';
export type AreaUnit = 'm2' | 'ft2';

export interface Neighbour {
  id: string;
  footprint: XY[];
  /** Hauteur au-dessus du sol (m). */
  height: number;
  /** Mesurée (fournisseur national), renseignée (attributs OSM), supposée (valeur usuelle) ; « édité » si l'utilisateur l'a changée. */
  heightSource: HeightSource;
  edited?: boolean;
}

/** Relief en grille régulière : altitudes (m, au-dessus de la mer), rangées du sud au nord, colonnes d'ouest en est. */
export interface TerrainGrid {
  west: number;
  south: number;
  step: number;
  columns: number;
  rows: number;
  heights: number[];
}

export interface StudyContext {
  buildings: Neighbour[];
  terrain: TerrainGrid | null;
  /** Attributions des données, à montrer et à exporter. */
  credits: string[];
  /** Rayon lu autour de l'origine (m). */
  radius: number;
  /** Date de la lecture (ISO) ; null tant que rien n'a été lu. */
  fetchedAt: string | null;
}

export interface Volume {
  id: string;
  name: string;
  footprint: XY[];
  /** Niveau du plancher bas (m, repère local). */
  baseLevel: number;
  floors: number;
  floorHeight: number;
  use: string;
  /** Usage par niveau depuis le rez-de-chaussée ; une case absente ou vide reprend `use`. */
  floorUses?: string[];
}

export interface Proposal {
  id: string;
  name: string;
  volumes: Volume[];
}

export interface Use {
  id: string;
  name: string;
  color: string;
  /** Compte pour l'estimation du nombre de logements. */
  housing: boolean;
}

export interface StudySettings {
  uses: Use[];
  /** Surface moyenne d'un logement (m², habitable). */
  dwellingSize: number;
  /** Part de la surface de plancher qui devient habitable (0 à 1). */
  efficiency: number;
  units: AreaUnit;
}

export interface Site {
  origin: { latitude: number; longitude: number; altitude: number };
  /** Décalage horaire du site (h) ; par défaut déduit de la longitude, à corriger par l'utilisateur. */
  utcOffset: number;
  /** Limite du terrain ; vide tant qu'elle n'est pas dessinée. */
  limit: XY[];
}

export interface Study {
  format: typeof STUDY_FORMAT;
  version: typeof STUDY_VERSION;
  name: string;
  site: Site;
  context: StudyContext;
  proposals: Proposal[];
  settings: StudySettings;
}

export const DEFAULT_USES: readonly Use[] = [
  { id: 'logement', name: 'Logement', color: '#e9b44c', housing: true },
  { id: 'bureaux', name: 'Bureaux', color: '#5b8bd9', housing: false },
  { id: 'commerce', name: 'Commerce', color: '#d9675b', housing: false },
  { id: 'stationnement', name: 'Stationnement', color: '#8f969e', housing: false },
  { id: 'autre', name: 'Autre', color: '#9b7fd1', housing: false },
];

/** Bornes d'une étude, à la lecture comme dans l'interface : au-delà, un fichier pourrait figer l'onglet. */
export const MAX_FLOORS = 200;
export const MIN_FLOOR_HEIGHT = 1;
export const MAX_FLOOR_HEIGHT = 20;
/** Points d'un contour (volume, voisin, limite du terrain). */
export const MAX_OUTLINE_POINTS = 1000;
/** Volumes par proposition. */
export const MAX_VOLUMES = 500;
export const MAX_PROPOSALS = 50;
export const MAX_NEIGHBOURS = 20_000;
/** Points de la grille du relief. */
export const MAX_TERRAIN_CELLS = 250_000;

export const newId = (): string => crypto.randomUUID();

export function newProposal(name: string): Proposal {
  return { id: newId(), name, volumes: [] };
}

export function newStudy(): Study {
  return {
    format: STUDY_FORMAT,
    version: STUDY_VERSION,
    name: 'Nouvelle étude',
    site: { origin: { latitude: 48.8566, longitude: 2.3522, altitude: 35 }, utcOffset: 0, limit: [] },
    context: { buildings: [], terrain: null, credits: [], radius: 0, fetchedAt: null },
    proposals: [newProposal('Proposition 1')],
    settings: { uses: DEFAULT_USES.map((use) => ({ ...use })), dwellingSize: 65, efficiency: 0.8, units: 'm2' },
  };
}

/** L'usage d'un niveau (0 : rez-de-chaussée). */
export const useOf = (volume: Volume, floor: number): string => volume.floorUses?.[floor] || volume.use;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() ? value : fallback);
const number = (value: unknown, fallback: number, min = -Infinity): number => (finite(value) && value >= min ? value : fallback);
const clamped = (value: unknown, fallback: number, min: number, max: number): number => (finite(value) ? Math.min(max, Math.max(min, value)) : fallback);

/** Un contour d'au moins trois points finis, ou null. */
function polygon(value: unknown): XY[] | null {
  if (!Array.isArray(value) || value.length > MAX_OUTLINE_POINTS) return null;
  const points = value.filter((p): p is XY => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]));
  return points.length === value.length && points.length >= 3 ? points.map(([x, y]) => [x, y]) : null;
}

const records = (value: unknown, max = Infinity): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord).slice(0, max) : []);

function parseVolume(raw: Record<string, unknown>, uses: readonly Use[]): Volume | null {
  const footprint = polygon(raw.footprint);
  if (!footprint) return null;
  const volume: Volume = {
    ...raw,
    id: text(raw.id, newId()),
    name: text(raw.name, 'Volume'),
    footprint,
    baseLevel: number(raw.baseLevel, 0),
    floors: Math.round(clamped(raw.floors, 1, 1, MAX_FLOORS)),
    floorHeight: clamped(raw.floorHeight, 3, MIN_FLOOR_HEIGHT, MAX_FLOOR_HEIGHT),
    use: text(raw.use, uses[0]?.id ?? 'autre'),
  };
  if (Array.isArray(raw.floorUses)) volume.floorUses = raw.floorUses.slice(0, MAX_FLOORS).map((use) => (typeof use === 'string' ? use : ''));
  else delete volume.floorUses;
  return volume;
}

function parseTerrain(raw: unknown): TerrainGrid | null {
  if (!isRecord(raw)) return null;
  const { west, south, step, columns, rows, heights } = raw;
  if (!finite(west) || !finite(south) || !finite(step) || step <= 0 || !Number.isInteger(columns) || !Number.isInteger(rows)) return null;
  if ((columns as number) < 2 || (rows as number) < 2 || (columns as number) * (rows as number) > MAX_TERRAIN_CELLS || !Array.isArray(heights) || heights.length !== (columns as number) * (rows as number) || !heights.every(finite)) return null;
  return { ...raw, west, south, step, columns: columns as number, rows: rows as number, heights: [...heights] };
}

/** Couleur « #RRGGBB » seulement ; tout le reste (CSS injecté, noms, rgb()…) est remplacé par `fallback`. */
export function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

/** Lit une étude ; lève une erreur en français si ce n'est pas une étude lisible. */
export function parseStudy(raw: unknown): Study {
  if (!isRecord(raw) || raw.format !== STUDY_FORMAT) throw new Error('Ce fichier n’est pas une étude de site.');
  if (raw.version !== STUDY_VERSION) throw new Error(`Version d’étude ${String(raw.version)} non prise en charge (version lue : ${STUDY_VERSION}).`);
  const base = newStudy();

  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  const uses = records(rawSettings.uses).flatMap((use): Use[] => (typeof use.id === 'string' && use.id
    ? [{ ...use, id: use.id, name: text(use.name, use.id), color: safeColor(use.color, '#9b7fd1'), housing: use.housing === true }]
    : []));
  const settings: StudySettings = {
    ...rawSettings,
    uses: uses.length > 0 ? uses : base.settings.uses,
    dwellingSize: number(rawSettings.dwellingSize, base.settings.dwellingSize, 1),
    efficiency: Math.min(1, number(rawSettings.efficiency, base.settings.efficiency, 0)),
    units: rawSettings.units === 'ft2' ? 'ft2' : 'm2',
  };

  const rawSite = isRecord(raw.site) ? raw.site : {};
  const rawOrigin = isRecord(rawSite.origin) ? rawSite.origin : {};
  const { latitude, longitude } = rawOrigin;
  if (!finite(latitude) || Math.abs(latitude) > 90) throw new Error('Latitude du site absente ou hors limites.');
  if (!finite(longitude) || Math.abs(longitude) > 180) throw new Error('Longitude du site absente ou hors limites.');
  const site: Site = {
    ...rawSite,
    origin: { ...rawOrigin, latitude, longitude, altitude: number(rawOrigin.altitude, 0) },
    utcOffset: Math.max(-12, Math.min(14, number(rawSite.utcOffset, 0))),
    limit: polygon(rawSite.limit) ?? [],
  };

  const rawContext = isRecord(raw.context) ? raw.context : {};
  const context: StudyContext = {
    ...rawContext,
    buildings: records(rawContext.buildings, MAX_NEIGHBOURS).flatMap((b): Neighbour[] => {
      const footprint = polygon(b.footprint);
      if (!footprint || !finite(b.height) || b.height <= 0) return [];
      const heightSource: HeightSource = b.heightSource === 'measured' || b.heightSource === 'tagged' ? b.heightSource : 'assumed';
      const out: Neighbour = { ...b, id: text(b.id, newId()), footprint, height: b.height, heightSource };
      if (b.edited === true) out.edited = true;
      else delete out.edited;
      return [out];
    }),
    terrain: parseTerrain(rawContext.terrain),
    credits: Array.isArray(rawContext.credits) ? rawContext.credits.filter((c): c is string => typeof c === 'string') : [],
    radius: number(rawContext.radius, 0, 0),
    fetchedAt: typeof rawContext.fetchedAt === 'string' ? rawContext.fetchedAt : null,
  };

  const proposals = records(raw.proposals, MAX_PROPOSALS).map((p, i): Proposal => ({
    ...p,
    id: text(p.id, newId()),
    name: text(p.name, `Proposition ${i + 1}`),
    volumes: records(p.volumes, MAX_VOLUMES).flatMap((v) => parseVolume(v, settings.uses) ?? []),
  }));

  return {
    ...raw,
    format: STUDY_FORMAT,
    version: STUDY_VERSION,
    name: text(raw.name, base.name),
    site,
    context,
    proposals: proposals.length > 0 ? proposals : base.proposals,
    settings,
  };
}

export const studyToJson = (study: Study): string => JSON.stringify(study, null, 1);
