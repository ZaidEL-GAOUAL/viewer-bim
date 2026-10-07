// Champs propres à chaque élément — son nom affiché et son identifiant — utilisables comme des
// propriétés dans les filtres de l'assistant et les règles d'apparence. Ils ne sont pas dans
// les métadonnées : « Mur pignon est » n'est souvent que le nom de l'élément.

export const ELEMENT_NAME = '#nom';
export const ELEMENT_ID = '#id';
export const ELEMENT_FIELDS: readonly string[] = [ELEMENT_NAME, ELEMENT_ID];
export const ELEMENT_FIELD_LABELS: Readonly<Record<string, string>> = { [ELEMENT_NAME]: 'Nom de l’élément', [ELEMENT_ID]: 'Identifiant' };

export function isElementField(path: string): boolean {
  return path === ELEMENT_NAME || path === ELEMENT_ID;
}

/** Libellé lisible d'une propriété ou d'un champ d'élément. */
export function fieldLabel(path: string): string {
  return ELEMENT_FIELD_LABELS[path] ?? path;
}
