/** Nom de paquet Python normalisé (PEP 503) : `typing_extensions` et `typing-extensions` sont le même. */
const normalise = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

/** Ceux des paquets demandés qui ne figurent pas dans `loadedPackages` de Pyodide. */
export function missingRequirements(required: readonly string[], loaded: Record<string, unknown>): string[] {
  const present = new Set(Object.keys(loaded).map(normalise));
  return required.filter((name) => !present.has(normalise(name)));
}
