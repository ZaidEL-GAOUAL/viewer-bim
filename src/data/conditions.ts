// Une seule façon de comparer la valeur d'un élément à une condition : règles d'apparence,
// filtres de l'assistant et planning s'appuient tous sur ce module.
//
// Règle : une valeur absente (rien, null ou texte vide) n'est égale à rien. « absente » est donc
// différente de tout, et seules « absent » / « renseigné » parlent des valeurs absentes ;
// « = », « contient », « > » ne les retiennent jamais.

import { ELEMENT_ID, ELEMENT_NAME } from './elementFields.ts';
import { ownValue, type PropValue, type PropertyStore } from './metadata.ts';
import { fold } from './text.ts';

export type RuleOp = 'equals' | 'not_equals' | 'contains' | 'missing' | 'present' | 'greater' | 'less' | 'greater_or_equal' | 'less_or_equal';
export type NumericScale = 'number' | 'percent' | 'fraction';
export interface RuleCondition { property: string; op: RuleOp; value?: PropValue; numericScale?: NumericScale }

export const RULE_OPS: readonly RuleOp[] = ['equals', 'not_equals', 'contains', 'missing', 'present', 'greater', 'less', 'greater_or_equal', 'less_or_equal'];
export const NUMERIC_OPS = new Set<RuleOp>(['greater', 'less', 'greater_or_equal', 'less_or_equal']);

export const isMissing = (value: PropValue | undefined): boolean => value === undefined || value === null || value === '';

/** No inference between 0..1 and 0..100: the rule declares how bare numbers are encoded. */
export function numericValue(value: PropValue | undefined, scale: NumericScale = 'number'): number | undefined {
  if (isMissing(value) || typeof value === 'boolean') return undefined;
  const text = String(value).trim();
  const hasPercent = text.endsWith('%');
  const cleaned = text.replace(/%$/, '').trim().replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cleaned)) return undefined;
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return undefined;
  return scale === 'percent' || (scale === 'fraction' && hasPercent) ? number / 100 : number;
}

/** Texte saisi qui n'est qu'un nombre décimal (« 12 », « -3,5 ») : sa valeur, sinon rien. « 50 % » ou « +33612 » restent du texte. */
export function plainNumber(text: string): number | undefined {
  return /^-?\d+(?:[.,]\d+)?$/.test(text) ? numericValue(text) : undefined;
}

export function matchesCondition(value: PropValue | undefined, condition: RuleCondition): boolean {
  const { op } = condition;
  if (op === 'missing') return isMissing(value);
  if (op === 'present') return !isMissing(value);
  const wanted = condition.value;
  const noWanted = wanted === undefined || wanted === null;
  if (op === 'not_equals' && (isMissing(value) || noWanted)) return true;
  if (isMissing(value)) return false;
  if (op === 'contains') return fold(value).includes(fold(wanted ?? ''));
  const scale = condition.numericScale ?? 'number';
  const a = numericValue(value, scale), b = numericValue(wanted, scale);
  if (NUMERIC_OPS.has(op)) {
    if (a === undefined || b === undefined) return false;
    if (op === 'greater') return a > b;
    if (op === 'less') return a < b;
    if (op === 'greater_or_equal') return a >= b;
    return a <= b;
  }
  if (noWanted) return false;
  const equal = a !== undefined && b !== undefined ? a === b : fold(value) === fold(wanted);
  return op === 'not_equals' ? !equal : equal;
}

/** Ce qui identifie un élément hors de ses métadonnées : son identifiant et son nom affiché. */
export interface ElementIdentity {
  keys: readonly string[];
  label(index: number): string;
}

/** Valeur d'un élément pour une propriété, ou pour #nom / #id quand `element` est donné. */
export function valueAt(store: PropertyStore, element: ElementIdentity | undefined, index: number, property: string): PropValue | undefined {
  if (property === ELEMENT_ID) return element?.keys[index];
  if (property === ELEMENT_NAME) return element?.label(index) ?? store.labelOf(index);
  return ownValue(store.propsOf(index), property);
}
