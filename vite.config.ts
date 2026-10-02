import { defineConfig } from 'vite';

// Chemins relatifs : le site fonctionne quel que soit le sous-dossier où il est publié
// (GitHub Pages le sert sous /<nom-du-dépôt>/).
export default defineConfig({ base: './' });
