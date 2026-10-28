import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetadata, type PropValue } from '../src/data/metadata.ts';
import { cameraPose, hiddenByView, parseViews, sectionBoxLocal, viewsToJson, type SavedView, type Vec3 } from '../src/data/savedViews.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} (±${tolerance})`);
const closeVec = (actual: readonly number[], expected: readonly number[], tolerance = 1e-9) => expected.forEach((x, i) => close(actual[i], x, tolerance));

const PERSPECTIVE = { position: [10, 2, 5], direction: [0, 0, -1], up: [0, 1, 0], projection: 'perspective', fov: 57.5 };
const BOUNDS = { center: [0, 3, 0] as Vec3, radius: 20 };

// ---------------------------------------------------------------------------------------------- lecture

test('parseViews lit la caméra, la boîte, les masquages et la phase', () => {
  const views = parseViews([
    {
      name: 'Cuisine', camera: PERSPECTIVE,
      sectionBox: { min: [-5, 0, -5], max: [5, 6, 5], rotation: 30 },
      hiddenCategories: { property: 'Catégorie', values: ['Murs', 'Sols'] },
      hiddenElements: ['a', 12, true, 'b'],
      phase: 'Neuf', phaseFilter: 'Tout',
    },
  ]);
  assert.equal(views.length, 1);
  const [view] = views;
  assert.equal(view.name, 'Cuisine');
  assert.deepEqual(view.camera, { position: [10, 2, 5], direction: [0, 0, -1], up: [0, 1, 0], projection: 'perspective', fov: 57.5 });
  assert.deepEqual(view.sectionBox, { min: [-5, 0, -5], max: [5, 6, 5], rotation: 30 });
  assert.deepEqual(view.hiddenCategories, { property: 'Catégorie', values: ['Murs', 'Sols'] });
  assert.deepEqual(view.hiddenElements, ['a', '12', 'b'], 'les clés sont des textes ; ce qui n’est ni texte ni nombre est écarté');
  assert.equal(view.phase, 'Neuf');
  assert.equal(view.phaseFilter, 'Tout');
});

test('la caméra accepte une cible à la place d’une direction, et corrige un haut mal donné', () => {
  const [view] = parseViews([{ name: 'V', camera: { position: [0, 0, 10], target: [0, 0, 0], projection: 'orthographic', size: [30, 12] } }]);
  closeVec(view.camera.direction, [0, 0, -1]);
  closeVec(view.camera.up, [0, 1, 0], 1e-12);
  assert.equal(view.camera.projection, 'orthographic');
  assert.deepEqual(view.camera.size, [30, 12]);
  // Un haut oblique au regard est projeté perpendiculairement.
  const [oblique] = parseViews([{ name: 'V', camera: { position: [0, 0, 0], direction: [0, 0, -1], up: [0, 1, 1] } }]);
  closeVec(oblique.camera.up, [0, 1, 0]);
  // Un haut parallèle au regard (vue de dessus avec la verticale pour haut) : le nord de la maquette en haut.
  const [top] = parseViews([{ name: 'V', camera: { position: [0, 9, 0], direction: [0, -1, 0], up: [0, -1, 0] } }]);
  closeVec(top.camera.up, [0, 0, -1]);
  // Un haut absent : la verticale. La perspective est la projection par défaut.
  const [plain] = parseViews([{ name: 'V', camera: { position: [0, 0, 0], direction: [1, 0, 0] } }]);
  assert.equal(plain.camera.projection, 'perspective');
  closeVec(plain.camera.up, [0, 1, 0]);
});

test('une taille ou un champ qui n’ont pas de sens sont ignorés, une vue sans caméra aussi', () => {
  const views = parseViews([
    { name: 'A', camera: { position: [0, 0, 0], direction: [0, 0, 1], fov: 200 } },
    { name: 'B', camera: { position: [0, 0, 0], direction: [0, 0, 1], projection: 'orthographic', size: [0, 5], fov: 60 } },
    { name: 'C', camera: { position: [0, 0, 0], direction: [0, 0, 0] } },
    { name: 'D', camera: { position: [0, 0, 'x'], direction: [0, 0, 1] } },
    { name: '', camera: PERSPECTIVE },
    { camera: PERSPECTIVE },
    { name: 'E' },
    'F',
  ]);
  assert.deepEqual(views.map((view) => view.name), ['A', 'B']);
  assert.equal(views[0].camera.fov, undefined);
  assert.equal(views[1].camera.size, undefined);
  assert.equal(views[1].camera.fov, undefined, 'un champ n’a de sens qu’en perspective');
  assert.deepEqual(parseViews(undefined), []);
  assert.deepEqual(parseViews({ name: 'V' }), []);
});

test('une boîte de coupe aux coins inversés est remise en ordre, sans rotation elle vaut 0', () => {
  const [view] = parseViews([{ name: 'V', camera: PERSPECTIVE, sectionBox: { min: [5, 6, 5], max: [-5, 0, -5] } }]);
  assert.deepEqual(view.sectionBox, { min: [-5, 0, -5], max: [5, 6, 5], rotation: 0 });
  assert.equal(parseViews([{ name: 'V', camera: PERSPECTIVE, sectionBox: { min: [0, 0], max: [1, 1, 1] } }])[0].sectionBox, undefined);
});

test('les métadonnées lisent les vues, et un fichier d’avant continue de s’ouvrir', () => {
  const elements = { A: { properties: { Type: 'Mur' } } };
  const metadata = parseMetadata({ version: 1, views: [{ name: 'V', camera: PERSPECTIVE }, { nom: 'invalide' }], elements });
  assert.equal(metadata.views?.length, 1);
  assert.equal(parseMetadata({ version: 1, elements }).views, undefined);
  assert.equal(parseMetadata({ version: 1, views: 'x', elements }).views, undefined);
  assert.equal(parseMetadata({ version: 1, views: [], elements }).views, undefined, 'une liste vide n’apporte aucune vue');
});

