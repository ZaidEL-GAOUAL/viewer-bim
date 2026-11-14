// Quelle sorte de fichier est-ce ? Une seule table, extension → sorte, lue par tous les chargeurs.

type FileKind = 'gltf' | 'ifc' | 'usd' | 'revit' | 'json';

const KINDS: Readonly<Record<string, FileKind>> = {
  glb: 'gltf', gltf: 'gltf',
  ifc: 'ifc',
  usdz: 'usd', usda: 'usd', usd: 'usd', usdc: 'usd',
  // Projet (.rvt), famille (.rfa), gabarit de projet (.rte), gabarit de famille (.rft) : même conteneur, même lecteur.
  rvt: 'revit', rfa: 'revit', rte: 'revit', rft: 'revit',
  json: 'json',
};

/** Extension du nom, en minuscules, sans le point ; rien si le nom n'en a pas (« rvt » seul n'est pas une extension). */
export function extensionOf(name: string): string | undefined {
  const match = /\.([^./\\]+)$/.exec(name);
  return match ? match[1].toLowerCase() : undefined;
}

export function fileKind(name: string): FileKind | undefined {
  const extension = extensionOf(name);
  return extension !== undefined && Object.hasOwn(KINDS, extension) ? KINDS[extension] : undefined;
}

export const isModelFile = (name: string): boolean => fileKind(name) === 'gltf';
export const isIfcFile = (name: string): boolean => fileKind(name) === 'ifc';
export const isUsdFile = (name: string): boolean => fileKind(name) === 'usd';
/** Un fichier Revit : projet, famille ou gabarit de l'un ou de l'autre. */
export const isRevitFile = (name: string): boolean => fileKind(name) === 'revit';
export const isJsonFile = (name: string): boolean => fileKind(name) === 'json';

/** Le nom sans son extension (le nom entier s'il n'en a pas). */
export function withoutExtension(name: string): string {
  const extension = extensionOf(name);
  return extension === undefined ? name : name.slice(0, name.length - extension.length - 1);
}
