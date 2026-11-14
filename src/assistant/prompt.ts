// Message système envoyé au LLM : le protocole, un résumé du modèle chargé (jamais le fichier
// entier) et les outils en une ligne chacun. Le résumé est borné à quelques milliers de caractères.

import { PATH_SEP, UNDEFINED_LABEL, rankedValues, type PropertyStore } from '../data/metadata.ts';
import { FORMAT, TOOL_RESULT_PREFIX, toolLines } from './protocol.ts';

const MAX_GENERAL = 40;
const MAX_CATEGORIES = 30;
const VALUES_LISTED = 20;
const LINE_CHARS = 320;
const EXAMPLES = 4;

interface ModelSummary {
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
      const values = rankedValues(store, path).map(([label, members]) => `${label} (${members.length})`);
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
  if (categoryLines.length > 0) text += `\n\nCatégories (nom complet d’une propriété : catégorie, « / », propriété) :\n${categoryLines.join('\n')}`;
  return text;
}

/**
 * Message système du traducteur (couche 2) : le protocole JSON, le résumé du modèle, une ligne par
 * outil. Les schémas complets ne partent qu'en seconde chance (protocol.ts) ; la correspondance des
 * phrases courantes (« isole », « masque »…) est traitée par les commandes (intent.ts), sans modèle.
 */
export function buildSystemPrompt({ fileName, count, store }: ModelSummary): string {
  const locked = store.readOnly.length > 0 ? store.readOnly.join(', ') : 'aucune';
  // Un exemple tiré du modèle : un gabarit comme « Catégorie / Nom » était recopié tel quel.
  const nested = store.paths.find((path) => path.includes(PATH_SEP));
  const nesting = nested
    ? `Une propriété rangée dans une catégorie s’écrit en entier, catégorie comprise, par exemple « ${nested} ».`
    : 'Les propriétés n’ont pas de catégorie.';
  return [
    'Tu traduis les demandes faites à un viewer BIM en requêtes pour ses outils. Le viewer vérifie la requête, exécute l’outil et écrit lui-même le compte rendu à l’utilisateur.',
    FORMAT,
    `Le résultat d’un outil te revient dans un message « ${TOOL_RESULT_PREFIX}outil] … » ; continue (4 étapes au plus) ou termine par {"answer": "…"}. Après une action réussie, termine par {"answer": ""} sauf si la demande comporte une autre action distincte.`,
    '',
    `Modèle chargé : « ${fileName} », ${count.toLocaleString('fr-FR')} éléments, ${store.matched.toLocaleString('fr-FR')} avec des propriétés. ${nesting}`,
    'Chaque élément a aussi un nom affiché et un identifiant, qui ne sont pas des propriétés : ils se filtrent avec property "#nom" et "#id".',
    `Champs verrouillés (non modifiables) : ${locked}.`,
    '',
    summarizeProperties(store),
    '',
    'Outils (« ? » : facultatif) :',
    toolLines(),
    'filters : liste de {property, op, value} combinés par ET, [] pour tous ; op : equals (défaut), not_equals, contains, missing, present, greater, less, greater_or_equal, less_or_equal. scope : "model" (défaut) ou "selection".',
    'Formules (compute, set_property) : propriétés entre crochets, ex. [Longueur] * [Hauteur] ; condition : [Porteur] == true and [FireRating] == null.',
    'update_view : rules = [{id, conditions: filters, color: "#rrggbb" ou opacity: 0..1}], groupBy = [propriétés].',
    'plan_dates : orderBy = la propriété qui groupe les tâches (le niveau…) ; « N jours/semaines par étage » → daysPerGroup en jours, sans end ; filters = [] sauf si l’utilisateur limite le périmètre. N’invente ni filtre, ni date de fin, ni order.',
    '',
    'Règles :',
    '- Ne devine aucune donnée : les noms de propriétés viennent du résumé ou de list_properties, les valeurs se vérifient (count_by). Les calculs se font avec compute.',
    '- Un identifiant cité par l’utilisateur est signalé entre crochets à la fin de sa demande : filtre alors uniquement sur "#id".',
    '- Tu n’écris des propriétés qu’avec set_property et plan_dates (annulables). Tu ne lis ni ne modifies la géométrie : si une mesure manque dans les métadonnées, dis-le.',
    '- Si la propriété, la valeur ou le périmètre est ambigu, pose une question courte avec {"answer": "…"}.',
    '- Après un refus (réponse invalide ou erreur d’outil), corrige seulement l’argument fautif et garde le reste de la requête.',
    '- Réponds en français.',
  ].join('\n');
}
