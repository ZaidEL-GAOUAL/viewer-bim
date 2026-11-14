import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetadata, type Metadata } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { applyOverlays, buildStore, chooseMetadata, modificationsFile, orphanNotice } from '../src/data/sidecar.ts';

const keys = ['a', 'b', 'c'];
const view = { name: '{3D}', camera: { position: [10, 10, 10], direction: [-1, -1, -1] } };

/** The reader's own metadata, as a .rvt gives it: only identity is locked. */
function own(): Metadata {
  return parseMetadata({
    version: 1,
    readOnly: ['Identifiant Revit', 'GUID IFC', 'Source de la géométrie'],
    georeference: { latitude: 45.7, longitude: 4.6 },
    views: [view],
    elements: {
      a: { label: 'Mur', properties: { 'Identifiant Revit': 1, Niveau: 'R+1', Lot: 'GO' } },
      b: { label: 'Porte', properties: { 'Identifiant Revit': 2, Niveau: 'R+1' } },
      c: { label: 'Dalle', properties: { 'Identifiant Revit': 3, Niveau: 'R+2' } },
    },
  });
}

/** Opens the model as `installModel` does: base, store, then the overlays on top. */
function open(fileMetadata: Metadata | null, dropped: Metadata[], extras: (Record<string, unknown> | undefined)[] = []) {
  const { metadata, overlays } = chooseMetadata(fileMetadata, dropped, keys);
  const store = buildStore(keys, extras, metadata);
  const edits = new PropertyEdits(store, () => {});
  const notices = applyOverlays(edits, overlays, keys);
  return { metadata, store, edits, notices };
}

function reread(json: unknown, name: string): Metadata {
  const metadata = parseMetadata(JSON.parse(JSON.stringify(json)));
  metadata.source = name;
  return metadata;
}

test('a model, its own metadata and the modifications JSON dropped together: the edits come back', () => {
  const session = open(own(), []);
  session.edits.set([0], 'Niveau', 'R+2');
  session.edits.delete([0], 'Lot');
  const file = modificationsFile(session.edits, keys, 'maison.rvt');
  assert.deepEqual(file.source, { name: 'maison.rvt', kind: 'revit' });
  assert.equal(file.propertiesMode, undefined, 'merge mode');

  const overlay = reread(file, 'maison.modifications.json');
  const reopened = open(own(), [overlay]);
  assert.equal(reopened.store.propsOf(0)?.Niveau, 'R+2');
  assert.equal(Object.hasOwn(reopened.store.propsOf(0)!, 'Lot'), false);
  assert.deepEqual(reopened.notices, []);
  assert.equal(reopened.edits.changed, false, 'nothing new to save');
  assert.equal(reopened.edits.modifiedCount, 1);
  assert.equal(reopened.edits.isModified(0, 'Niveau'), true);
  // Exporting again keeps the earlier changes along with the new ones.
  reopened.edits.set([1], 'Niveau', 'R+3');
  assert.deepEqual(Object.keys(reopened.edits.diff(keys).elements), ['a', 'b']);
  // And undoing the overlay goes back to the file.
  reopened.edits.revertAll();
  assert.equal(reopened.store.propsOf(0)?.Niveau, 'R+1');
});

test('overlays are applied in name order, on top of the file, after values it re-read fresh', () => {
  const first = reread({ version: 1, source: { name: 'maison.rvt', kind: 'revit' }, elements: { a: { properties: { Niveau: 'R+5', Lot: 'CVC' } } } }, '1-niveaux.json');
  const second = reread({ version: 1, source: { name: 'maison.rvt', kind: 'revit' }, elements: { a: { properties: { Niveau: 'R+6' } } } }, '2-niveaux.json');
  const fresh = own();
  fresh.elements.get('b')!.props.Niveau = 'R+9'; // re-saved in Revit: values nobody touched come from the file
  const { store, edits } = open(fresh, [second, first]);
  assert.equal(store.propsOf(0)?.Niveau, 'R+6');
  assert.equal(store.propsOf(0)?.Lot, 'CVC');
  assert.equal(store.propsOf(1)?.Niveau, 'R+9');
  assert.equal(edits.count, 2, 'one undo step per overlay');
});

