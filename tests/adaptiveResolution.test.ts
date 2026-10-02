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
