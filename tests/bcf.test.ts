import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { imageSize, readBcf, writeBcf, type BcfTopic } from '../src/data/bcf.ts';
import { readZip } from '../src/data/zip.ts';
import { deflatedZip, nodeInflate } from './zipHelpers.ts';

/** A PNG header with its IHDR chunk: enough for the size check, nothing is decoded. */
function fakePng(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6], 24);
  return bytes;
}
/** A JPEG made of SOI, an APP0 segment and a SOF0 segment. */
function fakeJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 0, 0, 0]);
}

/** Blobs compare by their bytes and type. */
async function plain(topics: readonly BcfTopic[]): Promise<unknown> {
  const bytes = async (blob: Blob | undefined) => (blob ? { type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] } : undefined);
  return Promise.all(topics.map(async (topic) => ({
    ...topic,
    viewpoints: await Promise.all(topic.viewpoints.map(async ({ snapshot, ...rest }) => ({ ...rest, snapshot: await bytes(snapshot) }))),
    documents: await Promise.all(topic.documents.map(async ({ data, ...rest }) => ({ ...rest, data: await bytes(data) }))),
  })));
}

const TOPIC: BcfTopic = {
  guid: '3f0e6a9c-1b2d-4e5f-8a7b-9c0d1e2f3a4b',
  type: 'Réserve', status: 'Ouverte', title: 'Joint <silicone> & "reprise"', priority: 'Haute', labels: ['Plomberie'],
  creationDate: '2026-11-14T08:30:00Z', creationAuthor: 'Zaid', modifiedDate: '2026-11-14T09:00:00Z', modifiedAuthor: 'Zaid',
  dueDate: '2026-11-30T00:00:00Z', assignedTo: 'Entreprise Durand', stage: 'OPR', description: 'Ligne 1\nLigne 2',
  referenceLinks: ['https://exemple.fr/doc'], relatedTopics: ['0f1e2d3c-4b5a-4968-8776-655443322110'],
  documents: [
    { guid: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', filename: 'photo-1.jpg', description: 'Vue de près', data: new Blob([fakeJpeg(1200, 900)], { type: 'image/jpeg' }) },
    { guid: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e', filename: 'pv.pdf', url: 'https://exemple.fr/pv.pdf' },
  ],
  comments: [
    { guid: 'c0ffee00-1234-4abc-8def-0123456789ab', date: '2026-11-14T08:31:00Z', author: 'Zaid', text: 'Créée sur place.', viewpoint: 'd00dfeed-1234-4abc-8def-0123456789ab' },
    { guid: 'c0ffee01-1234-4abc-8def-0123456789ab', date: '2026-11-14T09:00:00Z', author: 'Zaid', text: 'Statut : Ouverte → En cours', modifiedDate: '2026-11-14T09:05:00Z', modifiedAuthor: 'Paul' },
  ],
  viewpoints: [
    {
      guid: 'd00dfeed-1234-4abc-8def-0123456789ab',
      camera: { kind: 'perspective', viewPoint: [12.5, -3.25, 1.7], direction: [0, 1, 0], up: [0, 0, 1], fieldOfView: 50, aspectRatio: 1.6 },
      clippingPlanes: [{ location: [0, 0, 2.8], direction: [0, 0, 1] }],
      selection: [{ ifcGuid: '2O2Fr$t4X7Zf8NOew3FLOH' }, { authoringToolId: '318216' }],
      snapshot: new Blob([fakePng(1500, 844)], { type: 'image/png' }),
    },
    {
      guid: 'd00dfeed-5678-4abc-8def-0123456789ab',
      camera: { kind: 'orthogonal', viewPoint: [5, 5, 30], direction: [0, 0, -1], up: [0, 1, 0], viewToWorldScale: 24, aspectRatio: 1.5 },
      clippingPlanes: [], selection: [],
    },
  ],
};

test('BCF 3.0: write then read gives the same topics, comments, viewpoints, documents and snapshots', async () => {
  const minimal: BcfTopic = { guid: '4f0e6a9c-1b2d-4e5f-8a7b-9c0d1e2f3a4c', type: 'Tâche', status: 'Ouverte', title: '', labels: [], creationDate: '2026-11-14T10:00:00Z', creationAuthor: 'Zaid', referenceLinks: [], relatedTopics: [], documents: [], comments: [], viewpoints: [] };
  const extensions = { topicTypes: ['Réserve', 'Tâche'], topicStatuses: ['Ouverte', 'En cours'], priorities: ['Haute'], topicLabels: ['Plomberie'], users: ['Zaid'], stages: ['OPR'] };
  const file = await writeBcf([TOPIC, minimal], extensions);
  const read = await readBcf(file, nodeInflate);
  assert.equal(read.version, '3.0');
  assert.deepEqual(read.notes, []);
  assert.deepEqual(await plain(read.topics), await plain([TOPIC, minimal]));
  assert.deepEqual(read.extensions, extensions);
});

test('BCF 3.0 files are laid out and ordered as the schema says', async () => {
  const entries = await readZip(await writeBcf([TOPIC]), nodeInflate);
  const folder = TOPIC.guid;
  assert.deepEqual([...entries.keys()].sort(), ['Documents/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', `${folder}/markup.bcf`, `${folder}/snapshot.png`, `${folder}/viewpoint-d00dfeed-5678-4abc-8def-0123456789ab.bcfv`, `${folder}/viewpoint.bcfv`, 'bcf.version', 'documents.xml', 'extensions.xml'].sort());
  const text = async (name: string) => new TextDecoder().decode(await entries.get(name)!.bytes());
  assert.match(await text('bcf.version'), /<Version VersionId="3.0"\/>/);
  const markup = await text(`${folder}/markup.bcf`);
  const order = [...markup.matchAll(/<(\w+)[ >/]/g)].map((match) => match[1]).filter((name, i, all) => all.indexOf(name) === i);
  assert.deepEqual(order, ['Markup', 'Topic', 'ReferenceLinks', 'ReferenceLink', 'Title', 'Priority', 'Labels', 'Label', 'CreationDate', 'CreationAuthor', 'ModifiedDate', 'ModifiedAuthor', 'DueDate', 'AssignedTo', 'Stage', 'Description', 'DocumentReferences', 'DocumentReference', 'DocumentGuid', 'Url', 'RelatedTopics', 'RelatedTopic', 'Comments', 'Comment', 'Date', 'Author', 'Viewpoint', 'Viewpoints', 'ViewPoint', 'Snapshot']);
  assert.match(markup, /<Title>Joint &lt;silicone&gt; &amp; &quot;reprise&quot;<\/Title>/);
  const visinfo = await text(`${folder}/viewpoint.bcfv`);
  assert.match(visinfo, /<Components><Selection><Component IfcGuid="2O2Fr\$t4X7Zf8NOew3FLOH"\/><Component><AuthoringToolId>318216<\/AuthoringToolId><\/Component><\/Selection><Visibility DefaultVisibility="true"\/><\/Components><PerspectiveCamera>/);
  assert.match(visinfo, /<FieldOfView>50<\/FieldOfView><AspectRatio>1.6<\/AspectRatio><\/PerspectiveCamera><ClippingPlanes>/);
  assert.match(await text('documents.xml'), /<DocumentInfo><Documents><Document Guid="9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"><Filename>photo-1.jpg<\/Filename><\/Document><\/Documents><\/DocumentInfo>/);
});

test('the writer refuses what the schema forbids: a snapshot over 1500 px, a bad GUID, a bad date', async () => {
  const big = { ...TOPIC, viewpoints: [{ ...TOPIC.viewpoints[0], snapshot: new Blob([fakePng(1501, 800)], { type: 'image/png' }) }] };
  await assert.rejects(writeBcf([big]), /1 500 px/);
  await assert.rejects(writeBcf([{ ...TOPIC, guid: 'pas-un-guid' }]), /GUID/);
  await assert.rejects(writeBcf([{ ...TOPIC, dueDate: '30/11/2026' }]), /date/);
  // A field of view outside 45–60° is brought inside on writing.
  const wide = { ...TOPIC, viewpoints: [{ ...TOPIC.viewpoints[0], camera: { ...TOPIC.viewpoints[0].camera!, fieldOfView: 75 } }] };
  const back = await readBcf(await writeBcf([wide]), nodeInflate);
  assert.equal(back.topics[0].viewpoints[0].camera?.fieldOfView, 60);
});

test('image sizes are read from PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(fakePng(640, 480)), { width: 640, height: 480, type: 'png' });
  assert.deepEqual(imageSize(fakeJpeg(1500, 1000)), { width: 1500, height: 1000, type: 'jpeg' });
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), null);
});

