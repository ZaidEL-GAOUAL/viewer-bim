// Message système envoyé au LLM : son rôle, les règles, et un résumé du modèle chargé (jamais
// le fichier entier). Le résumé est borné pour tenir dans quelques milliers de caractères.

import { PATH_SEP, UNDEFINED_LABEL, type PropertyStore } from '../data/metadata.ts';
import { GEOMETRY_PATHS } from './tools.ts';

const MAX_GENERAL = 40;
const MAX_CATEGORIES = 30;
const VALUES_LISTED = 20;
const LINE_CHARS = 320;
const EXAMPLES = 4;

export interface ModelSummary {
  fileName: string;
  count: number;
  store: PropertyStore;
}

/** Une ligne de valeurs bornée en longueur : les premières, puis « +N autres ». */
function valuesLine(values: string[]): string {
  let text = '';
  for (let i = 0; i < values.length; i++) {
    const next = text ? `${text}, ${values[i]}` : values[i];
    if (next.length > LINE_CHARS && i > 0) return `${text} … (+${values.length - i} autres)`;
    text = next;
  }
  return text;
}

/**
 * Résumé des propriétés : les générales avec leurs valeurs, les catégories par ordre de
 * présence. Les catégories portées par presque aucun élément (un jeu de propriétés par porte,
 * exporté par certains logiciels) sont comptées sans être listées.
 */
export function summarizeProperties(store: PropertyStore): string {
  const general: string[] = [];
  const categories = new Map<string, string[]>();
  for (const path of store.paths) {
    const cut = path.lastIndexOf(PATH_SEP);
    if (cut < 0) general.push(path);
    else {
      const category = path.slice(0, cut);
      const list = categories.get(category);
      if (list) list.push(path.slice(cut + PATH_SEP.length));
      else categories.set(category, [path.slice(cut + PATH_SEP.length)]);
    }
  }

  const lines: string[] = [];
  for (const path of general.slice(0, MAX_GENERAL)) {
    const { count: distinct } = store.distinctCount(path, VALUES_LISTED);
    const lock = store.isEditable(path) ? '' : ' [verrouillée]';
    if (distinct <= VALUES_LISTED) {
      const groups = store.groups(path);
      const values = [...groups.entries()]
        .filter(([label]) => label !== UNDEFINED_LABEL)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([label, members]) => `${label} (${members.length})`);
      const missing = groups.get(UNDEFINED_LABEL)?.length ?? 0;
      lines.push(`- ${path}${lock} : ${valuesLine(values)}${missing > 0 ? ` ; non défini (${missing})` : ''}`);
    } else {
      const examples: string[] = [];
      for (const label of store.groups(path).keys()) {
        if (label === UNDEFINED_LABEL) continue;
        examples.push(label);
        if (examples.length >= EXAMPLES) break;
      }
      lines.push(`- ${path}${lock} : plus de ${VALUES_LISTED} valeurs distinctes, ex. ${valuesLine(examples)}`);
    }
  }
  if (general.length > MAX_GENERAL) lines.push(`- … et ${general.length - MAX_GENERAL} autres propriétés générales (voir list_properties)`);

  // Présence de chaque catégorie : nombre d'éléments qui ont au moins une de ses propriétés.
  const coverage = new Map<string, number>();
  for (let i = 0; i < store.count; i++) {
    const props = store.propsOf(i);
    if (!props) continue;
    const seen = new Set<string>();
    for (const path of Object.keys(props)) {
      const cut = path.lastIndexOf(PATH_SEP);
      if (cut >= 0) seen.add(path.slice(0, cut));
    }
    for (const category of seen) coverage.set(category, (coverage.get(category) ?? 0) + 1);
  }
  const rareBelow = Math.max(2, Math.ceil(store.count * 0.01));
  const ranked = [...categories.keys()].sort((a, b) => (coverage.get(b) ?? 0) - (coverage.get(a) ?? 0) || a.localeCompare(b, 'fr'));
  const common = ranked.filter((category) => (coverage.get(category) ?? 0) >= rareBelow);
  const rare = ranked.length - common.length;

  const categoryLines: string[] = [];
  for (const category of common.slice(0, MAX_CATEGORIES)) {
    const names = categories.get(category)!;
    const lock = store.isEditable(`${category}${PATH_SEP}${names[0]}`) ? '' : ' [verrouillée]';
    categoryLines.push(`- ${category}${lock} (${coverage.get(category)} éléments) : ${valuesLine(names)}`);
  }
  if (common.length > MAX_CATEGORIES) categoryLines.push(`- … et ${common.length - MAX_CATEGORIES} autres catégories (voir list_properties)`);
  if (rare > 0) categoryLines.push(`- … et ${rare} catégories rares, portées chacune par moins de ${rareBelow} éléments (voir list_properties)`);

  let text = lines.length > 0 ? `Propriétés générales :\n${lines.join('\n')}` : 'Aucune propriété générale.';
  if (categoryLines.length > 0) text += `\n\nCatégories (propriété = « Catégorie / Nom ») :\n${categoryLines.join('\n')}`;
  return text;
}

export function buildSystemPrompt({ fileName, count, store }: ModelSummary): string {
  const locked = store.readOnly.length > 0 ? store.readOnly.join(', ') : 'aucune';
  return [
    'Tu es l’assistant d’un viewer de maquettes BIM. L’utilisateur regarde un modèle 3D dont chaque élément porte des propriétés (métadonnées) ; tu l’aides à les interroger, les vérifier et les compléter.',
    '',
    `Modèle chargé : « ${fileName} », ${count.toLocaleString('fr-FR')} éléments, ${store.matched.toLocaleString('fr-FR')} avec des propriétés. Chaque élément a un identifiant, un nom (libellé) et des propriétés ; une propriété rangée dans une catégorie se nomme « Catégorie / Nom ».`,
    `Propriétés verrouillées (lecture seule, non modifiables, même sur demande) : ${locked}.`,
    '',
    summarizeProperties(store),
    '',
    `Propriétés calculées depuis la 3D (lecture seule, en mètres, repère du projet, Y = vertical), utilisables dans find_elements, select_elements et compute : ${GEOMETRY_PATHS.join(', ')}.`,
    '',
    'Règles :',
    '- Réponds en français, de façon brève et concrète. Pas de formules de politesse inutiles.',
    '- Pour toute question sur les données, appelle les outils : ne devine jamais une valeur, un nombre ou un identifiant. Si la réponse n’est pas dans un résultat d’outil, dis-le.',
    '- Utilise le nom exact des propriétés tel qu’il apparaît ci-dessus (ou dans list_properties).',
    '- Pour modifier ou ajouter des propriétés, utilise set_property. Avant une modification qui touche beaucoup d’éléments ou dont le périmètre est flou, vérifie d’abord avec find_elements et annonce le nombre d’éléments concernés. Après une modification, dis exactement ce qui a changé (propriété, valeur, nombre d’éléments). L’utilisateur peut tout annuler.',
    '- Si la demande est ambiguë (plusieurs propriétés possibles, valeur imprécise), pose une question courte plutôt que de choisir au hasard.',
    '- Ne fais aucun calcul toi-même (sommes, moyennes, vérifications de formules) : utilise compute, qui calcule sur tous les éléments. Les quantités (surfaces, volumes) sont des propriétés du modèle.',
  ].join('\n');
}
