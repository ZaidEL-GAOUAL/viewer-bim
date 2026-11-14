// Propriétés requises : une liste de règles (« pour ces éléments, ces propriétés doivent avoir une valeur ») vérifiée sur les
// métadonnées, et la lecture d'un fichier IDS 1.0 de buildingSMART (facettes entité, attribut, propriété : existence et
// valeur simple). Ce qu'un IDS demande et que ce module ne sait pas vérifier est listé, jamais ignoré en silence.
// Aucun nom de propriété n'est connu ici : la correspondance IFC → propriétés du viewer est une donnée (data/presets).

import { isMissing, matchesCondition, valueAt, type ElementIdentity, type RuleCondition } from './conditions.ts';
import { PATH_SEP, formatValue, type PropValue, type PropertyStore } from './metadata.ts';
import { child, parseXml, type XmlNode } from './xml.ts';

export interface Requirement {
  property: string;
  /** Valeur exigée ; absente : seule la présence compte. */
  value?: PropValue;
  /** `required` : doit être renseignée ; `prohibited` : doit être absente ; `optional` : si elle est renseignée, elle vaut `value`. */
  cardinality: 'required' | 'optional' | 'prohibited';
}

export interface RequirementRule {
  name: string;
  /** Les éléments concernés : toutes les conditions (ET) ; vide : tous les éléments. */
  applies: RuleCondition[];
  requirements: Requirement[];
}

/** Un manquement : la règle (son rang), l'élément, la propriété, ce qui est requis et ce qui est en place. */
export interface Failure {
  rule: number;
  element: number;
  property: string;
  required: string;
  actual: string;
  /** `required` : une valeur à saisir corrige le manquement. */
  cardinality: Requirement['cardinality'];
}

const requiredText = ({ value, cardinality }: Requirement): string =>
  cardinality === 'prohibited' ? (value === undefined ? 'absente' : `différente de ${formatValue(value)}`)
    : cardinality === 'optional' ? `vide ou ${formatValue(value)}`
      : value === undefined ? 'renseignée' : formatValue(value);

/** Vérifie les règles sur les éléments donnés (tous par défaut). Pur : ne lit que les propriétés. */
export function checkRequirements(store: PropertyStore, rules: readonly RequirementRule[], identity?: ElementIdentity, elements?: Iterable<number>): Failure[] {
  const failures: Failure[] = [];
  const indices = elements ? [...elements] : Array.from({ length: store.count }, (_, i) => i);
  rules.forEach((rule, r) => {
    for (const element of indices) {
      if (!rule.applies.every((condition) => matchesCondition(valueAt(store, identity, element, condition.property), condition))) continue;
      for (const requirement of rule.requirements) {
        const actual = valueAt(store, identity, element, requirement.property);
        const missing = isMissing(actual);
        const equal = requirement.value === undefined || matchesCondition(actual, { property: requirement.property, op: 'equals', value: requirement.value });
        const fails = requirement.cardinality === 'required' ? missing || !equal
          : requirement.cardinality === 'prohibited' ? !missing && equal
            : !missing && !equal;
        if (fails) failures.push({ rule: r, element, property: requirement.property, required: requiredText(requirement), actual: formatValue(actual), cardinality: requirement.cardinality });
      }
    }
  });
  return failures;
}

// ------------------------------------------------------------------ liste simple

/**
 * Une règle par ligne : `éléments -> propriétés`. Les éléments : `*` (tous) ou `Propriété = valeur` ; les propriétés, séparées
 * par `;`, chacune seule (doit être renseignée) ou `Propriété = valeur`. Une ligne vide ou commençant par `#` est ignorée.
 */
export function parseRequirementList(text: string): RequirementRule[] {
  const rules: RequirementRule[] = [];
  text.split(/\r?\n/).forEach((raw, line) => {
    const content = raw.trim();
    if (!content || content.startsWith('#')) return;
    const match = /^(.*?)\s*(?:->|=>|→)\s*(.*)$/.exec(content);
    if (!match) throw new Error(`Ligne ${line + 1} : « éléments -> propriétés » attendu (par exemple « Catégorie = Mur -> Résistance au feu »).`);
    const pair = (part: string): [string, string | undefined] => {
      const at = part.indexOf('=');
      return at < 0 ? [part.trim(), undefined] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    };
    const target = match[1].trim();
    const applies: RuleCondition[] = [];
    if (target && target !== '*') {
      const [property, value] = pair(target);
      if (!property || value === undefined) throw new Error(`Ligne ${line + 1} : les éléments s’écrivent « Propriété = valeur » ou « * ».`);
      applies.push({ property, op: 'equals', value });
    }
    const requirements = match[2].split(';').map((part) => part.trim()).filter(Boolean).map((part): Requirement => {
      const [property, value] = pair(part);
      return value === undefined || value === '' ? { property, cardinality: 'required' } : { property, value, cardinality: 'required' };
    });
    if (requirements.length === 0) throw new Error(`Ligne ${line + 1} : aucune propriété requise après « -> ».`);
    rules.push({ name: content, applies, requirements });
  });
  return rules;
}

// ------------------------------------------------------------------ IDS

/** Correspondance entre l'IFC et les propriétés du viewer (le préréglage IFC de data/presets). */
export interface IdsMapping {
  /** Propriété qui porte la classe IFC (facette entité). */
  classProperty: string;
  /** Propriété qui porte le type prédéfini, si le modèle en a une. */
  predefinedTypeProperty?: string;
  /** Attribut IFC → propriété du viewer (`#nom` pour le nom affiché). */
  attributes?: Record<string, string>;
}

