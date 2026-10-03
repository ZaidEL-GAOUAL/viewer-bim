import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PropertyStore } from '../src/data/metadata.ts';
import {
  compileSchedule, evaluateSchedule, formatScheduleDate, isScheduleDocument, parseSchedule, parseScheduleDate,
  scheduleFromMetadata, ScheduleStatus as status, type ScheduleTask,
} from '../src/data/schedule.ts';

const task = (overrides: Partial<ScheduleTask> = {}): ScheduleTask => ({ id: 'walls', name: 'Murs', start: '2026-03-28', end: '2026-03-30', elementIds: ['wall'], ...overrides });
const schedule = (tasks: ScheduleTask[] = [task()]) => parseSchedule({ version: 1, tasks });

test('schedule files are classified by their root shape, including malformed schedules, never nested metadata properties', () => {
  for (const raw of [{ type: 'bim-schedule' }, { type: 'bim-schedule', tasks: null }, { version: 1, tasks: [] }, { tasks: [false] }, { tasks: [task()] }]) {
    assert.equal(isScheduleDocument(raw), true);
  }
  for (const raw of [null, [], {}, { tasks: { properties: { Name: 'Tasks' } } }, { elements: { a: { properties: { tasks: [], type: 'bim-schedule' } } } }, Object.create({ tasks: [] }), Object.create({ type: 'bim-schedule' })]) {
    assert.equal(isScheduleDocument(raw), false);
  }
});

test('unsupported demolition or temporary task actions are rejected instead of animated as construction', () => {
  assert.doesNotThrow(() => parseSchedule({ version: 1, tasks: [{ ...task(), action: 'construction', type: 'construction' }] }));
  for (const fields of [{ action: 'demolish' }, { type: 'temporary' }, { type: 'remove' }, { action: null }]) {
    assert.throws(() => parseSchedule({ version: 1, tasks: [{ ...task(), ...fields }] }), /uniquement la construction/);
  }
});

test('schedule dates use UTC civil days, validate leap dates and reject rollover or ambiguous timestamps', () => {
  assert.equal(parseScheduleDate('2026-03-30') - parseScheduleDate('2026-03-28'), 2);
  assert.equal(parseScheduleDate('2026-10-26') - parseScheduleDate('2026-10-24'), 2);
  assert.equal(formatScheduleDate(parseScheduleDate('2024-02-29')), '2024-02-29');
  assert.equal(formatScheduleDate(parseScheduleDate('0001-01-01')), '0001-01-01');
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '2026-1-1', '03/28/2026', '2026-03-28T00:00:00Z', '0000-01-01', null, 20260328]) {
    assert.throws(() => parseScheduleDate(invalid));
  }
  assert.throws(() => formatScheduleDate(0.5));
});

test('schedule import validates atomically and detaches normalized task links', () => {
  const source = { type: 'bim-schedule', version: 1, name: 'Chantier', tasks: [task({ elementIds: ['wall', 'wall'], match: { property: 'Lot', values: ['A', 'A', 1, true] } })] };
  const parsed = parseSchedule(source);
  assert.deepEqual(parsed.tasks[0].elementIds, ['wall']);
  assert.deepEqual(parsed.tasks[0].match?.values, ['A', 1, true]);
  source.tasks[0].elementIds!.push('other'); source.tasks[0].match!.values.push('B');
  assert.deepEqual(parsed.tasks[0].elementIds, ['wall']);
  assert.deepEqual(parsed.tasks[0].match?.values, ['A', 1, true]);
  for (const invalid of [
    null, [], { version: 2, tasks: [task()] }, { type: 'metadata', version: 1, tasks: [task()] },
    { version: 1, tasks: [] }, { version: 1, name: false, tasks: [task()] },
    { version: 1, tasks: [task(), task()] },
    { version: 1, tasks: [task(), task({ id: 'later', end: '2026-03-27' })] },
    { version: 1, tasks: [task({ id: '' })] },
    { version: 1, tasks: [{ ...task(), name: false }] },
    { version: 1, tasks: [{ ...task(), elementIds: ['wall', 1] }] },
    { version: 1, tasks: [{ ...task(), match: { property: 'Lot', values: [] } }] },
    { version: 1, tasks: [{ ...task(), match: { property: 'Lot', values: [null] } }] },
    { version: 1, tasks: [{ ...task(), match: { property: 'Lot', values: [Infinity] } }] },
  ]) assert.throws(() => parseSchedule(invalid));
});

test('task parent hierarchy is validated without deriving dates or bindings', () => {
  const parsed = schedule([task({ id: 'child', parentId: 'parent' }), task({ id: 'parent', start: '2026-03-29', elementIds: [] })]);
  assert.equal(parsed.tasks[1].start, '2026-03-29');
  assert.deepEqual(parsed.tasks[1].elementIds, []);
  assert.throws(() => schedule([task({ parentId: 'missing' })]), /parente introuvable/);
  assert.throws(() => schedule([task({ parentId: 'walls' })]), /Cycle/);
  assert.throws(() => schedule([task({ id: 'A', parentId: 'B' }), task({ id: 'B', parentId: 'A' })]), /Cycle/);
  const deep = Array.from({ length: 12_000 }, (_, i) => task({ id: String(i), ...(i < 11_999 ? { parentId: String(i + 1) } : {}) }));
  assert.equal(schedule(deep).tasks.length, deep.length);
});

