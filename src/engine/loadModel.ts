import { LoadingManager } from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Un fichier fourni par l'utilisateur, avec son chemin relatif quand il vient d'un dossier. */
export interface InputFile {
  file: File;
  path: string;
}

export interface LoadedModel {
  gltf: GLTF;
  /** Textures de couleur référencées par le modèle mais absentes des fichiers fournis. */
  missingTextures: string[];
  /** Avertissements à montrer à l'utilisateur (contenu non pris en charge). */
  warnings: string[];
}

interface GltfJson {
  scene?: number;
  scenes?: unknown[];
  animations?: unknown;
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
  textures?: { source?: number; extensions?: Record<string, unknown> }[];
  materials?: {
    alphaMode?: string;
    normalTexture?: unknown;
    occlusionTexture?: unknown;
    emissiveTexture?: unknown;
    extensions?: Record<string, unknown>;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index?: number }; metallicRoughnessTexture?: unknown };
  }[];
}

/** Erreur dont le message est déjà rédigé pour l'utilisateur. */
export class ModelFileError extends Error {}

let draco: DRACOLoader | null = null;

/**
 * Prépare le glTF avant sa lecture par three.js, pour ne charger que ce que le viewer affiche.
 * Renvoie les avertissements à montrer à l'utilisateur.
 */
function simplify(json: GltfJson): string[] {
  const warnings: string[] = [];

  // Une seule scène est affichée. Charger les autres est inutile, et GLTFLoader perd alors le
  // lien entre objets et nœuds, dont dépend l'identification des éléments.
  if (json.scenes && json.scenes.length > 1) {
    json.scenes = [json.scenes[json.scene ?? 0] ?? json.scenes[0]];
    json.scene = 0;
  }
  delete json.animations;

  let compressed = false;
  for (const material of json.materials ?? []) {
    // Seule la couleur de base est affichée. Retirer les autres textures (relief, rugosité,
    // émission…) évite de les télécharger et de les décoder : une seule texture 4096 × 4096
    // occupe déjà 64 Mo une fois décodée.
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    const pbr = material.pbrMetallicRoughness;
    if (pbr) delete pbr.metallicRoughnessTexture;

    // Les textures compressées KTX2 demandent un décodeur que le viewer n'embarque pas :
    // le matériau garde sa couleur de base, sans la texture.
    const texture = pbr?.baseColorTexture?.index === undefined ? undefined : json.textures?.[pbr.baseColorTexture.index];
    if (pbr && texture?.source === undefined && texture?.extensions?.KHR_texture_basisu) {
      delete pbr.baseColorTexture;
      compressed = true;
    }

    // Verre décrit par « transmission » (export Blender, par exemple) : sans cette extension il
    // deviendrait un panneau opaque. On le traduit par une transparence équivalente.
    const extensions = material.extensions ?? {};
    const transmission = (extensions.KHR_materials_transmission as { transmissionFactor?: number } | undefined)?.transmissionFactor ?? 0;
    if (transmission > 0 && material.alphaMode !== 'BLEND') {
      const base = (material.pbrMetallicRoughness ??= {});
      const color = base.baseColorFactor ?? [1, 1, 1, 1];
      base.baseColorFactor = [color[0], color[1], color[2], (color[3] ?? 1) * (1 - 0.8 * Math.min(1, transmission))];
      material.alphaMode = 'BLEND';
    }
    material.extensions = extensions.KHR_materials_unlit ? { KHR_materials_unlit: extensions.KHR_materials_unlit } : {};
  }
  if (compressed) warnings.push('Les textures compressées KTX2 ne sont pas prises en charge : le modèle est affiché sans elles.');
  return warnings;
}

function createLoader(manager: LoadingManager, warnings: string[]): GLTFLoader {
  // Le décodeur Draco n'est téléchargé que si le fichier est réellement compressé.
  // (`import.meta.env` n'existe que sous Vite ; les tests lancés par Node s'en passent.)
  const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  draco ??= new DRACOLoader().setDecoderPath(`${base}draco/`);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => ({
    name: 'VIEWER_BIM_simplify',
    beforeRoot() {
      warnings.push(...simplify(parser.json as GltfJson));
      return null;
    },
  }));
  return loader;
}

export function isModelFile(name: string): boolean {
  return /\.(glb|gltf)$/i.test(name);
}

