// Télécharge les fichiers Revit d'essai (.rvt, .rfa, .rte) listés dans revit/samples.json vers
// revit/samples/ (dossier ignoré par git), en vérifiant leur empreinte sha256. Un fichier déjà présent et
// conforme n'est pas retéléchargé.
//
//   npm run samples:revit                  tout télécharger
//   npm run samples:revit -- RE1 Dynamo    seulement les échantillons dont le nom contient l'un des mots
//   npm run samples:revit -- --record      renseigne taille et sha256 manquants dans samples.json
//
// Les URL sont épinglées sur un commit : le contenu ne change pas sous nos pieds.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const listFile = join(root, 'revit/samples.json');
const folder = join(root, 'revit/samples');

const args = process.argv.slice(2);
const record = args.includes('--record');
const filters = args.filter((arg) => !arg.startsWith('--'));

const list = JSON.parse(readFileSync(listFile, 'utf8'));
const samples = list.samples.filter((sample) => filters.length === 0 || filters.some((word) => sample.name.includes(word)));
if (samples.length === 0) {
  console.error(`Aucun échantillon ne correspond à : ${filters.join(', ')}`);
  process.exit(1);
}

mkdirSync(folder, { recursive: true });

/** sha256 d'un fichier, lu en flux (certains échantillons dépassent 30 Mo). */
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Télécharge `url` dans un fichier temporaire, puis le renomme : jamais de fichier à moitié écrit. */
async function downloadOnce(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} pour ${url}`);
  const part = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
    renameSync(part, target);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}

/** Trois essais : GitHub coupe parfois une connexion longue (fichiers de plus de 30 Mo). */
async function download(url, target) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadOnce(url, target);
    } catch (error) {
      if (attempt >= 3) throw error;
      process.stdout.write(`(${error.message}, nouvel essai) `);
    }
  }
}

const megabytes = (bytes) => (bytes / 1e6).toFixed(1);
let failed = 0;
let changed = false;

for (const sample of samples) {
  // L'extension est celle du fichier d'origine : .rvt (projet), .rfa (famille) ou .rte (modèle de projet).
  const target = join(folder, `${sample.name}${extname(sample.path).toLowerCase()}`);
  try {
    if (existsSync(target)) {
      const actual = await hashFile(target);
      if (!sample.sha256 && record) {
        sample.sha256 = actual;
        sample.bytes = statSync(target).size;
        changed = true;
        console.log(`= ${sample.name}: empreinte enregistrée (${megabytes(sample.bytes)} Mo)`);
        continue;
      }
      if (actual === sample.sha256) {
        console.log(`= ${sample.name}: déjà présent`);
        continue;
      }
      console.log(`! ${sample.name}: empreinte différente, nouveau téléchargement`);
      rmSync(target);
    }

    process.stdout.write(`↓ ${sample.name} (${sample.repo}) … `);
    await download(sample.url, target);
    const actual = await hashFile(target);
    const size = statSync(target).size;
    if (sample.sha256 && actual !== sample.sha256) {
      rmSync(target);
      throw new Error(`empreinte inattendue (${actual}, attendue ${sample.sha256})`);
    }
    if (!sample.sha256) {
      if (!record) {
        rmSync(target);
        throw new Error('empreinte absente de samples.json : relancer avec --record');
      }
      sample.sha256 = actual;
      sample.bytes = size;
      changed = true;
    }
    console.log(`${megabytes(size)} Mo, sha256 ${actual.slice(0, 12)}`);
  } catch (error) {
    failed += 1;
    console.log(`\n✗ ${sample.name}: ${error.message}`);
  }
}

if (changed) writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
if (failed > 0) {
  console.error(`${failed} échantillon(s) en échec.`);
  process.exit(1);
}
