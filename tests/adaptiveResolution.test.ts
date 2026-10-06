import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptiveResolution } from '../src/engine/AdaptiveResolution.ts';

/** Simule `count` images rendues toutes les `interval` ms ; renvoie le dernier facteur et la date. */
function run(adaptive: AdaptiveResolution, start: number, interval: number, count: number): { scale: number; now: number } {
  let now = start;
  let scale = 1;
  for (let i = 0; i < count; i++) {
    now += interval;
    scale = adaptive.frame(now);
  }
  return { scale, now };
}

test('une machine rapide reste en pleine résolution', () => {
  const adaptive = new AdaptiveResolution();
  const { scale } = run(adaptive, 0, 16.7, 600);
  assert.equal(scale, 1);
  assert.equal(adaptive.motionScale, 1);
  assert.ok(Math.abs(adaptive.frameTime - 16.7) < 0.1);
});

test('une image isolée est toujours en pleine résolution', () => {
  const adaptive = new AdaptiveResolution();
  run(adaptive, 0, 60, 100); // mouvement très lent : la résolution baisse
  assert.ok(adaptive.motionScale < 1);
  assert.equal(adaptive.frame(1_000_000), 1); // bien plus tard : un clic, un changement de couleur
});

test('une machine lente voit sa résolution baisser pendant le mouvement, jusqu’à un plancher', () => {
  const adaptive = new AdaptiveResolution();
  const first = run(adaptive, 0, 50, 12);
  assert.ok(first.scale < 1, 'la résolution doit baisser après quelques images lentes');
  run(adaptive, first.now, 50, 200);
  assert.equal(adaptive.motionScale, 0.5);
});

test('le réglage trouvé est repris dès le début du mouvement suivant', () => {
  const adaptive = new AdaptiveResolution();
  const first = run(adaptive, 0, 50, 12);
  const kept = adaptive.motionScale;
  assert.ok(kept < 1);
  // Nouveau mouvement, une seconde plus tard : première image nette, la suivante déjà allégée.
  assert.equal(adaptive.frame(first.now + 1000), 1);
  assert.equal(adaptive.frame(first.now + 1016), kept);
});

test('la résolution remonte quand la machine suit de nouveau, sans osciller', () => {
  const adaptive = new AdaptiveResolution();
  let { now } = run(adaptive, 0, 50, 12);
  const lowered = adaptive.motionScale;
  ({ now } = run(adaptive, now, 16.7, 120));
  assert.ok(adaptive.motionScale > lowered, 'après deux secondes fluides, on retente plus de pixels');

  // La remontée provoque une rechute : la tentative suivante doit attendre plus longtemps.
  ({ now } = run(adaptive, now, 50, 20));
  ({ now } = run(adaptive, now, 16.7, 10)); // le temps que la moyenne oublie les images lentes
  const dropped = adaptive.motionScale;
  ({ now } = run(adaptive, now, 16.7, 100));
  assert.equal(adaptive.motionScale, dropped, 'pas de nouvelle tentative aussi vite');
  run(adaptive, now, 16.7, 100);
  assert.ok(adaptive.motionScale > dropped);
});

/** Images de la lecture du planning : un pas toutes les ~100 ms (gigue du minuteur), parfois un fondu à 60 Hz. */
function playbackFrames(steps: number): number[] {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const frames = new Set<number>();
  for (let step = 0; step < steps; step++) {
    const tick = step * 100 + (random() - 0.5) * 6;
    frames.add(Math.round((tick + 2) * 10) / 10);
    if (random() < 0.3) for (let t = tick + 16.7; t < tick + 240; t += 16.7) frames.add(Math.round(t * 10) / 10);
  }
  return [...frames].sort((a, b) => a - b);
}

test('le rythme du planning, compté comme un mouvement, ferait baisser la résolution d’une machine rapide', () => {
  // Constat à l'origine du correctif : des pas espacés d'un peu moins de 100 ms passent pour des images lentes.
  const adaptive = new AdaptiveResolution();
  for (const now of playbackFrames(300)) adaptive.frame(now);
  assert.ok(adaptive.motionScale < 1);
});

test('les images qui ne viennent pas d’un mouvement (planning, fondus, couleurs) restent en pleine résolution', () => {
  const adaptive = new AdaptiveResolution();
  for (const now of playbackFrames(300)) assert.equal(adaptive.frame(now, false), 1);
  assert.equal(adaptive.motionScale, 1);
  assert.equal(adaptive.frameTime, 0, 'aucune mesure prise hors mouvement');
});

test('pendant la lecture, une rotation de caméra n’est mesurée que sur ses propres images', () => {
  const adaptive = new AdaptiveResolution();
  const playback = new Set(playbackFrames(120));
  const camera = Array.from({ length: 700 }, (_, i) => Math.round(i * 16.7 * 10) / 10);
  for (const now of [...new Set([...playback, ...camera])].sort((a, b) => a - b)) {
    adaptive.frame(now, camera.includes(now));
  }
  assert.equal(adaptive.motionScale, 1);
  assert.ok(Math.abs(adaptive.frameTime - 16.7) < 0.5, `${adaptive.frameTime}`);
});
