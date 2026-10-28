// Vues enregistrées (voir docs/contrat-metadonnees.md, § « Vues enregistrées ») : lecture de la section `views` du JSON
// et calcul de ce que l'ouverture d'une vue demande au viewer. Rien ici ne suppose un nom de propriété : la catégorie
// des éléments est désignée par la vue elle-même (`hiddenCategories.property`).
//
// Les coordonnées du fichier sont celles du repère du modèle (mètres, axe Y vers le haut, comme le GLB) : le viewer les
// recentre en retranchant `Model.offset`.

import type { PropValue } from './metadata.ts';

export type Vec3 = [number, number, number];
export type CameraProjection = 'perspective' | 'orthographic';

export interface SavedViewCamera {
  position: Vec3;
  /** Sens du regard, unitaire (calculé depuis `target` si le fichier ne donne que celle-ci). */
  direction: Vec3;
  up: Vec3;
  projection: CameraProjection;
  /** Perspective : champ vertical, en degrés. */
  fov?: number;
  /** Projection parallèle : largeur et hauteur de ce que la vue montre, en mètres. */
  size?: [number, number];
}

export interface SectionBoxSpec {
  min: Vec3;
  max: Vec3;
  /** Rotation autour de la verticale (Y), en degrés, positive dans le sens anti-horaire vu d'en haut. */
  rotation: number;
}

export interface HiddenCategories {
  /** Propriété des éléments qui porte la catégorie. */
  property: string;
  values: string[];
}

export interface SavedView {
  name: string;
  camera: SavedViewCamera;
  sectionBox?: SectionBoxSpec;
  hiddenCategories?: HiddenCategories;
  /** Clés (celles de `elements`) des éléments masqués. */
  hiddenElements?: string[];
  /** Phase et filtre de phase (noms de la section `phases`). */
  phase?: string;
  phaseFilter?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function vec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  return [value[0], value[1], value[2]];
}

const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 | undefined => {
  const n = length(v);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : undefined;
};

function parseCamera(raw: unknown): SavedViewCamera | undefined {
  if (!isRecord(raw)) return undefined;
  const position = vec3(raw.position);
  if (!position) return undefined;
  const target = vec3(raw.target);
  const direction = unit(vec3(raw.direction) ?? (target ? sub(target, position) : [0, 0, 0]));
  if (!direction) return undefined;
  // Un haut absent, nul ou parallèle au regard : la verticale ; sinon projeté perpendiculairement au regard.
  const given = vec3(raw.up) ?? [0, 1, 0];
  let up = unit([given[0] - direction[0] * dot(given, direction), given[1] - direction[1] * dot(given, direction), given[2] - direction[2] * dot(given, direction)]);
  if (!up) {
    const vertical: Vec3 = Math.abs(direction[1]) < 0.99 ? [0, 1, 0] : [0, 0, -1];
    up = unit([vertical[0] - direction[0] * dot(vertical, direction), vertical[1] - direction[1] * dot(vertical, direction), vertical[2] - direction[2] * dot(vertical, direction)]);
    if (!up) return undefined;
  }
  const camera: SavedViewCamera = { position, direction, up, projection: raw.projection === 'orthographic' ? 'orthographic' : 'perspective' };
  if (camera.projection === 'perspective' && typeof raw.fov === 'number' && raw.fov > 1 && raw.fov < 179) camera.fov = raw.fov;
  if (camera.projection === 'orthographic' && Array.isArray(raw.size) && raw.size.length === 2 && raw.size.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0)) camera.size = [raw.size[0], raw.size[1]];
  return camera;
}

/**
 * Lit la section `views`. Une entrée illisible (sans nom, sans caméra valide) est ignorée sans empêcher les autres : un
 * viewer qui ne connaît pas la section l'ignore de même, et le reste du fichier garde son sens.
 */
export function parseViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const views: SavedView[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') continue;
    const camera = parseCamera(item.camera);
    if (!camera) continue;
    const view: SavedView = { name: item.name, camera };
    const min = isRecord(item.sectionBox) ? vec3(item.sectionBox.min) : undefined;
    const max = isRecord(item.sectionBox) ? vec3(item.sectionBox.max) : undefined;
    if (min && max && isRecord(item.sectionBox)) {
      const rotation = typeof item.sectionBox.rotation === 'number' && Number.isFinite(item.sectionBox.rotation) ? item.sectionBox.rotation : 0;
      view.sectionBox = { min: [Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])], max: [Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])], rotation };
    }
    if (isRecord(item.hiddenCategories) && typeof item.hiddenCategories.property === 'string' && Array.isArray(item.hiddenCategories.values)) {
      const values = item.hiddenCategories.values.filter((value): value is string => typeof value === 'string');
      if (values.length > 0) view.hiddenCategories = { property: item.hiddenCategories.property, values };
    }
    if (Array.isArray(item.hiddenElements)) {
      const keys = item.hiddenElements.filter((key): key is string | number => typeof key === 'string' || typeof key === 'number').map(String);
      if (keys.length > 0) view.hiddenElements = keys;
    }
    if (typeof item.phase === 'string' && item.phase !== '') view.phase = item.phase;
    if (typeof item.phaseFilter === 'string' && item.phaseFilter !== '') view.phaseFilter = item.phaseFilter;
    views.push(view);
  }
  return views;
}

