// Phases du projet (voir docs/contrat-metadonnees.md, § « Phases ») : lecture de la section `phases` du JSON et calcul
// de l'état de chaque élément dans la phase choisie. Rien ici ne suppose un nom de propriété ni de phase : la section
// dit quelles propriétés portent la phase de création et de démolition, et dans quel ordre vont les phases.

import type { ElementAppearance } from './appearanceRules.ts';
import type { PropValue } from './metadata.ts';

/** État d'un élément dans la phase d'une vue : de l'ordre « avant » à « après ». */
export const PHASE_STATUSES = ['past', 'existing', 'demolished', 'new', 'temporary', 'future'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

/** Ce que le filtre fait d'un état : le dessiner tel quel, avec son remplacement graphique, ou le masquer. */
export type PhasePresentation = 'normal' | 'overridden' | 'hidden';

export interface PhaseFilter {
  name: string;
  /** Filtre des vues neuves. */
  default: boolean;
  statuses: Record<PhaseStatus, PhasePresentation>;
}

/** Remplacement graphique d'un état (couleur #rrggbb, opacité 0 à 1). */
export interface PhaseOverride {
  color?: string;
  opacity?: number;
}

export interface Phases {
  /** Les phases, de la plus ancienne à la plus récente. */
  order: string[];
  /** Nom de la propriété qui porte la phase de création de chaque élément. */
  created: string;
  /** Nom de la propriété qui porte la phase de démolition, s'il y en a une. */
  demolished?: string;
  filters: PhaseFilter[];
  overrides: Partial<Record<PhaseStatus, PhaseOverride>>;
}

/**
 * Remplacements quand le fichier n'en donne pas : l'existant en gris, le démoli en rouge et translucide, le temporaire
 * en bleu. Un état « nouveau » n'est jamais teinté sans que le fichier le demande.
 */
export const DEFAULT_OVERRIDES: Readonly<Record<PhaseStatus, PhaseOverride>> = {
  past: { color: '#b0b0b0', opacity: 0.4 },
  existing: { color: '#808080' },
  demolished: { color: '#e03131', opacity: 0.6 },
  new: {},
  temporary: { color: '#1971c2', opacity: 0.6 },
  future: { color: '#b0b0b0', opacity: 0.4 },
};

const PRESENTATIONS: readonly PhasePresentation[] = ['normal', 'overridden', 'hidden'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lit la section `phases`. Une section illisible est ignorée (le reste du fichier garde son sens) : il faut au moins
 * une phase et le nom de la propriété de création. Un état absent d'un filtre est dessiné tel quel.
 */
export function parsePhases(raw: unknown): Phases | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.order) || typeof raw.created !== 'string' || raw.created === '') return undefined;
  const order = [...new Set(raw.order.filter((name): name is string => typeof name === 'string' && name !== ''))];
  if (order.length === 0) return undefined;
  const phases: Phases = { order, created: raw.created, filters: [], overrides: {} };
  if (typeof raw.demolished === 'string' && raw.demolished !== '') phases.demolished = raw.demolished;

  if (Array.isArray(raw.filters)) {
    for (const item of raw.filters) {
      if (!isRecord(item) || typeof item.name !== 'string' || item.name === '' || phases.filters.some((filter) => filter.name === item.name)) continue;
      const statuses = Object.fromEntries(PHASE_STATUSES.map((status) => [status, 'normal'])) as Record<PhaseStatus, PhasePresentation>;
      if (isRecord(item.statuses)) {
        for (const status of PHASE_STATUSES) {
          const value = item.statuses[status];
          if (PRESENTATIONS.includes(value as PhasePresentation)) statuses[status] = value as PhasePresentation;
        }
      }
      phases.filters.push({ name: item.name, default: item.default === true, statuses });
    }
  }
  if (isRecord(raw.overrides)) {
    for (const status of PHASE_STATUSES) {
      const item = raw.overrides[status];
      if (!isRecord(item)) continue;
      const override: PhaseOverride = {};
      if (typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color)) override.color = item.color.toLowerCase();
      if (typeof item.opacity === 'number' && Number.isFinite(item.opacity)) override.opacity = Math.min(1, Math.max(0, item.opacity));
      if (override.color !== undefined || override.opacity !== undefined) phases.overrides[status] = override;
    }
  }
  return phases;
}

/**
 * État d'un élément dans la phase d'indice `current`, d'après les indices de sa phase de création et de sa phase de
 * démolition (dans l'ordre des phases) :
 * - créé après la phase : « futur » ;
 * - démoli avant la phase : « passé » ;
 * - démoli dans la phase : « temporaire » s'il y est aussi créé, « démoli » sinon ;
 * - sinon : « nouveau » s'il est créé dans la phase, « existant » s'il l'est avant.
 * Une démolition avant la création (une incohérence) est ramenée à la création.
 */
