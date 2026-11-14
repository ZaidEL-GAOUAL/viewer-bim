// Règles du moteur IFC (convertisseur Pyodide + IfcOpenShell) : combien de convertisseurs garder
// prêts, et quand en préparer un d'avance. Fonctions pures : le temps et la machine sont passés en
// paramètres, pour que les tests les pilotent sans navigateur.

/** Tous les convertisseurs préparés restent prêts pendant ce délai après la dernière opération. */
export const WARM_ALL_MS = 5 * 60_000;
/** Ensuite il n'en reste qu'un, jusqu'à ce que l'onglet soit resté caché aussi longtemps. */
export const WARM_HIDDEN_MS = 10 * 60_000;
/** En dessous de cette mémoire (Go), on ne garde jamais plus d'un convertisseur, et on n'en prépare pas d'avance. */
export const LOW_MEMORY_GB = 4;

export interface PoolState {
  /** Nombre de convertisseurs actuellement dans le groupe. */
  size: number;
  /** Instant (ms) de la fin de la dernière opération. */
  lastUsed: number;
  /** Instant (ms) où l'onglet est devenu caché, ou null s'il est visible. */
  hiddenSince: number | null;
  /** Mémoire de l'appareil en Go, si le navigateur la donne. */
  memoryGB?: number;
}

export interface Settlement {
  /** Nombre de convertisseurs à garder (les autres sont arrêtés). */
  keep: number;
  /** Dans combien de ms réévaluer, ou null s'il n'y a plus d'échéance (un changement de visibilité le fera). */
  recheckIn: number | null;
}

/** Combien de convertisseurs garder à l'instant `now`, et quand reposer la question. */
export function settle(pool: PoolState, now: number): Settlement {
  const lowMemory = pool.memoryGB !== undefined && pool.memoryGB < LOW_MEMORY_GB;
  const idle = now - pool.lastUsed;
  if (!lowMemory && idle < WARM_ALL_MS) return { keep: pool.size, recheckIn: WARM_ALL_MS - idle };
  // Un seul convertisseur reste prêt, tant que l'onglet n'est pas resté caché assez longtemps.
  if (pool.hiddenSince === null) return { keep: Math.min(pool.size, 1), recheckIn: null };
  const hidden = now - pool.hiddenSince;
  if (hidden >= WARM_HIDDEN_MS) return { keep: 0, recheckIn: null };
  return { keep: Math.min(pool.size, 1), recheckIn: WARM_HIDDEN_MS - hidden };
}

/** Vrai si l'on peut préparer un convertisseur d'avance : ni économie de données, ni peu de mémoire. */
export function mayPreload(conditions: { saveData?: boolean; memoryGB?: number }): boolean {
  if (conditions.saveData) return false;
  return conditions.memoryGB === undefined || conditions.memoryGB >= LOW_MEMORY_GB;
}
