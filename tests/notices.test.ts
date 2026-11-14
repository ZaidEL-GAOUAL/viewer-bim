import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineNotices } from '../src/ui/notices.ts';

test('aucun message : rien à montrer', () => {
  assert.equal(combineNotices([]), null);
});

test('un seul message reste tel quel', () => {
  assert.deepEqual(combineNotices([{ text: 'Bonjour.', error: false }]), { text: 'Bonjour.', error: false });
});

test('les erreurs passent avant les informations, sans perdre aucun message', () => {
  const notice = combineNotices([
    { text: '2 modèles fournis.', error: false },
    { text: 'Texture manquante.', error: true },
    { text: 'JSON illisible.', error: true },
    { text: '3 éléments masqués.', error: false },
  ]);
  assert.equal(notice?.error, true);
  assert.equal(notice?.text, 'Texture manquante. JSON illisible. 2 modèles fournis. 3 éléments masqués.');
});

test('sans erreur, le message combiné n’en est pas une', () => {
  assert.equal(combineNotices([{ text: 'A.', error: false }, { text: 'B.', error: false }])?.error, false);
});
