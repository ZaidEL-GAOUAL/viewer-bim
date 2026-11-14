// Couche 3 : ce que l'assistant dit d'une action est écrit par le code, d'après le résultat de
// l'outil, jamais par le modèle. Une écriture importante passe d'abord par un aperçu à confirmer.

import { formatValue, type PropValue } from '../data/metadata.ts';
import { integer, plural, s } from '../data/text.ts';
import { runTool, type ToolContext, type ToolOutcome } from './tools.ts';

/** Au-delà de ce nombre d'éléments (ou sur toute la maquette), une écriture de l'assistant est montrée avant d'être faite. */
export const CONFIRM_ABOVE = 200;
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['set_property', 'plan_dates']);
export const VIEW_TOOLS: ReadonlySet<string> = new Set(['select_elements', 'set_visibility', 'update_view']);
const TABLE_ROWS = 12;

export interface Table { columns: string[]; rows: string[][]; more?: number }
export interface Answer {
  /** write : annulable par l'historique des propriétés ; view : par l'action inverse ; read : rien à annuler. */
  kind: 'write' | 'view' | 'read' | 'error';
  text: string;
  table?: Table;
  figures?: [string, string][];
}

type Result = Record<string, unknown>;
const cell = (value: unknown): string => (value === null || value === undefined ? '—' : typeof value === 'object' ? JSON.stringify(value) : formatValue(value as PropValue));
const number = (value: unknown): string => (typeof value === 'number' ? formatValue(value) : '—');
const table = (columns: string[], rows: string[][], total = rows.length): Table => ({ columns, rows: rows.slice(0, TABLE_ROWS), ...(total > Math.min(rows.length, TABLE_ROWS) ? { more: total - Math.min(rows.length, TABLE_ROWS) } : {}) });

/** « Mur A, Mur B et 12 autres » : les premiers noms rendus par l'outil. */
function names(result: Result): string {
  const list = Array.isArray(result.elements) ? (result.elements as unknown[]).filter((item): item is string => typeof item === 'string') : [];
  if (list.length === 0) return '';
  const extra = (typeof result.more === 'number' ? result.more : 0) + Math.max(0, list.length - 5);
  return ` : ${list.slice(0, 5).join(', ')}${extra > 0 ? ` et ${plural(extra, 'autre')}` : ''}`;
}

function errorAnswer(result: Result): Answer {
  const existing = result.existingValues && typeof result.existingValues === 'object' ? Object.entries(result.existingValues as Record<string, string[]>) : [];
  const hint = existing.map(([path, values]) => ` Valeurs de « ${path} » : ${values.slice(0, 8).join(', ')}${values.length > 8 ? '…' : ''}.`).join('');
  const text = String(result.error).startsWith('Aucun élément ne vérifie') ? 'Aucun élément ne correspond.' : String(result.error);
  return { kind: 'error', text: `${text}${hint}` };
}