test('les vues se réécrivent à l’identique pour l’export des métadonnées', () => {
  const views = parseViews([
    { name: 'A', camera: PERSPECTIVE, sectionBox: { min: [-1, 0, -2], max: [3, 4, 5], rotation: 12 }, hiddenCategories: { property: 'Catégorie', values: ['Murs'] }, hiddenElements: ['k'], phase: 'P', phaseFilter: 'F' },
    { name: 'B', camera: { position: [1, 2, 3], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic', size: [10, 6] } },
  ]);
  assert.deepEqual(parseViews(viewsToJson(views)), views);
});

// ---------------------------------------------------------------------------------------------- la caméra

test('une perspective garde son œil, son regard et son champ, et recentre le repère', () => {
  const [view] = parseViews([{ name: 'V', camera: PERSPECTIVE }]);
  // Le modèle a été recentré de (4, 1, 3) : tout le fichier est décalé d'autant.
  const pose = cameraPose(view.camera, [4, 1, 3], BOUNDS, 1.6);
  assert.deepEqual(pose.position, [6, 1, 2]);
  assert.equal(pose.projection, 'perspective');
  assert.equal(pose.fov, 57.5);
  closeVec(pose.up, [0, 1, 0]);
  // Le pivot est sur l'axe du regard (vers −Z) à la profondeur du centre du modèle (0, 3, 0) : vu de (6, 1, 2), 2 devant.
  closeVec(pose.target, [6, 1, 0]);
  assert.equal(pose.halfHeight, undefined);
});

test('un œil dont le modèle est derrière : le pivot est devant, à la moitié du rayon', () => {
  const [view] = parseViews([{ name: 'V', camera: { position: [0, 3, -50], direction: [0, 0, -1], projection: 'perspective' } }]);
  const pose = cameraPose(view.camera, [0, 0, 0], BOUNDS, 1);
  closeVec(pose.target, [0, 3, -60]);
  assert.equal(pose.fov, undefined, 'sans champ enregistré, celui du viewer reste');
});

test('une vue parallèle avec sa taille garde son axe et sa fenêtre', () => {
  const [view] = parseViews([{ name: 'V', camera: { position: [0, 3, 30], direction: [0, 0, -1], projection: 'orthographic', size: [40, 12] } }]);
  // Plus large que haute dans une fenêtre carrée : la largeur impose la hauteur montrée.
  const square = cameraPose(view.camera, [0, 0, 0], BOUNDS, 1);
  assert.equal(square.projection, 'orthographic');
  assert.equal(square.halfHeight, 20);
  assert.deepEqual(square.position, [0, 3, 30]);
  closeVec(square.target, [0, 3, 0]);
  // Dans une fenêtre assez large, la hauteur enregistrée suffit.
  assert.equal(cameraPose(view.camera, [0, 0, 0], BOUNDS, 4).halfHeight, 6);
});

test('une vue parallèle sans taille cadre la maquette : seule sa direction compte', () => {
  const [view] = parseViews([{ name: 'V', camera: { position: [999, 999, 999], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic' } }]);
  const pose = cameraPose(view.camera, [0, 0, 0], BOUNDS, 2);
  closeVec(pose.target, [0, 3, 0]);
  closeVec(pose.position, [0, 3 + 60, 0]);
  close(pose.halfHeight ?? 0, 20 * 1.05);
  closeVec(pose.up, [0, 0, -1]);
  // Une fenêtre en hauteur ne coupe pas la maquette.
  close(cameraPose(view.camera, [0, 0, 0], BOUNDS, 0.5).halfHeight ?? 0, (20 * 1.05) / 0.5);
});

// ---------------------------------------------------------------------------------------------- masquages et coupe

const PROPS: Record<number, Record<string, PropValue>> = {
  0: { Catégorie: 'Murs' }, 1: { Catégorie: 'Sols' }, 2: { Catégorie: 'Murs' }, 3: { Catégorie: 'Portes' }, 4: {},
};
const valueOf = (index: number, property: string): PropValue | undefined => PROPS[index]?.[property];
const KEYS = new Map([['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4]]);

test('une vue masque des catégories par la propriété qu’elle désigne, et des éléments par leur clé', () => {
  const view: Pick<SavedView, 'hiddenCategories' | 'hiddenElements'> = { hiddenCategories: { property: 'Catégorie', values: ['Murs'] }, hiddenElements: ['d', 'inconnue'] };
  assert.deepEqual([...hiddenByView(view, 5, KEYS, valueOf)], [1, 0, 1, 1, 0]);
  // La propriété est celle que la vue nomme : le viewer n'en connaît aucune.
  const other = hiddenByView({ hiddenCategories: { property: 'Type', values: ['Murs'] } }, 5, KEYS, valueOf);
  assert.deepEqual([...other], [0, 0, 0, 0, 0]);
  assert.deepEqual([...hiddenByView({}, 5, KEYS, valueOf)], [0, 0, 0, 0, 0]);
  assert.deepEqual([...hiddenByView({ hiddenCategories: { property: 'Catégorie', values: [] } }, 5, KEYS, valueOf)], [0, 0, 0, 0, 0]);
});

test('la boîte de coupe suit le décalage du modèle recentré', () => {
  const box = sectionBoxLocal({ min: [10, 0, -4], max: [20, 6, 4], rotation: 15 }, [10, 1, 0]);
  assert.deepEqual(box, { min: [0, -1, -4], max: [10, 5, 4], rotation: 15 });
});
