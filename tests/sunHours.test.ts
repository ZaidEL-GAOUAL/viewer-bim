import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOccluder, facadePoints, groundPoints, sunHoursJob, type SamplePoint } from '../src/site/analysis.ts';
import { volumeMesh } from '../src/site/massing.ts';
import { daySunPath } from '../src/site/sun.ts';
import type { Volume } from '../src/site/study.ts';

function run<T>(job: Generator<number, T, unknown>): T {
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
}

const [LAT, LON] = [48.8566, 2.3522];
// Un mur est-ouest de 100 m de long, 1 m d'épaisseur et 10 m de haut, entre les ordonnées nord 0 et 1 m.
const WALL: Volume = { id: 'mur', name: 'Mur', footprint: [[-50, 0], [50, 0], [50, 1], [-50, 1]], baseLevel: 0, floors: 1, floorHeight: 10, use: 'autre' };
// Repère de la scène : x = est, y = haut, z = −nord.
const ground = (east: number, north: number): SamplePoint => ({ position: [east, 0.05, -north], normal: null });

test('au sol, en hiver à Paris : plein soleil au sud d’un mur, aucun au nord ; un point isolé reçoit la durée du jour', () => {
  const occluder = buildOccluder([volumeMesh(WALL).positions]);
  const path = daySunPath('2026-12-21', LAT, LON, 1);
  const day = path.reduce((sum, sample) => sum + sample.hours, 0);
  // Durée du jour publiée pour Paris le 21 décembre : 8 h 15 (lever 08:41, coucher 16:56).
  assert.ok(Math.abs(day - (8 + 15 / 60)) < 0.25, `${day} h`);
  const [south, north, isolated] = run(sunHoursJob([ground(0, -1), ground(0, 2), ground(400, 400)], occluder, path));
  assert.ok(Math.abs(south - day) < 1e-6, `sud : ${south} h`);
  assert.equal(north, 0);
  assert.ok(Math.abs(isolated - day) < 1e-6);
  const noon = path.reduce((best, sample) => (sample.direction[2] > best.direction[2] ? sample : best));
  assert.deepEqual([...run(sunHoursJob([ground(0, -1), ground(0, 2)], occluder, [noon]))], [Math.fround(noon.hours), 0]);
  assert.deepEqual([...run(sunHoursJob([ground(0, 2)], null, path))], [Math.fround(day)]);
});

test('en façade : la face sud du mur voit tout le soleil d’hiver, la face nord aucun ; en été, la face nord a le soleil du soir et du matin', () => {
  const occluder = buildOccluder([volumeMesh(WALL).positions]);
  const points = facadePoints([WALL], 2).filter((point) => Math.abs(point.position[0]) < 1.5);
  const southFace = points.find((point) => point.normal![2] > 0.9)!;
  const northFace = points.find((point) => point.normal![2] < -0.9)!;
  const winter = daySunPath('2026-12-21', LAT, LON, 1);
  const [s, n] = run(sunHoursJob([southFace, northFace], occluder, winter));
  assert.ok(Math.abs(s - winter.reduce((sum, sample) => sum + sample.hours, 0)) < 1e-6);
  assert.equal(n, 0);
  const [, summerNorth] = run(sunHoursJob([southFace, northFace], occluder, daySunPath('2026-06-21', LAT, LON, 2)));
  assert.ok(summerNorth > 2 && summerNorth < 8, `${summerNorth} h`);
});

test('la grille au sol couvre la limite et évite le dessous des bâtiments', () => {
  const limit: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const points = groundPoints(limit, 1, [[[0, 0], [5, 0], [5, 10], [0, 10]]], () => 2);
  assert.equal(points.length, 50);
  assert.ok(points.every((point) => point.position[0] > 5 && point.position[1] === 2.05 && point.normal === null));
});
