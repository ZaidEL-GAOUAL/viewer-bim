import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingRequirements } from '../src/ifc/wheelRequires.ts';

const REQUIRED = ['numpy', 'shapely', 'isodate', 'python-dateutil', 'six', 'lark', 'typing-extensions'];

test('missingRequirements: all present gives nothing', () => {
  const loaded = Object.fromEntries(REQUIRED.map((name) => [name, {}]));
  assert.deepEqual(missingRequirements(REQUIRED, loaded), []);
});

test('missingRequirements: isodate and lark are missing from the Pyodide distribution', () => {
  const loaded = { numpy: {}, shapely: {}, 'python-dateutil': {}, six: {}, 'typing-extensions': {}, micropip: {} };
  assert.deepEqual(missingRequirements(REQUIRED, loaded), ['isodate', 'lark']);
});

test('missingRequirements: names are compared after normalisation', () => {
  const loaded = { typing_extensions: {}, 'Python_Dateutil': {}, NumPy: {} };
  assert.deepEqual(missingRequirements(['typing-extensions', 'python-dateutil', 'numpy', 'lark'], loaded), ['lark']);
});
