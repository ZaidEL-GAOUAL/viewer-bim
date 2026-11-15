import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isModelFile } from '../src/engine/fileKinds.ts';
import { ModelFileError, loadModelFiles } from '../src/engine/loadModel.ts';

const input = (name: string, content: string, path = name) => ({ file: new File([content], name), path });

test('isModelFile reconnaît les extensions glTF', () => {
  assert.equal(isModelFile('maquette.GLB'), true);
  assert.equal(isModelFile('scene.gltf'), true);
  assert.equal(isModelFile('scene.bin'), false);
  assert.equal(isModelFile('meta.json'), false);
});

test('un .gltf sans son .bin produit un message qui nomme le fichier manquant', async () => {
  const gltf = input('scene.gltf', JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin', byteLength: 4 }] }), 'dossier/scene.gltf');
  await assert.rejects(loadModelFiles(gltf, []), (error: unknown) => {
    assert.ok(error instanceof ModelFileError);
    assert.match(error.message, /« scene\.gltf » a besoin de « scene\.bin »/);
    assert.match(error.message, /dossier complet/);
    return true;
  });
  // Un fichier voisin qui porte un autre nom ne fait pas l'affaire.
  await assert.rejects(loadModelFiles(gltf, [input('autre.bin', 'abcd', 'dossier/autre.bin')]), ModelFileError);
});

test('un .gltf illisible est signalé comme tel', async () => {
  await assert.rejects(loadModelFiles(input('casse.gltf', '{oops'), []), (error: unknown) => {
    assert.ok(error instanceof ModelFileError);
    assert.match(error.message, /n’est pas un fichier glTF valide/);
    return true;
  });
});

test('several files dropped together: each model with its own JSON, the first to open first, a twin set aside with a line', async () => {
  const { planDrop } = await import('../src/engine/loadModel.ts');
  const input = (path: string) => ({ file: new File([''], path.split('/').pop()!), path });
  const plan = planDrop([
    input('lot/structure.rvt'), input('lot/archi.ifc'), input('lot/archi.json'), input('lot/reseaux.glb'), input('lot/reseaux.bin'),
    input('lot/reseaux.modifications.json'), input('lot/reseaux.usdz'), input('lot/planning.json'),
  ]);
  assert.deepEqual(plan.models.map((model) => model.main.path), ['lot/reseaux.glb', 'lot/archi.ifc', 'lot/structure.rvt'], 'a 3D model first, then the IFC, then Revit');
  assert.deepEqual(plan.models.map((model) => model.inputs.map((item) => item.path)), [
    ['lot/reseaux.glb', 'lot/reseaux.modifications.json', 'lot/planning.json', 'lot/reseaux.bin'],
    ['lot/archi.ifc', 'lot/archi.json', 'lot/reseaux.bin'],
    ['lot/structure.rvt', 'lot/reseaux.bin'],
  ], 'a JSON goes to the model it is named after, the others to the first');
  assert.deepEqual(plan.skipped, ['« reseaux.usdz » non ouvert : même nom que « reseaux.glb », ouvert à sa place.']);
  assert.deepEqual(planDrop([input('a.json')]).models, [], 'a JSON alone opens no model');
});
