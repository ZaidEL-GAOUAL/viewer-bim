// Couche 3 : les comptes rendus sont écrits par le code d'après le résultat des outils ; les écritures larges passent par un aperçu.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFIRM_ABOVE, answerFor, previewAnswer, previewWrite } from '../src/assistant/answers.ts';
import { runTool, type ToolContext } from '../src/assistant/tools.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { PropertyStore } from '../src/data/metadata.ts';

function model(count: number) {
  const store = new PropertyStore(count);
  for (let i = 0; i < count; i++) store.set(i, { Niveau: i % 2 ? 'R+1' : 'RDC', Longueur: i }, `Élément ${i}`);
  store.finalize();
  const edits = new PropertyEdits(store, () => {});
  const context: ToolContext = {
    store, count, keys: Array.from({ length: count }, (_, i) => `k${i}`), labelOf: (i) => `Élément ${i}`, selection: new Set(), select: () => {},
    setVisible: () => {}, showAll: () => {}, appearanceRules: [], setAppearanceRules: () => {}, groupBy: () => {}, writeProperties: (updates) => edits.setMany(updates),
  };
  return { store, edits, context };
}
const run = (name: string, args: Record<string, unknown>, context: ToolContext) => answerFor(name, args, runTool(name, args, context));

test('les actions sont racontées par le code, d’après le résultat de l’outil', () => {
  const { context } = model(8);
  const rdc = [{ property: 'Niveau', value: 'RDC' }];
  assert.deepEqual(run('select_elements', { filters: rdc, isolate: true }, context), { kind: 'view', text: '4 éléments isolés : Élément 0, Élément 2, Élément 4, Élément 6.' });
  assert.deepEqual(run('set_visibility', { filters: [], visible: false }, context), { kind: 'view', text: '8 éléments masqués : Élément 0, Élément 1, Élément 2, Élément 3, Élément 4 et 3 autres.' });
  assert.equal(run('set_visibility', { filters: [], showAll: true }, context).text, 'Toute la maquette est réaffichée.');
  assert.equal(run('update_view', { rules: [{ id: 'r', name: 'RDC en rouge', conditions: rdc, color: '#e53935' }], groupBy: ['Niveau'] }, context).text, 'Règle « RDC en rouge » (couleur #e53935) appliquée. Arborescence regroupée par Niveau.');
  assert.deepEqual(run('set_property', { filters: rdc, property: 'Lot', value: 'GO' }, context).kind, 'write');
  assert.equal(run('set_property', { filters: rdc, property: 'Lot', value: 'GO' }, context).text, 'Rien n’a changé : ces éléments avaient déjà cette valeur de « Lot ».');
  const missing = run('select_elements', { filters: [{ property: 'Niveau', value: 'R+9' }] }, context);
  assert.deepEqual(missing, { kind: 'error', text: 'Aucun élément ne correspond. Valeurs de « Niveau » : R+1, RDC.' });
});

test('les lectures deviennent des tableaux et des chiffres', () => {
  const { context } = model(8);
  const counted = run('count_by', { property: 'Niveau' }, context);
  assert.equal(counted.text, 'Répartition par « Niveau » : 8 éléments, 2 valeurs.');
  assert.deepEqual(counted.table, { columns: ['Valeur', 'Éléments'], rows: [['R+1', '4'], ['RDC', '4']] });
  const sum = run('compute', { filters: [], expression: '[Longueur] / 2' }, context);
  assert.deepEqual(sum.figures?.slice(0, 2), [['Somme', '14'], ['Moyenne', '1,75']]);
  const found = run('find_elements', { filters: [{ property: 'Niveau', value: 'R+1' }], properties: ['Longueur'] }, context);
  assert.deepEqual(found.table?.columns, ['Élément', 'Longueur', 'Niveau']);
  assert.deepEqual(found.table?.rows[0], ['Élément 1', '1', 'R+1']);
});

test('une écriture sur plus de 200 éléments, ou sur toute la maquette, est d’abord montrée', () => {
  const small = model(8);
  // Toute la maquette, même petite : aperçu.
  const whole = previewWrite('set_property', { filters: [], property: 'Lot', value: 'GO' }, small.context);
  assert.ok(whole);
  assert.equal(small.edits.canUndo, false, 'rien n’est écrit');
  const text = previewAnswer('set_property', whole!, small.context.count);
  assert.equal(text.text, 'Écrire « Lot » (nouvelle propriété) sur 8 éléments (toute la maquette) ? Rien n’est écrit avant « Appliquer ».');
  assert.deepEqual(text.table?.rows[0], ['Élément 0', '—', 'GO']);
  // Une partie, sous le seuil : directement.
  assert.equal(previewWrite('set_property', { filters: [{ property: 'Niveau', value: 'RDC' }], property: 'Lot', value: 'GO' }, small.context), null);
  // Au-delà du seuil, même partielle : aperçu.
  const large = model(2 * CONFIRM_ABOVE + 10);
  assert.ok(previewWrite('set_property', { filters: [{ property: 'Niveau', value: 'RDC' }], property: 'Lot', value: 'GO' }, large.context));
  const dates = previewWrite('plan_dates', { filters: [], start: '2026-01-05', end: '2026-12-18', minDays: 5, maxDays: 10, orderBy: ['Niveau'] }, small.context);
  assert.match(previewAnswer('plan_dates', dates!, 8).text, /^Écrire des dates de début et de fin sur 8 éléments \(toute la maquette\), du 2026-01-05 au 2026-12-18 \?/);
  // Lectures et vues : jamais d'aperçu ; une écriture refusée par l'outil non plus (il le dira).
  assert.equal(previewWrite('select_elements', { filters: [] }, small.context), null);
  assert.equal(previewWrite('set_property', { filters: [], property: 'Niveau / x', value: 1, expression: '[Inconnue]' }, small.context), null);
});
