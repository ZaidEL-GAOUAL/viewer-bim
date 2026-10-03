import { ownValue, type PropValue, type PropertyStore } from './metadata.ts';

export interface ScheduleTask {
  id: string;
  name: string;
  /** Civil dates, inclusive, with no time zone or inferred duration. */
  start: string;
  end: string;
  /** Display hierarchy only: no dependency or inherited object binding. */
  parentId?: string;
  elementIds?: string[];
  /** Exact, typed metadata values. Combined with elementIds by union. */
  match?: { property: string; values: Exclude<PropValue, null>[] };
}

export interface Schedule {
  type?: 'bim-schedule';
  version: 1;
  name?: string;
  tasks: ScheduleTask[];
}

export const ScheduleStatus = { context: 0, pending: 1, active: 2, complete: 3 } as const;
export type ScheduleStatusValue = typeof ScheduleStatus[keyof typeof ScheduleStatus];

export interface CompiledTask {
  task: ScheduleTask;
  startDay: number;
  endDay: number;
  elements: number[];
}

export interface ScheduleReport {
  linkedElementCount: number;
  unlinkedElementCount: number;
  unlinkedTaskIds: string[];
  unknownElementIds: string[];
  multipleTaskElementCount: number;
}

export interface CompiledSchedule {
  schedule: Schedule;
  tasks: CompiledTask[];
  startDay: number;
  endDay: number;
  elementCount: number;
  report: ScheduleReport;
}

export interface ScheduleFrame {
  elements: Uint8Array;
  tasks: Uint8Array;
}

const DAY_MS = 86_400_000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Route schedule-shaped files to schedule validation, including invalid/empty documents. */
export function isScheduleDocument(raw: unknown): boolean {
  return record(raw) && ((Object.hasOwn(raw, 'type') && raw.type === 'bim-schedule') || (Object.hasOwn(raw, 'tasks') && Array.isArray(raw.tasks)));
}

/** A UTC integer day avoids daylight-saving changes and Date's permissive rollover. */
export function parseScheduleDate(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    throw new Error('Les dates du planning doivent être au format AAAA-MM-JJ.');
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`Date de planning invalide : ${value}.`);
  }
  return timestamp / DAY_MS;
}

