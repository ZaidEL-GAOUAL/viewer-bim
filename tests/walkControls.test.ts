import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { PerspectiveCamera, Ray, Vector3 } from 'three';
import { Viewer } from '../src/engine/Viewer.ts';
import { Sections } from '../src/engine/Sections.ts';
import { WalkControls } from '../src/engine/WalkControls.ts';
import type { Model } from '../src/engine/Model.ts';
import { EYE_HEIGHT } from '../src/engine/walkMath.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

// Node n'a ni fenêtre ni clavier : une cible d'événements suffit à recevoir les touches de la visite.
const globals = globalThis as unknown as { window?: EventTarget; document?: unknown };
const saved = { window: globals.window, document: globals.document };
before(() => {
  globals.window = new EventTarget();
  globals.document = { activeElement: null };
});
after(() => {
  globals.window = saved.window;
  globals.document = saved.document;
});
// Une visite oubliée par un test qui échoue garderait ses écouteurs sur la fenêtre et fausserait les suivants.
const opened: Scene[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) {
    s.walk.exit();
  }
});

const cube = (id: string, from: [number, number, number], size: [number, number, number]) => ({ mesh: 0, translation: from, scale: size, extras: { id } });

/**
 * Un plateau de visite, en coordonnées du projet (le modèle est recentré au chargement : voir `at`) :
 * sol (dessus à y = 0), mur plein sud de x = 5, marche de 0,3 m, bloc de 0,6 m, plateforme à 3,2 m
 * au-dessus du sol, et une dalle plus bas (dessus à −4,8) que l'on atteint en retirant le sol.
 */
const NODES = [
  cube('sol', [-10, -0.2, -10], [20, 0.2, 20]),
  cube('mur', [5, 0, -5], [0.2, 3, 10]),
  cube('marche', [-6, 0, 0], [2, 0.3, 4]),
  cube('bloc', [0, 0, 6], [2, 0.6, 2]),
  cube('plateforme', [-10, 3, -10], [4, 0.2, 20]),
  cube('dalle', [-10, -5, -10], [20, 0.2, 20]),
];
const [SOL, MUR, , , PLATEFORME] = [0, 1, 2, 3, 4];

interface Scene {
  model: Model;
  viewer: Viewer;
  walk: WalkControls;
  /** Coordonnées du projet → coordonnées du modèle recentré. */
  at: (x: number, y: number, z: number) => Vector3;
  /** Position des pieds en coordonnées du projet. */
  feet: () => Vector3;
  eye: () => Vector3;
  /** Fait tourner `seconds` à `fps` images par seconde, avec les touches tenues. */
  run: (seconds: number, fps?: number) => void;
  press: (code: string, key?: string) => void;
  release: (code: string, key?: string) => void;
}

/** Une visite sur le plateau, caméra du côté `from` regardant vers `to` (coordonnées du projet), pivot à `to`. */
async function scene(from: [number, number, number], to: [number, number, number]): Promise<Scene> {
  const model = await buildFromNodes(NODES, NODES.map((_, i) => i), CUBE);
  const at = (x: number, y: number, z: number) => new Vector3(x, y, z).sub(model.offset);
  const sections = new Sections();
  sections.setBounds(model.box);
  const camera = new PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.copy(at(...from));
  camera.lookAt(at(...to));
  camera.updateMatrixWorld(true);
  const canvas = Object.assign(new EventTarget(), { classList: { add() {}, remove() {} }, hasPointerCapture: () => false, setPointerCapture() {}, releasePointerCapture() {} });
  const controls = { target: at(...to), enabled: true, updated: 0, update() { this.updated++; } };
  const viewer = Object.assign(Object.create(Viewer.prototype), {
    model, sections, freeRay: new Ray(), perspective: camera, camera, controls, renderer: { domElement: canvas },
    externalCamera: false, invalidate() {}, invalidateMotion() {}, sectionHandles: { blocksPicking: false },
  }) as Viewer;
  const walk = new WalkControls(viewer);
  let now = performance.now();
  let shift = false;
  // Comme un navigateur : l'événement porte l'état de Maj, y compris celui de Maj lui-même.
  const key = (type: 'keydown' | 'keyup', code: string, keyName = '') => {
    if (code.startsWith('Shift')) shift = type === 'keydown';
    globals.window!.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, key: keyName, shiftKey: shift }));
  };
  const result: Scene = {
    model, viewer, walk, at,
    feet: () => new Vector3(walk['x'], walk['feet'], walk['z']).add(model.offset),
    eye: () => viewer.perspective.position.clone().add(model.offset),
    run(seconds, fps = 60) {
      const frames = Math.round(seconds * fps);
      for (let i = 0; i < frames; i++) {
        now += 1000 / fps;
        walk.update(now);
      }
    },
    press: (code, keyName) => key('keydown', code, keyName),
    release: (code, keyName) => key('keyup', code, keyName),
  };
  opened.push(result);
  return result;
}

