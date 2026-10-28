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

/** `'plan'` : un plan d'étage (vu de dessus, coupé à sa hauteur de coupe) ; `'3d'` : toute autre vue, par défaut. */
export type ViewKind = '3d' | 'plan';

/** L'étendue verticale d'un plan d'étage, en mètres, dans le repère du modèle (Y vers le haut, comme `sectionBox`). */
export interface PlanRange {
  /** La profondeur de vue : le plan ne montre rien de plus bas. Absente quand elle est illimitée. */
  bottom?: number;
  /** Le plan de coupe : le plan ne montre rien de plus haut. */
  top: number;
}

export interface SavedView {
  name: string;
  /** `'3d'` si le fichier n'en dit rien, ou si un plan n'a pas d'étendue lisible : il s'ouvre alors comme une vue ordinaire. */
  kind: ViewKind;
  /** Le type de vue de Revit (« Floor Plan », « Structural Plan »…), pour distinguer deux plans de même nom. */
  type?: string;
  /** Plans seulement : de la profondeur de vue (facultative) à la hauteur de coupe. */
  range?: PlanRange;
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
 * L'étendue d'un plan : une hauteur de coupe (`top`) finie ; une profondeur de vue (`bottom`) absente (illimitée) ou finie
 * et plus basse que la coupe. Tout le reste est illisible : l'étendue est écartée en entier plutôt que devinée.
 */
function parseRange(raw: unknown): PlanRange | undefined {
  if (!isRecord(raw)) return undefined;
  const { top, bottom } = raw;
  if (typeof top !== 'number' || !Number.isFinite(top)) return undefined;
  if (bottom === undefined || bottom === null) return { top };
  if (typeof bottom !== 'number' || !Number.isFinite(bottom) || bottom >= top) return undefined;
  return { bottom, top };
}

/**
 * Lit la section `views`. Une entrée illisible (sans nom, sans caméra valide) est ignorée sans empêcher les autres : un
 * viewer qui ne connaît pas la section l'ignore de même, et le reste du fichier garde son sens.
 *
 * Un plan d'étage (`kind: "plan"`) a besoin d'une étendue lisible (`range.top` fini, voir `parseRange`) ; sans elle, il
 * devient une vue ordinaire : sa caméra, ses masquages et sa phase restent, mais il n'est ni un plan ni coupé à une hauteur.
 */
export function parseViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const views: SavedView[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') continue;
    const camera = parseCamera(item.camera);
    if (!camera) continue;
    const view: SavedView = { name: item.name, kind: '3d', camera };
    if (typeof item.type === 'string' && item.type !== '') view.type = item.type;
    const range = item.kind === 'plan' ? parseRange(item.range) : undefined;
    if (range) {
      view.kind = 'plan';
      view.range = range;
    }
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

/**
 * Les éléments que toutes les vues 3D enregistrées masquent (l'intersection des `hiddenByView` de chaque vue 3D), ou `null`
 * s'il n'y a aucune vue 3D ou si aucun élément n'est masqué par toutes. Revit ne montre jamais un tel élément dans une vue
 * 3D du fichier : à l'ouverture, le viewer le laisse masqué (un élément que seules certaines vues masquent reste visible,
 * une autre vue le montre). Les clés et les catégories qu'aucun élément ne porte sont sans effet.
 *
 * Les plans d'étage (`kind: 'plan'`) sont ignorés : l'ouverture montre la maquette en 3D, et un plan s'écarte de la 3D
 * dans les deux sens. Il montre ce que la 3D masque (le dessin DWG d'un niveau, que les vues 3D laissent éteint) et masque
 * ce que la 3D montre (le DWG d'un autre niveau). Compté, un tel plan viderait l'intersection : un élément masqué par
 * toutes les vues 3D redeviendrait visible dès qu'un seul plan le montre, alors qu'aucune vue 3D ne le montre.
 */
export function hiddenInEveryView(
  allViews: readonly (Pick<SavedView, 'hiddenCategories' | 'hiddenElements'> & { kind?: ViewKind })[],
  count: number,
  indexOfKey: ReadonlyMap<string, number>,
  valueOf: (index: number, property: string) => PropValue | undefined,
): Uint8Array | null {
  const views = allViews.filter((view) => view.kind !== 'plan');
  if (views.length === 0) return null;
  const hidden = hiddenByView(views[0], count, indexOfKey, valueOf);
  for (let v = 1; v < views.length && hidden.includes(1); v++) {
    const other = hiddenByView(views[v], count, indexOfKey, valueOf);
    for (let i = 0; i < count; i++) hidden[i] &= other[i];
  }
  return hidden.includes(1) ? hidden : null;
}

/** La boîte de coupe dans le repère recentré du modèle. */
export function sectionBoxLocal(box: SectionBoxSpec, offset: Vec3): SectionBoxSpec {
  return { min: sub(box.min, offset), max: sub(box.max, offset), rotation: box.rotation };
}

/**
 * La caméra d'un plan d'étage dans le repère recentré : celle de `cameraPose`, avec l'œil remonté au-dessus de la maquette.
 * Le fichier place l'œil à la hauteur de coupe ; en projection parallèle cela ne change pas l'image, mais le plan proche
 * passerait alors dans le plan de coupe, et le remplissage de la coupe (les murs coupés) en serait retranché. Reculer l'œil
 * sur son axe, jusqu'à ce que toute la sphère englobante soit devant lui, garde la même vue. Un œil déjà assez en recul
 * (vue sans taille, que `cameraPose` cadre à trois rayons) ne bouge pas.
 */
export function planCameraPose(camera: SavedViewCamera, offset: Vec3, bounds: Bounds, aspect: number): CameraPose {
  const pose = cameraPose(camera, offset, bounds, aspect);
  const { direction } = camera;
  const depth = dot(sub(bounds.center, pose.position), direction);
  const back = Math.max(0, Math.max(bounds.radius, 1e-3) * 1.05 - depth);
  if (back > 0) pose.position = [pose.position[0] - direction[0] * back, pose.position[1] - direction[1] * back, pose.position[2] - direction[2] * back];
  return pose;
}

/** Marge sous la profondeur de vue d'un plan : garde dans la coupe le dessus d'une dalle ou un DWG posé exactement au niveau. */
const PLAN_DEPTH_MARGIN = 0.02;

/**
 * La boîte de coupe d'un plan d'étage dans le repère recentré (`offset` retranché), ou `null` pour une vue sans étendue.
 *
 * - **x et z** : ceux du recadrage du plan (`sectionBox`, avec sa rotation) s'il en a un ; sinon la boîte du modèle
 *   agrandie de 1 m de chaque côté (rien n'est coupé sur les côtés). Sans recadrage ni modèle, il n'y a pas de boîte.
 * - **y** : de la profondeur de vue du plan, moins 2 cm (`PLAN_DEPTH_MARGIN`), à sa hauteur de coupe. Sans profondeur
 *   (illimitée), du bas du modèle moins 1 m. Le y du recadrage n'est pas lu : la plage du plan le remplace.
 *
 * `modelBox` est la boîte du modèle dans le repère recentré (vide ou non finie : sans effet).
 */
export function planSectionBox(view: Pick<SavedView, 'sectionBox' | 'range'>, offset: Vec3, modelBox: { min: Vec3; max: Vec3 } | null): SectionBoxSpec | null {
  const { range } = view;
  if (!range) return null;
  const model = modelBox && modelBox.min.every((x, axis) => Number.isFinite(x) && Number.isFinite(modelBox.max[axis]) && x <= modelBox.max[axis]) ? modelBox : null;
  const top = range.top - offset[1];
  // Sans profondeur : le bas du modèle moins 1 m. Un modèle tout entier au-dessus de la coupe donne une tranche de 1 m sous
  // elle : rien n'est montré, mais la boîte reste valide (le bas ne dépasse jamais le haut).
  const bottom = range.bottom !== undefined ? range.bottom - PLAN_DEPTH_MARGIN - offset[1] : model ? Math.min(model.min[1] - 1, top - 1) : top - 1e4;
  if (view.sectionBox) {
    const { min, max, rotation } = view.sectionBox;
    return { min: [min[0] - offset[0], bottom, min[2] - offset[2]], max: [max[0] - offset[0], top, max[2] - offset[2]], rotation };
  }
  if (!model) return null;
  return { min: [model.min[0] - 1, bottom, model.min[2] - 1], max: [model.max[0] + 1, top, model.max[2] + 1], rotation: 0 };
}

/** La section `views` au format du contrat (pour réexporter les métadonnées). */
export function viewsToJson(views: readonly SavedView[]): Record<string, unknown>[] {
  return views.map((view) => {
    const { camera } = view;
    const out: Record<string, unknown> = {
      name: view.name,
      // Une vue 3D n'écrit pas `kind` : c'est son absence que le contrat appelle « vue 3D ».
      ...(view.kind === 'plan' ? { kind: 'plan' } : {}),
      ...(view.type !== undefined ? { type: view.type } : {}),
      camera: {
        position: [...camera.position], direction: [...camera.direction], up: [...camera.up], projection: camera.projection,
        ...(camera.fov !== undefined ? { fov: camera.fov } : {}), ...(camera.size ? { size: [...camera.size] } : {}),
      },
    };
    if (view.kind === 'plan' && view.range) out.range = { ...(view.range.bottom !== undefined ? { bottom: view.range.bottom } : {}), top: view.range.top };
    if (view.sectionBox) out.sectionBox = { min: [...view.sectionBox.min], max: [...view.sectionBox.max], ...(view.sectionBox.rotation !== 0 ? { rotation: view.sectionBox.rotation } : {}) };
    if (view.hiddenCategories) out.hiddenCategories = { property: view.hiddenCategories.property, values: [...view.hiddenCategories.values] };
    if (view.hiddenElements) out.hiddenElements = [...view.hiddenElements];
    if (view.phase !== undefined) out.phase = view.phase;
    if (view.phaseFilter !== undefined) out.phaseFilter = view.phaseFilter;
    return out;
  });
}