/** La phrase (et le tableau) qui rend compte d'un outil exécuté, d'après son seul résultat. */
export function answerFor(name: string, args: Record<string, unknown>, outcome: ToolOutcome): Answer {
  const result = (outcome.result ?? {}) as Result;
  if (typeof result.error === 'string') return errorAnswer(result);
  switch (name) {
    case 'select_elements': {
      const count = Number(result.count) || 0;
      const verb = result.isolated ? 'isolé' : result.highlighted ? 'mis en évidence' : 'sélectionné';
      const done = verb === 'mis en évidence' ? verb : `${verb}${s(count)}`;
      return { kind: 'view', text: `${plural(count, 'élément')} ${done}${names(result)}.${result.notHighlighted ? ' Mise en évidence impossible : ils sont seulement sélectionnés.' : ''}` };
    }
    case 'set_visibility':
      if (result.shown !== undefined) return { kind: 'view', text: 'Toute la maquette est réaffichée.' };
      return { kind: 'view', text: `${plural(Number(result.changed) || 0, 'élément')} ${result.visible ? 'réaffiché' : 'masqué'}${s(Number(result.changed))}${names(result)}.` };
    case 'update_view': {
      const parts: string[] = [];
      for (const rule of (args.rules ?? []) as Result[]) {
        const effect = rule.color ? `couleur ${rule.color}` : typeof rule.opacity === 'number' ? `opacité ${Math.round(rule.opacity * 100)} %` : rule.opacityBy ? 'opacité selon une propriété' : '';
        parts.push(`Règle « ${rule.name ?? rule.id} »${effect ? ` (${effect})` : ''} appliquée.`);
      }
      const removed = (args.removeRuleIds ?? []) as string[];
      if (removed.length > 0) parts.push(`${plural(removed.length, 'règle retirée', 'règles retirées')}.`);
      if (args.ruleOrder !== undefined) parts.push('Ordre des règles mis à jour.');
      if (args.groupBy !== undefined) {
        const paths = (result.groupBy ?? args.groupBy) as string[];
        parts.push(paths.length > 0 ? `Arborescence regroupée par ${paths.join(', puis ')}.` : 'Regroupement de l’arborescence supprimé.');
      }
      return { kind: 'view', text: parts.join(' ') || 'Présentation mise à jour.' };
    }
    case 'set_property': {
      const count = Number(result.count) || 0;
      if (result.unchanged) return { kind: 'read', text: `Rien n’a changé : ces éléments avaient déjà cette valeur de « ${result.property} ».` };
      const skipped = typeof result.skipped === 'number' ? ` ${plural(result.skipped, 'élément')} ignoré${s(result.skipped)} : la formule n’y donne pas de valeur.` : '';
      return { kind: 'write', text: `« ${result.property} » ${result.created ? 'ajoutée' : 'modifiée'} sur ${plural(count, 'élément')}${names(result)}.${skipped}` };
    }
    case 'plan_dates': {
      const planning = (result.planning ?? {}) as Result;
      const opened = planning.opened ? ` Planning 4D ouvert (${plural(Number(planning.tasks) || 0, 'tâche')}).` : planning.error ? ` Planning 4D non ouvert : ${planning.error}` : '';
      const periods = (result.periods ?? []) as Result[];
      return {
        kind: result.unchanged ? 'read' : 'write',
        text: `${result.unchanged ? 'Ces dates étaient déjà écrites' : 'Dates de début et de fin écrites'} sur ${plural(Number(result.elements) || 0, 'élément')}, du ${result.from} au ${result.to}.${opened}`,
        table: table(['Période', 'Éléments', 'Début', 'Fin'], periods.map((period) => [String(period.value), cell(period.elements), String(period.from), String(period.to)]), periods.length + (Number(result.morePeriods) || 0)),
      };
    }
    case 'count_by': {
      const values = (result.values ?? []) as Result[];
      return {
        kind: 'read',
        text: `Répartition par « ${result.property} » : ${plural(Number(result.total) || 0, 'élément')}, ${plural(Number(result.distinct) || 0, 'valeur')}.`,
        table: table(['Valeur', 'Éléments'], values.map((item) => [item.value === null ? '(non défini)' : String(item.value), cell(item.count)]), Number(result.distinct) || values.length),
      };
    }
    case 'find_elements': {
      const count = Number(result.count) || 0;
      const elements = (result.elements ?? []) as Result[];
      const columns = [...new Set(elements.flatMap((element) => Object.keys(element)).filter((key) => key !== 'label' && key !== 'id'))];
      return {
        kind: 'read',
        text: `${plural(count, 'élément')} trouvé${s(count)}.`,
        ...(elements.length > 0 ? { table: table(['Élément', ...columns], elements.map((element) => [String(element.label ?? element.id), ...columns.map((key) => cell(element[key]))]), count) } : {}),
      };
    }
    case 'list_properties': {
      const properties = (result.properties ?? []) as Result[];
      return {
        kind: 'read',
        text: `${plural(Number(result.total) || 0, 'propriété')}.`,
        table: table(['Propriété', 'Valeurs distinctes', 'Sans valeur'], properties.map((item) => [`${item.property}${item.locked ? ' (verrouillée)' : ''}`, cell(item.distinct), cell(item.missing)]), Number(result.total) || properties.length),
      };
    }
    case 'get_element': {
      const elements = (result.elements ?? []) as Result[];
      const first = elements[0] ?? {};
      const properties = Object.entries((first.properties ?? {}) as Record<string, unknown>);
      return {
        kind: 'read',
        text: `Fiche de « ${first.label} »${elements.length > 1 ? ` (${plural(elements.length - 1, 'autre élément trouvé', 'autres éléments trouvés')})` : ''}.`,
        table: table(['Propriété', 'Valeur'], properties.map(([key, value]) => [key, cell(value)]), properties.length),
      };
    }
    case 'compute': {
      const figures: [string, string][] = [];
      if (result.matching !== undefined) figures.push(['Condition vraie', `${integer.format(Number(result.matching))} sur ${integer.format(Number(result.elements))}`]);
      if (result.sum !== undefined) {
        figures.push(['Somme', number(result.sum)], ['Moyenne', number(result.mean)], ['Minimum', number(result.min)], ['Maximum', number(result.max)], ['Éléments calculés', number(result.computed)]);
        if (Number(result.skipped) > 0) figures.push(['Ignorés (valeur absente)', number(result.skipped)]);
      }
      const examples = (result.examples ?? []) as Result[];
      return {
        kind: 'read',
        text: `Calcul sur ${plural(Number(result.elements) || 0, 'élément')}.`,
        figures,
        ...(examples.length > 0 ? { table: table(['Élément', 'Valeur'], examples.map((item) => [String(item.label), cell(item.value)]), Number(result.matching ?? result.computed) || examples.length) } : {}),
      };
    }
    case 'get_view_settings': {
      const rules = (result.rules ?? []) as Result[];
      const grouping = (result.groupBy ?? []) as string[];
      return {
        kind: 'read',
        text: `${plural(rules.length, 'règle')} de présentation. ${grouping.length > 0 ? `Arborescence regroupée par ${grouping.join(', puis ')}.` : 'Arborescence non regroupée.'}`,
        ...(rules.length > 0 ? { table: table(['Règle', 'Active', 'Effet'], rules.map((rule) => [String(rule.name ?? rule.id), rule.enabled ? 'oui' : 'non', rule.color ? String(rule.color) : typeof rule.opacity === 'number' ? `opacité ${Math.round(rule.opacity * 100)} %` : 'opacité selon une propriété'])) } : {}),
      };
    }
    default:
      return { kind: 'read', text: outcome.note };
  }
}

