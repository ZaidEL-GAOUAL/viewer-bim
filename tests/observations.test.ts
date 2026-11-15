import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBcf, writeBcf } from '../src/data/bcf.ts';
import { readZip } from '../src/data/zip.ts';
import { parseMetadata } from '../src/data/metadata.ts';
import {
  addObservations, allowedStatuses, boxOfPlanes, changeStatus, defaultLists, emptyBook, filterObservations, fromBcfTopic, groupObservations,
  locate, mergeBooks, newObservation, observationFromClash, observationsCsv, observationsToJson, orphans, parseObservations, sortObservations,
  statusColor, statusLayer, toBcfTopic, viewOfViewpoint, viewpointOfView, type Observation, type ObservationBook,
} from '../src/data/observations.ts';
import { modificationsFile } from '../src/data/sidecar.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import { nodeInflate } from './zipHelpers.ts';

const NOW = new Date('2026-11-14T08:00:00Z');
const lists = defaultLists();

function make(fields: Partial<Observation>): Observation {
  return { ...newObservation({}, 'Zaid', NOW, lists, 1), ...fields };
}

const A = make({ number: 1, title: 'Joint silicone', status: 'Ouverte', assignedTo: 'Durand', labels: ['Plomberie'], stage: 'OPR', dueDate: '2026-11-10T00:00:00Z', location: { level: 'R+1', room: 'Salle de bain' }, elements: [{ key: '2O2Fr$t4X7Zf8NOew3FLOH', model: 'a.ifc' }] });
const B = make({ number: 2, title: 'Peinture écaillée', status: 'Résolue', assignedTo: 'Martin', labels: ['Peinture'], stage: 'OPR', dueDate: '2026-11-01T00:00:00Z', location: { level: 'RDC' } });
const C = make({ number: 3, title: 'Garde-corps manquant', type: 'Sécurité', status: 'En cours', assignedTo: 'Durand', labels: ['Serrurerie'], stage: 'Visite', priority: 'Critique', location: { level: 'R+1' }, description: 'Trémie escalier' });

test('a new observation takes the first kind and status, an ISO date and the author', () => {
  const observation = newObservation({ title: 'Fissure' }, 'Zaid', NOW, lists, 7);
  assert.match(observation.guid, /^[0-9a-f-]{36}$/);
  assert.equal(observation.type, 'Réserve');
  assert.equal(observation.status, 'Ouverte');
  assert.equal(observation.creationDate, '2026-11-14T08:00:00Z');
  assert.equal(observation.creationAuthor, 'Zaid');
  assert.equal(observation.number, 7);
});

test('filters: status, company, trade, level, phase, overdue, due before, text without accents', () => {
  const all = [A, B, C];
  const today = '2026-11-14';
  const titles = (filter: Parameters<typeof filterObservations>[1]) => filterObservations(all, filter, lists, today).map((o) => o.title);
  assert.deepEqual(titles({ statuses: ['Ouverte', 'En cours'] }), ['Joint silicone', 'Garde-corps manquant']);
  assert.deepEqual(titles({ company: 'Durand' }), ['Joint silicone', 'Garde-corps manquant']);
  assert.deepEqual(titles({ trade: 'Peinture' }), ['Peinture écaillée']);
  assert.deepEqual(titles({ level: 'R+1', phase: 'OPR' }), ['Joint silicone']);
  // B is past due but resolved: not late.
  assert.deepEqual(titles({ overdue: true }), ['Joint silicone']);
  assert.deepEqual(titles({ dueBefore: '2026-11-05' }), ['Peinture écaillée']);
  assert.deepEqual(titles({ text: 'ECAILLEE' }), ['Peinture écaillée']);
  assert.deepEqual(titles({ text: 'tremie' }), ['Garde-corps manquant']);
});

test('sort by status order, priority order, due date; group by company then level', () => {
  assert.deepEqual(sortObservations([B, C, A], 'status', lists).map((o) => o.number), [1, 3, 2]);
  assert.deepEqual(sortObservations([A, B, C], 'priority', lists).map((o) => o.number), [3, 1, 2]);
  // Without a due date: last.
  assert.deepEqual(sortObservations([C, A, B], 'due', lists).map((o) => o.number), [2, 1, 3]);
  const groups = groupObservations([A, B, C], 'company');
  assert.deepEqual(groups.map((group) => [group.label, group.topics.map((o) => o.number)]), [['Durand', [1, 3]], ['Martin', [2]]]);
  const levels = groupObservations([A, make({ number: 4 }), C], 'level');
  assert.deepEqual(levels.map((group) => group.label), ['R+1', '(sans niveau)']);
});

