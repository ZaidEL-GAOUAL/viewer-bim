/** Mémoire supposée quand le navigateur ne la dit pas (Firefox, Safari) : la même pour l'IFC et pour Revit. */
export const ASSUMED_MEMORY_GB = 4;

/** `navigator.deviceMemory` en Go (plafonné à 8 par les navigateurs), ou rien s'il n'est pas disponible. */
export function deviceMemoryGB(): number | undefined {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}
