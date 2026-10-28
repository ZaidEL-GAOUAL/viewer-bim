import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMetadata, type PropValue } from '../src/data/metadata.ts';
import { cameraPose, hiddenByView, hiddenInEveryView, parseViews, planCameraPose, planSectionBox, sectionBoxLocal, viewsToJson, type SavedView, type Vec3 } from '../src/data/savedViews.ts';

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

// ---------------------------------------------------------------------------------------------- plans d'étage

const PLAN_CAMERA = { position: [12, 30, -8], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic', size: [24, 16] };

test('une vue sans « kind » est une vue 3D, sans type ni étendue', () => {
  const [view] = parseViews([{ name: 'V', camera: PERSPECTIVE }]);
  assert.equal(view.kind, '3d');
  assert.equal(view.type, undefined);
  assert.equal(view.range, undefined);
  // « 3d » écrit, ou un genre inconnu : c'est une vue 3D aussi.
  assert.equal(parseViews([{ name: 'V', kind: '3d', camera: PERSPECTIVE }])[0].kind, '3d');
  assert.equal(parseViews([{ name: 'V', kind: 'coupe', camera: PERSPECTIVE, range: { top: 3 } }])[0].kind, '3d');
});

test('un plan d’étage garde son type et son étendue, avec ou sans profondeur de vue', () => {
  const [limited, unlimited] = parseViews([
    { name: 'GF', kind: 'plan', type: 'Floor Plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 } },
    { name: '1F', kind: 'plan', type: 'Structural Plan', camera: PLAN_CAMERA, range: { top: 4.4 } },
  ]);
  assert.equal(limited.kind, 'plan');
  assert.equal(limited.type, 'Floor Plan');
  assert.deepEqual(limited.range, { bottom: 0.3, top: 1.5 });
  assert.equal(unlimited.kind, 'plan');
  assert.deepEqual(unlimited.range, { top: 4.4 });
  assert.equal('bottom' in (unlimited.range ?? {}), false, 'une profondeur illimitée est une profondeur absente');
  // Une profondeur nulle (JSON `null`) vaut aussi illimitée.
  assert.deepEqual(parseViews([{ name: 'P', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: null, top: 2 } }])[0].range, { top: 2 });
  // Une profondeur négative est une profondeur : sous le zéro du modèle.
  assert.deepEqual(parseViews([{ name: 'P', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: -1.2, top: -0.5 } }])[0].range, { bottom: -1.2, top: -0.5 });
});

test('une étendue illisible est écartée, et le plan devient une vue ordinaire', () => {
  const invalid: unknown[] = [
    undefined, null, 'x', [], {}, { bottom: 0 },
    { top: '1,5' }, { top: null }, { top: Number.NaN }, { top: Number.POSITIVE_INFINITY },
    { bottom: '0', top: 1 }, { bottom: Number.NEGATIVE_INFINITY, top: 1 },
    { bottom: 2, top: 1 }, { bottom: 1, top: 1 },
  ];
  for (const range of invalid) {
    const [view] = parseViews([{ name: 'P', kind: 'plan', type: 'Floor Plan', camera: PLAN_CAMERA, range, hiddenElements: ['k'], phase: 'Neuf' }]);
    assert.equal(view.kind, '3d', `étendue ${JSON.stringify(range)} : le plan devient une vue`);
    assert.equal(view.range, undefined);
    // La vue reste lisible : caméra, masquages et phase ne sont pas perdus.
    assert.equal(view.name, 'P');
    assert.deepEqual(view.hiddenElements, ['k']);
    assert.equal(view.phase, 'Neuf');
    assert.equal(view.camera.projection, 'orthographic');
  }
});

test('une étendue sur une vue 3D est sans effet', () => {
  const [view] = parseViews([{ name: 'V', camera: PERSPECTIVE, range: { bottom: 0, top: 3 } }]);
  assert.equal(view.kind, '3d');
  assert.equal(view.range, undefined);
});