// Caméra au sud-ouest regardant vers +X (cap −90°) : avancer, c'est aller vers le mur.
const TOWARDS_WALL: [[number, number, number], [number, number, number]] = [[-8, 1, 0], [0, 1, 0]];

test('on entre à 1,70 m au-dessus du sol sous le pivot, à l’horizontale dans le sens de la vue', async () => {
  const s = await scene([10, 8, 10], [0, 1.5, 0]);
  assert.equal(s.walk.active, false);
  assert.equal(s.walk.unavailable, null);
  assert.ok(s.walk.enter());
  assert.equal(s.walk.active, true);
  assert.equal(s.viewer.controls.enabled, false, 'les contrôles d’orbite se taisent');
  const eye = s.eye();
  assert.ok(Math.abs(eye.y - EYE_HEIGHT) < 1e-5, `yeux à ${eye.y} m`);
  assert.ok(Math.abs(eye.x) < 1e-5 && Math.abs(eye.z) < 1e-5, 'sous le pivot');
  const direction = s.viewer.perspective.getWorldDirection(new Vector3());
  assert.ok(Math.abs(direction.y) < 1e-9, 'regard horizontal');
  assert.ok(direction.x < -0.5 && direction.z < -0.5, 'dans le sens où la caméra regardait (vers −X, −Z)');
  const { feet, ground } = s.walk.heights;
  assert.ok(ground !== null && Math.abs(ground - feet) < 1e-9, 'le sol connu est celui sous les pieds');
});

test('la visite refuse sans modèle, en 2D et sur la carte, en le disant', async () => {
  const s = await scene([10, 8, 10], [0, 1.5, 0]);
  (s.viewer as unknown as { camera: unknown }).camera = {};
  assert.match(s.walk.unavailable ?? '', /perspective/);
  assert.equal(s.walk.enter(), false);
  (s.viewer as unknown as { camera: unknown }).camera = s.viewer.perspective;
  (s.viewer as unknown as { externalCamera: boolean }).externalCamera = true;
  assert.match(s.walk.unavailable ?? '', /carte/);
  (s.viewer as unknown as { externalCamera: boolean }).externalCamera = false;
  (s.viewer as unknown as { model: Model | null }).model = null;
  assert.match(s.walk.unavailable ?? '', /maquette/);
  assert.equal(s.walk.active, false);
});

test('on avance à 1,4 m/s, trois fois plus vite avec Maj, quelle que soit la cadence', async () => {
  const distances: number[] = [];
  for (const fps of [30, 60, 144]) {
    const s = await scene(...TOWARDS_WALL);
    s.walk.setCollisions(false);
    s.walk.enter();
    const start = s.feet();
    s.press('KeyW', 'z'); // AZERTY : la touche Z est en position W
    s.run(1, fps);
    s.release('KeyW', 'z');
    const walked = s.feet().sub(start);
    assert.ok(Math.abs(walked.x - 1.4) < 0.01 && Math.abs(walked.z) < 1e-6, `à ${fps} img/s : ${walked.toArray()}`);
    distances.push(walked.length());
    s.walk.exit();
  }
  assert.ok(Math.max(...distances) - Math.min(...distances) < 0.01, 'même distance à 30, 60 et 144 img/s');

  const s = await scene(...TOWARDS_WALL);
  s.walk.setCollisions(false);
  s.walk.enter();
  const start = s.feet();
  s.press('ShiftLeft', 'Shift');
  s.press('ArrowUp', 'ArrowUp');
  s.run(1);
  assert.ok(Math.abs(s.feet().x - start.x - 4.2) < 0.01, 'courir : 4,2 m en une seconde');
  s.release('ArrowUp');
  s.release('ShiftLeft', 'Shift');
  const stopped = s.feet();
  s.run(0.5);
  assert.deepEqual(s.feet().toArray(), stopped.toArray(), 'touches relâchées : on s’arrête');
  s.walk.exit();
});

