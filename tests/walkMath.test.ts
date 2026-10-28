import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BODY_RADIUS, CLIMB_RATE, EYE_HEIGHT, GRAVITY, MAX_PITCH, MAX_SPEED, MIN_SPEED, RUN_FACTOR, STEP_HEIGHT, WALK_SPEED,
  axesOf, clampSpeed, clearance, currentSpeed, followGround, formatSpeed, headingOf, lookStep, planarMove, probeLength, slide, walkKeyOf, wheelSpeed,
  type Heading, type WalkKey,
} from '../src/engine/walkMath.ts';

const close = (actual: number, expected: number, tolerance = 1e-9, message?: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `${actual} ≠ ${expected} (±${tolerance})`);

test('les touches se lisent par position physique : QWERTY et AZERTY font la même chose', () => {
  // Une même touche physique : W d'un QWERTY, Z d'un AZERTY. Le code décide, pas la lettre produite.
  assert.equal(walkKeyOf({ code: 'KeyW', key: 'w' }), 'forward');
  assert.equal(walkKeyOf({ code: 'KeyW', key: 'z' }), 'forward');
  assert.equal(walkKeyOf({ code: 'KeyA', key: 'a' }), 'left');
  assert.equal(walkKeyOf({ code: 'KeyA', key: 'q' }), 'left');
  assert.equal(walkKeyOf({ code: 'KeyS', key: 's' }), 'back');
  assert.equal(walkKeyOf({ code: 'KeyD', key: 'd' }), 'right');
  // La touche « A » d'un AZERTY (code KeyQ) n'est pas une touche de déplacement : elle garde son raccourci « tout afficher ».
  assert.equal(walkKeyOf({ code: 'KeyQ', key: 'a' }), null);
  assert.equal(walkKeyOf({ code: 'KeyZ', key: 'w' }), null);
  for (const [code, key] of [['ArrowUp', 'forward'], ['ArrowDown', 'back'], ['ArrowLeft', 'left'], ['ArrowRight', 'right']] as const) assert.equal(walkKeyOf({ code, key: code }), key);
  for (const code of ['KeyE', 'Space', 'PageUp']) assert.equal(walkKeyOf({ code, key: '' }), 'up', code);
  for (const code of ['KeyC', 'PageDown']) assert.equal(walkKeyOf({ code, key: '' }), 'down', code);
  for (const code of ['ShiftLeft', 'ShiftRight']) assert.equal(walkKeyOf({ code, key: 'Shift' }), 'run', code);
  assert.equal(walkKeyOf({ code: 'KeyV', key: 'v' }), null);
  assert.equal(walkKeyOf({ code: 'Escape', key: 'Escape' }), null);
});

test('sans code physique (clavier virtuel), la lettre produite sert de repli, en ZQSD comme en WASD', () => {
  for (const code of ['', 'Unidentified']) {
    const key = (value: string) => walkKeyOf({ code, key: value });
    assert.equal(key('z'), 'forward');
    assert.equal(key('W'), 'forward');
    assert.equal(key('q'), 'left');
    assert.equal(key('a'), 'left');
    assert.equal(key('s'), 'back');
    assert.equal(key('D'), 'right');
    assert.equal(key(' '), 'up');
    assert.equal(key('Shift'), 'run');
    assert.equal(key('x'), null);
  }
});

test('les touches tenues donnent des axes ; deux touches opposées s’annulent', () => {
  const axes = (...keys: WalkKey[]) => axesOf(new Set(keys));
  assert.deepEqual(axes(), { forward: 0, right: 0, up: 0, run: false });
  assert.deepEqual(axes('forward', 'right', 'run'), { forward: 1, right: 1, up: 0, run: true });
  assert.deepEqual(axes('forward', 'back'), { forward: 0, right: 0, up: 0, run: false });
  assert.deepEqual(axes('left', 'up', 'down', 'up'), { forward: 0, right: -1, up: 0, run: false });
});

test('la vitesse : 1,4 m/s en marchant, trois fois plus en courant, bornée', () => {
  assert.equal(WALK_SPEED, 1.4);
  assert.equal(RUN_FACTOR, 3);
  close(currentSpeed(WALK_SPEED, false), 1.4);
  close(currentSpeed(WALK_SPEED, true), 4.2);
  assert.equal(clampSpeed(0), MIN_SPEED);
  assert.equal(clampSpeed(1e6), MAX_SPEED);
  assert.equal(clampSpeed(Number.NaN), WALK_SPEED);
  assert.equal(clampSpeed(2), 2);
});

