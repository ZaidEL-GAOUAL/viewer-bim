import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STUDY_VERSION, newStudy, parseStudy, studyToJson, useOf, type Study } from '../src/site/study.ts';

function sample(): Study {
  const study = newStudy();
  study.name = 'Îlot des Tanneurs';
  study.site.origin = { latitude: -33.8688, longitude: 151.2093, altitude: 12.5 };
  study.site.utcOffset = 10;
  study.site.limit = [[0, 0], [40, 0], [40, 25], [0, 25]];
  study.context = {
    buildings: [{ id: 'osm-12', footprint: [[50, 0], [60, 0], [60, 10]], height: 12, heightSource: 'tagged' }],
    terrain: { west: -300, south: -300, step: 30, columns: 2, rows: 2, heights: [10, 11, 12, 13] },
    credits: ['© les contributeurs d’OpenStreetMap'],
    radius: 300,
    fetchedAt: '2026-11-14T10:00:00.000Z',
  };
  study.proposals[0].volumes.push({ id: 'v1', name: 'Bâtiment A', footprint: [[5, 5], [25, 5], [25, 15], [5, 15]], baseLevel: 0, floors: 5, floorHeight: 3, use: 'logement', floorUses: ['commerce'] });
  return study;
}

test('une étude fait l’aller-retour par JSON sans perte', () => {
  const study = sample();
  const text = studyToJson(study);
  assert.deepEqual(parseStudy(JSON.parse(text)), study);
  assert.equal(JSON.parse(text).version, STUDY_VERSION);
  assert.equal(JSON.parse(text).format, 'etude-de-site');
});

test('les champs inconnus sont gardés, à la racine comme dans un volume ou un voisin', () => {
  const raw = JSON.parse(studyToJson(sample()));
  raw.plusTard = { note: 'gardé' };
  raw.proposals[0].volumes[0].structure = 'bois';
  raw.context.buildings[0].source = 'relevé';
  const back = JSON.parse(studyToJson(parseStudy(raw)));
  assert.deepEqual(back.plusTard, { note: 'gardé' });
  assert.equal(back.proposals[0].volumes[0].structure, 'bois');
  assert.equal(back.context.buildings[0].source, 'relevé');
});

test('la version est vérifiée, et un fichier qui n’est pas une étude est refusé', () => {
  const raw = JSON.parse(studyToJson(sample()));
  assert.throws(() => parseStudy({ ...raw, version: STUDY_VERSION + 1 }), /version/i);
  assert.throws(() => parseStudy({ version: 1, elements: {} }), /étude/);
  assert.throws(() => parseStudy({ ...raw, site: { origin: { latitude: 120, longitude: 0 } } }), /latitude/i);
});

test('lecture tolérante : un volume illisible est écarté, les valeurs manquantes prennent leur défaut', () => {
  const raw = JSON.parse(studyToJson(sample()));
  raw.proposals[0].volumes.push({ id: 'v2', footprint: [[0, 0], [1, 1]] });
  raw.proposals[0].volumes.push({ id: 'v3', footprint: [[0, 0], [4, 0], [4, 4]], floors: 'beaucoup' });
  delete raw.settings;
  const study = parseStudy(raw);
  assert.deepEqual(study.proposals[0].volumes.map((volume) => volume.id), ['v1', 'v3']);
  const v3 = study.proposals[0].volumes[1];
  assert.equal(v3.floors, 1);
  assert.equal(v3.floorHeight, 3);
  assert.equal(v3.use, study.settings.uses[0].id);
  assert.equal(study.settings.dwellingSize, newStudy().settings.dwellingSize);
  assert.equal(useOf(study.proposals[0].volumes[0], 0), 'commerce');
  assert.equal(useOf(study.proposals[0].volumes[0], 1), 'logement');
});

test('une étude neuve a une proposition, la liste d’usages par défaut et aucun contexte', () => {
  const study = newStudy();
  assert.equal(study.proposals.length, 1);
  assert.deepEqual(study.settings.uses.map((use) => use.id), ['logement', 'bureaux', 'commerce', 'stationnement', 'autre']);
  assert.deepEqual(study.context.buildings, []);
  assert.equal(study.context.terrain, null);
});
