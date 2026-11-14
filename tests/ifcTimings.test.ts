import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineTimings, describeTimings } from '../src/ifc/timings.ts';

test('combineTimings keeps the slowest start-up and the longest parallel phases', () => {
  const slow = { total: 6000, boot: 2000, wheelFetch: 1500, wheelSource: 'network' as const };
  const combined = combineTimings(
    [
      { startup: {}, parse: 1000, geometry: 3000 },
      { startup: slow, parse: 1200, geometry: 2500 },
    ],
    300,
    80,
  );
  assert.deepEqual(combined, { startup: slow, parse: 1200, geometry: 3000, merge: 300, read: 80 });
});

test('describeTimings says the engine was ready, or lists the start-up steps', () => {
  const warm = describeTimings({ startup: {}, parse: 1000, geometry: 3000, merge: 300, read: 80 });
  assert.match(warm, /^Moteur déjà prêt\./);
  assert.match(warm, /géométrie 3 s/);
  const cold = describeTimings({
    startup: { total: 6200, boot: 2100, packages: 1300, wheelFetch: 30, wheelSource: 'cache', install: 1500, import: 900 },
    parse: 1000, geometry: 3000, merge: 300, read: 80,
  });
  assert.match(cold, /Démarrage du moteur : 6,2 s \(Python 2,1 s, paquets 1,3 s, installation 1,5 s, import 0,9 s\)/);
  assert.doesNotMatch(cold, /en cache/); // under 50 ms: left out
});