test('la molette change la vitesse de façon continue et réversible', () => {
  assert.ok(wheelSpeed(1.4, -100) > 1.4, 'vers l’avant : plus vite');
  assert.ok(wheelSpeed(1.4, 100) < 1.4, 'vers l’arrière : moins vite');
  close(wheelSpeed(wheelSpeed(1.4, -100), 100), 1.4, 1e-9, 'une encoche vers l’avant puis une vers l’arrière se compensent');
  // Un défilement fin (pavé tactile) fait la même chose que quelques encoches : 10 × 10 = 1 × 100.
  let speed = 1.4;
  for (let i = 0; i < 10; i++) speed = wheelSpeed(speed, -10);
  close(speed, wheelSpeed(1.4, -100), 1e-9);
  assert.equal(wheelSpeed(MAX_SPEED, -500), MAX_SPEED);
  assert.equal(wheelSpeed(MIN_SPEED, 500), MIN_SPEED);
  // Un énorme défilement d'un coup ne fait pas exploser la vitesse.
  assert.ok(wheelSpeed(1.4, -1e6) < 1.4 * Math.exp(600 * 0.0022) + 1e-9);
});

test('la vitesse s’affiche en français', () => {
  assert.equal(formatSpeed(1.4), '1,4 m/s');
  assert.equal(formatSpeed(4.2), '4,2 m/s');
  assert.equal(formatSpeed(12.4), '12 m/s');
});

test('le cap se lit dans la direction de vue : −Z est le cap 0, la gauche est positive', () => {
  const north = headingOf(0, 0, -1);
  close(north.yaw, 0);
  close(north.pitch, 0);
  close(headingOf(-1, 0, 0).yaw, Math.PI / 2, 1e-9, 'regarder vers −X, c’est tourner à gauche');
  close(headingOf(1, 0, 0).yaw, -Math.PI / 2);
  close(Math.abs(headingOf(0, 0, 1).yaw), Math.PI, 1e-9, 'vers +Z : demi-tour');
  close(headingOf(0, 1, -1).pitch, Math.PI / 4, 1e-9);
  // Regarder à la verticale (vue de dessus) : le cap reste celui qui était donné.
  assert.equal(headingOf(0, -1, 0, 0.7).yaw, 0.7);
  assert.equal(headingOf(0, 0, 0, 0.3).yaw, 0.3);
});

test('glisser fait tourner la vue comme on attrape la scène, et borne l’inclinaison', () => {
  const start: Heading = { yaw: 0, pitch: 0 };
  assert.ok(lookStep(start, 100, 0).yaw > 0, 'glisser à droite : la vue tourne à gauche');
  assert.ok(lookStep(start, -100, 0).yaw < 0);
  assert.ok(lookStep(start, 0, 100).pitch > 0, 'glisser vers le bas : la vue monte');
  assert.equal(lookStep(start, 0, 1e6).pitch, MAX_PITCH);
  assert.equal(lookStep(start, 0, -1e6).pitch, -MAX_PITCH);
  // Les glissements s'additionnent : deux demi-gestes valent le geste entier.
  const half = lookStep(lookStep(start, 30, 20), 30, 20);
  const whole = lookStep(start, 60, 40);
  close(half.yaw, whole.yaw);
  close(half.pitch, whole.pitch);
});

test('le déplacement suit le cap, et la diagonale ne va pas plus vite', () => {
  const at = (yaw: number, forward: number, right: number, distance = 1) => planarMove(yaw, forward, right, distance);
  let move = at(0, 1, 0);
  close(move.x, 0); close(move.z, -1);
  move = at(0, 0, 1);
  close(move.x, 1); close(move.z, 0);
  move = at(Math.PI / 2, 1, 0);
  close(move.x, -1); close(move.z, 0, 1e-9, 'cap +90° : vers −X');
  move = at(-Math.PI / 2, 1, 0);
  close(move.x, 1); close(move.z, 0, 1e-9);
  move = at(0.4, 1, 1, 2);
  close(Math.hypot(move.x, move.z), 2, 1e-9, 'longueur normée en diagonale');
  move = at(1.1, 0, 0);
  assert.deepEqual(move, { x: 0, z: 0 });
  move = at(0.9, -1, 0, 3);
  const ahead = at(0.9, 1, 0, 3);
  close(move.x, -ahead.x); close(move.z, -ahead.z);
});

/** Simule `seconds` de suivi du sol à `fps` images par seconde. */
function simulate(feet: number, ground: number, seconds: number, fps: number): { feet: number; velocity: number; landedAt: number | null; lowest: number } {
  let state = { feet, velocity: 0 };
  let landedAt: number | null = null;
  let lowest = feet;
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(seconds * fps); i++) {
    state = followGround(state.feet, state.velocity, ground, dt);
    lowest = Math.min(lowest, state.feet);
    if (landedAt === null && Math.abs(state.feet - ground) < 1e-3) landedAt = (i + 1) * dt;
  }
  return { ...state, landedAt, lowest };
}