test('bindings union exact IDs and typed property values, deduplicate and report unresolved links', () => {
  const store = new PropertyStore(5);
  store.set(0, { Lot: 'A' }); store.set(1, { Lot: 'A' }); store.set(2, { Lot: 1 }); store.set(3, { Lot: '1' }); store.set(4, { Lot: true }); store.finalize();
  const compiled = compileSchedule(schedule([
    task({ elementIds: ['a', 'unknown'], match: { property: 'Lot', values: ['A', 1] } }),
    task({ id: 'second', elementIds: ['a'], match: { property: 'Lot', values: [true] } }),
    task({ id: 'unlinked', elementIds: ['unknown'], match: { property: 'does-not-exist', values: ['A'] } }),
  ]), ['a', 'b', 'c', 'd', 'e'], store);
  assert.deepEqual(compiled.tasks.map((item) => item.elements), [[0, 1, 2], [0, 4], []]);
  assert.deepEqual(compiled.report, {
    linkedElementCount: 4, unlinkedElementCount: 1, unlinkedTaskIds: ['unlinked'], unknownElementIds: ['unknown'], multipleTaskElementCount: 1,
  });
  assert.throws(() => compileSchedule(schedule(), [], store), /même index/);
});

test('construction end dates are inclusive and unlinked objects remain context', () => {
  const compiled = compileSchedule(schedule(), ['wall', 'context'], new PropertyStore(2));
  const first = parseScheduleDate('2026-03-28'), last = parseScheduleDate('2026-03-30');
  assert.equal(compiled.startDay, first); assert.equal(compiled.endDay, last);
  assert.deepEqual([...evaluateSchedule(compiled, first - 1).elements], [status.pending, status.context]);
  assert.deepEqual([...evaluateSchedule(compiled, first).elements], [status.active, status.context]);
  assert.deepEqual([...evaluateSchedule(compiled, last).elements], [status.active, status.context]);
  assert.deepEqual([...evaluateSchedule(compiled, last + 1).elements], [status.complete, status.context]);
  assert.deepEqual([...evaluateSchedule(compiled, last).tasks], [status.active]);
});

test('unlinked task diagnostics ignore intentional summaries but report unlinked leaves and broken parent bindings', () => {
  const compiled = compileSchedule(schedule([
    task({ id: 'lot', elementIds: undefined }),
    task({ id: 'level', parentId: 'lot', elementIds: [] }),
    task({ id: 'wall-task', parentId: 'level' }),
    task({ id: 'unlinked-leaf', parentId: 'level', elementIds: [] }),
    task({ id: 'broken-parent-id', elementIds: ['unknown'] }),
    task({ id: 'linked-child-id', parentId: 'broken-parent-id' }),
    task({ id: 'broken-parent-property', elementIds: [], match: { property: 'Lot', values: ['missing'] } }),
    task({ id: 'linked-child-property', parentId: 'broken-parent-property' }),
  ]), ['wall'], new PropertyStore(1));
  assert.deepEqual(compiled.report.unlinkedTaskIds, ['unlinked-leaf', 'broken-parent-id', 'broken-parent-property']);
  assert.deepEqual(compiled.report.unknownElementIds, ['unknown']);
  assert.equal(compiled.report.linkedElementCount, 1);
  assert.deepEqual(compiled.tasks.slice(0, 2).map(({ elements }) => elements), [[], []]);
});

test('multi-stage construction never hides previously started objects; active stages override completion in any task order', () => {
  const tasks = [task({ end: '2026-03-28' }), task({ id: 'finish', start: '2026-04-01', end: '2026-04-02' }), task({ id: 'overlap', start: '2026-04-02', end: '2026-04-04' })];
  for (const ordered of [tasks, [...tasks].reverse(), [tasks[1], tasks[0], tasks[2]]]) {
    const compiled = compileSchedule(schedule(ordered), ['wall'], new PropertyStore(1));
    for (const [date, expected] of [
      ['2026-03-27', status.pending], ['2026-03-28', status.active], ['2026-03-29', status.complete],
      ['2026-04-01', status.active], ['2026-04-02', status.active], ['2026-04-03', status.active], ['2026-04-05', status.complete],
    ] as const) assert.equal(evaluateSchedule(compiled, parseScheduleDate(date)).elements[0], expected, date);
  }
});

