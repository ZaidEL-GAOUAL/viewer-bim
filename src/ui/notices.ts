/** Un message à montrer à l'utilisateur : `error` en fait un message d'erreur (plus long, en rouge). */
export interface Notice {
  text: string;
  error: boolean;
}

/**
 * Réunit les messages d'un même chargement en un seul, le plus grave d'abord : une erreur ne doit pas
 * disparaître derrière un avertissement ou une information (la zone de message n'en montre qu'un à la fois).
 * À gravité égale, l'ordre d'arrivée est gardé.
 */
export function combineNotices(notices: readonly Notice[]): Notice | null {
  if (notices.length === 0) return null;
  const ordered = [...notices.filter((notice) => notice.error), ...notices.filter((notice) => !notice.error)];
  return { text: ordered.map((notice) => notice.text).join(' '), error: ordered[0].error };
}