export function phaseStatus(created: number, demolished: number | undefined, current: number): PhaseStatus {
  if (created > current) return 'future';
  const end = demolished === undefined ? Infinity : Math.max(demolished, created);
  if (end < current) return 'past';
  if (end === current) return created === current ? 'temporary' : 'demolished';
  return created === current ? 'new' : 'existing';
}

/** Le filtre de ce nom, à défaut le filtre des vues neuves, à défaut le premier. */
export function resolveFilter(phases: Phases, name?: string): PhaseFilter | undefined {
  return phases.filters.find((filter) => filter.name === name) ?? phases.filters.find((filter) => filter.default) ?? phases.filters[0];
}

export interface PhaseSelection {
  /** Phase de la vue, dans `Phases.order`. */
  phase: string;
  /** Nom du filtre de phase ; à défaut, celui des vues neuves. */
  filter?: string;
}

export interface PhaseEvaluation {
  /** 1 pour chaque élément que le filtre masque dans cette phase. */
  hidden: Uint8Array;
  /** Remplacements graphiques des éléments « remplacés » par le filtre. */
  appearance: Map<number, ElementAppearance>;
  /** Nombre d'éléments par état, et nombre d'éléments sans phase (que le filtre ne touche pas). */
  counts: Record<PhaseStatus, number>;
  unphased: number;
}

/**
 * Calcule ce que la phase et le filtre font de chaque élément. Un élément sans phase de création connue (propriété
 * absente, ou phase qui n'est pas dans l'ordre) n'est pas lié aux phases : il reste affiché tel quel, comme dans Revit
 * (niveaux, trames). `valueOf(index, propriété)` lit la propriété d'un élément.
 */
export function evaluatePhases(
  phases: Phases,
  selection: PhaseSelection,
  count: number,
  valueOf: (index: number, property: string) => PropValue | undefined,
): PhaseEvaluation {
  const current = phases.order.indexOf(selection.phase);
  const filter = resolveFilter(phases, selection.filter);
  const hidden = new Uint8Array(count);
  const appearance = new Map<number, ElementAppearance>();
  const counts = Object.fromEntries(PHASE_STATUSES.map((status) => [status, 0])) as Record<PhaseStatus, number>;
  let unphased = 0;
  const indexOf = (value: PropValue | undefined): number | undefined => {
    if (typeof value !== 'string') return undefined;
    const index = phases.order.indexOf(value);
    return index < 0 ? undefined : index;
  };
  for (let i = 0; i < count; i++) {
    const created = current < 0 ? undefined : indexOf(valueOf(i, phases.created));
    if (created === undefined) { unphased++; continue; }
    const demolished = phases.demolished === undefined ? undefined : indexOf(valueOf(i, phases.demolished));
    const status = phaseStatus(created, demolished, current);
    counts[status]++;
    const presentation = filter?.statuses[status] ?? 'normal';
    if (presentation === 'hidden') hidden[i] = 1;
    else if (presentation === 'overridden') {
      // Le remplacement du fichier vaut en entier : sans opacité, l'état est opaque (l'écrivain ne la donne que si le matériau
      // de Revit est translucide). Les remplacements du viewer ne servent qu'aux états que le fichier ne remplace pas.
      const { color, opacity } = phases.overrides[status] ?? DEFAULT_OVERRIDES[status];
      if (color !== undefined || opacity !== undefined) appearance.set(i, { ...(color !== undefined ? { color } : {}), ...(opacity !== undefined && opacity < 1 ? { opacity } : {}) });
    }
  }
  return { hidden, appearance, counts, unphased };
}

/** Fusionne deux apparences par élément : celles de `over` l'emportent attribut par attribut. */
export function mergeAppearance(under: ReadonlyMap<number, ElementAppearance>, over: ReadonlyMap<number, ElementAppearance>): Map<number, ElementAppearance> {
  const merged = new Map<number, ElementAppearance>();
  for (const [index, appearance] of under) merged.set(index, { ...appearance });
  for (const [index, appearance] of over) merged.set(index, { ...merged.get(index), ...appearance });
  return merged;
}

/** La section `phases` au format du contrat (pour réexporter les métadonnées). */
export function phasesToJson(phases: Phases): Record<string, unknown> {
  const out: Record<string, unknown> = { order: [...phases.order], created: phases.created };
  if (phases.demolished !== undefined) out.demolished = phases.demolished;
  out.filters = phases.filters.map((filter) => ({ name: filter.name, ...(filter.default ? { default: true } : {}), statuses: { ...filter.statuses } }));
  if (Object.keys(phases.overrides).length > 0) out.overrides = Object.fromEntries(Object.entries(phases.overrides).map(([status, override]) => [status, { ...override }]));
  return out;
}
