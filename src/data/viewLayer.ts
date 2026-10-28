// Ce que la phase et la vue enregistrée masquent, et le passage d'un état au suivant. Les deux ne sont pas une couche
// d'affichage à part : elles écrivent la visibilité des éléments, comme l'arbre et les filtres (voir App.syncLayerVisibility).
// Ces fonctions pures disent seulement quoi masquer et quoi réafficher, pour que le choix de l'utilisateur sur les autres
// éléments ne soit jamais touché.

/** Réunit des masques (1 = masqué) ; `null` quand ils ne masquent rien, ou qu'il n'y en a pas. */
export function combineHidden(count: number, ...masks: (Uint8Array | null | undefined)[]): Uint8Array | null {
  const present = masks.filter((mask): mask is Uint8Array => mask !== null && mask !== undefined);
  if (present.length === 0) return null;
  const out = new Uint8Array(count);
  let any = false;
  for (const mask of present) {
    for (let i = 0; i < count; i++) {
      if (mask[i] === 1) {
        out[i] = 1;
        any = true;
      }
    }
  }
  return any ? out : null;
}

/** Les éléments à masquer et ceux à réafficher quand on passe de `before` à `next`. Les autres ne bougent pas. */
export function layerChanges(count: number, before: Uint8Array | null, next: Uint8Array | null): { hide: number[]; show: number[] } {
  const hide: number[] = [], show: number[] = [];
  for (let i = 0; i < count; i++) {
    const was = before?.[i] === 1, now = next?.[i] === 1;
    if (now && !was) hide.push(i);
    else if (was && !now) show.push(i);
  }
  return { hide, show };
}