test('QWERTY et AZERTY avancent pareil, et la touche « A » d’un AZERTY n’avance pas', async () => {
  const s = await scene(...TOWARDS_WALL);
  s.walk.setCollisions(false);
  s.walk.enter();
  const start = s.feet();
  s.press('KeyA', 'q'); // AZERTY : Q est à la place du A d'un QWERTY, c'est un pas à gauche
  s.run(1);
  s.release('KeyA', 'q');
  const left = s.feet().sub(start);
  assert.ok(left.z < -1.3, `un pas à gauche (vers −Z quand on regarde +X) : ${left.toArray()}`);
  const here = s.feet();
  s.press('KeyQ', 'a'); // la touche étiquetée A d'un AZERTY n'est pas une touche de déplacement
  s.run(1);
  s.release('KeyQ', 'a');
  assert.deepEqual(s.feet().toArray(), here.toArray());
  s.walk.exit();
});

test('un mur arrête à 0,3 m et se longe ; sans collisions on le traverse', async () => {
  let s = await scene(...TOWARDS_WALL);
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(6);
  s.release('KeyW', 'w');
  assert.ok(Math.abs(s.feet().x - 4.7) < 0.02, `arrêté à x = ${s.feet().x} (mur en 5, rayon 0,3)`);

  // En diagonale contre le mur : la part qui le longe continue.
  s.press('KeyW', 'w');
  s.press('KeyD', 'd');
  const before = s.feet();
  s.run(2);
  s.release('KeyW', 'w');
  s.release('KeyD', 'd');
  const slid = s.feet().sub(before);
  assert.ok(s.feet().x <= 4.71, `ne traverse pas : x = ${s.feet().x}`);
  assert.ok(slid.z > 1, `glisse le long du mur : ${slid.z} m`);
  s.walk.exit();

  s = await scene(...TOWARDS_WALL);
  s.walk.setCollisions(false);
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(6);
  assert.ok(s.feet().x > 7, 'sans collisions, le mur est traversé');
  s.walk.exit();
});

test('on longe un mur à incidence rasante sans le traverser', async () => {
  const s = await scene([-8, 1, -4], [4.6, 1, -4]);
  s.walk.enter();
  assert.ok(Math.abs(s.feet().x - 4.6) < 1e-5);
  // Cap qui vise +Z avec une dérive de 10° vers le mur (x = 5) : sans protection, on le traverserait en 3 m.
  s.walk['yaw'] = Math.PI + 0.175;
  s.press('KeyW', 'w');
  s.run(4);
  s.release('KeyW', 'w');
  assert.ok(s.feet().x < 5, `x = ${s.feet().x} : le mur (x = 5) n’est pas traversé`);
  assert.ok(s.feet().z > -1, `et l’on avance le long de lui : z = ${s.feet().z}`);
});

test('une marche de 0,3 m se monte ; un bloc de 0,6 m arrête', async () => {
  let s = await scene([-16, 1, 2], [-8, 1, 2]);
  s.walk.enter();
  s.press('KeyW', 'w');
  let highest = 0;
  for (let i = 0; i < 160; i++) {
    s.run(1 / 60);
    highest = Math.max(highest, s.feet().y);
  }
  // Marche entre x = −6 et −4 : on l'a gravie (0,3) puis quittée ; après 2,7 m de marche on est à x ≈ −4,3 : dessus.
  assert.ok(Math.abs(highest - 0.3) < 0.01, `plus haut atteint : ${highest}`);
  assert.ok(s.feet().x > -4.3, 'pas arrêté par la marche');
  s.run(2);
  assert.ok(Math.abs(s.feet().y) < 0.01, `redescendu au sol : y = ${s.feet().y}`);
  s.walk.exit();

  // Le bloc (dessus à 0,6) est au-dessus de la hauteur d'une marche : il arrête, depuis le nord-ouest vers +Z.
  s = await scene([1, 1, -4], [1, 1, 2]);
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(5);
  assert.ok(Math.abs(s.feet().z - 5.7) < 0.02, `arrêté à z = ${s.feet().z} (bloc en 6, rayon 0,3)`);
  assert.ok(Math.abs(s.feet().y) < 1e-3, 'et sans être monté dessus');
  s.walk.exit();

  // Sans collisions on le traverse, sans y monter non plus.
  s = await scene([1, 1, -4], [1, 1, 2]);
  s.walk.setCollisions(false);
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(5);
  assert.ok(s.feet().z > 6.5);
  assert.ok(Math.abs(s.feet().y) < 1e-3);
  s.walk.exit();
});