test('a full snapshot dropped with its model wins a tie, the reader keeps views, georeference and locks', () => {
  const session = open(own(), []);
  session.edits.set([2], 'Niveau', 'R+3');
  const exported = session.store.export(keys) as Record<string, unknown>;
  exported.readOnly = ['Catégorie', 'Niveau', 'Identifiant Revit']; // what the reader used to lock
  exported.views = [{ ...view, name: 'Ancienne vue' }];
  const snapshot = reread(exported, 'maison.json');
  const { metadata, store } = open(own(), [snapshot]);
  assert.equal(metadata?.source, 'maison.json');
  assert.equal(store.propsOf(2)?.Niveau, 'R+3');
  assert.deepEqual(metadata?.views?.map((saved) => saved.name), ['{3D}']);
  assert.equal(metadata?.georeference?.latitude, 45.7);
  assert.equal(store.isEditable('Niveau'), true);
  // A snapshot of fewer elements than the file loses, as before.
  const partial = reread({ version: 1, propertiesMode: 'replace', elements: { a: { properties: { Niveau: 'R+8' } } } }, 'partiel.json');
  assert.equal(open(own(), [partial]).store.propsOf(0)?.Niveau, 'R+1');
});

test('without metadata of its own (a glb), a plain JSON is the base and the modifications go on top', () => {
  const complement = reread({ version: 1, readOnly: ['Classe IFC'], elements: { a: { properties: { 'Classe IFC': 'IfcWall', Niveau: 'R+1' } }, b: { properties: { Niveau: 'R+1' } }, c: { properties: { Niveau: 'R+2' } } } }, 'maison.json');
  const overlay = reread({ version: 1, source: { name: 'maison.glb', kind: 'glb' }, elements: { a: { properties: { 'Classe IFC': 'IfcWall', Niveau: 'R+4' } }, b: { properties: { Niveau: 'R+4' } }, c: { properties: { Niveau: 'R+4' } } } }, 'a-modifications.json');
  // The overlay touches every element and sorts first: it still goes on top, never under.
  const opened = open(null, [overlay, complement]);
  assert.equal(opened.metadata, complement);
  assert.equal(opened.store.propsOf(0)?.Niveau, 'R+4');
  assert.equal(opened.edits.modifiedCount, 3);
  // A glb whose properties are in its extras, with the modifications only: the extras are the file.
  const extras = [{ Niveau: 'R+1' }, { Niveau: 'R+1' }, undefined];
  const bare = open(null, [overlay], extras);
  assert.equal(bare.metadata, null);
  assert.equal(bare.store.propsOf(1)?.Niveau, 'R+4');
  assert.deepEqual(bare.edits.diff(keys).elements.b, { properties: { Niveau: 'R+4' } });
});

test('an overlay that mostly misses the model is loaded, and said so', () => {
  const overlay = reread({ version: 1, source: { name: 'maison.rvt', kind: 'revit' }, elements: { a: { properties: { Niveau: 'R+4' } }, x: { properties: { Niveau: 'R+4' } }, y: { properties: { Niveau: 'R+4' } }, z: { properties: { Niveau: 'R+4' } } } }, 'ancien.json');
  const { store, notices } = open(own(), [overlay]);
  assert.equal(store.propsOf(0)?.Niveau, 'R+4');
  assert.deepEqual(notices, ['« ancien.json » : 3 éléments modifiés sur 4 introuvables dans ce modèle.']);
  assert.equal(orphanNotice(reread({ version: 1, elements: { a: {}, x: {} } }, 'moitié.json'), keys), '', 'half found: nothing to say');
});
