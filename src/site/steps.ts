// Les cinq étapes d'une étude, dans l'ordre : ce que chacune demande pour commencer, quand elle est faite, et la
// phrase qui le dit. Pur : la page lit l'état ici, l'interface n'a pas à le redécider.

export type StepId = 'lieu' | 'terrain' | 'voisinage' | 'volumes' | 'analyses';
export type NeighbourStatus = 'none' | 'loading' | 'loaded' | 'failed';

export interface StepState {
  placed: boolean;
  limit: boolean;
  neighbours: NeighbourStatus;
  /** Volumes de la proposition affichée. */
  volumes: number;
}

export interface Step {
  id: StepId;
  title: string;
  /** Une phrase : ce qu'il y a à faire dans l'étape. */
  instruction: string;
}

export const STEPS: readonly Step[] = [
  { id: 'lieu', title: 'Lieu', instruction: 'Cherchez l’adresse ou le lieu du projet, ou cliquez sur la carte.' },
  { id: 'terrain', title: 'Terrain', instruction: 'Tracez la limite de votre terrain : cliquez ses coins sur la carte, puis le premier point pour fermer.' },
  { id: 'voisinage', title: 'Voisinage', instruction: 'Les bâtiments voisins et le relief se chargent tout seuls ; cliquez un bâtiment pour corriger sa hauteur.' },
  { id: 'volumes', title: 'Volumes', instruction: 'Dessinez vos bâtiments sur le terrain, puis réglez leurs niveaux et leur usage.' },
  { id: 'analyses', title: 'Analyses', instruction: 'Lisez les chiffres, jouez les ombres d’une journée, puis lancez une analyse.' },
];

export interface Missing {
  message: string;
  /** L'étape où le faire. */
  goTo: StepId;
}

/** Ce qui manque pour commencer cette étape (le premier manque), ou null. */
export function missingFor(step: StepId, state: StepState): Missing | null {
  if (step === 'lieu') return null;
  if (!state.placed) return { message: 'Choisissez d’abord le lieu du projet (étape 1).', goTo: 'lieu' };
  if (step === 'terrain' || step === 'voisinage') return null;
  if (!state.limit) return { message: 'Tracez d’abord la limite du terrain (étape 2).', goTo: 'terrain' };
  if (step === 'analyses' && state.volumes === 0) return { message: 'Dessinez d’abord un volume (étape 4).', goTo: 'volumes' };
  return null;
}

/** Ce qui manque sans empêcher l'étape : une phrase, ou null. */
export function warningFor(step: StepId, state: StepState): string | null {
  if (step !== 'analyses' || !state.placed) return null;
  if (state.neighbours === 'loading') return 'Le voisinage se charge encore : les ombres des bâtiments voisins arrivent dans un instant.';
  if (state.neighbours !== 'loaded') return 'Le voisinage n’est pas chargé : les ombres des bâtiments voisins manquent (étape 3).';
  return null;
}

export function isDone(step: StepId, state: StepState): boolean {
  switch (step) {
    case 'lieu': return state.placed;
    case 'terrain': return state.limit;
    case 'voisinage': return state.neighbours === 'loaded';
    case 'volumes': return state.volumes > 0;
    case 'analyses': return false;
  }
}

/** L'étape à proposer : la première qui n'est pas faite (les analyses quand tout l'est). */
export function nextStep(state: StepState): StepId {
  return STEPS.find((step) => !isDone(step.id, state) && step.id !== 'analyses')?.id ?? 'analyses';
}
