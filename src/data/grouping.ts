import { PATH_SEP, compareValues, type PropertyStore } from './metadata.ts';

export interface TreeGroup {
  /** Clé unique dans l'arbre (chemin des libellés depuis la racine). */
  key: string;
  label: string;
  /** Propriété utilisée pour ce niveau de regroupement. */
  path: string;
  /** Tous les éléments du groupe, sous-groupes compris. */
  elements: number[];
  children: TreeGroup[];
}

const KEY_SEP = '\u001f';

/**
 * Construit l'arborescence en regroupant les éléments selon une liste ordonnée de propriétés :
 * la première donne les groupes, la suivante les sous-groupes, etc.
 */
export function buildTree(store: PropertyStore, paths: string[], elements: number[], parentKey = ''): TreeGroup[] {
  if (paths.length === 0) return [];
  const [path, ...rest] = paths;
  const buckets = new Map<string, number[]>();
  for (const index of elements) {
    const value = store.displayValue(index, path);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(index);
    else buckets.set(value, [index]);
  }
  return [...buckets.keys()].sort(compareValues).map((label) => {
    const members = buckets.get(label)!;
    const key = parentKey + KEY_SEP + label;
    return { key, label, path, elements: members, children: buildTree(store, rest, members, key) };
  });
}

/**
 * Propose une propriété de regroupement par défaut : une propriété renseignée sur presque tous
 * les éléments, avec peu de valeurs distinctes (ni une seule, ni presque une par élément).
 * À couverture équivalente, on préfère au moins trois valeurs à un simple oui/non.
 */
export function suggestGrouping(store: PropertyStore): string | undefined {
  const limit = Math.max(2, Math.min(100, Math.floor(store.count / 2)));
  const candidates: { path: string; size: number; coverage: number }[] = [];
  for (const path of store.paths) {
    // Comptage rapide, interrompu dès que la propriété a trop de valeurs distinctes.
    const { count: size, undefinedCount } = store.distinctCount(path, limit);
    if (size < 2 || size > limit) continue;
    candidates.push({ path, size, coverage: store.count - undefinedCount });
  }
  if (candidates.length === 0) return undefined;
  const bestCoverage = Math.max(...candidates.map((candidate) => candidate.coverage));
  const covered = candidates.filter((candidate) => candidate.coverage >= bestCoverage * 0.9);
  // Une propriété générale (« Niveau », « Catégorie ») passe avant une propriété rangée dans une
  // catégorie (« Dimensions / Hauteur ») : elle décrit mieux l'organisation du modèle.
  const rank = (candidate: { path: string; size: number }) =>
    (candidate.path.includes(PATH_SEP) ? 10_000 : 0) + (candidate.size >= 3 ? candidate.size : 1000 + candidate.size);
  covered.sort((a, b) => rank(a) - rank(b));
  return covered[0].path;
}
