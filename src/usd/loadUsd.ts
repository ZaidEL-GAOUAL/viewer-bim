// Chargement d'un fichier USD (usda, usdc ou usdz) en scène three.js prête pour buildModel, avec
// les métadonnées lues dans les prims. Sous-ensemble : maillages polygonaux, transformations
// (matrice ou opérations translate / rotate / scale / orient), références et charges internes,
// matériaux UsdPreviewSurface. Le binaire (usdc) est converti dans le même calque que le texte.

import { BufferAttribute, BufferGeometry, DoubleSide, Euler, FrontSide, LinearSRGBColorSpace, MathUtils, Matrix4, Mesh, MeshStandardMaterial, Object3D, Quaternion, type EulerOrder } from 'three';
import { flattenProperties, type Metadata, type MetadataEntry } from '../data/metadata.ts';
import { parseGeoreference } from '../geo/georeference.ts';
import type { ModelSource } from '../engine/buildModel.ts';
import { parseUsda, type UsdDictionary, type UsdLayer, type UsdPath, type UsdPrim, type UsdValue } from './usda.ts';

interface LoadedUsd {
  source: ModelSource;
  /** Métadonnées embarquées dans les prims (`customData`), s'il y en a. */
  metadata: Metadata | null;
  warnings: string[];
}

/** Z vers le haut (USD par défaut en construction) vers Y vers le haut (three.js). */
const Z_UP_TO_Y_UP = new Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

// ------------------------------------------------------------------- usdz

/**
 * Calque racine d'un paquet usdz (archive zip sans compression) : la première entrée USD, qui est
 * la première de l'archive selon la spécification. Les images et autres calques sont ignorés.
 */
export function rootLayerOfUsdz(data: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  let at = 0;
  const decoder = new TextDecoder();
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extraLength;
    if (/\.(usda|usd|usdc)$/i.test(name)) {
      if (method !== 0) throw new Error(`Le paquet USDZ contient un fichier compressé (« ${name} »), ce que le format n’autorise pas.`);
      return bytes.subarray(start, start + size);
    }
    at = start + size;
  }
  throw new Error('Aucun fichier USD trouvé dans le paquet USDZ.');
}

// --------------------------------------------------------------- matériaux

interface UsdMaterial {
  material: MeshStandardMaterial;
  name: string;
}