test('playback supports reverse scrubbing and reusable buffers without reading metadata', () => {
  const store = new PropertyStore(20);
  for (let i = 0; i < store.count; i++) store.set(i, { Lot: i % 2 ? 'A' : 'B' });
  store.finalize();
  let reads = 0;
  const propsOf = store.propsOf.bind(store);
  store.propsOf = (index) => { reads++; return propsOf(index); };
  const compiled = compileSchedule(schedule([
    task({ elementIds: [], match: { property: 'Lot', values: ['A'] } }),
    task({ id: 'B', elementIds: [], match: { property: 'Lot', values: ['B'] } }),
  ]), Array.from({ length: 20 }, (_, i) => String(i)), store);
  assert.equal(reads, 20, 'one property index is shared across tasks');
  const frame = evaluateSchedule(compiled, compiled.endDay + 1);
  assert.ok(frame.elements.every((value) => value === status.complete));
  assert.equal(evaluateSchedule(compiled, compiled.startDay - 1, frame), frame);
  assert.ok(frame.elements.every((value) => value === status.pending));
  assert.equal(reads, 20);
  assert.throws(() => evaluateSchedule(compiled, NaN));
  assert.throws(() => evaluateSchedule(compiled, compiled.startDay, { elements: new Uint8Array(1), tasks: new Uint8Array(1) }));
});

test('metadata adapter maps explicitly selected date and task fields while preserving model properties', () => {
  const store = new PropertyStore(3);
  const first = { Start: '2026-04-01', End: '2026-04-04', Task: 'structure', Name: 'Gros œuvre' };
  store.set(0, first, 'Mur'); store.set(1, { ...first }, 'Dalle');
  store.set(2, { Start: '2026-04-05', End: '2026-04-05', Task: 'roof', Name: 'Toiture' }); store.finalize();
  const result = scheduleFromMetadata(['wall', 'slab', 'roof'], store, { startProperty: 'Start', endProperty: 'End', taskIdProperty: 'Task', taskNameProperty: 'Name', name: 'Planning du modèle' });
  assert.equal(result.schedule?.name, 'Planning du modèle');
  assert.deepEqual(result.schedule?.tasks, [
    { id: 'structure', name: 'Gros œuvre', start: '2026-04-01', end: '2026-04-04', elementIds: ['wall', 'slab'] },
    { id: 'roof', name: 'Toiture', start: '2026-04-05', end: '2026-04-05', elementIds: ['roof'] },
  ]);
  assert.deepEqual(result.report, { missingDateIds: [], invalidDateIds: [], missingTaskIdIds: [], conflictingTaskIds: [] });
  assert.equal(store.propsOf(0), first);
  assert.deepEqual(first, { Start: '2026-04-01', End: '2026-04-04', Task: 'structure', Name: 'Gros œuvre' });
});

test('metadata adapter reports missing/invalid dates, task IDs and conflicting grouped dates without guessing', () => {
  const store = new PropertyStore(7);
  store.set(0, { Start: '2026-04-01', End: '2026-04-02', Task: 'good' });
  store.set(1, { Start: '2026-04-01', End: null, Task: 'missing' });
  store.set(2, { Start: '01/04/2026', End: '2026-04-02', Task: 'invalid' });
  store.set(3, { Start: '2026-04-03', End: '2026-04-02', Task: 'reverse' });
  store.set(4, { Start: '2026-04-01', End: '2026-04-02', Task: ' ' });
  store.set(5, { Start: '2026-04-01', End: '2026-04-02', Task: 'conflict' });
  store.set(6, { Start: '2026-04-03', End: '2026-04-04', Task: 'conflict' }); store.finalize();
  const result = scheduleFromMetadata(['good', 'missing', 'invalid', 'reverse', 'no-task', 'first', 'second'], store, { startProperty: 'Start', endProperty: 'End', taskIdProperty: 'Task' });
  assert.equal(result.schedule?.tasks.length, 1);
  assert.deepEqual(result.report, { missingDateIds: ['missing'], invalidDateIds: ['invalid', 'reverse'], missingTaskIdIds: ['no-task'], conflictingTaskIds: ['conflict'] });
  assert.throws(() => scheduleFromMetadata([], store, { startProperty: 'Start', endProperty: 'End' }), /même index/);
  assert.throws(() => scheduleFromMetadata(Array.from({ length: 7 }, String), store, { startProperty: 'Unknown', endProperty: 'End' }), /introuvable/);
});

test('metadata dates can become individual tasks and an entirely invalid mapping returns no schedule', () => {
  const store = new PropertyStore(2);
  store.set(0, { Start: '2026-04-01', End: '2026-04-02' }, 'Dalle'); store.set(1, { Start: '2026-04-01' }); store.finalize();
  const options = { startProperty: 'Start', endProperty: 'End' };
  const result = scheduleFromMetadata(['a', 'b'], store, options);
  assert.equal(result.schedule?.tasks[0].id, 'element:a');
  assert.equal(result.schedule?.tasks[0].name, 'Dalle');
  assert.deepEqual(result.report.missingDateIds, ['b']);
  store.update(0, 'Start', 'yesterday');
  assert.equal(scheduleFromMetadata(['a', 'b'], store, options).schedule, null);
});
