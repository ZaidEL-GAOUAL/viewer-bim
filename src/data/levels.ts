// Niveaux du modèle (section `levels` du contrat, voir docs/contrat-metadonnees.md) : un nom et une altitude en mètres,
// dans le repère du modèle (le Y du GLB, c'est-à-dire la hauteur Z de l'IFC). Ils donnent un plan par niveau quand le
// fichier n'en a pas, et la coupe « au niveau ».

import { isRecord } from './json.ts';
import { fold } from './text.ts';
import type { SavedView } from './savedViews.ts';

export interface Level {
  name: string;
  elevation: number;
}

/** Hauteur de coupe d'un plan au-dessus de son niveau, en mètres (celle des plans d'étage usuels). */
export const PLAN_CUT_HEIGHT = 1.2;

/** Lit la section `levels`, triée par altitude. Une entrée sans nom ou sans altitude finie est écartée. */
export function parseLevels(raw: unknown): Level[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Level => isRecord(item) && typeof item.name === 'string' && item.name !== '' && typeof item.elevation === 'number' && Number.isFinite(item.elevation))
    .map(({ name, elevation }) => ({ name, elevation }))
    .sort((a, b) => a.elevation - b.elevation);
}

export const levelsToJson = (levels: readonly Level[]): Level[] => levels.map(({ name, elevation }) => ({ name, elevation }));

/** Une profondeur de vue à moins de 5 cm d'un niveau : le plan du fichier est celui de ce niveau. */
const SAME_LEVEL = 0.05;

/**
 * Un plan par niveau que les plans du fichier ne couvrent pas (même nom, ou profondeur de vue au niveau) : vu de dessus, en
 * projection parallèle cadrée sur la maquette, coupé à `PLAN_CUT_HEIGHT` au-dessus du niveau, profondeur de vue au niveau.
 * Calculés à la demande, ils ne sont pas enregistrés tant que l'utilisateur ne les enregistre pas.
 */
export function levelPlans(levels: readonly Level[], views: readonly SavedView[]): SavedView[] {
  const plans = views.filter((view) => view.kind === 'plan');
  const covered = (level: Level) => plans.some((plan) => fold(plan.name) === fold(level.name) || (plan.range?.bottom !== undefined && Math.abs(plan.range.bottom - level.elevation) < SAME_LEVEL));
  return levels.filter((level) => !covered(level)).map((level) => ({
    name: `Plan du niveau ${level.name}`,
    kind: 'plan',
    range: { bottom: level.elevation, top: level.elevation + PLAN_CUT_HEIGHT },
    // Sans `size`, la caméra d'un plan cadre la maquette : seule la direction compte. Le haut de l'écran est le nord du
    // projet (+Y de l'IFC, −Z du GLB).
    camera: { position: [0, level.elevation + PLAN_CUT_HEIGHT, 0], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic' },
  }));
}