/** Chemin normalisé : séparateurs « / », sans « ./ » ni segments « .. ». */
function normalizePath(path: string): string {
  const out: string[] = [];
  // Forme Unicode unique : macOS peut fournir « é » en deux caractères (e + accent) quand le
  // glTF l'écrit en un seul, et les deux noms ne se correspondraient pas.
  for (const segment of path.normalize('NFC').replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function decodeUri(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

/** Vrai si l'URI désigne un fichier séparé (ni intégré au glTF, ni absent). */
const isExternal = (uri: string | undefined): uri is string => uri !== undefined && !/^(data|blob):/i.test(uri);

/**
 * Charge un .glb ou un .gltf fourni par l'utilisateur. Les fichiers voisins d'un .gltf (.bin,
 * textures, éventuellement dans des sous-dossiers) sont retrouvés par leur chemin relatif, ou à
 * défaut par leur nom.
 */
export async function loadModelFiles(main: InputFile, siblings: InputFile[]): Promise<LoadedModel> {
  const mainPath = normalizePath(main.path);
  const baseDir = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
  const byPath = new Map<string, File>();
  const byName = new Map<string, File>();
  for (const { file, path } of siblings) {
    const normalized = normalizePath(path);
    byPath.set(normalized.startsWith(baseDir) ? normalized.slice(baseDir.length) : normalized, file);
    const name = file.name.normalize('NFC');
    if (!byName.has(name)) byName.set(name, file);
  }
  const find = (uri: string): File | undefined => {
    const path = normalizePath(decodeUri(uri.split(/[?#]/)[0]));
    return byPath.get(path) ?? byName.get(path.slice(path.lastIndexOf('/') + 1));
  };

  const isBinary = /\.glb$/i.test(main.file.name);
  const data = isBinary ? await main.file.arrayBuffer() : await main.file.text();
  const missingTextures: string[] = [];

  // Pour un .gltf, on vérifie avant de lancer la lecture que ses fichiers voisins sont bien là :
  // le message d'erreur peut alors dire exactement lequel manque.
  if (typeof data === 'string') {
    let json: GltfJson;
    try {
      json = JSON.parse(data) as GltfJson;
    } catch {
      throw new ModelFileError(`« ${main.file.name} » n’est pas un fichier glTF valide.`);
    }
    const missingBuffers = (json.buffers ?? []).map((buffer) => buffer.uri).filter((uri) => isExternal(uri) && !find(uri));
    if (missingBuffers.length > 0) {
      throw new ModelFileError(
        `« ${main.file.name} » a besoin de « ${missingBuffers.join(' », « ')} », absent des fichiers fournis. ` +
          'Déposez le dossier complet (ou utilisez « Dossier… ») pour charger le .gltf avec ses fichiers voisins.',
      );
    }
    const used = new Set<number>();
    for (const material of json.materials ?? []) {
      const texture = material.pbrMetallicRoughness?.baseColorTexture?.index;
      const source = texture === undefined ? undefined : json.textures?.[texture]?.source;
      if (source !== undefined) used.add(source);
    }
    for (const index of used) {
      const uri = json.images?.[index]?.uri;
      if (isExternal(uri) && !find(uri)) missingTextures.push(decodeUri(uri));
    }
  }

  const urls: string[] = [];
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/i.test(url)) return url;
    const file = find(url);
    if (!file) return url;
    const objectUrl = URL.createObjectURL(file);
    urls.push(objectUrl);
    return objectUrl;
  });

  const warnings: string[] = [];
  try {
    const gltf = await createLoader(manager, warnings).parseAsync(data, '');
    return { gltf, missingTextures, warnings };
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

export function loadModelUrl(url: string): Promise<GLTF> {
  return createLoader(new LoadingManager(), []).loadAsync(url);
}

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file(resolve: (file: File) => void, reject: (error: unknown) => void): void;
  createReader(): { readEntries(resolve: (entries: Entry[]) => void, reject: (error: unknown) => void): void };
}

async function walk(entry: Entry, out: InputFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    if (!file.name.startsWith('.')) out.push({ file, path: entry.fullPath.replace(/^\//, '') });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries renvoie le contenu par paquets : on relit jusqu'à obtenir une liste vide.
    for (;;) {
      const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

/** Fichiers d'un glisser-déposer, en parcourant les dossiers déposés. */
export async function filesFromDrop(transfer: DataTransfer): Promise<InputFile[]> {
  // Les entrées doivent être récupérées tout de suite : la liste est vidée dès la fin de l'événement.
  const entries: Entry[] = [];
  for (const item of transfer.items) {
    const entry = item.kind === 'file' ? (item.webkitGetAsEntry?.() as Entry | null) : null;
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return filesFromList(transfer.files);
  const out: InputFile[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

/** Fichiers d'un sélecteur de fichiers ou de dossier. */
export function filesFromList(list: FileList): InputFile[] {
  return [...list]
    .filter((file) => !file.name.startsWith('.'))
    .map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}