test('on tombe d’une plateforme sans être téléporté, et on se pose au sol', async () => {
  const s = await scene([-8, 5, -6], [-8, 4, -6]);
  s.walk.setCollisions(false);
  s.walk.enter();
  assert.ok(Math.abs(s.feet().y - 3.2) < 1e-5, `posé sur la plateforme : ${s.feet().y}`);
  // Cap : on regarde vers −Z ; on se tourne vers +X (cap −90°) pour quitter la plateforme qui finit à x = −6.
  s.walk['yaw'] = -Math.PI / 2;
  s.press('KeyW', 'w');
  s.run(1.5);
  s.release('KeyW', 'w');
  const falling: number[] = [];
  for (let i = 0; i < 90; i++) {
    s.run(1 / 60);
    falling.push(s.feet().y);
  }
  assert.ok(falling.every((y, i) => i === 0 || y <= falling[i - 1] + 1e-6), 'la chute ne remonte jamais');
  assert.ok(falling.every((y) => y >= -1e-5), 'on ne passe pas sous le sol');
  assert.ok(Math.abs(s.feet().y) < 1e-5, `posé au sol : ${s.feet().y}`);
  const midair = falling.findIndex((y) => y > 0.2 && y < 3);
  assert.ok(midair >= 0, 'la chute n’est pas instantanée');
  s.walk.exit();
});

test('un sol masqué est ignoré : on retombe sur celui d’en dessous', async () => {
  const s = await scene([0, 1, 0], [0, 1, 0.1]);
  s.walk.enter();
  s.run(0.5);
  assert.ok(Math.abs(s.feet().y) < 1e-6);
  s.model.state.setVisible(SOL, false);
  s.model.state.commit();
  s.run(2);
  assert.ok(Math.abs(s.feet().y + 4.8) < 0.01, `tombé sur la dalle du dessous : y = ${s.feet().y}`);
  s.model.state.setVisible(SOL, true);
  s.run(0.5);
  assert.ok(Math.abs(s.feet().y + 4.8) < 0.01, 'on reste sur la dalle : le sol revenu est au-dessus de la tête');
  s.walk.exit();
});

test('un mur masqué ne gêne plus, un plan de coupe qui le retire non plus', async () => {
  let s = await scene(...TOWARDS_WALL);
  s.model.state.setVisible(MUR, false);
  s.model.state.commit();
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(6);
  assert.ok(s.feet().x > 7, 'mur masqué : traversé');
  s.walk.exit();

  s = await scene(...TOWARDS_WALL);
  // Le plan garde x ≤ 4 (en coordonnées du projet) : le mur de x = 5 est retiré, et le sol au-delà aussi.
  s.viewer.sections.set(0, { enabled: true, position: s.at(4, 0, 0).x });
  assert.equal(s.viewer.sections.isClipped(...s.at(5.1, 1, 0).toArray()), true);
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(6);
  assert.ok(s.feet().x > 7, `mur coupé : traversé (x = ${s.feet().x})`);
  assert.ok(Math.abs(s.feet().y) < 1e-6, 'et sans sol au-delà du plan, on garde son niveau');
  s.walk.exit();
});

test('sans gravité on vole : E monte, C descend, la hauteur est gardée', async () => {
  const s = await scene(...TOWARDS_WALL);
  s.walk.setGravity(false);
  s.walk.setCollisions(false);
  s.walk.enter();
  s.press('KeyE', 'e');
  s.run(1);
  s.release('KeyE', 'e');
  assert.ok(Math.abs(s.feet().y - 1.4) < 0.01, `monté de 1,4 m : ${s.feet().y}`);
  s.run(2);
  assert.ok(Math.abs(s.feet().y - 1.4) < 0.01, 'sans gravité on reste en l’air');
  s.press('Space', ' ');
  s.run(1);
  s.release('Space', ' ');
  s.press('PageDown', 'PageDown');
  s.run(2);
  s.release('PageDown', 'PageDown');
  assert.ok(Math.abs(s.feet().y) < 0.01, `1,4 + 1,4 − 2,8 : ${s.feet().y}`);
  s.press('KeyE', 'e');
  s.run(1);
  s.release('KeyE', 'e');
  assert.ok(Math.abs(s.feet().y - 1.4) < 0.01);

  // La gravité revenue, on retombe au sol.
  s.walk.setGravity(true);
  s.run(2);
  assert.ok(Math.abs(s.feet().y) < 1e-6, `retombé : ${s.feet().y}`);
  s.walk.exit();
});

