import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { LICENCE_FILES } from './scripts/licence-files.mjs';

const root = dirname(fileURLToPath(import.meta.url));
// Fichiers que CesiumJS charge à l'exécution (workers, données, feuilles de style) : servis
// depuis node_modules en développement, copiés dans dist/cesium à la construction.
const cesiumBuild = resolve(root, 'node_modules/cesium/Build/Cesium');
const CESIUM_FOLDERS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.xml': 'application/xml', '.glsl': 'text/plain', '.ktx2': 'image/ktx2', '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary',
};

function cesiumAssets(): Plugin {
  return {
    name: 'cesium-assets',
    configureServer(server) {
      server.middlewares.use('/cesium', (request, response, next) => {
        const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]));
        const file = join(cesiumBuild, path);
        if (!file.startsWith(cesiumBuild) || !existsSync(file) || !statSync(file).isFile()) return next();
        response.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
        response.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (!existsSync(cesiumBuild)) return;
      for (const folder of CESIUM_FOLDERS) cpSync(join(cesiumBuild, folder), join(root, 'dist/cesium', folder), { recursive: true });
    },
  };
}

// Textes de licence publiés dans licences/ (liste dans scripts/licence-files.mjs) : ils vivent hors
// de public/, donc servis depuis leur source en développement et émis dans le build à la construction.
function licenceFiles(): Plugin {
  return {
    name: 'licence-files',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent((request.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        if (!Object.hasOwn(LICENCE_FILES, path) || !existsSync(resolve(root, LICENCE_FILES[path]))) return next();
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(readFileSync(resolve(root, LICENCE_FILES[path])));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(LICENCE_FILES)) {
        const file = resolve(root, source);
        if (!existsSync(file)) this.error(`Fichier de licence introuvable : ${source} (publié sous ${fileName}).`);
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
  };
}

// Chemins relatifs : le site fonctionne quel que soit le sous-dossier où il est publié
// (GitHub Pages le sert sous /<nom-du-dépôt>/).
export default defineConfig({
  base: './',
  plugins: [cesiumAssets(), licenceFiles()],
  optimizeDeps: { include: ['cesium'] },
  // Cesium est chargé à la demande, dans son propre morceau de plusieurs mégaoctets.
  build: { chunkSizeWarningLimit: 6000 },
});
