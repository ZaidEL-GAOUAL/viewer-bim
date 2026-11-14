// Couche 1 : le corpus de phrases passe par les commandes, sans modèle de langage ni réseau.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseIntent, type Parsed } from '../src/assistant/intent.ts';
import { ValueIndex, stem, words } from '../src/assistant/valueIndex.ts';
import { PropertyStore, type FlatProps } from '../src/data/metadata.ts';

interface Model { readOnly: string[]; elements: { key: string; label: string | null; props: FlatProps | null }[] }
interface Case { model: string; lang: string; style: string; text: string; expect: null | { undo: true } | { ambiguity: string[] } | { tool: string; args: Record<string, unknown> } }
const corpus = JSON.parse(readFileSync(new URL('./fixtures/assistant/corpus.json', import.meta.url), 'utf8')) as { models: Record<string, Model>; cases: Case[] };

export function indexOf(model: Model): ValueIndex {
  const store = new PropertyStore(model.elements.length);
  model.elements.forEach((element, i) => store.set(i, element.props ?? undefined, element.label ?? undefined));
  store.finalize();
  store.readOnly = model.readOnly;
  return new ValueIndex(store, model.elements.length, model.elements.map((element) => element.key), (i) => model.elements[i].label ?? '');
}

/** Ce que la couche 1 a produit, sous la forme des attentes du corpus. */
function shape(parsed: Parsed): Case['expect'] {
  if (parsed === null) return null;
  if (parsed.kind === 'undo') return { undo: true };
  if (parsed.kind === 'ambiguity') return { ambiguity: parsed.choices.map((choice) => choice.label) };
  return { tool: parsed.tool, args: parsed.args };
}

test('le corpus passe par les commandes : action attendue, question à choix, ou refus', (t) => {
  const indexes = new Map(Object.entries(corpus.models).map(([name, model]) => [name, indexOf(model)]));
  assert.ok(corpus.cases.length >= 40, `${corpus.cases.length} phrases`);
  const failures: string[] = [];
  for (const item of corpus.cases) {
    const got = shape(parseIntent(item.text, indexes.get(item.model)!));
    try { assert.deepEqual(got, item.expect); }
    catch { failures.push(`« ${item.text} » (${item.model}) : attendu ${JSON.stringify(item.expect)}, obtenu ${JSON.stringify(got)}`); }
  }
  const counts = (key: keyof Case, value: string) => corpus.cases.filter((item) => item[key] === value).length;
  t.diagnostic(`${corpus.cases.length - failures.length}/${corpus.cases.length} phrases (${counts('lang', 'fr')} fr, ${counts('lang', 'en')} en, ${counts('style', 'dictated')} dictées) ; refus attendus : ${corpus.cases.filter((item) => item.expect === null).length}`);
  assert.deepEqual(failures, []);
});

test('chaque choix d’une question est une commande complète, prête à exécuter', () => {
  const index = indexOf(corpus.models.etages);
  const parsed = parseIntent('masque R+2', index);
  assert.equal(parsed?.kind, 'ambiguity');
  if (parsed?.kind !== 'ambiguity') return;
  assert.deepEqual(parsed.choices.map((choice) => choice.intent), [
    { kind: 'tool', tool: 'set_visibility', args: { filters: [{ property: 'Contraintes / Contrainte inférieure', op: 'equals', value: 'R+2' }], visible: false } },
    { kind: 'tool', tool: 'set_visibility', args: { filters: [{ property: 'Niveau', op: 'equals', value: 'R+2' }], visible: false } },
  ]);
});

test('une durée par groupe dont le nom désigne deux propriétés devient une question, chaque choix prêt à exécuter', () => {
  const index = indexOf({ readOnly: [], elements: [
    { key: 'k1', label: 'Mur', props: { 'Niveau de base': 'R+1', 'Niveau supérieur': 'R+2' } },
    { key: 'k2', label: 'Dalle', props: { 'Niveau de base': 'RDC', 'Niveau supérieur': 'R+1' } },
  ] });
  const parsed = parseIntent('le 2 mars 2027, chaque niveau dure trois semaines', index);
  assert.equal(parsed?.kind, 'ambiguity');
  if (parsed?.kind !== 'ambiguity') return;
  assert.deepEqual(parsed.choices.map((choice) => choice.intent), ['Niveau de base', 'Niveau supérieur'].map((path) => (
    { kind: 'tool', tool: 'plan_dates', args: { filters: [], start: '2027-03-02', daysPerGroup: 21, orderBy: [path] } }
  )));
});

