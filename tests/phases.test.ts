import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetadata, type PropValue } from '../src/data/metadata.ts';
import { DEFAULT_OVERRIDES, evaluatePhases, mergeAppearance, parsePhases, phaseStatus, phasesToJson, resolveFilter, type Phases } from '../src/data/phases.ts';

const SHOW_ALL = { name: 'Show All', default: true, statuses: { past: 'hidden', existing: 'overridden', demolished: 'overridden', new: 'normal', temporary: 'overridden', future: 'hidden' } };
const SHOW_NEW = { name: 'Show New', statuses: { past: 'hidden', existing: 'hidden', demolished: 'hidden', new: 'normal', temporary: 'hidden', future: 'hidden' } };
const SHOW_COMPLETE = { name: 'Show Complete', statuses: { past: 'hidden', existing: 'normal', demolished: 'hidden', new: 'normal', temporary: 'hidden', future: 'hidden' } };

function phases(extra: Record<string, unknown> = {}): Phases {
  const parsed = parsePhases({ order: ['Existing', 'Demo', 'New Construction'], created: 'Phase de création', demolished: 'Phase de démolition', filters: [SHOW_ALL, SHOW_NEW, SHOW_COMPLETE], ...extra });
  assert.ok(parsed);
  return parsed;
}

// --------------------------------------------------------------------------------------------- l'état d'un élément

test('l’état d’un élément dans une phase : futur, nouveau, existant, démoli, temporaire, passé', () => {
  // Phases : 0 Existant, 1 Démolition, 2 Neuf.
  // Créé dans la phase 1, jamais démoli.
  assert.equal(phaseStatus(1, undefined, 0), 'future', 'créé après la phase');
  assert.equal(phaseStatus(1, undefined, 1), 'new', 'créé dans la phase');
  assert.equal(phaseStatus(1, undefined, 2), 'existing', 'créé avant la phase');
  // Créé dans la phase 0, démoli dans la phase 1.
  assert.equal(phaseStatus(0, 1, 0), 'new');
  assert.equal(phaseStatus(0, 1, 1), 'demolished', 'démoli dans la phase, créé avant');
  assert.equal(phaseStatus(0, 1, 2), 'past', 'démoli avant la phase');
  // Créé et démoli dans la même phase : temporaire.
  assert.equal(phaseStatus(1, 1, 1), 'temporary');
  assert.equal(phaseStatus(1, 1, 0), 'future');
  assert.equal(phaseStatus(1, 1, 2), 'past');
  // Une démolition avant la création est ramenée à la création (jamais « passé » avant d'exister).
  assert.equal(phaseStatus(2, 0, 2), 'temporary');
  assert.equal(phaseStatus(2, 0, 1), 'future');
  // Démolition dans une phase ultérieure : l'élément existe encore.
  assert.equal(phaseStatus(0, 2, 1), 'existing');
  assert.equal(phaseStatus(0, 2, 2), 'demolished');
});

test('une même suite de phases classe chaque élément dans exactement un état', () => {
  const statuses = new Set<string>();
  for (let created = 0; created < 4; created++) {
    for (const demolished of [undefined, 0, 1, 2, 3]) {
      for (let current = 0; current < 4; current++) statuses.add(phaseStatus(created, demolished, current));
    }
  }
  assert.deepEqual([...statuses].sort(), ['demolished', 'existing', 'future', 'new', 'past', 'temporary']);
});

// --------------------------------------------------------------------------------------------- la section du contrat

test('parsePhases lit l’ordre, les propriétés, les filtres et les remplacements', () => {
  const parsed = phases({ overrides: { demolished: { color: '#FF0000', opacity: 0.6 }, existing: { color: '#7f7f7f' } } });
  assert.deepEqual(parsed.order, ['Existing', 'Demo', 'New Construction']);
  assert.equal(parsed.created, 'Phase de création');
  assert.equal(parsed.demolished, 'Phase de démolition');
  assert.deepEqual(parsed.filters.map((filter) => [filter.name, filter.default]), [['Show All', true], ['Show New', false], ['Show Complete', false]]);
  assert.equal(parsed.filters[1].statuses.existing, 'hidden');
  assert.deepEqual(parsed.overrides, { demolished: { color: '#ff0000', opacity: 0.6 }, existing: { color: '#7f7f7f' } });
});

