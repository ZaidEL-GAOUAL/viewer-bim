import { NUMERIC_OPS, RULE_OPS, isMissing, matchesCondition, numericValue, valueAt, type ElementIdentity, type NumericScale, type RuleCondition, type RuleOp } from './conditions.ts';
import { isElementField } from './elementFields.ts';
import { isRecord } from './json.ts';
import { ownValue, type PropValue, type PropertyStore } from './metadata.ts';
import { fold } from './text.ts';

export interface AppearanceRule {
  id: string;
  name?: string;
  enabled: boolean;
  /** All conditions must match. An empty list applies to every element. */
  conditions: RuleCondition[];
  color?: string;
  /** Absolute opacity: 0 = invisible, 1 = opaque. */
  opacity?: number;
  opacityBy?: { property: string; scale: 'percent' | 'fraction' };
}
export interface ElementAppearance { color?: string; opacity?: number }
/**
 * Last matching rule wins independently for color and opacity. Neither metadata nor visibility is mutated.
 * Conditions may also read the element's displayed name (#nom) and identifier (#id) when `element` is given.
 */
export function evaluateAppearanceRules(store: PropertyStore, rules: readonly AppearanceRule[], element?: ElementIdentity): Map<number, ElementAppearance> {
  const read = (index: number, property: string): PropValue | undefined => valueAt(store, element, index, property);
  const result = new Map<number, ElementAppearance>();
  const active = rules.filter((rule) => rule.enabled);
  const indexes = new Map<string, Map<string, number[]>>();
  const keyOf = (value: PropValue | undefined, scale: NumericScale) => {
    const numeric = numericValue(value, scale);
    return numeric === undefined ? `s:${fold(value)}` : `n:${numeric}`;
  };
  const candidates = (conditions: RuleCondition[]): Iterable<number> => {
    const equal = conditions.find((condition) => condition.op === 'equals');
    if (!equal) return Array.from({ length: store.count }, (_, index) => index);
    const scale = equal.numericScale ?? 'number', key = `${equal.property}\u0000${scale}`;
    let groups = indexes.get(key);
    if (!groups) {
      groups = new Map(); indexes.set(key, groups);
      for (let index = 0; index < store.count; index++) {
        const value = read(index, equal.property);
        if (isMissing(value)) continue;
        const bucketKey = keyOf(value, scale), bucket = groups.get(bucketKey);
        if (bucket) bucket.push(index); else groups.set(bucketKey, [index]);
      }
    }
    return groups.get(keyOf(equal.value, scale)) ?? [];
  };
  // Index equality conditions once per property so a categorical palette does not rescan every object for every value.
  for (const rule of active) {
    for (const index of candidates(rule.conditions)) {
      const props = store.propsOf(index);
      if (!rule.conditions.every((condition) => matchesCondition(read(index, condition.property), condition))) continue;
      let appearance = result.get(index);
      if (rule.color !== undefined) (appearance ??= {}).color = rule.color;
      if (rule.opacity !== undefined) (appearance ??= {}).opacity = rule.opacity;
      if (rule.opacityBy) {
        const value = numericValue(ownValue(props, rule.opacityBy.property), rule.opacityBy.scale);
        // Missing/non-numeric progress preserves the opacity from earlier rules.
        if (value !== undefined) (appearance ??= {}).opacity = Math.min(1, Math.max(0, value));
      }
      if (appearance) result.set(index, appearance);
    }
  }
  return result;
}

/**
 * Returns detached, normalized rules. Omit store when managing a saved stack: deleted
 * properties remain valid references and evaluate as missing until restored. When editing,
 * retained rules allow their own missing references while new references must exist.
 */
export function validateAppearanceRules(raw: unknown, store?: PropertyStore, retainedRules: readonly AppearanceRule[] = []): AppearanceRule[] {
  if (!Array.isArray(raw)) throw new Error('Les règles doivent former une liste.');
  const ids = new Set<string>();
  const retainedById = new Map(retainedRules.map((rule) => [rule.id, rule]));
  const property = (value: unknown, retained: ReadonlySet<string>): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Chaque condition nécessite une propriété.');
    if (store && !store.paths.includes(value) && !isElementField(value) && !retained.has(value)) throw new Error(`Propriété introuvable : ${value}.`);
    return value;
  };
  return raw.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) throw new Error('Chaque règle nécessite un identifiant.');
    if (ids.has(value.id)) throw new Error(`Identifiant de règle en double : ${value.id}.`);
    ids.add(value.id);
    const saved = retainedById.get(value.id);
    const retained = new Set(saved?.conditions.map((condition) => condition.property));
    if (saved?.opacityBy) retained.add(saved.opacityBy.property);
    if (typeof value.enabled !== 'boolean') throw new Error('enabled doit être un booléen.');
    if (value.name !== undefined && typeof value.name !== 'string') throw new Error('Le nom de la règle doit être un texte.');
    if (!Array.isArray(value.conditions)) throw new Error('conditions doit être une liste (vide pour tous les éléments).');
    const conditions: RuleCondition[] = value.conditions.map((condition) => {
      if (!isRecord(condition) || !RULE_OPS.includes(condition.op as RuleOp)) throw new Error('Opérateur de condition inconnu.');
      const result: RuleCondition = { property: property(condition.property, retained), op: condition.op as RuleOp };
      if (condition.numericScale !== undefined) {
        if (!['number', 'percent', 'fraction'].includes(String(condition.numericScale))) throw new Error('Échelle numérique inconnue.');
        result.numericScale = condition.numericScale as NumericScale;
      }
      if (!['missing', 'present'].includes(result.op)) {
        const v = condition.value;
        if (!(v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))) throw new Error('Valeur de condition invalide.');
        result.value = v;
        if (NUMERIC_OPS.has(result.op) && numericValue(v, result.numericScale) === undefined) throw new Error('Une comparaison numérique nécessite un nombre.');
      }
      return result;
    });
    const rule: AppearanceRule = { id: value.id, enabled: value.enabled, conditions, ...(typeof value.name === 'string' ? { name: value.name } : {}) };
    if (value.color !== undefined) {
      if (typeof value.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.color)) throw new Error('La couleur doit être au format #rrggbb.');
      rule.color = value.color.toLowerCase();
    }
    if (value.opacity !== undefined) {
      if (typeof value.opacity !== 'number' || !Number.isFinite(value.opacity) || value.opacity < 0 || value.opacity > 1) throw new Error('L’opacité doit être comprise entre 0 et 1.');
      rule.opacity = value.opacity;
    }
    if (value.opacityBy !== undefined) {
      if (!isRecord(value.opacityBy) || !['percent', 'fraction'].includes(String(value.opacityBy.scale))) throw new Error('L’opacité par propriété nécessite une échelle percent (0–100) ou fraction (0–1).');
      rule.opacityBy = { property: property(value.opacityBy.property, retained), scale: value.opacityBy.scale as 'percent' | 'fraction' };
      if (isElementField(rule.opacityBy.property)) throw new Error('L’opacité doit suivre une propriété numérique, pas le nom ou l’identifiant.');
      if (rule.opacity !== undefined) throw new Error('Choisissez une opacité fixe ou liée à une propriété dans une même règle.');
    }
    if (rule.color === undefined && rule.opacity === undefined && rule.opacityBy === undefined) throw new Error('Une règle doit définir une couleur ou une opacité.');
    return rule;
  });
}