/**
 * Une écriture large (plus de CONFIRM_ABOVE éléments, ou toute la maquette) est d'abord calculée à
 * blanc : son aperçu est rendu, rien n'est écrit. null : l'écriture peut se faire directement (ou
 * l'outil va de toute façon refuser, et le dira).
 */
export function previewWrite(name: string, args: Record<string, unknown>, context: ToolContext): ToolOutcome | null {
  if (!WRITE_TOOLS.has(name) || args.dryRun === true) return null;
  const dry = runTool(name, { ...args, dryRun: true }, context);
  const result = dry.result as Result;
  const count = Number(name === 'set_property' ? result.count : result.elements);
  if (typeof result.error === 'string' || !Number.isFinite(count)) return null;
  return count > CONFIRM_ABOVE || count === context.count ? dry : null;
}

/** Le texte et l'échantillon d'un aperçu d'écriture. */
export function previewAnswer(name: string, outcome: ToolOutcome, total: number): Answer {
  const result = outcome.result as Result;
  const count = Number(name === 'set_property' ? result.count : result.elements) || 0;
  const whole = count === total ? ' (toute la maquette)' : '';
  if (name === 'set_property') {
    const sample = (result.sample ?? []) as Result[];
    return {
      kind: 'read',
      text: `Écrire « ${result.property} »${result.created ? ' (nouvelle propriété)' : ''} sur ${plural(count, 'élément')}${whole} ? Rien n’est écrit avant « Appliquer ».`,
      table: table(['Élément', 'Avant', 'Après'], sample.map((item) => [String(item.element), cell(item.before), cell(item.after)]), count),
    };
  }
  const periods = (result.periods ?? []) as Result[];
  return {
    kind: 'read',
    text: `Écrire des dates de début et de fin sur ${plural(count, 'élément')}${whole}, du ${result.from} au ${result.to} ? Rien n’est écrit avant « Appliquer ».`,
    table: table(['Période', 'Éléments', 'Début', 'Fin'], periods.map((period) => [String(period.value), cell(period.elements), String(period.from), String(period.to)]), periods.length),
  };
}