test('parsePhases ignore ce qui est illisible sans empêcher de lire le reste', () => {
  assert.equal(parsePhases(undefined), undefined);
  assert.equal(parsePhases('phases'), undefined);
  assert.equal(parsePhases({ order: [], created: 'Phase' }), undefined, 'au moins une phase');
  assert.equal(parsePhases({ order: ['A'] }), undefined, 'il faut dire où est la phase de création');
  const parsed = parsePhases({
    order: ['A', 'A', 3, 'B'], created: 'Phase',
    filters: [{ name: 'F', statuses: { new: 'inconnu', existing: 'hidden', bizarre: 'hidden' } }, { name: 'F' }, { statuses: {} }, 7],
    overrides: { existing: { color: 'rouge', opacity: 4 }, demolished: 'x', new: {} },
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.order, ['A', 'B'], 'doublons et valeurs qui ne sont pas des noms écartés');
  assert.equal(parsed.demolished, undefined);
  // Un seul filtre « F » ; l'état inconnu et la présentation inconnue valent « tel quel ».
  assert.equal(parsed.filters.length, 1);
  assert.equal(parsed.filters[0].statuses.new, 'normal');
  assert.equal(parsed.filters[0].statuses.existing, 'hidden');
  // Couleur invalide ignorée, opacité ramenée dans [0, 1], remplacement vide ignoré.
  assert.deepEqual(parsed.overrides, { existing: { opacity: 1 } });
});

test('les métadonnées lisent la section, et un fichier d’avant continue de s’ouvrir', () => {
  const elements = { A: { label: 'Mur', properties: { 'Phase de création': 'New Construction' } } };
  const withPhases = parseMetadata({ version: 1, phases: { order: ['Existing', 'New Construction'], created: 'Phase de création', filters: [SHOW_ALL] }, elements });
  assert.deepEqual(withPhases.phases?.order, ['Existing', 'New Construction']);
  // Sans la section, rien ne change.
  assert.equal(parseMetadata({ version: 1, elements }).phases, undefined);
  // Une section illisible est ignorée : le fichier s'ouvre quand même.
  assert.equal(parseMetadata({ version: 1, phases: 12, elements }).phases, undefined);
  assert.equal(parseMetadata({ version: 1, phases: { order: [] }, elements }).elements.size, 1);
});

test('la section se réécrit à l’identique pour l’export des métadonnées', () => {
  const parsed = phases({ overrides: { demolished: { color: '#ff0000', opacity: 0.6 } } });
  assert.deepEqual(parsePhases(phasesToJson(parsed)), parsed);
});

// --------------------------------------------------------------------------------------------- le calcul

const ELEMENTS: Record<number, Record<string, PropValue>> = {
  0: { 'Phase de création': 'Existing' }, // existant, jamais démoli
  1: { 'Phase de création': 'Existing', 'Phase de démolition': 'Demo' }, // démoli dans « Demo »
  2: { 'Phase de création': 'Demo' }, // créé en « Demo »
  3: { 'Phase de création': 'New Construction' }, // neuf
  4: { 'Phase de création': 'Demo', 'Phase de démolition': 'Demo' }, // temporaire en « Demo »
  5: {}, // sans phase : niveau, trame…
  6: { 'Phase de création': 'Inconnue' }, // une phase hors liste : pas liée aux phases
};
const valueOf = (index: number, property: string): PropValue | undefined => ELEMENTS[index]?.[property];

test('« Show All » dans « Demo » : existant et démoli remplacés, nouveau tel quel, futur masqué', () => {
  const evaluation = evaluatePhases(phases(), { phase: 'Demo' }, 7, valueOf);
  assert.deepEqual([...evaluation.hidden], [0, 0, 0, 1, 0, 0, 0], 'seul l’élément créé après « Demo » est masqué');
  assert.deepEqual(evaluation.counts, { past: 0, existing: 1, demolished: 1, new: 1, temporary: 1, future: 1 });
  assert.equal(evaluation.unphased, 2, 'l’élément sans phase et celui d’une phase inconnue restent affichés');
  // Existant : gris par défaut ; démoli : rouge translucide ; temporaire : bleu translucide ; nouveau : rien.
  assert.deepEqual(evaluation.appearance.get(0), { color: DEFAULT_OVERRIDES.existing.color });
  assert.deepEqual(evaluation.appearance.get(1), { color: '#e03131', opacity: 0.6 });
  assert.deepEqual(evaluation.appearance.get(4), { color: '#1971c2', opacity: 0.6 });
  assert.equal(evaluation.appearance.has(2), false, 'un élément nouveau n’est pas teinté');
  assert.equal(evaluation.appearance.has(5), false);
});

test('un remplacement donné par le fichier remplace celui du viewer en entier', () => {
  const evaluation = evaluatePhases(phases({ overrides: { demolished: { color: '#ff0000' }, existing: { color: '#7f7f7f', opacity: 0.5 } } }), { phase: 'Demo' }, 7, valueOf);
  // Le fichier ne donne que la couleur du démoli : son état est opaque, l'opacité du viewer (0,6) ne s'y ajoute pas.
  assert.deepEqual(evaluation.appearance.get(1), { color: '#ff0000' });
  assert.deepEqual(evaluation.appearance.get(0), { color: '#7f7f7f', opacity: 0.5 });
  // Un état que le fichier ne remplace pas garde le remplacement du viewer.
  assert.deepEqual(evaluation.appearance.get(4), { color: '#1971c2', opacity: 0.6 });
});

test('un remplacement du fichier sans opacité n’applique aucune opacité', () => {
  const evaluation = evaluatePhases(phases({ overrides: { demolished: { color: '#ff0000' } } }), { phase: 'Demo' }, 7, valueOf);
  assert.equal('opacity' in evaluation.appearance.get(1)!, false,'l’opacité par défaut du démoli (0,6) ne doit pas revenir');
  // Une opacité de 1 donnée par le fichier ne s'applique pas non plus : l'élément reste opaque.
  const opaque = evaluatePhases(phases({ overrides: { demolished: { color: '#ff0000', opacity: 1 } } }), { phase: 'Demo' }, 7, valueOf);
  assert.deepEqual(opaque.appearance.get(1), { color: '#ff0000' });
});

test('« Show New » masque tout sauf le nouveau ; « Show Complete » garde l’existant tel quel', () => {
  const neuf = evaluatePhases(phases(), { phase: 'New Construction', filter: 'Show New' }, 7, valueOf);
  // Dans « New Construction » : 0 existant, 1 passé, 2 existant, 3 neuf, 4 passé.
  assert.deepEqual([...neuf.hidden], [1, 1, 1, 0, 1, 0, 0]);
  assert.equal(neuf.appearance.size, 0);
  const complet = evaluatePhases(phases(), { phase: 'New Construction', filter: 'Show Complete' }, 7, valueOf);
  assert.deepEqual([...complet.hidden], [0, 1, 0, 0, 1, 0, 0], 'l’existant reste, le passé disparaît');
  assert.equal(complet.appearance.size, 0, 'tels quels : aucune teinte');
});

test('sans filtre nommé, le filtre des vues neuves s’applique ; un nom inconnu aussi', () => {
  const parsed = phases();
  assert.equal(resolveFilter(parsed)?.name, 'Show All');
  assert.equal(resolveFilter(parsed, 'Show New')?.name, 'Show New');
  assert.equal(resolveFilter(parsed, 'Inconnu')?.name, 'Show All');
  const without = parsePhases({ order: ['A'], created: 'P', filters: [SHOW_NEW] });
  assert.equal(resolveFilter(without!)?.name, 'Show New', 'à défaut de filtre par défaut, le premier');
  assert.equal(resolveFilter(parsePhases({ order: ['A'], created: 'P' })!), undefined);
  // Sans filtre du tout, tout reste affiché tel quel.
  const bare = parsePhases({ order: ['A', 'B'], created: 'P' })!;
  const evaluation = evaluatePhases(bare, { phase: 'B' }, 1, () => 'A');
  assert.deepEqual([...evaluation.hidden], [0]);
  assert.equal(evaluation.appearance.size, 0);
});

test('une phase hors de la liste ne lie aucun élément', () => {
  const evaluation = evaluatePhases(phases(), { phase: 'Fantôme' }, 7, valueOf);
  assert.equal(evaluation.unphased, 7);
  assert.equal(evaluation.hidden.includes(1), false);
});

test('les remplacements de la phase passent sous les règles d’apparence, attribut par attribut', () => {
  const merged = mergeAppearance(new Map([[0, { color: '#808080', opacity: 0.5 }], [1, { color: '#ff0000' }]]), new Map([[0, { color: '#00ff00' }], [2, { opacity: 0.2 }]]));
  assert.deepEqual(merged.get(0), { color: '#00ff00', opacity: 0.5 });
  assert.deepEqual(merged.get(1), { color: '#ff0000' });
  assert.deepEqual(merged.get(2), { opacity: 0.2 });
});