function number(value: UsdValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function tuple(value: UsdValue | undefined): number[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value as number[];
  if (value instanceof Float64Array) return Array.from(value);
  return null;
}

function materialFrom(prim: UsdPrim, doubleSided: boolean, cache: Map<string, UsdMaterial>): UsdMaterial {
  const key = `${prim.path}|${doubleSided}`;
  let entry = cache.get(key);
  if (entry) return entry;
  let color = [0.45, 0.45, 0.45];
  let opacity = 1;
  const shader = prim.children.find((child) => child.type === 'Shader') ?? prim;
  const diffuse = tuple(shader.attributes.get('inputs:diffuseColor')?.value);
  if (diffuse && diffuse.length >= 3) color = diffuse;
  opacity = number(shader.attributes.get('inputs:opacity')?.value, 1);
  const material = new MeshStandardMaterial({
    transparent: opacity < 1,
    opacity,
    side: doubleSided ? DoubleSide : FrontSide,
    depthWrite: opacity >= 1,
    metalness: 0,
    roughness: 0.9,
  });
  material.color.setRGB(color[0], color[1], color[2], LinearSRGBColorSpace);
  const name = (prim.meta.customData as UsdDictionary | undefined)?.name;
  entry = { material, name: typeof name === 'string' ? name : prim.name };
  material.name = entry.name;
  cache.set(key, entry);
  return entry;
}

// ----------------------------------------------------------------- maillage

function meshFrom(prim: UsdPrim, layer: UsdLayer, materials: Map<string, UsdMaterial>, fallback: MeshStandardMaterial): Mesh | null {
  const points = prim.attributes.get('points')?.value;
  const indices = prim.attributes.get('faceVertexIndices')?.value;
  const counts = prim.attributes.get('faceVertexCounts')?.value;
  if (!(points instanceof Float64Array) || !(indices instanceof Int32Array) || !(counts instanceof Int32Array)) return null;
  if (points.length < 9) return null;

  // Les faces à plus de trois sommets sont découpées en éventail.
  let triangleCount = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i] >= 3) triangleCount += counts[i] - 2;
  const index = new Uint32Array(triangleCount * 3);
  let read = 0;
  let write = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i];
    for (let k = 1; k + 1 < count; k++) {
      index[write++] = indices[read];
      index[write++] = indices[read + k];
      index[write++] = indices[read + k + 1];
    }
    read += count;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(points), 3));
  const normals = prim.attributes.get('normals') ?? prim.attributes.get('primvars:normals');
  if (normals?.value instanceof Float64Array && normals.value.length === points.length && normals.meta.interpolation !== 'faceVarying') {
    geometry.setAttribute('normal', new BufferAttribute(Float32Array.from(normals.value), 3));
  }
  geometry.setIndex(new BufferAttribute(index, 1));

  const doubleSided = Boolean(prim.attributes.get('doubleSided')?.value);
  const binding = prim.relationships.get('material:binding')?.[0];
  const materialPrim = binding ? layer.byPath.get(binding.path) : undefined;
  const mesh = new Mesh(geometry, materialPrim ? materialFrom(materialPrim, doubleSided, materials).material : fallback);
  mesh.name = prim.name;
  return mesh;
}

/** Matrice d'une opération de transformation (`xformOp:translate`, `xformOp:rotateXYZ:pivot`…). */
function opMatrix(name: string, value: UsdValue | undefined): Matrix4 | null {
  const kind = name.split(':')[1] ?? '';
  const values = tuple(value);
  if (kind === 'transform') {
    const flat = Array.isArray(value) ? value.flatMap((row) => tuple(row) ?? []) : [];
    // Lignes USD = colonnes glTF : les seize nombres sont dans l'ordre attendu par fromArray.
    return flat.length === 16 ? new Matrix4().fromArray(flat) : null;
  }
  if (kind === 'translate' && values?.length === 3) return new Matrix4().makeTranslation(values[0], values[1], values[2]);
  if (kind === 'scale' && values?.length === 3) return new Matrix4().makeScale(values[0], values[1], values[2]);
  if (kind === 'orient' && values?.length === 4) {
    // Quaternion USD : (réel, i, j, k).
    return new Matrix4().makeRotationFromQuaternion(new Quaternion(values[1], values[2], values[3], values[0]).normalize());
  }
  const axis = /^rotate([XYZ])$/.exec(kind)?.[1];
  if (axis && typeof value === 'number') {
    const angle = MathUtils.degToRad(value);
    return axis === 'X' ? new Matrix4().makeRotationX(angle) : axis === 'Y' ? new Matrix4().makeRotationY(angle) : new Matrix4().makeRotationZ(angle);
  }
  const order = /^rotate([XYZ]{3})$/.exec(kind)?.[1];
  if (order && values?.length === 3) {
    // rotateXYZ tourne d'abord autour de X, puis Y, puis Z : en vecteurs colonnes Rz·Ry·Rx, soit
    // l'ordre « ZYX » d'Euler de three.js. Les angles sont dans l'ordre du nom (X, Y, Z).
    const [x, y, z] = ['X', 'Y', 'Z'].map((letter) => MathUtils.degToRad(values[order.indexOf(letter)]));
    return new Matrix4().makeRotationFromEuler(new Euler(x, y, z, [...order].reverse().join('') as EulerOrder));
  }
  return null;
}

