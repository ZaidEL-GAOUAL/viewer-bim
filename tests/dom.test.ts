import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stored } from '../src/ui/dom.ts';

function withStorage(fake: unknown, run: () => void): void {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try { run(); } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

test('stored lit, écrit et efface une clé', () => {
  const data = new Map<string, string>();
  withStorage({ getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }, () => {
    assert.equal(stored.get('a'), null);
    stored.set('a', 'x');
    assert.equal(stored.get('a'), 'x');
    stored.set('a', '');
    assert.equal(stored.get('a'), null, 'une valeur vide efface la clé');
    stored.set('b', 'y');
    stored.set('b', null);
    assert.equal(data.has('b'), false);
  });
});

test('stored ne lève jamais quand le stockage est bloqué ou absent', () => {
  const blocked = () => { throw new DOMException('bloqué', 'SecurityError'); };
  withStorage({ getItem: blocked, setItem: blocked, removeItem: blocked }, () => {
    assert.equal(stored.get('a'), null);
    assert.doesNotThrow(() => stored.set('a', 'x'));
    assert.doesNotThrow(() => stored.set('a', null));
  });
  withStorage(undefined, () => {
    assert.equal(stored.get('a'), null);
    assert.doesNotThrow(() => stored.set('a', 'x'));
  });
});
