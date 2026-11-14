import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNDEFINED_LABEL } from '../src/data/metadata.ts';
import { categoryColor, hexToRgb } from '../src/data/palette.ts';

const HEX = /^#[0-9a-f]{6}$/;

test('la couleur d’une valeur est stable : même rang, même couleur', () => {
  for (const index of [0, 5, 11, 12, 40, 500]) {
    assert.equal(categoryColor(index, 'A'), categoryColor(index, 'A'));
    assert.match(categoryColor(index, 'A'), HEX);
  }
});

test('les douze premières valeurs ont des teintes distinctes, les suivantes aussi', () => {
  const colors = Array.from({ length: 60 }, (_, index) => categoryColor(index, `v${index}`));
  assert.equal(new Set(colors).size, colors.length);
});

test('« (non défini) » est toujours gris, quel que soit son rang', () => {
  assert.equal(categoryColor(0, UNDEFINED_LABEL), '#9aa0a6');
  assert.equal(categoryColor(30, UNDEFINED_LABEL), '#9aa0a6');
});

test('la couleur ne dépend que du rang, pas du texte de la valeur', () => {
  assert.equal(categoryColor(3, 'Béton'), categoryColor(3, 'Bois'));
});

test('hexToRgb lit #rrggbb', () => {
  assert.deepEqual(hexToRgb('#3b82c4'), [0x3b, 0x82, 0xc4]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
  assert.deepEqual(hexToRgb('#ffffff'), [255, 255, 255]);
});