/**
 * Lit un fichier IDS 1.0 : une règle par spécification. Les facettes entité, attribut et propriété sont reprises (présence et
 * valeur simple) ; le reste (classification, matériau, partOf, restrictions de valeur, type de données) est listé dans
 * `unsupported`. Une spécification dont l'applicabilité ne peut pas être lue est écartée, et listée.
 */
export function parseIds(xml: string, mapping: IdsMapping): { title: string; rules: RequirementRule[]; unsupported: string[] } {
  const root = child(parseXml(xml), 'ids');
  if (!root) throw new Error('Ce fichier n’est pas un IDS : l’élément <ids> manque.');
  const unsupported = new Set<string>();
  const rules: RequirementRule[] = [];
  const specifications = child(root, 'specifications')?.children.filter((node) => node.name === 'specification') ?? [];
  for (const [index, specification] of specifications.entries()) {
    const name = specification.attributes.name || `Spécification ${index + 1}`;
    /** La valeur simple d'un champ, `undefined` s'il est absent, null s'il est donné autrement (restriction). */
    const simple = (node: XmlNode | undefined, what: string): string | null | undefined => {
      if (!node) return undefined;
      const value = child(node, 'simpleValue');
      if (value) return value.text.trim();
      unsupported.add(`« ${name} » : ${what} donné par une restriction (motif, liste, bornes), non vérifié`);
      return null;
    };
    /** Une facette en conditions (applicabilité) ou en exigences ; null si elle ne peut pas l'être (la raison est listée). */
    const facet = (node: XmlNode): Requirement[] | null => {
      const cardinality = (node.attributes.cardinality ?? 'required') as Requirement['cardinality'];
      if (!['required', 'optional', 'prohibited'].includes(cardinality)) {
        unsupported.add(`« ${name} » : cardinalité « ${cardinality} » inconnue`);
        return null;
      }
      let property: string | undefined;
      let value: string | null | undefined;
      if (node.name === 'entity') {
        const entity = simple(child(node, 'name'), 'la classe');
        if (!entity) return null;
        const out: Requirement[] = [{ property: mapping.classProperty, value: entity, cardinality: 'required' }];
        const predefined = simple(child(node, 'predefinedType'), 'le type prédéfini');
        if (predefined === null) return null;
        if (predefined !== undefined) {
          if (!mapping.predefinedTypeProperty) {
            unsupported.add(`« ${name} » : type prédéfini « ${predefined} » sans propriété correspondante dans le viewer`);
            return null;
          }
          out.push({ property: mapping.predefinedTypeProperty, value: predefined, cardinality: 'required' });
        }
        return out;
      }
      if (node.name === 'attribute') {
        const attribute = simple(child(node, 'name'), 'le nom d’attribut');
        if (!attribute) return null;
        property = mapping.attributes?.[attribute];
        if (!property) {
          unsupported.add(`« ${name} » : attribut IFC « ${attribute} » sans propriété correspondante dans le viewer`);
          return null;
        }
      } else if (node.name === 'property') {
        const set = simple(child(node, 'propertySet'), 'le jeu de propriétés');
        const base = simple(child(node, 'baseName'), 'le nom de propriété');
        if (!set || !base) return null;
        property = `${set}${PATH_SEP}${base}`;
        if (node.attributes.dataType) unsupported.add(`« ${name} » : type de données (${node.attributes.dataType}) non vérifié`);
      } else {
        unsupported.add(`« ${name} » : facette « ${node.name} » non prise en charge`);
        return null;
      }
      value = simple(child(node, 'value'), 'la valeur');
      if (value === null) return null;
      return [value === undefined ? { property, cardinality } : { property, value, cardinality }];
    };

    const applies: RuleCondition[] = [];
    let readable = true;
    for (const node of child(specification, 'applicability')?.children ?? []) {
      const conditions = facet(node);
      if (!conditions) readable = false;
      for (const condition of conditions ?? []) {
        applies.push(condition.value === undefined ? { property: condition.property, op: 'present' } : { property: condition.property, op: 'equals', value: condition.value });
      }
    }
    if (!readable) {
      unsupported.add(`« ${name} » : spécification non vérifiée, son applicabilité utilise ce que le viewer ne sait pas lire`);
      continue;
    }
    const requirements: Requirement[] = [];
    for (const node of child(specification, 'requirements')?.children ?? []) requirements.push(...(facet(node) ?? []));
    if (requirements.length > 0) rules.push({ name, applies, requirements });
  }
  return { title: child(child(root, 'info'), 'title')?.text.trim() ?? '', rules, unsupported: [...unsupported] };
}

// ------------------------------------------------------------------ rapport

/** Le rapport en CSV (séparateur « ; », pour un tableur réglé en français) : une ligne par manquement. */
export function failuresCsv(failures: readonly Failure[], rules: readonly RequirementRule[], keys: readonly string[], labelOf: (element: number) => string): string {
  const cell = (value: string) => (/[;"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [['Règle', 'Élément', 'Identifiant', 'Propriété', 'Requis', 'Valeur actuelle'].join(';')];
  for (const failure of failures) {
    lines.push([rules[failure.rule]?.name ?? '', labelOf(failure.element), keys[failure.element] ?? '', failure.property, failure.required, failure.actual].map(cell).join(';'));
  }
  return lines.join('\r\n');
}