test('a hand-written BCF 2.1 file (deflated) reads: topic, labels, comments, viewpoint, snapshot, documents', async () => {
  const root = new URL('./fixtures/bcf21/', import.meta.url);
  const folder = '2b9d2f1e-6c4a-4f3e-9d1a-1f2e3d4c5b6a';
  const snapshot = fakePng(800, 600);
  const file = deflatedZip({
    'bcf.version': readFileSync(new URL('bcf.version', root), 'utf8'),
    [`${folder}/markup.bcf`]: readFileSync(new URL(`${folder}/markup.bcf`, root), 'utf8'),
    [`${folder}/viewpoint.bcfv`]: readFileSync(new URL(`${folder}/viewpoint.bcfv`, root), 'utf8'),
    [`${folder}/snapshot.png`]: snapshot,
    'Documents/croquis.txt': readFileSync(new URL('Documents/croquis.txt', root)),
  });
  const { version, topics, notes } = await readBcf(file, nodeInflate);
  assert.equal(version, '2.1');
  assert.deepEqual(notes, []);
  assert.equal(topics.length, 1);
  const [topic] = topics;
  assert.deepEqual({ ...topic, documents: [], viewpoints: [] }, {
    guid: folder, type: 'Error', status: 'Open', title: 'Fissure sur voile & reprise', priority: 'High', labels: ['Gros œuvre', 'Structure'],
    creationDate: '2026-10-02T09:15:00+02:00', creationAuthor: 'marie@exemple.fr', modifiedDate: '2026-10-03T10:00:00Z', modifiedAuthor: 'paul@exemple.fr',
    dueDate: '2026-11-30T00:00:00Z', assignedTo: 'Entreprise Martin', stage: 'OPR', description: 'Fissure de 2 mm au droit de l\'ouverture.',
    referenceLinks: ['https://exemple.fr/chantier/12'], relatedTopics: ['0f1e2d3c-4b5a-4968-8776-655443322110'],
    comments: [
      { guid: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', date: '2026-10-02T09:20:00Z', author: 'marie@exemple.fr', text: 'Vue depuis l\'escalier.', viewpoint: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9' },
      { guid: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e', date: '2026-10-03T10:00:00Z', author: 'paul@exemple.fr', text: 'Reprise prévue lundi.' },
    ],
    documents: [], viewpoints: [],
  });
  const [viewpoint] = topic.viewpoints;
  assert.deepEqual({ ...viewpoint, snapshot: undefined }, {
    guid: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9', snapshot: undefined,
    camera: { kind: 'perspective', viewPoint: [10, -5, 1.6], direction: [0, 1, 0], up: [0, 0, 1], fieldOfView: 60 },
    clippingPlanes: [{ location: [0, 0, 3], direction: [0, 0, 1] }],
    selection: [{ ifcGuid: '2O2Fr$t4X7Zf8NOew3FLOH', originatingSystem: 'Revit', authoringToolId: '318215' }, { authoringToolId: '318216' }],
  });
  assert.deepEqual(new Uint8Array(await viewpoint.snapshot!.arrayBuffer()), snapshot);
  assert.equal(viewpoint.snapshot!.type, 'image/png');
  const [sketch, external] = topic.documents;
  assert.deepEqual({ ...sketch, data: undefined }, { guid: '7c1e0b8a-3d2f-4a6b-8e9c-0a1b2c3d4e5f', filename: 'croquis.txt', description: 'Croquis du métreur', data: undefined });
  assert.match(await sketch.data!.text(), /fissure verticale/);
  assert.deepEqual(external, { guid: '8d2f1c9b-4e3a-4b7c-9fad-1b2c3d4e5f60', filename: 'opr.pdf', url: 'https://exemple.fr/pv/opr.pdf' });
});

test('an unreadable topic is skipped with a note; an unknown version is refused', async () => {
  const notes = (await readBcf(deflatedZip({ 'bcf.version': '<Version VersionId="3.0"/>', 'x/markup.bcf': '<Markup><Topic' }), nodeInflate)).notes;
  assert.equal(notes.length, 1);
  assert.match(notes[0], /x\/markup\.bcf/);
  await assert.rejects(readBcf(deflatedZip({ 'bcf.version': '<Version VersionId="1.0"/>' }), nodeInflate), /1\.0/);
});
