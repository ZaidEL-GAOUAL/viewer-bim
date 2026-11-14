import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASSUMED_MEMORY_GB } from '../src/engine/deviceMemory.ts';
import { isMemoryFailure, triangleBudgetFor } from '../src/revit/readRevit.ts';

test('sans mémoire connue, le budget Revit suppose la mémoire par défaut, la même que pour l’IFC', () => {
  assert.equal(triangleBudgetFor(undefined), triangleBudgetFor(ASSUMED_MEMORY_GB));
  assert.equal(triangleBudgetFor(0), triangleBudgetFor(ASSUMED_MEMORY_GB));
  assert.equal(triangleBudgetFor(Number.NaN), triangleBudgetFor(ASSUMED_MEMORY_GB));
});

test('les échecs de mémoire du navigateur (ouverture d’un GLB, export) sont reconnus', () => {
  const failure = (name: string, message: string) => ({ name, message });
  assert.equal(isMemoryFailure(failure('RangeError', 'Invalid array length')), true);
  assert.equal(isMemoryFailure(failure('RangeError', 'Invalid typed array length: 4000000000')), true);
  assert.equal(isMemoryFailure(failure('Error', 'Out of memory')), true);
  assert.equal(isMemoryFailure(failure('Error', 'Allocation failed - JavaScript heap out of memory')), true);
  assert.equal(isMemoryFailure(failure('SyntaxError', 'Unexpected token')), false);
});
