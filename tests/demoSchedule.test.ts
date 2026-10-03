import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PropertyStore } from '../src/data/metadata.ts';
import { compileSchedule, evaluateSchedule, parseSchedule, parseScheduleDate, ScheduleStatus } from '../src/data/schedule.ts';

const metadata = JSON.parse(readFileSync(new URL('../public/samples/demo.json', import.meta.url), 'utf8')) as {
  elements: Record<string, { label: string; properties: Record<string, unknown> }>;
};
const binary = readFileSync(new URL('../public/samples/demo.glb', import.meta.url));
const gltf = JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)).toString('utf8')) as {
  nodes: { name?: string; extras?: { id?: string } }[];
};
const keys = gltf.nodes.flatMap((node) => node.extras?.id ? [node.extras.id] : []);
const source = JSON.parse(readFileSync(new URL('../public/samples/demo-planning.json', import.meta.url), 'utf8'));
const schedule = parseSchedule(source);
const leaves = schedule.tasks.filter((task) => task.elementIds?.length);
const byElement = new Map(leaves.map((task) => [task.elementIds![0], task]));
const taskFor = (level: string, label: string) => {
  const entry = Object.entries(metadata.elements).find(([, element]) => element.properties.Niveau === level && element.label === label);
  assert.ok(entry, `${level} / ${label}`);
  return byElement.get(entry[0])!;
};

test('the shipped demo schedule is reproducible and binds every actual object exactly once', () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/make-demo-planning.mjs', import.meta.url)), '--check']);
  assert.equal(keys.length, 220);
  assert.equal(Object.keys(metadata.elements).length, 219, 'the deliberate missing metadata fixture remains unchanged');
  assert.equal(leaves.length, keys.length);
  assert.equal(byElement.size, keys.length);
  assert.deepEqual(new Set(byElement.keys()), new Set(keys));
  for (const leaf of leaves) {
    assert.equal(leaf.elementIds!.length, 1, 'each object has its own task');
    assert.equal(leaf.match, undefined, 'a whole floor must not replace explicit object scheduling');
    assert.ok(leaf.parentId);
  }
  const compiled = compileSchedule(schedule, keys, new PropertyStore(keys.length));
  assert.equal(compiled.report.linkedElementCount, 220);
  assert.equal(compiled.report.unlinkedElementCount, 0);
  assert.equal(compiled.report.multipleTaskElementCount, 0);
  assert.deepEqual(compiled.report.unknownElementIds, []);
  assert.match(schedule.name!, /dates fictives/);
});

test('demo lots, levels and work packages aggregate dates without applying a second object binding', () => {
  assert.equal(schedule.tasks.filter((task) => !task.parentId).length, 6);
  const groups = schedule.tasks.filter((task) => !task.elementIds);
  assert.ok(groups.length > 30);
  for (const group of groups) {
    const children = schedule.tasks.filter((task) => task.parentId === group.id);
    assert.ok(children.length, group.id);
    assert.equal(group.match, undefined);
    assert.equal(group.start, children.map((task) => task.start).sort()[0]);
    assert.equal(group.end, children.map((task) => task.end).sort().at(-1));
  }
  for (const leaf of leaves) {
    const allowed = new Set(['id', 'name', 'parentId', 'start', 'end', 'elementIds']);
    assert.ok(Object.keys(leaf).every((key) => allowed.has(key)), 'no progress or geometry-edit fields');
  }
});

test('illustrative work respects storey sequence, enclosure before partitions and partitions before doors', () => {
  for (const [index, level] of ['RDC', 'R+1', 'R+2'].entries()) {
    const storeyObjects = Object.entries(metadata.elements).filter(([, element]) => element.properties.Niveau === level);
    const slab = taskFor(level, `Dalle ${level}`);
    const columns = storeyObjects.filter(([, element]) => element.properties.Catégorie === 'Poteau').map(([id]) => byElement.get(id)!);
    assert.ok(columns.every((task) => task.start > slab.end));
    if (index > 0) {
      const previous = index === 1 ? 'RDC' : 'R+1';
      const lowerStructure = Object.entries(metadata.elements).filter(([, element]) => element.properties.Niveau === previous && element.properties.Lot === 'Gros œuvre');
      assert.ok(lowerStructure.every(([id]) => byElement.get(id)!.end < slab.start), 'slab follows supporting elements below');
    }
    const windows = storeyObjects.filter(([, element]) => element.properties.Catégorie === 'Fenêtre').map(([id]) => byElement.get(id)!);
    const partitions = storeyObjects.filter(([, element]) => element.properties.Lot === 'Cloisons').map(([id]) => byElement.get(id)!);
    const roof = taskFor('Toiture', 'Toiture-terrasse');
    assert.ok(partitions.every((task) => windows.every((window) => window.end < task.start) && roof.end < task.start));
    for (const axis of [6, 14]) {
      const door = taskFor(level, `Porte ${axis}`);
      for (const label of [`Cloison ${axis} A`, `Cloison ${axis} B`, `Imposte ${axis}`]) {
        assert.ok(taskFor(level, label).end < door.start);
      }
    }
  }
  assert.ok(taskFor('RDC', 'Fenêtre façade sud 1').start < taskFor('R+2', 'Dalle R+2').start, 'trades overlap instead of finishing one whole lot at a time');
});

test('demo playback exposes progressive object work rather than one instant floor per date', () => {
  const compiled = compileSchedule(schedule, keys, new PropertyStore(keys.length));
  const starts = new Map<string, number>();
  for (const leaf of leaves) starts.set(leaf.start, (starts.get(leaf.start) ?? 0) + 1);
  assert.ok(starts.size > 70, 'many distinct construction dates');
  assert.ok(Math.max(...starts.values()) < 10, 'small crews/work packages, not entire floor reveals');
  assert.ok(compiled.endDay - compiled.startDay > 100);
  assert.ok(compiled.endDay - compiled.startDay < 200);
  for (const level of ['RDC', 'R+1', 'R+2']) {
    const first = parseScheduleDate(taskFor(level, 'Mur façade sud 1 gauche').start);
    const frame = evaluateSchedule(compiled, first);
    const indices = keys.flatMap((id, index) => metadata.elements[id]?.properties.Niveau === level ? [index] : []);
    assert.ok(indices.some((index) => frame.elements[index] === ScheduleStatus.active));
    assert.ok(indices.some((index) => frame.elements[index] === ScheduleStatus.pending));
  }
  assert.ok(evaluateSchedule(compiled, compiled.endDay + 1).elements.every((state) => state === ScheduleStatus.complete));
});
