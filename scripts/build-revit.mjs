// Compile la caisse Rust revit/ (lecture native des .rvt) en WebAssembly et génère le code de
// liaison JavaScript dans src/revit/pkg/. Ces fichiers sont versionnés : npm run dev, npm test et
// l'intégration continue n'ont besoin d'aucun outil Rust. Ce script ne sert qu'à les régénérer.
//
//   npm run build:revit
//
// Prérequis (une fois) :
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-bindgen-cli --locked --version <version de revit/Cargo.lock>
//
// Dossier de compilation : revit/target (ignoré par git), ou celui de CARGO_TARGET_DIR s'il est défini.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'revit');
const manifest = join(crate, 'Cargo.toml');
const outDir = join(root, 'src/revit/pkg');
const targetDir = process.env.CARGO_TARGET_DIR || join(crate, 'target');

function fail(message) {
  console.error(`build:revit — ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: targetDir }, ...options });
  if (result.error?.code === 'ENOENT') fail(`« ${command} » est introuvable. Voir les prérequis en tête de scripts/build-revit.mjs.`);
  if (result.status !== 0) fail(`« ${command} » a échoué (code ${result.status ?? result.signal}).`);
}

/** Version de wasm-bindgen figée par revit/Cargo.lock : le CLI doit être exactement la même. */
function lockedWasmBindgenVersion() {
  const lock = join(crate, 'Cargo.lock');
  if (!existsSync(lock)) return null;
  return /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(readFileSync(lock, 'utf8'))?.[1] ?? null;
}

/** Version du CLI wasm-bindgen installé, ou null s'il est absent. */
function installedWasmBindgenVersion() {
  const result = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return /wasm-bindgen (\S+)/.exec(result.stdout)?.[1] ?? null;
}

// Le fichier Cargo.lock n'existe qu'après une première compilation ou un « cargo generate-lockfile ».
if (!existsSync(join(crate, 'Cargo.lock'))) run('cargo', ['generate-lockfile', '--manifest-path', manifest]);

const wanted = lockedWasmBindgenVersion();
if (!wanted) fail('wasm-bindgen est absent de revit/Cargo.lock.');
const installed = installedWasmBindgenVersion();
if (!installed) fail(`wasm-bindgen-cli n'est pas installé. Installer : cargo install wasm-bindgen-cli --locked --version ${wanted}`);
if (installed !== wanted) fail(`wasm-bindgen-cli ${installed} est installé, mais revit/Cargo.lock demande ${wanted} : le code de liaison et le module doivent venir de la même version.\nInstaller : cargo install wasm-bindgen-cli --locked --force --version ${wanted}`);

// SIMD 128 bits : sans lui, la recherche de motifs (memchr) et les sommes de contrôle de rvt-rs
// retombent sur du code scalaire, et la lecture de 2024_Core_Interior.rvt passe de 8 s à 14 s dans
// V8 (3,5 s en natif). Pris en charge par Chrome 91, Firefox 89 et Safari 16.4 et plus.
const rustflags = 'target.wasm32-unknown-unknown.rustflags=["-C","target-feature=+simd128"]';
run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', manifest, '--lib', '--config', rustflags]);

const wasm = join(targetDir, 'wasm32-unknown-unknown/release/revit.wasm');
if (!existsSync(wasm)) fail(`module introuvable : ${wasm}`);

run('wasm-bindgen', ['--target', 'web', '--out-dir', outDir, '--out-name', 'revit', wasm]);

// macOS sème des doublons « ._* » (AppleDouble) sur les disques exFAT : ils n'ont rien à faire ici.
for (const folder of [outDir, dirname(outDir)]) for (const name of readdirSync(folder)) if (name.startsWith('._')) rmSync(join(folder, name));

const megabytes = (path) => (statSync(path).size / 1e6).toFixed(2);
console.log(`\nwasm-bindgen ${installed}`);
console.log(`module brut      ${megabytes(wasm)} Mo  (${wasm})`);
console.log(`module livré     ${megabytes(join(outDir, 'revit_bg.wasm'))} Mo  (src/revit/pkg/revit_bg.wasm)`);
