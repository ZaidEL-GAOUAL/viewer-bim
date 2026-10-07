// Identifiants d'éléments cités tels quels dans la demande (un GlobalId copié depuis la fiche,
// par exemple). Le navigateur les reconnaît lui-même : le modèle n'a pas à le deviner.

/** GlobalId IFC : 22 caractères d'un alphabet fixe. */
const GLOBAL_ID = /^[0-9A-Za-z_$]{22}$/;

/**
 * Seules des clés qui ressemblent à des identifiants comptent : un GlobalId, ou un code d'au
 * moins 6 caractères contenant un chiffre (UUID, « W-0012 »…). Une maquette sans identifiants
 * utilise parfois le nom des nœuds (« Toiture ») : un mot ne doit pas passer pour une citation.
 */
function looksLikeIdentifier(key: string): boolean {
  return GLOBAL_ID.test(key) || (key.length >= 6 && key.length <= 64 && /\d/.test(key) && !/\s/.test(key));
}

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
    if (tokens.has(keys[index]) && looksLikeIdentifier(keys[index])) found.push(index);
  }
  return found;
}

/**
 * Le nom et l'identifiant viennent du fichier de la maquette : ils sont nettoyés (caractères de
 * contrôle, sauts de ligne, crochets et guillemets qui encadrent la précision) et tronqués, pour
 * qu'un fichier ne puisse pas glisser d'instructions dans la demande envoyée au modèle.
 */
function clean(text: string, max: number): string {
  const flat = text.replace(/[\p{C}[\]«»"“”]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Précision ajoutée à la demande envoyée au modèle (l'utilisateur voit son message tel quel). */
export function describeMentions(indices: readonly number[], keys: readonly string[], labelOf: (index: number) => string): string {
  if (indices.length === 0) return '';
  const list = indices.map((index) => `${clean(keys[index], 64)} = « ${clean(labelOf(index), 80)} »`).join(' ; ');
  const plural = indices.length > 1;
  return `\n\n[Viewer : ${plural ? 'identifiants d’éléments reconnus' : 'identifiant d’élément reconnu'} dans la demande — ${list}. ${plural ? 'Ces identifiants désignent ces éléments' : 'Cet identifiant désigne cet élément'} et ${plural ? 'eux seuls' : 'lui seul'} : filtre uniquement sur "#id" (equals), sans filtre sur le nom, même si d’autres éléments portent le même nom.]`;
}