test('un type qui n’est pas un texte, ou vide, est ignoré', () => {
  assert.equal(parseViews([{ name: 'P', kind: 'plan', type: 7, camera: PLAN_CAMERA, range: { top: 1 } }])[0].type, undefined);
  assert.equal(parseViews([{ name: 'P', kind: 'plan', type: '', camera: PLAN_CAMERA, range: { top: 1 } }])[0].type, undefined);
});

test('les plans se réécrivent à l’identique, et une vue 3D n’écrit ni « kind » ni étendue', () => {
  const views = parseViews([
    { name: '{3D}', camera: PERSPECTIVE },
    { name: 'GF', kind: 'plan', type: 'Floor Plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 }, sectionBox: { min: [-4, 0, -3], max: [20, 1.5, 9], rotation: 25 }, hiddenElements: ['k'], phase: 'P' },
    { name: '1F', kind: 'plan', camera: PLAN_CAMERA, range: { top: 4.4 } },
  ]);
  const json = viewsToJson(views);
  assert.deepEqual(parseViews(json), views);
  assert.equal('kind' in json[0], false);
  assert.equal('range' in json[0], false);
  assert.equal(json[1].kind, 'plan');
  assert.equal(json[1].type, 'Floor Plan');
  assert.deepEqual(json[1].range, { bottom: 0.3, top: 1.5 });
  assert.deepEqual(json[2].range, { top: 4.4 }, 'une profondeur illimitée n’est pas écrite');
  assert.equal('type' in json[2], false);
  // Le tout passe par le JSON : ce qu'on a écrit se relit.
  assert.deepEqual(parseViews(JSON.parse(JSON.stringify(json))), views);
});

test('les métadonnées lisent les plans d’étage', () => {
  const metadata = parseMetadata({ version: 1, views: [{ name: 'V', camera: PERSPECTIVE }, { name: 'GF', kind: 'plan', camera: PLAN_CAMERA, range: { top: 1.5 } }], elements: { A: { properties: { Type: 'Mur' } } } });
  assert.deepEqual(metadata.views?.map((view) => view.kind), ['3d', 'plan']);
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

test('l’œil d’un plan est remonté au-dessus de la maquette, sans changer l’axe ni la fenêtre', () => {
  const [view] = parseViews([{ name: 'GF', kind: 'plan', camera: { position: [0, 1.5, 0], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic', size: [40, 12] }, range: { top: 1.5 } }]);
  // Le fichier place l'œil à la hauteur de coupe (1,5) : dans la sphère du modèle (centre y = 3, rayon 20).
  const plain = cameraPose(view.camera, [0, 0, 0], BOUNDS, 4);
  assert.deepEqual(plain.position, [0, 1.5, 0]);
  const pose = planCameraPose(view.camera, [0, 0, 0], BOUNDS, 4);
  // Toute la sphère est devant l'œil : sa hauteur est au moins celle du sommet de la sphère (3 + 20) et un peu plus (5 %).
  close(pose.position[1], 3 + 20 * 1.05);
  closeVec([pose.position[0], pose.position[2]], [0, 0]);
  // Même cible, même haut, même fenêtre : seul l'œil a reculé le long de son axe.
  assert.deepEqual(pose.target, plain.target);
  assert.deepEqual(pose.up, plain.up);
  assert.equal(pose.halfHeight, plain.halfHeight);
  assert.equal(pose.projection, 'orthographic');
});

test('l’œil d’un plan qui est déjà assez haut, ou sans taille (cadré par cameraPose), ne bouge pas', () => {
  const high = { position: [0, 90, 0], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic', size: [40, 12] };
  const [tall] = parseViews([{ name: 'A', kind: 'plan', camera: high, range: { top: 1.5 } }]);
  assert.deepEqual(planCameraPose(tall.camera, [0, 0, 0], BOUNDS, 4), cameraPose(tall.camera, [0, 0, 0], BOUNDS, 4));
  const [framed] = parseViews([{ name: 'B', kind: 'plan', camera: { position: [0, 1.5, 0], direction: [0, -1, 0], up: [0, 0, -1], projection: 'orthographic' }, range: { top: 1.5 } }]);
  assert.deepEqual(planCameraPose(framed.camera, [0, 0, 0], BOUNDS, 2), cameraPose(framed.camera, [0, 0, 0], BOUNDS, 2));
  // Le décalage du modèle recentré s'applique comme pour toute vue.
  const shifted = planCameraPose(tall.camera, [5, 2, -3], BOUNDS, 4);
  assert.deepEqual(shifted.position, [-5, 88, 3]);
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

// ---------------------------------------------------------------------------------------------- ouverture

test('sans vue enregistrée, l’ouverture ne masque rien', () => {
  assert.equal(hiddenInEveryView([], 5, KEYS, valueOf), null);
});

test('une seule vue : l’ouverture masque exactement ce qu’elle masque', () => {
  const hidden = hiddenInEveryView([{ hiddenElements: ['a', 'd'] }], 5, KEYS, valueOf);
  assert.deepEqual([...(hidden ?? [])], [1, 0, 0, 1, 0]);
});

test('plusieurs vues : l’ouverture masque ce que toutes masquent, pas ce que certaines seulement masquent', () => {
  const hidden = hiddenInEveryView([{ hiddenElements: ['a', 'b', 'c'] }, { hiddenElements: ['b', 'c', 'd'] }, { hiddenElements: ['c', 'b', 'e'] }], 5, KEYS, valueOf);
  assert.deepEqual([...(hidden ?? [])], [0, 1, 1, 0, 0]);
});

test('une vue qui ne masque rien suffit à ne rien masquer à l’ouverture', () => {
  assert.equal(hiddenInEveryView([{ hiddenElements: ['a', 'b'] }, {}], 5, KEYS, valueOf), null);
  assert.equal(hiddenInEveryView([{}, { hiddenElements: ['a', 'b'] }], 5, KEYS, valueOf), null);
  // Des vues qui masquent chacune autre chose n'ont rien en commun.
  assert.equal(hiddenInEveryView([{ hiddenElements: ['a'] }, { hiddenElements: ['b'] }], 5, KEYS, valueOf), null);
});

test('des catégories masquées par toutes les vues masquent les éléments qui les portent', () => {
  const murs: Pick<SavedView, 'hiddenCategories' | 'hiddenElements'> = { hiddenCategories: { property: 'Catégorie', values: ['Murs'] } };
  const mursEtSols: Pick<SavedView, 'hiddenCategories' | 'hiddenElements'> = { hiddenCategories: { property: 'Catégorie', values: ['Murs', 'Sols'] }, hiddenElements: ['d'] };
  const hidden = hiddenInEveryView([murs, mursEtSols], 5, KEYS, valueOf);
  assert.deepEqual([...(hidden ?? [])], [1, 0, 1, 0, 0]);
  // Une catégorie masquée par une vue et un élément de cette catégorie masqué par l'autre : l'élément est masqué dans les deux.
  assert.deepEqual([...(hiddenInEveryView([murs, { hiddenElements: ['c', 'e'] }], 5, KEYS, valueOf) ?? [])], [0, 0, 1, 0, 0]);
});

test('des clés absentes du modèle sont sans effet à l’ouverture', () => {
  assert.equal(hiddenInEveryView([{ hiddenElements: ['inconnue'] }, { hiddenElements: ['inconnue'] }], 5, KEYS, valueOf), null);
  const hidden = hiddenInEveryView([{ hiddenElements: ['inconnue', 'b'] }, { hiddenElements: ['b', 'autre'] }], 5, KEYS, valueOf);
  assert.deepEqual([...(hidden ?? [])], [0, 1, 0, 0, 0]);
});

test('la boîte de coupe suit le décalage du modèle recentré', () => {
  const box = sectionBoxLocal({ min: [10, 0, -4], max: [20, 6, 4], rotation: 15 }, [10, 1, 0]);
  assert.deepEqual(box, { min: [0, -1, -4], max: [10, 5, 4], rotation: 15 });
});

test('l’ouverture ignore les plans d’étage : seules les vues 3D comptent', () => {
  const troisD: Pick<SavedView, 'hiddenElements' | 'kind'> = { kind: '3d', hiddenElements: ['a', 'b'] };
  const autre: Pick<SavedView, 'hiddenElements' | 'kind'> = { kind: '3d', hiddenElements: ['b', 'c'] };
  // Un plan qui montre « b » (un DWG que les vues 3D masquent) ne rend pas « b » visible à l'ouverture.
  const plan: Pick<SavedView, 'hiddenElements' | 'kind'> = { kind: 'plan', hiddenElements: ['d'] };
  const nu: Pick<SavedView, 'kind'> = { kind: 'plan' };
  assert.deepEqual([...(hiddenInEveryView([troisD, autre, plan, nu], 5, KEYS, valueOf) ?? [])], [0, 1, 0, 0, 0]);
  assert.deepEqual([...(hiddenInEveryView([plan, troisD, nu, autre], 5, KEYS, valueOf) ?? [])], [0, 1, 0, 0, 0]);
  // Ce que les plans masquent seuls ne masque rien : ils ne sont pas dans l'intersection.
  assert.equal(hiddenInEveryView([{ kind: '3d' }, plan], 5, KEYS, valueOf), null);
  // Que des plans : aucune vue 3D, donc rien à masquer à l'ouverture.
  assert.equal(hiddenInEveryView([plan, { kind: 'plan', hiddenElements: ['a'] }], 5, KEYS, valueOf), null);
  assert.equal(hiddenInEveryView([plan], 5, KEYS, valueOf), null);
  // Une vue 3D lue par `parseViews` a bien `kind: '3d'`, un plan `kind: 'plan'` : c'est ce que `hiddenInEveryView` lit.
  const lues = parseViews([
    { name: 'A', camera: PERSPECTIVE, hiddenElements: ['a'] },
    { name: 'P', kind: 'plan', camera: PLAN_CAMERA, range: { top: 1 }, hiddenElements: ['c'] },
  ]);
  assert.deepEqual([...(hiddenInEveryView(lues, 5, KEYS, valueOf) ?? [])], [1, 0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------------------------- boîte de coupe d'un plan

const MODEL_BOX = { min: [-10, 0, -6] as Vec3, max: [30, 12, 14] as Vec3 };

test('un plan sans recadrage prend la boîte du modèle agrandie de 1 m, de sa profondeur de vue (moins 2 cm) à sa coupe', () => {
  const [view] = parseViews([{ name: 'GF', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 } }]);
  const box = planSectionBox(view, [0, 0, 0], MODEL_BOX);
  assert.ok(box);
  closeVec(box.min, [-11, 0.28, -7]);
  closeVec(box.max, [31, 1.5, 15]);
  assert.equal(box.rotation, 0);
});

test('un plan sans profondeur de vue descend à 1 m sous le bas du modèle', () => {
  const [view] = parseViews([{ name: 'RF', kind: 'plan', camera: PLAN_CAMERA, range: { top: 9 } }]);
  const box = planSectionBox(view, [0, 0, 0], { min: [-10, 2, -6], max: [30, 12, 14] });
  assert.ok(box);
  closeVec(box.min, [-11, 1, -7]);
  closeVec(box.max, [31, 9, 15]);
});

test('le recadrage d’un plan donne x, z et la rotation, et sa plage donne y : le y du recadrage est ignoré', () => {
  const [view] = parseViews([{
    name: 'GF', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 },
    sectionBox: { min: [-4, -50, -3], max: [20, 50, 9], rotation: 25 },
  }]);
  const box = planSectionBox(view, [0, 0, 0], MODEL_BOX);
  assert.ok(box);
  closeVec(box.min, [-4, 0.28, -3]);
  closeVec(box.max, [20, 1.5, 9]);
  assert.equal(box.rotation, 25, 'la rotation du recadrage est gardée');
  // Sans profondeur, le recadrage garde ses x et z et descend sous le modèle.
  const [open] = parseViews([{ name: 'RF', kind: 'plan', camera: PLAN_CAMERA, range: { top: 9 }, sectionBox: { min: [-4, 0, -3], max: [20, 1, 9], rotation: -90 } }]);
  const unbounded = planSectionBox(open, [0, 0, 0], MODEL_BOX);
  assert.ok(unbounded);
  closeVec(unbounded.min, [-4, -1, -3]);
  closeVec(unbounded.max, [20, 9, 9]);
  assert.equal(unbounded.rotation, -90);
});

test('la boîte d’un plan est dans le repère recentré : le décalage du modèle est retranché de x, y et z', () => {
  const [view] = parseViews([{
    name: 'GF', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 },
    sectionBox: { min: [104, 0, 52], max: [120, 3, 69], rotation: 25 },
  }]);
  const box = planSectionBox(view, [100, 0.5, 60], MODEL_BOX);
  assert.ok(box);
  closeVec(box.min, [4, -0.22, -8]);
  closeVec(box.max, [20, 1, 9]);
  assert.equal(box.rotation, 25);
  // Sans recadrage, la boîte du modèle est déjà recentrée : seule la plage de hauteur se décale.
  const [uncropped] = parseViews([{ name: 'GF', kind: 'plan', camera: PLAN_CAMERA, range: { bottom: 0.3, top: 1.5 } }]);
  const around = planSectionBox(uncropped, [100, 0.5, 60], MODEL_BOX);
  assert.ok(around);
  closeVec(around.min, [-11, -0.22, -7]);
  closeVec(around.max, [31, 1, 15]);
});

test('la boîte d’un plan reste valide quand le modèle est vide, ou tout entier au-dessus de la coupe', () => {
  const [bounded] = parseViews([{ name: 'A', kind: 'plan', camera: PLAN_CAMERA, range: { top: 1.5 } }]);
  // Modèle vide (boîte « vide » de three.js : min à +∞, max à −∞) : pas de x ni de z à deviner, donc pas de boîte.
  assert.equal(planSectionBox(bounded, [0, 0, 0], { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }), null);
  assert.equal(planSectionBox(bounded, [0, 0, 0], null), null);
  // Avec un recadrage, le modèle n'est pas nécessaire : sans profondeur, la boîte descend très bas.
  const [cropped] = parseViews([{ name: 'B', kind: 'plan', camera: PLAN_CAMERA, range: { top: 1.5 }, sectionBox: { min: [0, 0, 0], max: [5, 1, 5], rotation: 0 } }]);
  const open = planSectionBox(cropped, [0, 0, 0], null);
  assert.ok(open);
  assert.equal(open.max[1], 1.5);
  assert.ok(open.min[1] <= 1.5 - 1e4 + 1e-6);
  // Modèle entièrement au-dessus de la coupe : le bas ne dépasse jamais le haut.
  const above = planSectionBox(bounded, [0, 0, 0], { min: [0, 20, 0], max: [5, 30, 5] });
  assert.ok(above);
  assert.ok(above.min[1] <= above.max[1]);
  assert.equal(above.max[1], 1.5);
});

test('une vue sans étendue n’a pas de boîte de plan', () => {
  const [view] = parseViews([{ name: 'V', camera: PERSPECTIVE, sectionBox: { min: [0, 0, 0], max: [1, 1, 1] } }]);
  assert.equal(planSectionBox(view, [0, 0, 0], MODEL_BOX), null);
});
