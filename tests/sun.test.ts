import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daySunPath, defaultUtcOffset, localTime, presetDays, solarNoon, sunPosition, sunVector } from '../src/site/sun.ts';

const PLACES = {
  Paris: [48.8566, 2.3522],
  Singapour: [1.3521, 103.8198],
  Sydney: [-33.8688, 151.2093],
  Tromsø: [69.6492, 18.9553],
} as const;

// Déclinaison du Soleil d'après les instants publiés (IMCCE / USNO) de 2026 : ±23,44° aux solstices (21 juin 08:24 UTC,
// 21 décembre 20:50 UTC) ; aux équinoxes (20 mars 14:46 UTC, 23 septembre 00:05 UTC), 0° à l'instant même, et elle varie
// alors de 0,395° par jour (+ en mars, − en septembre).
const EQUINOXES = { '2026-03-20': [Date.UTC(2026, 2, 20, 14, 46), 1], '2026-09-23': [Date.UTC(2026, 8, 23, 0, 5), -1] } as const;
function declination(day: string, at: Date): number {
  if (day === '2026-06-21') return 23.44;
  if (day === '2026-12-21') return -23.44;
  const [instant, sign] = EQUINOXES[day as keyof typeof EQUINOXES];
  return (sign * 0.395 * (at.getTime() - instant)) / 86_400_000;
}

const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test('midi solaire aux solstices et aux équinoxes : hauteur 90° − |φ − δ| et azimut plein sud ou plein nord, à 0,5° près', () => {
  for (const [name, [latitude, longitude]] of Object.entries(PLACES)) {
    for (const day of ['2026-03-20', '2026-06-21', '2026-09-23', '2026-12-21']) {
      const noon = solarNoon(day, longitude);
      const position = sunPosition(noon, latitude, longitude);
      const delta = declination(day, noon);
      const expected = 90 - Math.abs(latitude - delta);
      assert.ok(Math.abs(position.elevation - expected) < 0.5, `${name} ${day} : hauteur ${position.elevation.toFixed(2)}°, attendu ${expected.toFixed(2)}°`);
      // Près du zénith (Singapour aux équinoxes), l'azimut n'a plus de sens.
      if (expected < 85) assert.ok(angle(position.azimuth, latitude > delta ? 180 : 0) < 0.5, `${name} ${day} : azimut ${position.azimuth.toFixed(2)}°`);
    }
  }
});

test('Tromsø : soleil de minuit le 21 juin, nuit polaire le 21 décembre', () => {
  const [latitude, longitude] = PLACES.Tromsø;
  const midnight = new Date(solarNoon('2026-06-21', longitude).getTime() + 12 * 3_600_000);
  assert.ok(sunPosition(midnight, latitude, longitude).elevation > 2.5);
  assert.ok(sunPosition(solarNoon('2026-12-21', longitude), latitude, longitude).elevation < -2.5);
  const offset = defaultUtcOffset(longitude);
  assert.equal(daySunPath('2026-12-21', latitude, longitude, offset).length, 0);
  const summer = daySunPath('2026-06-21', latitude, longitude, offset);
  assert.ok(Math.abs(summer.reduce((sum, sample) => sum + sample.hours, 0) - 24) < 1e-9);
});

test('la nuit, le Soleil est sous l’horizon ; lever et coucher publiés à Paris le 21 juin (05:46 et 21:58, heure d’été)', () => {
  const [latitude, longitude] = PLACES.Paris;
  assert.ok(sunPosition(new Date(Date.UTC(2026, 5, 21, 0, 0)), latitude, longitude).elevation < -10);
  const at = (hours: number, minutes: number) => sunPosition(localTime('2026-06-21', hours * 60 + minutes, 2), latitude, longitude).elevation;
  assert.ok(at(5, 30) < 0 && at(6, 0) > 0);
  assert.ok(at(21, 45) > 0 && at(22, 15) < 0);
});

test('hémisphère sud : à Sydney le 21 juin, le soleil du matin se lève au nord-est et la journée dure 9 h 53', () => {
  const [latitude, longitude] = PLACES.Sydney;
  const offset = defaultUtcOffset(longitude);
  assert.equal(offset, 10);
  const morning = sunPosition(localTime('2026-06-21', 8 * 60, offset), latitude, longitude);
  assert.ok(morning.elevation > 0 && morning.azimuth > 30 && morning.azimuth < 90, `azimut ${morning.azimuth}`);
  const hours = daySunPath('2026-06-21', latitude, longitude, offset).reduce((sum, sample) => sum + sample.hours, 0);
  assert.ok(Math.abs(hours - (9 + 53 / 60)) < 0.25, `${hours} h`);
});

test('fuseau par défaut d’après la longitude, dates prédéfinies, vecteur vers le Soleil (est, nord, haut)', () => {
  assert.equal(defaultUtcOffset(2.35), 0);
  assert.equal(defaultUtcOffset(-74), -5);
  assert.equal(defaultUtcOffset(179.9), 12);
  assert.equal(defaultUtcOffset(-179.9), -12);
  assert.deepEqual(presetDays(2027).map((preset) => preset.day), ['2027-03-20', '2027-06-21', '2027-09-22', '2027-12-21']);
  const [e, n, u] = sunVector({ elevation: 30, azimuth: 90 });
  assert.ok(Math.abs(e - Math.cos(Math.PI / 6)) < 1e-12 && Math.abs(n) < 1e-12 && Math.abs(u - 0.5) < 1e-12);
  assert.equal(localTime('2026-06-21', 12 * 60, 2).toISOString(), '2026-06-21T10:00:00.000Z');
});
