import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STEPS, isDone, missingFor, nextStep, warningFor, type StepState } from '../src/site/steps.ts';

const state = (patch: Partial<StepState> = {}): StepState => ({ placed: true, limit: true, neighbours: 'loaded', volumes: 1, ...patch });

test('cinq étapes dans l’ordre, chacune avec une phrase d’instruction', () => {
  assert.deepEqual(STEPS.map((step) => step.id), ['lieu', 'terrain', 'voisinage', 'volumes', 'analyses']);
  for (const step of STEPS) assert.match(step.instruction, /^[A-ZÉ].+\.$/);
});

test('ce que chaque étape demande, et la phrase qui dit lequel manque', () => {
  const nowhere = state({ placed: false, limit: false, neighbours: 'none', volumes: 0 });
  assert.equal(missingFor('lieu', nowhere), null);
  assert.deepEqual(missingFor('terrain', nowhere), { message: 'Choisissez d’abord le lieu du projet (étape 1).', goTo: 'lieu' });
  assert.deepEqual(missingFor('voisinage', nowhere)?.goTo, 'lieu');

  const noLimit = state({ limit: false, volumes: 0 });
  assert.equal(missingFor('terrain', noLimit), null);
  assert.equal(missingFor('voisinage', noLimit), null);
  assert.deepEqual(missingFor('volumes', noLimit), { message: 'Tracez d’abord la limite du terrain (étape 2).', goTo: 'terrain' });
  assert.deepEqual(missingFor('analyses', noLimit)?.message, 'Tracez d’abord la limite du terrain (étape 2).');

  const noVolume = state({ volumes: 0 });
  assert.equal(missingFor('volumes', noVolume), null);
  assert.deepEqual(missingFor('analyses', noVolume), { message: 'Dessinez d’abord un volume (étape 4).', goTo: 'volumes' });
  assert.equal(missingFor('analyses', state()), null);
});

test('un voisinage absent n’empêche pas les analyses, mais le dit', () => {
  assert.match(warningFor('analyses', state({ neighbours: 'failed' })) ?? '', /voisinage n’est pas chargé.*étape 3/);
  assert.match(warningFor('analyses', state({ neighbours: 'loading' })) ?? '', /se charge encore/);
  assert.equal(warningFor('analyses', state()), null);
  assert.equal(warningFor('volumes', state({ neighbours: 'none' })), null);
  assert.equal(missingFor('analyses', state({ neighbours: 'failed' })), null);
});

test('l’étape proposée est la première qui n’est pas faite', () => {
  assert.equal(nextStep(state({ placed: false, limit: false, neighbours: 'none', volumes: 0 })), 'lieu');
  assert.equal(nextStep(state({ limit: false, neighbours: 'loading', volumes: 0 })), 'terrain');
  assert.equal(nextStep(state({ neighbours: 'failed', volumes: 0 })), 'voisinage');
  assert.equal(nextStep(state({ volumes: 0 })), 'volumes');
  assert.equal(nextStep(state()), 'analyses');
  assert.equal(isDone('voisinage', state({ neighbours: 'loading' })), false);
  assert.equal(isDone('analyses', state()), false);
});