test('status transitions: allowed ones change the status and leave a comment; others are refused', () => {
  assert.deepEqual(allowedStatuses(lists, 'Clôturée'), ['Ouverte']);
  assert.ok(allowedStatuses(lists, 'Ouverte').includes('En cours'));
  const later = new Date('2026-11-15T10:00:00Z');
  const moved = changeStatus(A, 'En cours', lists, 'Paul', later);
  assert.equal(moved.status, 'En cours');
  assert.equal(moved.modifiedAuthor, 'Paul');
  assert.equal(moved.modifiedDate, '2026-11-15T10:00:00Z');
  assert.equal(moved.comments.at(-1)?.text, 'Statut : Ouverte → En cours');
  assert.equal(A.status, 'Ouverte', 'the original is not changed');
  assert.throws(() => changeStatus(make({ status: 'Clôturée' }), 'Résolue', lists, 'Paul', later), /Clôturée.*Résolue/);
  // A status the list does not know (read from another tool) may go anywhere.
  assert.equal(changeStatus(make({ status: 'Open' }), 'Résolue', lists, 'Paul', later).status, 'Résolue');
});

test('location comes from the properties the user designates; orphans are the ones whose element is gone', () => {
  const props = { Niveau: 'R+1', 'Pièce / Nom': 'Cuisine', Zone: null, Autre: 3 };
  assert.deepEqual(locate(props, { level: 'Niveau', room: 'Pièce / Nom', zone: 'Zone' }), { level: 'R+1', room: 'Cuisine' });
  assert.deepEqual(locate(props, {}), {});
  const present = new Set(['a.ifc\u00002O2Fr$t4X7Zf8NOew3FLOH']);
  const gone = make({ number: 5, elements: [{ key: 'disparu', model: 'a.ifc' }] });
  assert.deepEqual(orphans([A, B, gone], (ref) => present.has(`${ref.model}\u0000${ref.key}`)).map((o) => o.number), [5]);
});

test('colour by status: each element takes the colour of its least advanced observation', () => {
  const index = new Map([['k1', 0], ['k2', 1]]);
  const layer = statusLayer([make({ status: 'Clôturée', elements: [{ key: 'k1' }] }), make({ status: 'Ouverte', elements: [{ key: 'k1' }, { key: 'k2' }, { key: 'absent' }] })], (ref) => index.get(ref.key), lists);
  assert.deepEqual([...layer.keys()].sort(), [0, 1]);
  assert.equal(layer.get(0)?.color, layer.get(1)?.color);
});

