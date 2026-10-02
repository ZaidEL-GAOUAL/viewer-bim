import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUBE, buildFromNodes, loadTestModel } from './helpers.ts';

const cubeNode = { name: 'Cube', mesh: 0, extras: { id: 'cube' } };

test('sans normales dans le fichier, les faces sont ombrées à plat', async () => {
  const model = await buildFromNodes([cubeNode], [0], CUBE);
  const geometry = model.chunks[0].mesh.geometry;
  // Les 8 sommets partagés sont dédoublés : 3 sommets par triangle.
  assert.equal(geometry.getAttribute('position').count, 36);
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) {
    const components = [normal.getX(i), normal.getY(i), normal.getZ(i)].map((value) => Math.abs(Math.round(value * 127)));
    assert.deepEqual(components.sort(), [0, 0, 127], `normale ${i} non alignée sur un axe`);
  }
  assert.equal(model.state.isOpen(0), false);
});

test('seul le mode BLEND rend un matériau transparent', async () => {
  const withMaterial = (material: object) =>
    buildFromNodes([cubeNode], [0], CUBE, (gltf) => {
      gltf.materials = [material];
      gltf.meshes[0].primitives[0].material = 0;
    });

  const opaque = await withMaterial({ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.3] } });
  assert.equal(opaque.chunks[0].transparent, false);
  assert.equal(opaque.chunks[0].mesh.geometry.getAttribute('color').getW(0), 1);

  const blend = await withMaterial({ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.3] } });
  assert.equal(blend.chunks[0].transparent, true);
  assert.ok(Math.abs(blend.chunks[0].mesh.geometry.getAttribute('color').getW(0) - 0.3) < 0.01);
});

test('un verre décrit par « transmission » devient transparent', async () => {
  const model = await buildFromNodes([cubeNode], [0], CUBE, (gltf) => {
    gltf.extensionsUsed = ['KHR_materials_transmission'];
    gltf.materials = [{ extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }];
    gltf.meshes[0].primitives[0].material = 0;
  });
  assert.equal(model.chunks[0].transparent, true);
  assert.ok(model.chunks[0].mesh.geometry.getAttribute('color').getW(0) < 0.3);
});

test('dans un fichier à plusieurs scènes, la scène par défaut garde ses identifiants', async () => {
  const model = await buildFromNodes(
    [
      { name: 'Autre', mesh: 0, extras: { id: 'autre' } },
      { name: 'Mur', mesh: 0, extras: { id: 'mur-1', Type: 'Mur' } },
      { name: 'Dalle', mesh: 0, translation: [0, 2, 0], extras: { id: 'dalle-1' } },
    ],
    [0],
    CUBE,
    (gltf) => {
      gltf.scenes = [{ nodes: [0] }, { nodes: [1, 2] }];
      gltf.scene = 1;
    },
  );
  assert.deepEqual(model.keys, ['mur-1', 'dalle-1']);
  assert.deepEqual(model.extras[0], { Type: 'Mur' });
});

test('une texture KTX2 est écartée avec un avertissement au lieu de faire échouer le chargement', async () => {
  const { model, warnings } = await loadTestModel([cubeNode], [0], CUBE, (gltf) => {
    gltf.extensionsUsed = ['KHR_texture_basisu'];
    gltf.extensionsRequired = ['KHR_texture_basisu'];
    gltf.images = [{ uri: 'couleur.ktx2' }];
    gltf.textures = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
    gltf.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [0.2, 0.4, 0.6, 1] } }];
    gltf.meshes[0].primitives[0].material = 0;
  });
  assert.equal(model.count, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /KTX2/);
});

test('la fermeture d’un élément ne tient compte que de ses pièces opaques', async () => {
  // Un cadre opaque fermé et un vitrage transparent réduit à un seul triangle (surface ouverte).
  const model = await buildFromNodes(
    [
      { name: 'Fenêtre', extras: { id: 'fenetre' }, children: [1, 2] },
      { name: 'Cadre', mesh: 0 },
      { name: 'Vitrage', mesh: 1 },
    ],
    [0],
    CUBE,
    (gltf) => {
      gltf.materials = [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.7, 0.9, 0.3] } }];
      gltf.accessors.push({ bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' });
      gltf.meshes.push({ primitives: [{ attributes: { POSITION: 0 }, indices: 2, material: 0 }] });
    },
  );
  assert.equal(model.count, 1);
  assert.equal(model.chunks.length, 2);
  assert.equal(model.state.isOpen(0), false);
});
