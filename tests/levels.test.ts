import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetadata } from '../src/data/metadata.ts';
import { PLAN_CUT_HEIGHT, levelPlans, levelsToJson, parseLevels } from '../src/data/levels.ts';
import { parseViews, planSectionBox } from '../src/data/savedViews.ts';

test('les niveaux se lisent triés par altitude, un niveau illisible est écarté', () => {
  const levels = parseLevels([{ name: 'R+1', elevation: 38 }, { name: 'RDC', elevation: 35 }, { name: '', elevation: 3 }, { name: 'X' }, { name: 'Y', elevation: Number.NaN }, 'Z']);
  assert.deepEqual(levels, [{ name: 'RDC', elevation: 35 }, { name: 'R+1', elevation: 38 }]);
  assert.deepEqual(parseLevels({}), []);
  assert.deepEqual(levelsToJson(levels), [{ name: 'RDC', elevation: 35 }, { name: 'R+1', elevation: 38 }]);
});

test('les métadonnées lisent la section levels ; un fichier d’avant n’en a pas', () => {
  const metadata = parseMetadata({ version: 1, elements: { a: {} }, levels: [{ name: 'RDC', elevation: 0 }] });
  assert.deepEqual(metadata.levels, [{ name: 'RDC', elevation: 0 }]);
  assert.equal(parseMetadata({ version: 1, elements: { a: {} } }).levels, undefined);
  assert.equal(parseMetadata({ version: 1, elements: { a: {} }, levels: 'x' }).levels, undefined);
});

test('un plan est proposé pour chaque niveau que le fichier ne couvre pas : vue de dessus, coupe à 1,20 m, profondeur au niveau', () => {
  const views = parseViews([
    { name: 'RDC', kind: 'plan', camera: { position: [0, 36, 0], direction: [0, -1, 0], projection: 'orthographic' }, range: { bottom: 35, top: 36.2 } },
    { name: 'Toiture', kind: 'plan', camera: { position: [0, 50, 0], direction: [0, -1, 0], projection: 'orthographic' }, range: { bottom: 40.99, top: 42.2 } },
    { name: 'Vue 3D', camera: { position: [0, 0, 0], direction: [1, 0, 0] } },
  ]);
  const plans = levelPlans([{ name: 'RDC', elevation: 35 }, { name: 'R+1', elevation: 38 }, { name: 'R+2', elevation: 41 }, { name: 'r+3', elevation: 44 }], views);
  assert.deepEqual(plans.map((plan) => plan.name), ['Plan du niveau R+1', 'Plan du niveau r+3'], 'RDC par son nom, R+2 par sa profondeur de vue');
  const [plan] = plans;
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.origin, undefined, 'généré : ni du fichier ni de l’utilisateur tant qu’il n’est pas enregistré');
  assert.deepEqual(plan.range, { bottom: 38, top: 38 + PLAN_CUT_HEIGHT });
  assert.equal(plan.camera.projection, 'orthographic');
  assert.deepEqual(plan.camera.direction, [0, -1, 0]);
  assert.deepEqual(plan.camera.up, [0, 0, -1], 'le nord du projet en haut');
  // La boîte du plan rouvert : le modèle agrandi de 1 m, du niveau (moins 2 cm) à la coupe.
  const box = planSectionBox(plan, [0, 30, 0], { min: [-5, 4, -5], max: [5, 15, 5] })!;
  assert.ok(Math.abs(box.min[1] - (38 - 0.02 - 30)) < 1e-9);
  assert.ok(Math.abs(box.max[1] - (39.2 - 30)) < 1e-9);
  assert.deepEqual([box.min[0], box.max[2]], [-6, 6]);
});