test('a view becomes a BCF viewpoint in model coordinates, Z up, and back; a section box becomes six planes and is found again', () => {
  const view = {
    name: 'v', kind: '3d' as const,
    camera: { position: [10, 2, -5] as [number, number, number], direction: [0, 0, -1] as [number, number, number], up: [0, 1, 0] as [number, number, number], projection: 'perspective' as const, fov: 50 },
    sections: [{ point: [0, 3, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number], enabled: true }],
    sectionBox: { min: [-2, 0, -3] as [number, number, number], max: [4, 3, 1] as [number, number, number], rotation: 30 },
  };
  const viewpoint = viewpointOfView(view, 1.5, '11111111-2222-4333-8444-555555555555');
  // Y up (x, y, z) → Z up (x, −z, y).
  assert.deepEqual(viewpoint.camera, { kind: 'perspective', viewPoint: [10, 5, 2], direction: [0, 1, 0], up: [0, 0, 1], fieldOfView: 50, aspectRatio: 1.5 });
  assert.deepEqual(viewpoint.clippingPlanes[0], { location: [0, 0, 3], direction: [0, 0, 1] });
  assert.equal(viewpoint.clippingPlanes.length, 7);
  const back = viewOfViewpoint(viewpoint, 'v');
  assert.ok(back);
  assert.deepEqual(back.camera.position, [10, 2, -5]);
  assert.deepEqual(back.sections?.map((plane) => plane.point), [[0, 3, 0]]);
  const box = back.sectionBox!;
  const close = (a: readonly number[], b: readonly number[]) => a.every((value, i) => Math.abs(value - b[i]) < 1e-9);
  assert.ok(close(box.min, [-2, 0, -3]) && close(box.max, [4, 3, 1]) && Math.abs(box.rotation - 30) < 1e-9, JSON.stringify(box));
  assert.equal(boxOfPlanes(viewpoint.clippingPlanes.slice(0, 4)), null);
  // An orthographic view keeps its height (ViewToWorldScale) and proportions.
  const plan = viewpointOfView({ camera: { position: [0, 20, 0], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic', size: [30, 20] } }, 1.5, '11111111-2222-4333-8444-555555555556');
  assert.deepEqual(plan.camera, { kind: 'orthogonal', viewPoint: [0, 0, 20], direction: [0, 0, -1], up: [0, 1, 0], viewToWorldScale: 20, aspectRatio: 1.5 });
  assert.deepEqual(viewOfViewpoint(plan, 'p')?.camera.size, [30, 20]);
});

test('an observation becomes a BCF topic (extension left out, elements as components) and comes back', () => {
  const observation = make({
    number: 9, title: 'Fuite', elements: [{ key: '2O2Fr$t4X7Zf8NOew3FLOH', model: 'a.ifc' }, { key: 'rvt-318215', model: 'b.rvt' }],
    pin: { plan: 'Niveau 1', x: 4, y: 5 }, point: [4, 5, 3.2], location: { level: 'R+1' },
    viewpoints: [{ guid: '11111111-2222-4333-8444-555555555557', clippingPlanes: [], selection: [] }],
  });
  const topic = toBcfTopic(observation);
  assert.deepEqual(Object.keys(topic).filter((key) => ['number', 'elements', 'pin', 'point', 'location', 'origin'].includes(key)), []);
  assert.deepEqual(topic.viewpoints[0].selection, [{ ifcGuid: '2O2Fr$t4X7Zf8NOew3FLOH' }, { originatingSystem: 'Revit', authoringToolId: '318215' }]);
  const back = fromBcfTopic(topic, 12);
  assert.equal(back.number, 12);
  assert.deepEqual(back.elements, [{ key: '2O2Fr$t4X7Zf8NOew3FLOH' }, { key: 'rvt-318215' }]);
  assert.deepEqual(back.viewpoints[0].selection, []);
});

test('the observations section: JSON round trip without photos, carried by the modifications JSON, ignored by BCF', async () => {
  const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const withPhoto = make({ ...A, documents: [{ guid: '11111111-2222-4333-8444-555555555558', filename: 'photo.jpg', data: photo }], pin: { plan: 'Niveau 1', x: 4.5, y: -2 }, point: [4.5, -2, 3] });
  const book: ObservationBook = { ...emptyBook(), settings: { level: 'Niveau' }, topics: [withPhoto, B] };
  const json = JSON.parse(JSON.stringify(observationsToJson(book)));
  assert.equal(JSON.stringify(json).includes('data'), false, 'no photo bytes in the JSON');
  const parsed = parseObservations(json)!;
  assert.deepEqual(parsed.settings, { level: 'Niveau' });
  assert.deepEqual(parsed.topics[0].pin, { plan: 'Niveau 1', x: 4.5, y: -2 });
  assert.deepEqual(parsed.topics[0].documents, [{ guid: '11111111-2222-4333-8444-555555555558', filename: 'photo.jpg' }]);
  assert.deepEqual({ ...parsed.topics[0], documents: [] }, { ...withPhoto, documents: [] });
  assert.deepEqual(parsed.topics[1], B);
  // An empty book writes nothing; an unreadable section or entry is ignored.
  assert.equal(observationsToJson(emptyBook()), undefined);
  assert.equal(parseObservations('rien'), undefined);
  assert.equal(parseObservations({ topics: [{ title: 'sans guid' }] })?.topics.length, 0);

  // Both JSON exports carry it; a modifications JSON with only observations opens.
  const store = new PropertyStore(1);
  store.set(0, { a: 1 });
  store.finalize();
  const file = modificationsFile(new PropertyEdits(store, () => {}), ['k'], 'maquette.ifc', [], { observations: observationsToJson(book) });
  const metadata = parseMetadata(JSON.parse(JSON.stringify(file)));
  assert.equal(metadata.observations?.topics.length, 2);
  // An older file without the section loads unchanged.
  assert.equal(parseMetadata({ elements: { k: { a: 1 } } }).observations, undefined);

  // The plan pin and our other fields travel in viewer-bim.json only (no standard BCF field); the photo is in the .bcf, and comes back by merging on the GUID.
  const bcf = await writeBcf(book.topics.map((topic) => toBcfTopic(topic)));
  const read = await readBcf(bcf, nodeInflate);
  const entries = await readZip(bcf, nodeInflate);
  for (const [name, entry] of entries) {
    const text = new TextDecoder().decode(await entry.bytes());
    assert.equal(/Niveau 1/.test(text), name.endsWith('/viewer-bim.json'), name);
  }
  const merged = mergeBooks(parsed, { ...emptyBook(), topics: read.topics.map((topic, i) => fromBcfTopic(topic, i + 1)) });
  assert.equal(merged.added, 0);
  assert.equal(merged.updated, 2);
  const restored = merged.book.topics.find((topic) => topic.guid === withPhoto.guid)!;
  assert.deepEqual(restored.pin, { plan: 'Niveau 1', x: 4.5, y: -2 });
  assert.deepEqual(restored.elements, withPhoto.elements, 'the elements keep their model');
  assert.deepEqual(new Uint8Array(await restored.documents[0].data!.arrayBuffer()), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
});

test('merging a .bcf: new topics are added and numbered, comments are joined, the newer topic wins', () => {
  const current = { ...emptyBook(), topics: [A] };
  const newer = { ...A, status: 'Résolue', modifiedDate: '2026-11-20T00:00:00Z', elements: [], comments: [{ guid: '11111111-2222-4333-8444-555555555559', date: '2026-11-20T00:00:00Z', author: 'Martin', text: 'Fait.' }] };
  const other = make({ guid: '11111111-2222-4333-8444-55555555555a', title: 'Nouveau', type: 'Clash', assignedTo: 'Petit' });
  const { book, added, updated } = mergeBooks(current, { ...emptyBook(), topics: [newer, other] });
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(book.topics[0].status, 'Résolue');
  assert.deepEqual(book.topics[0].elements, A.elements);
  assert.equal(book.topics[0].comments.length, A.comments.length + 1);
  assert.equal(book.topics[1].number, 2);
  // Values used by imported topics join the lists.
  assert.ok(book.lists.kinds.includes('Clash'));
  assert.ok(book.lists.companies.includes('Petit'));
});

test('clash results become observations once, with both elements, the point (Z up) and a viewpoint aimed at it', () => {
  const record = { a: { key: 'A1', model: 's.ifc' }, b: { key: 'B1', model: 'r.ifc' }, status: 'new' as const, comment: 'réservation', depth: 0.045, point: [1, 2, 3] as [number, number, number] };
  const observation = observationFromClash(record, (ref) => ref.key, 'Zaid', NOW, lists);
  assert.equal(observation.title, 'A1 × B1');
  assert.deepEqual(observation.point, [1, -3, 2]);
  assert.deepEqual(observation.elements, [record.a, record.b]);
  const camera = observation.viewpoints[0].camera!;
  const toPoint = [1 - camera.viewPoint[0], -3 - camera.viewPoint[1], 2 - camera.viewPoint[2]];
  const length = Math.hypot(...toPoint);
  assert.ok(toPoint.every((value, i) => Math.abs(value / length - camera.direction[i]) < 1e-9));
  const first = addObservations(emptyBook(), [observation]);
  const again = addObservations(first.book, [observationFromClash(record, (ref) => ref.key, 'Zaid', NOW, lists)]);
  assert.equal(first.added, 1);
  assert.equal(again.added, 0);
});

test('the CSV has one line per observation, semicolons, quoted when needed', () => {
  const csv = observationsCsv([C]);
  const [header, line] = csv.split('\r\n');
  assert.match(header, /^N°;Titre;Type;Statut;Entreprise;Lot;Phase;Priorité;Échéance;Niveau;Local;Zone;Créée le;Auteur;Description;Identifiant$/);
  assert.match(line, /^3;Garde-corps manquant;Sécurité;En cours;Durand;Serrurerie;Visite;Critique;;R\+1;;;14\/11\/2026;Zaid;Trémie escalier;/);
});

test('a status read from a file named like an Object member is a plain status (colour, transitions)', () => {
  const odd = { ...lists, statuses: [...lists.statuses, 'constructor', '__proto__', 'toString'] };
  for (const status of ['constructor', '__proto__', 'toString']) {
    assert.match(statusColor(status, odd), /^#[0-9a-f]{6}$/i, status);
    assert.ok(allowedStatuses(odd, status).includes('Ouverte'), status);
  }
  const book = parseObservations({ lists: { statuses: ['Ouverte', 'constructor'], transitions: { constructor: ['Ouverte'] } }, topics: [] })!;
  assert.deepEqual(allowedStatuses(book.lists, 'constructor'), ['Ouverte']);
});

test('the CSV defuses spreadsheet formulas in text, keeps numbers as numbers', () => {
  const evil = make({ number: 4, title: '=HYPERLINK("http://x","clic")', assignedTo: '+33 6', description: '@SUM(A1)', creationAuthor: '-2+3' });
  const line = observationsCsv([evil]).split('\r\n')[1];
  assert.ok(line.startsWith('4;'), line);
  assert.match(line, /;"'=HYPERLINK\(""http:\/\/x"",""clic""\)";/);
  assert.match(line, /;'\+33 6;/);
  assert.match(line, /;'-2\+3;/);
  assert.match(line, /;'@SUM\(A1\);/);
});
