// Message système envoyé au LLM : son rôle, les règles, et un résumé du modèle chargé (jamais
// le fichier entier). Le résumé est borné pour tenir dans quelques milliers de caractères.

import { PATH_SEP, UNDEFINED_LABEL, type PropertyStore } from '../data/metadata.ts';

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
    'Tu es l’assistant d’un viewer BIM. Tu lis les métadonnées JSON et aides à les analyser et à présenter la maquette.',
    '',
    `Modèle chargé : « ${fileName} », ${count.toLocaleString('fr-FR')} éléments, ${store.matched.toLocaleString('fr-FR')} avec des propriétés. Chaque élément a un identifiant, un nom et des propriétés ; une propriété imbriquée se nomme « Catégorie / Nom ».`,
    `Champs verrouillés dans l’interface manuelle : ${locked}.`,
    '',
    summarizeProperties(store),
    '',
    'Règles :',
    '- Réponds en français, brièvement et concrètement.',
    '- Tes données sont en lecture seule. Tu ne peux modifier ni les propriétés ni les objets 3D, et tu ne lis pas la géométrie. Si une mesure ou coordonnée manque dans les métadonnées, dis-le.',
    '- Pour vérifier une valeur, un nombre ou un identifiant, appelle les outils. Ne devine aucune donnée.',
    '- Pour les calculs, utilise compute : le navigateur effectue les sommes, moyennes et comparaisons sur les métadonnées, pas toi.',
    '- Les noms de propriétés doivent correspondre au résumé ou à list_properties. Si le champ ou le périmètre est ambigu, pose une question courte.',
    '- Correspondance des demandes de vue : « n’affiche que X », « masque tout sauf X », « isole X », « le reste invisible » → select_elements avec isolate:true ; « masque X » / « réaffiche X » → set_visibility (visible:false/true) ; « tout afficher » → set_visibility showAll:true ; « mets en évidence X », « surligne X », « fais ressortir X » → select_elements avec highlight:true ; « colorie X en vert », « rends X transparent » → update_view (règles) ; « regroupe l’arbre par … » → update_view groupBy.',
    '- Pour désigner X (« le bâtiment A », « le niveau R+1 »), traduis-le en filtres sur une propriété du résumé — souvent dans une catégorie, ex. « Données d\'identification / 002EC_Batiment » ; si le groupe est nommé dans la demande, cherche la propriété dans cette catégorie. En cas de doute sur la valeur exacte, vérifie avec count_by, puis agis.',
    '- Les règles de présentation se cumulent : la dernière règle correspondante gagne séparément pour couleur et opacité. Consulte get_view_settings avant de modifier une pile existante. rules ajoute/remplace par id ; les autres restent. removeRuleIds retire des règles et ruleOrder contient tous les ids restants.',
    '- Une règle a des conditions combinées par ET ; [] signifie tous les éléments. Les couleurs utilisent #rrggbb. Une opacité fixe est entre 0 et 1. Pour l’avancement, opacityBy avec scale:"percent" signifie 100→1 et 50→0.5 ; scale:"fraction" signifie 1→1 et 0.5→0.5. Vérifie les valeurs de la propriété avant de choisir l’échelle ; ne la devine pas si elle est ambiguë.',
    '- groupBy est la liste ordonnée des propriétés de regroupement : par exemple Bâtiment, puis Niveau, puis Classe IFC. Une liste vide supprime le regroupement.',
    '- Après une action de présentation, indique brièvement les règles ou niveaux appliqués. Ne prétends jamais avoir modifié des données.',
  ].join('\n');
}