/** Transformation locale : les opérations de `xformOpOrder`, de la première (la plus externe) à la dernière. */
function transformOf(prim: UsdPrim): Matrix4 | null {
  const order = prim.attributes.get('xformOpOrder')?.value;
  const ops = Array.isArray(order) ? order.filter((op): op is string => typeof op === 'string') : ['xformOp:transform'];
  let matrix: Matrix4 | null = null;
  for (const op of ops) {
    const inverse = op.startsWith('!invert!');
    const name = inverse ? op.slice('!invert!'.length) : op;
    const step = opMatrix(name, prim.attributes.get(name)?.value);
    if (!step) continue;
    if (inverse) step.invert();
    matrix = matrix ? matrix.multiply(step) : step;
  }
  return matrix;
}

// ------------------------------------------------------------------- scène

interface Context {
  layer: UsdLayer;
  materials: Map<string, UsdMaterial>;
  fallback: MeshStandardMaterial;
  metadata: Map<string, MetadataEntry>;
  depth: number;
  /** Formes non polygonales rencontrées (Sphere, Cube…), par type, avec un exemple de chemin. */
  skipped: Map<string, { count: number; path: string }>;
}

function customData(prim: UsdPrim): UsdDictionary | null {
  const data = prim.meta.customData;
  return data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Float64Array) && !(data instanceof Int32Array) ? (data as UsdDictionary) : null;
}

function referenced(prim: UsdPrim, layer: UsdLayer): UsdPrim | null {
  const reference = prim.meta.references ?? prim.meta.payload;
  const target = Array.isArray(reference) ? (reference[0] as UsdPath | undefined) : (reference as UsdPath | undefined);
  if (!target || typeof target !== 'object' || !('path' in target)) return null;
  return layer.byPath.get(target.path) ?? null;
}

/** Formes géométriques USD autres que les maillages : non affichées, mais signalées. */
const GPRIMS = new Set(['Sphere', 'Cube', 'Cylinder', 'Cone', 'Capsule', 'Plane', 'Points', 'BasisCurves', 'NurbsCurves', 'NurbsPatch', 'PointInstancer', 'TetMesh']);

/** Construit l'objet three.js d'un prim : ses maillages, ses enfants, et ce qu'il référence. */
function instantiate(prim: UsdPrim, context: Context): Object3D {
  const object = new Object3D();
  object.name = prim.name;
  const matrix = transformOf(prim);
  if (matrix) object.matrix.copy(matrix).decompose(object.position, object.quaternion, object.scale);

  const data = customData(prim);
  const id = data?.id;
  if (typeof id === 'string' || typeof id === 'number') {
    // Un élément : son identifiant et ses métadonnées voyagent dans customData.
    object.userData.element = { id, name: typeof data?.name === 'string' ? data.name : prim.name };
    const properties = data?.properties;
    const label = typeof data?.label === 'string' ? data.label : undefined;
    const flat = properties && typeof properties === 'object' && !Array.isArray(properties) ? flattenProperties(properties as Record<string, unknown>) : {};
    context.metadata.set(String(id), { label, props: flat });
  }

  const source = referenced(prim, context.layer);
  const bodies = source && context.depth < 8 ? [source, prim] : [prim];
  for (const body of bodies) {
    if (body.type === 'Mesh') {
      const mesh = meshFrom(body, context.layer, context.materials, context.fallback);
      if (mesh) object.add(mesh);
    }
    for (const child of body.children) {
      if (child.type === 'Mesh') {
        const mesh = meshFrom(child, context.layer, context.materials, context.fallback);
        if (mesh) object.add(mesh);
        continue;
      }
      // Les prototypes (prims de classe) et les matériaux ne s'affichent pas d'eux-mêmes.
      if (child.specifier === 'class' || child.type === 'Material' || child.type === 'Shader') continue;
      if (child.type !== 'Xform' && child.type !== 'Scope' && child.type !== 'SkelRoot' && child.type !== '') {
        if (GPRIMS.has(child.type)) {
          const entry = context.skipped.get(child.type) ?? { count: 0, path: child.path };
          entry.count++;
          context.skipped.set(child.type, entry);
        }
        continue;
      }
      context.depth++;
      object.add(instantiate(child, context));
      context.depth--;
    }
  }
  return object;
}

