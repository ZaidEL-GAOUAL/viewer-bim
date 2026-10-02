import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelFileError, isModelFile, loadModelFiles } from '../src/engine/loadModel.ts';

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
