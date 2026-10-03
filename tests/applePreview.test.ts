import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applePreviewMode } from '../src/ui/ApplePreview.ts';

const mac = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15', maxTouchPoints: 0 };

test('Safari sur Mac ne propose pas Quick Look mobile, même quand rel="ar" est reconnu', () => {
  assert.equal(applePreviewMode(mac, true, false), 'unavailable');
  assert.equal(applePreviewMode(mac, false, false), 'unavailable');
});

test('un Mac doté du moteur model utilise l’aperçu natif intégré', () => {
  assert.equal(applePreviewMode(mac, true, true), 'model');
  assert.equal(applePreviewMode(mac, false, true), 'model');
});

test('iPhone et iPad conservent Quick Look, même avec le nouvel élément model', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', maxTouchPoints: 5 };
  const ipad = { userAgent: 'Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X)', maxTouchPoints: 5 };
  for (const device of [iphone, ipad]) {
    assert.equal(applePreviewMode(device, true, false), 'quick-look');
    assert.equal(applePreviewMode(device, true, true), 'quick-look');
  }
});

test('iPadOS en mode bureau est identifié malgré son user agent Macintosh', () => {
  assert.equal(applePreviewMode({ ...mac, maxTouchPoints: 5 }, true, false), 'quick-look');
});

test('un navigateur mobile sans Quick Look utilise model ou explique la compatibilité', () => {
  const iphone = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)', maxTouchPoints: 5 };
  assert.equal(applePreviewMode(iphone, false, true), 'model');
  assert.equal(applePreviewMode(iphone, false, false), 'unavailable');
  const android = { userAgent: 'Mozilla/5.0 (Linux; Android 16)', maxTouchPoints: 5 };
  assert.equal(applePreviewMode(android, true, false), 'unavailable');
});
