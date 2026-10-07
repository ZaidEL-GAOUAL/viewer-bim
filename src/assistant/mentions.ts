// Identifiants d'éléments cités tels quels dans la demande (un GlobalId copié depuis la fiche,
// par exemple). Le navigateur les reconnaît lui-même : le modèle n'a pas à le deviner.

/** Indices des éléments dont l'identifiant figure mot pour mot dans le texte. */
export function mentionedElements(text: string, keys: readonly string[], limit = 20): number[] {
  const tokens = new Set(
    text.split(/[\s,;:()«»"“”'‘’!?<>[\]{}]+/)
      .map((token) => token.replace(/\.+$/, ''))
      .filter((token) => token.length >= 6),
  );
  if (tokens.size === 0) return [];
  const found: number[] = [];
  for (let index = 0; index < keys.length && found.length < limit; index++) {
    if (tokens.has(keys[index])) found.push(index);
  }
  return found;
}

/** Précision ajoutée à la demande envoyée au modèle (l'utilisateur voit son message tel quel). */
export function describeMentions(indices: readonly number[], keys: readonly string[], labelOf: (index: number) => string): string {
  if (indices.length === 0) return '';
  const list = indices.map((index) => `${keys[index]} = « ${labelOf(index)} »`).join(' ; ');
  const plural = indices.length > 1;
  return `\n\n[Viewer : ${plural ? 'identifiants d’éléments reconnus' : 'identifiant d’élément reconnu'} dans la demande — ${list}. ${plural ? 'Ces identifiants désignent ces éléments' : 'Cet identifiant désigne cet élément'} et ${plural ? 'eux seuls' : 'lui seul'} : filtre uniquement sur "#id" (equals), sans filtre sur le nom, même si d’autres éléments portent le même nom.]`;
}