test('une marche montée est lissée : on la rejoint sans saut', () => {
  const dt = 1 / 60;
  let state = followGround(0, 0, 0.3, dt);
  assert.ok(state.feet > 0 && state.feet < 0.3, 'une image ne suffit pas à monter');
  assert.ok(state.feet < 0.3 * 0.3, 'et ne saute pas');
  assert.equal(state.velocity, 0);
  for (let i = 0; i < 120; i++) state = followGround(state.feet, state.velocity, 0.3, dt);
  close(state.feet, 0.3, 1e-3);
  assert.equal(STEP_HEIGHT, 0.4);
  assert.ok(CLIMB_RATE > 0);
});

test('une descente de moins d’une marche est lissée, sans accélérer', () => {
  const state = followGround(0.3, 0, 0, 1 / 60);
  assert.ok(state.feet < 0.3 && state.feet > 0.15);
  assert.equal(state.velocity, 0);
  close(simulate(0.3, 0, 1, 60).feet, 0, 1e-3);
});

test('plus haut qu’une marche, on tombe : vitesse croissante, jamais sous le sol, arrivée exacte', () => {
  const drop = 3;
  const run = simulate(drop, 0, 2, 60);
  assert.equal(run.feet, 0);
  assert.equal(run.velocity, 0);
  assert.ok(run.lowest >= 0, 'on ne passe jamais sous le sol');
  // Chute libre : t = √(2h/g) ≈ 0,78 s ; l'image qui touche le sol arrive juste après.
  const expected = Math.sqrt((2 * drop) / GRAVITY);
  assert.ok(run.landedAt !== null && Math.abs(run.landedAt - expected) < 0.06, `arrivée à ${run.landedAt} s, attendue vers ${expected.toFixed(2)} s`);
  // La chute est visible : après 0,2 s on est encore haut.
  const early = simulate(drop, 0, 0.2, 60);
  assert.ok(early.feet > drop - 0.5 && early.feet < drop);
  assert.ok(early.velocity > 1);
});

test('la vitesse de chute est bornée, et le pas de temps ne change presque rien au résultat', () => {
  const high = simulate(200, 0, 3, 60);
  assert.ok(high.velocity <= 30 + 1e-9);
  for (const fps of [20, 30, 60, 120, 240]) {
    const half = simulate(8, 0, 0.6, fps);
    const reference = simulate(8, 0, 0.6, 1200);
    close(half.feet, reference.feet, 0.15, `chute à ${fps} img/s : ${half.feet} contre ${reference.feet}`);
    const stairs = simulate(0, 0.3, 0.1, fps);
    close(stairs.feet, simulate(0, 0.3, 0.1, 1200).feet, 1e-9, `marche à ${fps} img/s`);
  }
});

test('sans sol connu, on garde sa hauteur ; sans temps écoulé, rien ne change', () => {
  assert.deepEqual(followGround(1.2, 3, null, 1 / 60), { feet: 1.2, velocity: 0 });
  assert.deepEqual(followGround(1.2, 3, 0, 0), { feet: 1.2, velocity: 3 });
  assert.deepEqual(followGround(1.2, 0, 1.2, 1 / 60), { feet: 1.2, velocity: 0 });
});

test('devant un mur on s’arrête à 0,3 m, moins franchement sous une incidence rasante', () => {
  assert.equal(BODY_RADIUS, 0.3);
  close(clearance(2, -1), 1.7);
  close(clearance(0.2, -1), 0);
  // À 60° du mur (cosinus 0,5), le rayon touche plus loin que la distance perpendiculaire : on s'arrête plus tôt.
  close(clearance(2, -0.5), 2 - 0.3 / 0.5);
  // Très rasant : borné, pour que l'on longe le mur au lieu de buter à un mètre.
  close(clearance(2, -0.01), 2 - 1);
  assert.ok(probeLength(0.02) >= 1.0, 'le rayon voit assez loin pour un mur rasant');
});

test('le glissement garde la part du déplacement qui longe le mur', () => {
  // Mur de normale −X (face tournée vers −X), on avance en +X et un peu en +Z : seule la part Z reste.
  const ux = Math.SQRT1_2, uz = Math.SQRT1_2;
  const rest = slide(ux, uz, -1, 0, 1)!;
  close(rest.x, 0); close(rest.z, Math.SQRT1_2);
  // De front : plus rien ne glisse.
  const head = slide(1, 0, -1, 0, 1)!;
  close(head.x, 0); close(head.z, 0);
  // Une normale verticale (sol, plafond) n'est pas un mur.
  assert.equal(slide(1, 0, 0, 0, 1), null);
  assert.equal(slide(1, 0, 0.1, 0.1, 1), null);
  assert.ok(EYE_HEIGHT === 1.7);
});