/** Une caméra prête pour le viewer : repère du modèle recentré (`Model.offset` retranché). */
export interface CameraPose {
  position: Vec3;
  /** Le point autour duquel la caméra tourne. */
  target: Vec3;
  up: Vec3;
  projection: CameraProjection;
  /** Perspective : champ vertical (degrés), absent pour garder celui du viewer. */
  fov?: number;
  /** Projection parallèle : demi-hauteur de ce que la vue montre, en mètres. */
  halfHeight?: number;
}

/** La sphère englobante du modèle, dans le repère recentré. */
export interface Bounds {
  center: Vec3;
  radius: number;
}

/**
 * La caméra d'une vue enregistrée, dans le repère recentré du modèle.
 *
 * - Perspective : l'œil et le regard du fichier, le pivot sur l'axe du regard à la profondeur du centre du modèle (à
 *   défaut, devant l'œil, à la moitié du rayon).
 * - Projection parallèle avec la taille enregistrée : le même axe, la même fenêtre ; la hauteur montrée est au moins
 *   celle qui laisse voir la largeur enregistrée dans la forme de la vue (`aspect` = largeur / hauteur).
 * - Projection parallèle sans taille : seule la direction compte (l'œil d'une vue parallèle est arbitraire sur son axe) ;
 *   la maquette est cadrée.
 */
export function cameraPose(camera: SavedViewCamera, offset: Vec3, bounds: Bounds, aspect: number): CameraPose {
  const direction = camera.direction;
  const eye = sub(camera.position, offset);
  const toCentre = sub(bounds.center, eye);
  const depth = dot(toCentre, direction);
  const along = (distance: number): Vec3 => [eye[0] + direction[0] * distance, eye[1] + direction[1] * distance, eye[2] + direction[2] * distance];
  const radius = Math.max(bounds.radius, 1e-3);

  if (camera.projection === 'orthographic') {
    if (!camera.size) {
      const distance = radius * 3;
      return {
        position: [bounds.center[0] - direction[0] * distance, bounds.center[1] - direction[1] * distance, bounds.center[2] - direction[2] * distance],
        target: bounds.center,
        up: camera.up,
        projection: 'orthographic',
        halfHeight: (radius * 1.05) / Math.min(1, aspect),
      };
    }
    const [width, height] = camera.size;
    return {
      position: eye,
      target: along(depth > 0 ? depth : radius),
      up: camera.up,
      projection: 'orthographic',
      halfHeight: Math.max(height / 2, width / 2 / Math.max(aspect, 1e-3)),
    };
  }
  const pose: CameraPose = { position: eye, target: along(depth > 0.5 ? depth : Math.max(radius * 0.5, 1)), up: camera.up, projection: 'perspective' };
  if (camera.fov !== undefined) pose.fov = camera.fov;
  return pose;
}

/**
 * Les éléments qu'une vue masque : ceux de ses éléments masqués (par clé) et ceux dont la propriété de catégorie vaut
 * l'une des catégories masquées. Les clés et les catégories qu'aucun élément ne porte sont sans effet.
 */
export function hiddenByView(
  view: Pick<SavedView, 'hiddenCategories' | 'hiddenElements'>,
  count: number,
  indexOfKey: ReadonlyMap<string, number>,
  valueOf: (index: number, property: string) => PropValue | undefined,
): Uint8Array {
  const hidden = new Uint8Array(count);
  for (const key of view.hiddenElements ?? []) {
    const index = indexOfKey.get(key);
    if (index !== undefined) hidden[index] = 1;
  }
  const categories = view.hiddenCategories;
  if (categories && categories.values.length > 0) {
    const values = new Set(categories.values);
    for (let i = 0; i < count; i++) {
      const value = valueOf(i, categories.property);
      if (typeof value === 'string' && values.has(value)) hidden[i] = 1;
    }
  }
  return hidden;
}

/** La boîte de coupe dans le repère recentré du modèle. */
export function sectionBoxLocal(box: SectionBoxSpec, offset: Vec3): SectionBoxSpec {
  return { min: sub(box.min, offset), max: sub(box.max, offset), rotation: box.rotation };
}

/** La section `views` au format du contrat (pour réexporter les métadonnées). */
export function viewsToJson(views: readonly SavedView[]): Record<string, unknown>[] {
  return views.map((view) => {
    const { camera } = view;
    const out: Record<string, unknown> = {
      name: view.name,
      camera: {
        position: [...camera.position], direction: [...camera.direction], up: [...camera.up], projection: camera.projection,
        ...(camera.fov !== undefined ? { fov: camera.fov } : {}), ...(camera.size ? { size: [...camera.size] } : {}),
      },
    };
    if (view.sectionBox) out.sectionBox = { min: [...view.sectionBox.min], max: [...view.sectionBox.max], ...(view.sectionBox.rotation !== 0 ? { rotation: view.sectionBox.rotation } : {}) };
    if (view.hiddenCategories) out.hiddenCategories = { property: view.hiddenCategories.property, values: [...view.hiddenCategories.values] };
    if (view.hiddenElements) out.hiddenElements = [...view.hiddenElements];
    if (view.phase !== undefined) out.phase = view.phase;
    if (view.phaseFilter !== undefined) out.phaseFilter = view.phaseFilter;
    return out;
  });
}
