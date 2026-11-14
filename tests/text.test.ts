import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRecord } from '../src/data/json.ts';
import { csvCell, fold, integer, megabytes, plural, s } from '../src/data/text.ts';

test('fold ignore accents, casse et espaces autour', () => {
  assert.equal(fold('  Été Béton '), 'ete beton');
  assert.equal(fold('ÇA va'), 'ca va');
  assert.equal(fold(12), '12');
  assert.equal(fold('50 %'), '50 %');
  assert.equal(fold(true), 'true');
});

test('pluriels à la française : « 0 élément », « 1 élément », « 2 éléments »', () => {
  assert.equal(plural(0, 'élément'), '0 élément');
  assert.equal(plural(1, 'élément'), '1 élément');
  assert.equal(plural(2, 'élément'), '2 éléments');
  assert.equal(plural(2, 'cheval', 'chevaux'), '2 chevaux');
  assert.equal(plural(1500, 'triangle'), `${integer.format(1500)} triangles`);
  assert.deepEqual([0, 1, 2].map(s), ['', '', 's']);
});

test('megabytes arrondit au mégaoctet, à la française', () => {
  assert.equal(megabytes(1_499_999), '1');
  assert.equal(megabytes(1_500_000), '2');
  assert.equal(megabytes(1234e6), (1234).toLocaleString('fr-FR'));
});

test('isRecord : un objet, ni tableau ni null', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord('x'), false);
});

test('csvCell : une formule de tableur devient du texte, un nombre reste un nombre', () => {
  for (const text of ['=1+1', '+33 6', '-2+3', '@SUM(A1)', '\tx', '\rx']) assert.ok(csvCell(text).replace(/^"/, '').startsWith(`'${text[0]}`), JSON.stringify(text));
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell('-5'), '-5');
  assert.equal(csvCell('-1 234,5'), '-1 234,5');
  assert.equal(csvCell('Mur ; "A"'), '"Mur ; ""A"""');
  assert.equal(csvCell('a\tb', '\t'), '"a\tb"');
  assert.equal(csvCell('Mur'), 'Mur');
});