test('vocabulaire courant : « étage » trouve « Niveau » faute de mieux, jamais à la place d’une propriété qu’il nomme', () => {
  const niveauOnly = indexOf(corpus.models.niveau_revit);
  assert.deepEqual(niveauOnly.propertiesNamed('étages'), ['Niveau'], 'le nom exact passe avant « Floor finish level » et « …rapport au niveau »');
  assert.deepEqual(niveauOnly.propertiesNamed('storey'), ['Niveau']);
  const both = indexOf({ readOnly: [], elements: [
    { key: 'k1', label: 'Mur', props: { Catégorie: 'Murs', Étage: 'E1', Niveau: 'N1' } },
    { key: 'k2', label: 'Sol', props: { Catégorie: 'Sols', Étage: 'E2', Niveau: 'N2' } },
  ] });
  assert.deepEqual(both.propertiesNamed('étage'), ['Étage']);
  assert.deepEqual(both.propertiesNamed('niveau'), ['Niveau']);
  assert.deepEqual(shape(parseIntent('le 2 mars 2027, chaque étage prend trois semaines', both)), { tool: 'plan_dates', args: { filters: [], start: '2027-03-02', daysPerGroup: 21, orderBy: ['Étage'] } });
  assert.deepEqual(shape(parseIntent('combien de murs par étage', both)), { tool: 'count_by', args: { property: 'Étage', filters: [{ property: 'Catégorie', op: 'equals', value: 'Murs' }] } });
});

test('« combien de X par Y » : une question quand Y désigne deux propriétés, chaque choix filtré sur X', () => {
  const index = indexOf({ readOnly: [], elements: [
    { key: 'k1', label: 'Mur', props: { Catégorie: 'Murs', 'Niveau de base': 'R+1', 'Niveau supérieur': 'R+2' } },
    { key: 'k2', label: 'Dalle', props: { Catégorie: 'Sols', 'Niveau de base': 'RDC', 'Niveau supérieur': 'R+1' } },
  ] });
  assert.deepEqual(shape(parseIntent('combien de murs par niveau', index)), { ambiguity: ['Niveau de base', 'Niveau supérieur'] });
  const parsed = parseIntent('combien de murs par niveau', index);
  if (parsed?.kind !== 'ambiguity') return;
  assert.deepEqual(parsed.choices[1].intent, { kind: 'tool', tool: 'count_by', args: { property: 'Niveau supérieur', filters: [{ property: 'Catégorie', op: 'equals', value: 'Murs' }] } });
});

test('aucun vocabulaire BIM : la même phrase marche sur un modèle anglais par ses valeurs, et nulle part ailleurs', () => {
  const english = indexOf({ readOnly: [], elements: [
    { key: 'k1', label: 'Basic Wall', props: { Category: 'Walls', Level: 'Level 1' } },
    { key: 'k2', label: 'Floor', props: { Category: 'Floors', Level: 'Level 2' } },
  ] });
  assert.deepEqual(shape(parseIntent('isolate the walls', english)), { tool: 'select_elements', args: { filters: [{ property: 'Category', op: 'equals', value: 'Walls' }], isolate: true } });
  assert.deepEqual(shape(parseIntent('hide level 2', english)), { tool: 'set_visibility', args: { filters: [{ property: 'Level', op: 'equals', value: 'Level 2' }], visible: false } });
  // « murs » n'est pas une valeur de ce modèle : aucune traduction cachée.
  assert.equal(parseIntent('isole les murs', english), null);
});

test('mots comparables : accents, casse, pluriels, « R plus 2 », apostrophes', () => {
  assert.deepEqual(words('N’affiche que le R plus 2 et le rez-de-chaussée'), ['n', 'affiche', 'que', 'le', 'r+2', 'et', 'le', 'rez', 'de', 'chaussee']);
  assert.deepEqual(words('à A'), ['au', 'a']);
  assert.deepEqual(words('Épaisseur 0.25'), ['epaisseur', '0,25']);
  assert.deepEqual(['murs', 'poteaux', 'niveaux', 'matériaux', 'métaux', 'métal', 'categories', 'rdc', '1f'].map((word) => stem(words(word)[0])), ['mur', 'poteau', 'niveau', 'materiau', 'metau', 'metau', 'category', 'rdc', '1f']);
});

test('les propriétés aux valeurs presque toutes différentes ne sont pas indexées, leurs noms si', () => {
  const index = indexOf({ readOnly: [], elements: Array.from({ length: 600 }, (_, i) => ({ key: `k${i}`, label: null, props: { Identifiant: `ID ${i}`, Niveau: i % 2 ? 'Haut' : 'Bas' } })) });
  assert.equal(index.valuesFor(['id', '5']).length, 0);
  assert.equal(index.valuesFor(['haut']).length, 1);
  assert.deepEqual(index.propertiesNamed('identifiant'), ['Identifiant']);
});
