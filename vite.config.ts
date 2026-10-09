import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

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

// Chemins relatifs : le site fonctionne quel que soit le sous-dossier où il est publié
// (GitHub Pages le sert sous /<nom-du-dépôt>/).
export default defineConfig({
  base: './',
  plugins: [cesiumAssets()],
  optimizeDeps: { include: ['cesium'] },
  // Cesium est chargé à la demande, dans son propre morceau de plusieurs mégaoctets.
  build: { chunkSizeWarningLimit: 6000 },
});
