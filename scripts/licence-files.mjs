// Fichiers de licence publiés avec le site, dans licences/ : chemin publié → chemin source (depuis
// la racine du dépôt). Ces fichiers vivent hors de public/ : la construction les copie dans dist/
// au lieu de les dupliquer, et le serveur de développement les sert depuis leur emplacement.
export const LICENCE_FILES = {
  'licences/LICENCE.txt': 'LICENSE',
  'licences/NOTICE.txt': 'NOTICE',
  'licences/revit-THIRD_PARTY.txt': 'revit/THIRD_PARTY.md',
  'licences/three.txt': 'node_modules/three/LICENSE',
  'licences/cesium.txt': 'node_modules/cesium/LICENSE.md',
  'licences/three-mesh-bvh.txt': 'node_modules/three-mesh-bvh/LICENSE',
  'licences/leaflet.txt': 'node_modules/leaflet/LICENSE',
  'licences/jspdf.txt': 'node_modules/jspdf/LICENSE',
  'licences/supabase-js.txt': 'node_modules/@supabase/supabase-js/LICENSE',
  'licences/phoenix.txt': 'node_modules/@supabase/phoenix/LICENSE.md',
  // Servi en .txt : un .md part en téléchargement dans certains navigateurs au lieu de s'afficher.
  'licences/revit-demo.txt': 'public/samples/revit-demo.LICENSE.md',
};