test('la molette règle la vitesse, qui est annoncée', async () => {
  const s = await scene(...TOWARDS_WALL);
  const seen: number[] = [];
  s.walk.onSpeed.add((speed) => seen.push(speed));
  s.walk.setSpeed(2.8);
  assert.deepEqual(seen, [2.8]);
  s.walk.setCollisions(false);
  s.walk.enter();
  const start = s.feet();
  s.press('KeyW', 'w');
  s.run(1);
  assert.ok(Math.abs(s.feet().x - start.x - 2.8) < 0.01);
  s.walk.exit();
});

test('Échap quitte la visite et rend l’orbite, autour d’un point devant les yeux', async () => {
  const s = await scene(...TOWARDS_WALL);
  const changes: boolean[] = [];
  s.walk.onChange.add(() => changes.push(s.walk.active));
  s.walk.enter();
  s.press('KeyW', 'w');
  s.run(0.5);
  s.press('Escape', 'Escape');
  assert.equal(s.walk.active, false);
  assert.equal(s.viewer.controls.enabled, true);
  assert.deepEqual(changes, [true, false]);
  const eye = s.viewer.perspective.position;
  const target = s.viewer.controls.target;
  const forward = s.viewer.perspective.getWorldDirection(new Vector3());
  const toTarget = target.clone().sub(eye);
  assert.ok(toTarget.length() >= 1.5 && toTarget.length() <= 40, `pivot à ${toTarget.length()} m`);
  assert.ok(toTarget.normalize().dot(forward) > 0.9999, 'le pivot est droit devant les yeux');
  // Le mur est à 5 m : c'est lui que l'on regardait, le pivot s'y pose.
  assert.ok(Math.abs(target.x + s.model.offset.x - 5) < 0.05, `pivot sur le mur : x = ${target.x + s.model.offset.x}`);
  // La visite terminée, les touches ne déplacent plus rien.
  const after = eye.clone();
  s.press('KeyW', 'w');
  s.walk.update(performance.now() + 5000);
  assert.deepEqual(eye.toArray(), after.toArray());
});

test('un double-clic replace le visiteur debout sur le sol touché, devant le mur si c’est un mur', async () => {
  const s = await scene([0, 5, 0], [0, 1, 0]);
  s.walk.enter();
  s.walk.placeAt(s.at(-8, 3.2, 3), new Vector3(0, 1, 0)); // dessus de la plateforme
  assert.ok(Math.abs(s.feet().y - 3.2) < 1e-6 && Math.abs(s.feet().x + 8) < 1e-6);
  s.walk.placeAt(s.at(4.9, 2.5, 0), new Vector3(-1, 0, 0)); // le mur, vu de l'ouest, à 2,5 m de haut : au sol, devant lui
  assert.ok(Math.abs(s.feet().y) < 1e-6, `au sol : ${s.feet().y}`);
  assert.ok(Math.abs(s.feet().x - 4.5) < 1e-6, `devant le mur : x = ${s.feet().x}`);
  // Sous la plateforme (dessous touché, normale vers le bas) : au sol dessous, pas sur la dalle du dessus.
  s.walk.placeAt(s.at(-8, 3, 2), new Vector3(0, -1, 0));
  assert.ok(Math.abs(s.feet().y) < 1e-6, `sous la plateforme : ${s.feet().y}`);
  s.walk.exit();
});

test('le lancer borné par maxDistance ignore ce qui est plus loin', async () => {
  const s = await scene(...TOWARDS_WALL);
  const origin = s.at(0, 1, 0);
  const east = new Vector3(1, 0, 0);
  assert.equal(s.viewer.castRay(origin, east, 4), null, 'le mur est à 5 m');
  const hit = s.viewer.castRay(origin, east, 6);
  assert.ok(hit && Math.abs(hit.distance - 5) < 1e-6 && hit.element === MUR);
  assert.equal(s.viewer.castRay(origin, east)?.element, MUR);
  assert.equal(s.viewer.castRay(s.at(-8, 5, 0), new Vector3(0, -1, 0))?.element, PLATEFORME);
});
