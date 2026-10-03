import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PropertyStore } from '../src/data/metadata.ts';
import { compileSchedule, evaluateSchedule, parseScheduleDate, ScheduleStatus, type CompiledTask } from '../src/data/schedule.ts';
import { buildScheduleTree, collectTaskElements, visibleScheduleRows } from '../src/data/scheduleTree.ts';

const task = (id: string, parentId?: string): CompiledTask => ({
  task: { id, name: id, start: '2026-01-01', end: '2026-01-31', ...(parentId ? { parentId } : {}) },
  startDay: 0, endDay: 30, elements: [],
});

test('schedule hierarchy preserves sibling order with children before parents and counts every descendant', () => {
  const tasks = [
    task('object-a', 'package'), task('other-lot'), task('main-lot'), task('level', 'main-lot'),
    task('package', 'level'), task('object-b', 'package'), task('object-c', 'level'), task('other-object', 'other-lot'),
  ];
  const tree = buildScheduleTree(tasks);
  assert.deepEqual(tree.roots, [1, 2]);
  assert.deepEqual([...tree.children], [[4, [0, 5]], [2, [3]], [3, [4, 6]], [1, [7]]]);
  assert.deepEqual([...tree.descendantTaskCounts], [0, 1, 5, 4, 2, 0, 0, 0]);
  assert.deepEqual(visibleScheduleRows(tree, new Set()), [
    { index: 1, depth: 0, hasChildren: true }, { index: 7, depth: 1, hasChildren: false },
    { index: 2, depth: 0, hasChildren: true }, { index: 3, depth: 1, hasChildren: true },
    { index: 4, depth: 2, hasChildren: true }, { index: 0, depth: 3, hasChildren: false },
    { index: 5, depth: 3, hasChildren: false }, { index: 6, depth: 2, hasChildren: false },
  ]);
  assert.deepEqual(visibleScheduleRows(tree, new Set([4])).map(({ index }) => index), [1, 7, 2, 3, 4, 6]);
  assert.deepEqual(visibleScheduleRows(tree, new Set(tree.children.keys())).map(({ index }) => index), [1, 2]);
  assert.deepEqual(visibleScheduleRows(tree, new Set([2, 0])).map(({ index }) => index), [1, 7, 2]);
});

test('branch selection unions direct and descendant links without inheriting simulation bindings or dates', () => {
  const compiled = compileSchedule({ version: 1, tasks: [
    { ...task('lot').task, elementIds: ['context'], end: '2026-01-02' },
    { ...task('package', 'lot').task, end: '2026-01-02' },
    { ...task('wall', 'package').task, start: '2026-01-15', elementIds: ['wall', 'context'] },
    { ...task('wall-finish', 'package').task, start: '2026-01-20', elementIds: ['wall'] },
    { ...task('roof').task, elementIds: ['roof'] },
  ] }, ['wall', 'roof', 'context'], new PropertyStore(3));
  const tree = buildScheduleTree(compiled.tasks);
  const before = compiled.tasks.map(({ elements }) => [...elements]);
  assert.deepEqual(collectTaskElements(tree, compiled.tasks, 0), [2, 0]);
  assert.deepEqual(collectTaskElements(tree, compiled.tasks, 1), [0, 2]);
  assert.deepEqual(collectTaskElements(tree, compiled.tasks, 4), [1]);
  assert.deepEqual(compiled.tasks.map(({ elements }) => elements), before);
  assert.deepEqual(compiled.tasks[1].elements, []);
  const frame = evaluateSchedule(compiled, parseScheduleDate('2026-01-01'));
  assert.equal(frame.elements[0], ScheduleStatus.pending, 'child objects do not start when the summary starts');
  assert.equal(frame.tasks[1], ScheduleStatus.active, 'summary dates remain their explicit dates');
});

test('deep work breakdown structures can build, expand, fold and select without recursive stack overflow', () => {
  const count = 35_000;
  const tasks = Array.from({ length: count }, (_, index) => ({
    ...task(String(index), index + 1 < count ? String(index + 1) : undefined), elements: [0],
  }));
  const tree = buildScheduleTree(tasks);
  assert.deepEqual(tree.roots, [count - 1]);
  assert.equal(tree.descendantTaskCounts[count - 1], count - 1);
  assert.equal(tree.descendantTaskCounts[0], 0);
  const rows = visibleScheduleRows(tree, new Set());
  assert.equal(rows.length, count);
  assert.deepEqual(rows.at(-1), { index: 0, depth: count - 1, hasChildren: false });
  assert.equal(visibleScheduleRows(tree, new Set([count - 1])).length, 1);
  assert.deepEqual(collectTaskElements(tree, tasks, count - 1), [0]);
});

test('an empty hierarchy has no display rows or selectable elements', () => {
  const tree = buildScheduleTree([]);
  assert.deepEqual(tree.roots, []);
  assert.equal(tree.children.size, 0);
  assert.equal(tree.descendantTaskCounts.length, 0);
  assert.deepEqual(visibleScheduleRows(tree, new Set()), []);
  assert.deepEqual(collectTaskElements(tree, [], 0), []);
});