/** Charge un texte usda. */
export function loadUsda(text: string): LoadedUsd {
  return loadUsdLayer(parseUsda(text), []);
}

/** Construit la scène d'un calque USD, lu du texte ou du binaire. */
function loadUsdLayer(layer: UsdLayer, warnings: string[]): LoadedUsd {
  const context: Context = {
    layer,
    materials: new Map(),
    fallback: new MeshStandardMaterial({ color: 0x737373, metalness: 0, roughness: 0.9 }),
    metadata: new Map(),
    depth: 0,
    skipped: new Map(),
  };
  const root = new Object3D();
  root.name = 'USD';
  for (const prim of layer.prims) {
    if (prim.specifier === 'class' || prim.type === 'Material') continue;
    root.add(instantiate(prim, context));
  }
  const unit = number(layer.meta.metersPerUnit, 1);
  if (layer.meta.upAxis !== 'Y') root.matrix.copy(Z_UP_TO_Y_UP);
  if (unit !== 1) root.matrix.multiply(new Matrix4().makeScale(unit, unit, unit));
  root.matrix.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);

  const metadata: Metadata | null = context.metadata.size > 0 ? { version: 1, elements: context.metadata } : null;
  const layerData = layer.meta.customLayerData as UsdDictionary | undefined;
  if (metadata && Array.isArray(layerData?.readOnly)) {
    metadata.readOnly = layerData.readOnly.filter((item): item is string => typeof item === 'string');
  }
  const position = layerData?.georeference;
  if (metadata && position && typeof position === 'object' && !Array.isArray(position)) {
    // Les tuples USD (double3, double2) arrivent en tableaux : même forme que le JSON.
    const georeference = parseGeoreference(position);
    if (georeference) metadata.georeference = georeference;
  }
  let meshes = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh) meshes++;
  });
  for (const [type, { count, path }] of context.skipped) {
    warnings.push(`${count} forme${count > 1 ? 's' : ''} « ${type} » non affichée${count > 1 ? 's' : ''} (par exemple « ${path} ») : seuls les maillages sont lus.`);
  }
  if (meshes === 0) warnings.push('Le fichier USD ne contient aucun maillage polygonal lisible.');

  const source: ModelSource = {
    scene: root,
    useIds: context.metadata.size > 0,
    isNode: (object) => object !== root && !(object as Mesh).isMesh,
    idOf: (object) => (object.userData.element as { id?: string | number } | undefined)?.id,
    nameOf: (object) => (object.userData.element as { name?: string } | undefined)?.name ?? object.name,
    extrasOf: () => undefined,
  };
  return { source, metadata, warnings };
}

/** Charge le contenu d'un fichier .usda, .usdc ou .usdz. */
export async function loadUsdData(buffer: ArrayBuffer): Promise<LoadedUsd> {
  let bytes = new Uint8Array(buffer);
  const head = (): string => new TextDecoder().decode(bytes.subarray(0, 8));
  if (head().startsWith('PK')) bytes = rootLayerOfUsdz(buffer);
  if (head() === 'PXR-USDC') {
    // Le lecteur binaire n'est chargé que pour un fichier binaire.
    const { parseUsdc } = await import('./usdc.ts');
    const { layer, warnings } = parseUsdc(bytes.byteLength === buffer.byteLength ? buffer : bytes.slice().buffer);
    return loadUsdLayer(layer, warnings);
  }
  return loadUsda(new TextDecoder().decode(bytes));
}

/** Charge un fichier .usda, .usdc ou .usdz. */
export async function loadUsdFile(file: File): Promise<LoadedUsd> {
  return loadUsdData(await file.arrayBuffer());
}

