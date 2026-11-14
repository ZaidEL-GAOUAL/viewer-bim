// Quand préparer le moteur IFC d'avance : dès qu'un fichier est glissé sur la fenêtre, quand on
// approche ou active « Ouvrir », ou après 2 s d'inactivité si ce navigateur a déjà converti un IFC.
// Ne fait que déclencher `preload` : c'est lui (preloadIfc) qui refuse en économie de données ou
// avec peu de mémoire.

const USED_KEY = 'viewer-bim.ifc-converted';
export const IDLE_PRELOAD_MS = 2000;

export interface IntentStorage {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

/** À appeler après une conversion réussie : les prochaines visites préchargeront le moteur à l'inactivité. */
export function rememberIfcUse(storage: IntentStorage): void {
  storage.set(USED_KEY, '1');
}

export function watchPreloadIntent(options: {
  /** La fenêtre (pour le glisser-déposer de fichiers). */
  page: EventTarget;
  /** Le bouton « Ouvrir ». */
  openControl: EventTarget;
  preload: () => void;
  storage: IntentStorage;
  schedule?: (callback: () => void, ms: number) => unknown;
}): void {
  const { page, openControl, preload, storage, schedule = setTimeout } = options;
  page.addEventListener('dragenter', (event) => {
    if ((event as DragEvent).dataTransfer?.types.includes('Files')) preload();
  });
  for (const type of ['pointerenter', 'focus']) openControl.addEventListener(type, preload);
  if (storage.get(USED_KEY)) schedule(preload, IDLE_PRELOAD_MS);
}
