import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_XML_DEPTH, MAX_XML_LENGTH, child, parseXml } from '../src/data/xml.ts';

test('comments, CDATA, declarations and DOCTYPE are read; entities decoded', () => {
  const root = parseXml('<?xml version="1.0"?><!DOCTYPE a><!-- note --><a x="1 &amp; 2"><![CDATA[<b>]]>&lt;c&gt;<?pi ok?></a>');
  const a = child(root, 'a')!;
  assert.equal(a.attributes.x, '1 & 2');
  assert.equal(a.text, '<b><c>');
});

test('an unterminated comment, CDATA, declaration or DOCTYPE is refused, and repeated ones stay fast', () => {
  for (const opener of ['<!--', '<![CDATA[', '<?', '<!DOCTYPE']) assert.throws(() => parseXml(`<a>${opener} x</a`), /XML mal formé/, opener);
  for (const opener of ['<?', '<!--', '<![CDATA[']) {
    const started = performance.now();
    assert.throws(() => parseXml(`<a>${opener.repeat(80_000)}</a>`), /XML mal formé/);
    assert.ok(performance.now() - started < 300, opener);
  }
});

test('document size and nesting depth are capped with a clear message', () => {
  assert.throws(() => parseXml(`<a>${' '.repeat(MAX_XML_LENGTH)}</a>`), /XML trop grand/);
  assert.throws(() => parseXml('<a>'.repeat(MAX_XML_DEPTH + 1)), /imbrication/);
  assert.doesNotThrow(() => parseXml(`${'<a>'.repeat(MAX_XML_DEPTH)}${'</a>'.repeat(MAX_XML_DEPTH)}`));
});

test('custom entities are never expanded, even named like an Object member', () => {
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>'), /XML/);
  assert.throws(() => parseXml('<a>&constructor;</a>'), /Entité XML inconnue/);
  assert.throws(() => parseXml('<a>&__proto__;</a>'), /Entité XML inconnue/);
});
