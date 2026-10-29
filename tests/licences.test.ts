import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LICENCE_FILES } from '../scripts/licence-files.mjs';

const path = (relative: string) => fileURLToPath(new URL(`../${relative}`, import.meta.url));

test('chaque fichier de licence publié existe à sa source', () => {
  for (const [published, source] of Object.entries(LICENCE_FILES)) {
    assert.ok(existsSync(path(source)), `${published} : source introuvable (${source})`);
  }
});

test('chaque lien relatif de la page Licences mène à un fichier servi', () => {
  const page = readFileSync(path('public/licences/index.html'), 'utf8');
  const hrefs = [...page.matchAll(/\bhref="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 0, 'la page ne contient aucun lien');

  for (const href of hrefs) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // http(s) et autres adresses absolues
    if (href === '../') continue; // la racine du viewer
    const target = posix.join('licences', decodeURI(href.split(/[?#]/)[0]));
    assert.ok(
      Object.hasOwn(LICENCE_FILES, target) || existsSync(path(`public/${target}`)),
      `lien « ${href} » : ni dans public/ ni dans les fichiers de licence publiés (${target})`,
    );
  }
});

test('le paquet IfcOpenShell n’est plus distribué avec le site', () => {
  const folder = path('public/wheels');
  const files = existsSync(folder) ? readdirSync(folder) : [];
  assert.deepEqual(files.filter((name) => /\.whl$/i.test(name)), []);
});