export function formatScheduleDate(day: number): string {
  if (!Number.isInteger(day)) throw new Error('Le jour du planning doit être un entier.');
  const date = new Date(day * DAY_MS);
  if (!Number.isFinite(date.getTime())) throw new Error('Jour de planning invalide.');
  return date.toISOString().split('T')[0];
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} doit être un texte non vide.`);
  return value;
}

/** Validate the whole document before returning a detached schedule (no partial import). */
export function parseSchedule(raw: unknown): Schedule {
  if (!record(raw)) throw new Error('Le planning doit contenir un objet JSON.');
  if (raw.type !== undefined && raw.type !== 'bim-schedule') throw new Error('Type de document de planning inconnu.');
  if (raw.version !== 1) throw new Error('Version du planning non prise en charge : version 1 attendue.');
  if (raw.name !== undefined && typeof raw.name !== 'string') throw new Error('Le nom du planning doit être un texte.');
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error('Le planning doit contenir au moins une tâche.');
  const ids = new Set<string>();
  const tasks: ScheduleTask[] = raw.tasks.map((item, index) => {
    if (!record(item)) throw new Error(`Tâche ${index + 1} invalide.`);
    for (const field of ['action', 'type']) {
      if (item[field] !== undefined && item[field] !== 'construction') {
        throw new Error(`La tâche ${index + 1} utilise ${field}=${String(item[field])}. Ce lecteur 4D prend en charge uniquement la construction.`);
      }
    }
    const id = text(item.id, 'L’identifiant de tâche');
    if (ids.has(id)) throw new Error(`Identifiant de tâche en double : ${id}.`);
    ids.add(id);
    const name = text(item.name, `Le nom de la tâche ${id}`);
    const startDay = parseScheduleDate(item.start), endDay = parseScheduleDate(item.end);
    if (endDay < startDay) throw new Error(`La tâche ${id} se termine avant son début.`);
    const task: ScheduleTask = { id, name, start: item.start as string, end: item.end as string };
    if (item.parentId !== undefined) task.parentId = text(item.parentId, 'L’identifiant de tâche parente');
    if (item.elementIds !== undefined) {
      if (!Array.isArray(item.elementIds)) throw new Error(`elementIds doit être une liste pour la tâche ${id}.`);
      task.elementIds = [...new Set(item.elementIds.map((value) => text(value, 'L’identifiant d’élément')))];
    }
    if (item.match !== undefined) {
      if (!record(item.match) || !Array.isArray(item.match.values) || item.match.values.length === 0) {
        throw new Error(`Le lien par propriété de la tâche ${id} nécessite une liste de valeurs.`);
      }
      const property = text(item.match.property, 'La propriété de liaison');
      const values = item.match.values.map((value) => {
        if (!(typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
          throw new Error(`Valeur de liaison invalide pour la tâche ${id}.`);
        }
        return value;
      });
      task.match = { property, values: [...new Set(values)] };
    }
    return task;
  });

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  // Iterative traversal also accepts large, deeply nested work-breakdown structures.
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    const chain = new Set<string>();
    let current: ScheduleTask | undefined = task;
    while (current && !visited.has(current.id)) {
      if (chain.has(current.id)) throw new Error(`Cycle dans la hiérarchie du planning : ${current.id}.`);
      chain.add(current.id);
      if (!current.parentId) break;
      const parent: ScheduleTask | undefined = byId.get(current.parentId);
      if (!parent) throw new Error(`Tâche parente introuvable : ${current.parentId}.`);
      current = parent;
    }
    for (const id of chain) visited.add(id);
  }
  return { type: 'bim-schedule', version: 1, ...(typeof raw.name === 'string' ? { name: raw.name } : {}), tasks };
}

/** Resolve once when the schedule/model/metadata changes; playback never scans metadata. */
export function compileSchedule(input: Schedule, keys: readonly string[], store: PropertyStore): CompiledSchedule {
  if (keys.length !== store.count) throw new Error('Le planning et les propriétés doivent utiliser le même index d’éléments.');
  const schedule = parseSchedule(input);
  const elementsById = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const bucket = elementsById.get(key);
    if (bucket) bucket.push(index); else elementsById.set(key, [index]);
  });
  const indexes = new Map<string, Map<PropValue, number[]>>();
  const propertyIndex = (property: string) => {
    let index = indexes.get(property);
    if (index) return index;
    index = new Map();
    for (let element = 0; element < store.count; element++) {
      const value = ownValue(store.propsOf(element), property);
      if (value === undefined || value === null) continue;
      const bucket = index.get(value);
      if (bucket) bucket.push(element); else index.set(value, [element]);
    }
    indexes.set(property, index);
    return index;
  };

  const unknownIds = new Set<string>(), linkCounts = new Uint32Array(keys.length);
  let startDay = Infinity, endDay = -Infinity;
  const tasks = schedule.tasks.map((task): CompiledTask => {
    const taskStart = parseScheduleDate(task.start), taskEnd = parseScheduleDate(task.end);
    startDay = Math.min(startDay, taskStart); endDay = Math.max(endDay, taskEnd);
    const elements = new Set<number>();
    for (const id of task.elementIds ?? []) {
      const matches = elementsById.get(id);
      if (matches) for (const element of matches) elements.add(element);
      else unknownIds.add(id);
    }
    if (task.match) {
      const index = propertyIndex(task.match.property);
      for (const value of task.match.values) for (const element of index.get(value) ?? []) elements.add(element);
    }
    for (const element of elements) linkCounts[element]++;
    return { task, startDay: taskStart, endDay: taskEnd, elements: [...elements] };
  });
  let linkedElementCount = 0, multipleTaskElementCount = 0;
  for (const count of linkCounts) {
    if (count > 0) linkedElementCount++;
    if (count > 1) multipleTaskElementCount++;
  }
  const parentIds = new Set(schedule.tasks.map((task) => task.parentId).filter((id) => id !== undefined));
  return {
    schedule, tasks, startDay, endDay, elementCount: keys.length,
    report: {
      linkedElementCount, unlinkedElementCount: keys.length - linkedElementCount,
      // An unbound parent is an intentional summary; broken explicit links still need attention.
      unlinkedTaskIds: tasks.filter(({ task, elements }) => elements.length === 0 && (
        !parentIds.has(task.id) || !!task.elementIds?.length || task.match !== undefined
      )).map(({ task }) => task.id),
      unknownElementIds: [...unknownIds], multipleTaskElementCount,
    },
  };
}

/**
 * Future objects are hidden; current work is highlighted; completed work stays visible.
 * Multiple stages never make a previously started object disappear between tasks.
 * A reusable output is optional for a player that wants to avoid frame allocations.
 */
export function evaluateSchedule(compiled: CompiledSchedule, day: number, output?: ScheduleFrame): ScheduleFrame {
  if (!Number.isInteger(day)) throw new Error('Le jour du planning doit être un entier.');
  const frame = output ?? { elements: new Uint8Array(compiled.elementCount), tasks: new Uint8Array(compiled.tasks.length) };
  if (frame.elements.length !== compiled.elementCount || frame.tasks.length !== compiled.tasks.length) {
    throw new Error('Le résultat 4D ne correspond pas au planning chargé.');
  }
  frame.elements.fill(ScheduleStatus.context);
  for (let i = 0; i < compiled.tasks.length; i++) {
    const task = compiled.tasks[i];
    const status = day < task.startDay ? ScheduleStatus.pending : day <= task.endDay ? ScheduleStatus.active : ScheduleStatus.complete;
    frame.tasks[i] = status;
    for (const element of task.elements) {
      const previous = frame.elements[element];
      if (status === ScheduleStatus.active || previous === ScheduleStatus.context || (status === ScheduleStatus.complete && previous !== ScheduleStatus.active)) {
        frame.elements[element] = status;
      }
    }
  }
  return frame;
}

export interface MetadataScheduleOptions {
  startProperty: string;
  endProperty: string;
  taskIdProperty?: string;
  taskNameProperty?: string;
  name?: string;
}

export interface MetadataScheduleReport {
  missingDateIds: string[];
  invalidDateIds: string[];
  missingTaskIdIds: string[];
  conflictingTaskIds: string[];
}

/**
 * Explicit mapping only, never guess a date field or match an object's display name.
 * Skipped rows are reported. A task ID with conflicting dates is excluded entirely.
 */
export function scheduleFromMetadata(keys: readonly string[], store: PropertyStore, options: MetadataScheduleOptions): { schedule: Schedule | null; report: MetadataScheduleReport } {
  if (keys.length !== store.count) throw new Error('Le planning et les propriétés doivent utiliser le même index d’éléments.');
  for (const property of [options.startProperty, options.endProperty, options.taskIdProperty, options.taskNameProperty]) {
    if (property !== undefined && !store.paths.includes(property)) throw new Error(`Propriété de planning introuvable : ${property}.`);
  }
  const report: MetadataScheduleReport = { missingDateIds: [], invalidDateIds: [], missingTaskIdIds: [], conflictingTaskIds: [] };
  const tasks = new Map<string, ScheduleTask>(), conflicts = new Set<string>();
  const absent = (value: PropValue | undefined) => value === undefined || value === null || (typeof value === 'string' && !value.trim());
  for (let element = 0; element < keys.length; element++) {
    const key = keys[element], props = store.propsOf(element);
    const start = ownValue(props, options.startProperty), end = ownValue(props, options.endProperty);
    if (absent(start) || absent(end)) { report.missingDateIds.push(key); continue; }
    try {
      if (parseScheduleDate(end) < parseScheduleDate(start)) throw new Error('Date de fin antérieure.');
    } catch { report.invalidDateIds.push(key); continue; }
    const idValue = options.taskIdProperty ? ownValue(props, options.taskIdProperty) : `element:${key}`;
    if (absent(idValue)) { report.missingTaskIdIds.push(key); continue; }
    const id = String(idValue);
    const nameValue = options.taskNameProperty ? ownValue(props, options.taskNameProperty) : undefined;
    const name = absent(nameValue) ? (options.taskIdProperty ? id : store.labelOf(element) ?? key) : String(nameValue);
    const previous = tasks.get(id);
    if (previous) {
      if (previous.start !== start || previous.end !== end) conflicts.add(id);
      previous.elementIds!.push(key);
    } else {
      tasks.set(id, { id, name: name.trim() ? name : id, start: start as string, end: end as string, elementIds: [key] });
    }
  }
  for (const id of conflicts) tasks.delete(id);
  report.conflictingTaskIds = [...conflicts];
  const schedule = tasks.size > 0 ? parseSchedule({ type: 'bim-schedule', version: 1, ...(options.name !== undefined ? { name: options.name } : {}), tasks: [...tasks.values()] }) : null;
  return { schedule, report };
}
