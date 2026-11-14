import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOccluder, facadePoints, skyComponentJob, type SamplePoint } from '../src/site/analysis.ts';
import { volumeMesh } from '../src/site/massing.ts';
import type { Volume } from '../src/site/study.ts';

function run<T>(job: Generator<number, T, unknown>): T {
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
}

/** Composante de ciel d'une façade verticale face à un mur parallèle infini d'angle d'obstruction `alpha`, par intégration fine (indépendante du lancer de rayons). */
function reference(alpha: number): number {
  const luminance = (theta: number) => (1 + 2 * Math.sin(theta)) / 3;
  let sum = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    const phi = -Math.PI / 2 + ((i + 0.5) * Math.PI) / N;
    const from = Math.atan(Math.tan(alpha) * Math.cos(phi));
    for (let j = 0; j < N; j++) {
      const theta = from + ((j + 0.5) * (Math.PI / 2 - from)) / N;
      sum += luminance(theta) * Math.cos(theta) ** 2 * Math.cos(phi) * (Math.PI / N) * ((Math.PI / 2 - from) / N);
    }
  }
  return (100 * sum) / ((7 * Math.PI) / 9);
}

// Une fenêtre en façade sud, à 1 m du sol, tournée vers le sud (repère de la scène : x = est, y = haut, z = −nord).
const WINDOW: SamplePoint = { position: [0, 1, 0.05], normal: [0, 0, 1] };

test('une façade verticale sans obstacle reçoit 39,6 % du ciel couvert CIE', () => {
  const [vsc] = run(skyComponentJob([WINDOW], null));
  assert.ok(Math.abs(vsc - 39.6) < 0.1, `${vsc} %`);
  assert.ok(Math.abs(reference(0) - 39.6) < 0.05);
  // Toutes les orientations se valent sous un ciel couvert.
  const [east] = run(skyComponentJob([{ position: [0, 1, 0], normal: [1, 0, 0] }], null));
  assert.ok(Math.abs(east - vsc) < 1e-4);
});

test('un mur parallèle très long en vis-à-vis abaisse la composante comme prévu (25° d’obstruction : 27 %)', () => {
  // Mur de 4 km de long, 30 m au sud de la fenêtre, dont le sommet est vu à 25° au-dessus d'elle.
  const height = 1 + 30 * Math.tan((25 * Math.PI) / 180);
  const wall: Volume = { id: 'vis-a-vis', name: 'Vis-à-vis', footprint: [[-2000, -31], [2000, -31], [2000, -30.05], [-2000, -30.05]], baseLevel: 0, floors: 1, floorHeight: height, use: 'autre' };
  const occluder = buildOccluder([volumeMesh(wall).positions]);
  const [vsc] = run(skyComponentJob([WINDOW], occluder));
  const expected = reference((25 * Math.PI) / 180);
  assert.ok(Math.abs(expected - 27.3) < 0.1, `${expected} %`);
  assert.ok(Math.abs(vsc - expected) < 1, `${vsc} %, attendu ${expected} %`);
  // Une façade qui tourne le dos au mur n'en voit rien.
  const [back] = run(skyComponentJob([{ position: [0, 1, 0.05], normal: [0, 0, -1] }], occluder));
  assert.ok(Math.abs(back - 39.6) < 0.1);
});

test('les points de façade : un par pas le long de chaque côté et par niveau, à mi-hauteur, tournés vers l’extérieur', () => {
  const box: Volume = { id: 'b', name: 'B', footprint: [[0, 0], [10, 0], [10, 4], [0, 4]], baseLevel: 2, floors: 3, floorHeight: 3, use: 'logement' };
  const points = facadePoints([box], 2);
  // (5 + 2 + 5 + 2) points par niveau, 3 niveaux.
  assert.equal(points.length, 14 * 3);
  assert.deepEqual([...new Set(points.map((point) => point.position[1]))].sort((a, b) => a - b), [3.5, 6.5, 9.5]);
  // Le sens de tracé du contour (horaire ou non) ne change rien.
  const reversed = facadePoints([{ ...box, footprint: [...box.footprint].reverse() }], 2);
  const outward = (list: SamplePoint[]) => list.filter((point) => point.normal![2] > 0.9 && point.position[2] > 0).length;
  assert.equal(outward(points), 15);
  assert.equal(outward(reversed), 15);
});
