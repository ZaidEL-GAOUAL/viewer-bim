// Désigner un élément hors de la session (conflits, observations) : sa clé dans le fichier de sa maquette et le nom de ce
// fichier, et le retrouver ensuite, même quand plusieurs maquettes sont ouvertes (voir data/federation.ts).

import { Box3, Vector3 } from 'three';
import type { BcfCamera } from '../data/bcf.ts';
import type { ElementRef } from '../data/clashes.ts';
import { sourceIndexOf, sourceKey } from '../data/federation.ts';
import { toModelPoint, toViewerPoint, yUpToZUp, zUpToYUp, type Vec3 } from '../data/modelFrame.ts';
import { aimAt, baseKey, type BcfExportContext, type ElementIdentity } from '../data/observations.ts';
import { fileKind } from '../engine/fileKinds.ts';
import type { App } from './App.ts';

export function elementRef(app: App, element: number): ElementRef {
  const model = app.model!;
  const source = model.sources[sourceIndexOf(model, element)];
  return { key: sourceKey(model.keys[element], source), model: source?.name ?? app.sourceName };
}

/**
 * Retrouve un élément par sa maquette et sa clé. Sans maquette (lu d'un .bcf), ou d'une maquette qui n'est pas ouverte sous ce
 * nom (fichier renommé), par sa clé dans la première maquette qui l'a.
 */
export function refResolver(app: App): (ref: ElementRef) => number | undefined {
  const byRef = new Map<string, number>(), byKey = new Map<string, number>(), models = new Set<string | undefined>();
  for (let i = 0; i < (app.model?.count ?? 0); i++) {
    const ref = elementRef(app, i);
    models.add(ref.model);
    byRef.set(`${ref.model}\u0000${ref.key}`, i);
    if (!byKey.has(ref.key)) byKey.set(ref.key, i);
  }
  return (ref) => (ref.model === undefined || !models.has(ref.model) ? byKey.get(ref.key) : byRef.get(`${ref.model}\u0000${ref.key}`));
}

/** Le centre des éléments, repère du modèle, Z vers le haut (celui des observations et du BCF) ; rien sans géométrie. */
export function elementsPoint(app: App, elements: readonly number[]): Vec3 | undefined {
  const model = app.model;
  if (!model || elements.length === 0) return undefined;
  const box = model.boxOf(elements, new Box3());
  if (box.isEmpty()) return undefined;
  return yUpToZUp(toModelPoint(box.getCenter(new Vector3()).toArray(), model.offset.toArray())).map((x) => Math.round(x * 1000) / 1000 + 0) as Vec3;
}

/** Le type de la maquette d'un élément (`revit`, `ifc`, `glb`, `usd`) : celui de sa maquette, à défaut celui du fichier ouvert. */
function kindOf(app: App, element: number): string {
  const model = app.model!;
  const source = model.sources[sourceIndexOf(model, element)];
  if (source) return source.kind;
  const kind = fileKind(app.sourceName);
  return kind === 'gltf' || kind === undefined ? 'glb' : kind;
}

/** Vrai si la session ouverte est un `.rvt` : un nombre seul d'un .bcf y est alors un ElementId. */
export function isRevitSession(app: App): boolean {
  const model = app.model;
  return !!model && (model.sources.length > 0 ? model.sources.some((source) => source.kind === 'revit') : fileKind(app.sourceName) === 'revit');
}

/** Un point (repère du modèle, Z vers le haut) dans le repère du viewer. */
const viewerPoint = (app: App, point: Vec3): Vec3 => toViewerPoint(zUpToYUp(point), app.model!.offset.toArray());

/** La boîte de ces éléments, repère du modèle, Z vers le haut ; rien sans géométrie. */
function elementsBox(app: App, elements: readonly number[]): { min: Vec3; max: Vec3 } | undefined {
  const model = app.model;
  if (!model || elements.length === 0) return undefined;
  const box = model.boxOf(elements, new Box3());
  if (box.isEmpty()) return undefined;
  const [o0, o1, o2] = model.offset.toArray();
  const min = [box.min.x + o0, box.min.y + o1, box.min.z + o2], max = [box.max.x + o0, box.max.y + o1, box.max.z + o2];
  return { min: [min[0], -max[2], min[1]], max: [max[0], -min[2], max[1]] };
}

/** Vrai si un obstacle sépare le point de vue du point visé (voir `aimAt`) : un rayon du point vers la caméra touche la maquette. */
function blockedBy(app: App): (from: Vec3, to: Vec3) => boolean {
  return (from, to) => {
    const a = new Vector3(...viewerPoint(app, to)), b = new Vector3(...viewerPoint(app, from));
    const distance = a.distanceTo(b), direction = b.sub(a).normalize();
    // Le point est sur une surface : le rayon part un peu devant elle et s'arrête avant la caméra.
    return distance > 0.1 && app.viewer.castRay(a.addScaledVector(direction, 0.05), direction, distance - 0.05) !== null;
  };
}

/** L'identité des éléments pour le BCF, le cadre de leur boîte et le test d'obstacle : tout ce que `toBcfTopic` demande à la session. */
export function bcfContext(app: App): BcfExportContext {
  const model = app.model;
  if (!model) return {};
  const resolve = refResolver(app), byBase = new Map<string, number>();
  for (let i = 0; i < model.count; i++) {
    const ref = elementRef(app, i);
    const id = `${ref.model}\u0000${baseKey(ref.key)}`;
    if (!byBase.has(id)) byBase.set(id, i);
  }
  return {
    identify: (ref): ElementIdentity | undefined => {
      const element = byBase.get(`${ref.model}\u0000${ref.key}`) ?? resolve(ref);
      return element === undefined ? undefined : { kind: kindOf(app, element), props: app.store.propsOf(element), readOnly: app.store.readOnly };
    },
    frame: (refs) => elementsBox(app, refs.flatMap((ref) => resolve(ref) ?? [])),
    blocked: blockedBy(app),
  };
}

/** Une caméra qui regarde `point` (Z vers le haut), assez loin pour cadrer ces éléments et jamais derrière un mur. */
export function aimedCamera(app: App, point: Vec3, elements: readonly number[]): BcfCamera {
  const box = elementsBox(app, elements);
  const radius = box ? Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2 : 0;
  return aimAt(point, box ? Math.min(80, Math.max(4, radius * 2.5)) : 6, blockedBy(app))!;
}

/** Où la caméra du point de vue regarde sur la maquette (rayon le long de sa direction), repère du modèle, Z vers le haut, au millimètre. */
export function lookPoint(app: App, camera: BcfCamera | undefined): Vec3 | undefined {
  if (!camera || !app.model) return undefined;
  const direction = new Vector3(...zUpToYUp(camera.direction)).normalize();
  const hit = app.viewer.castRay(new Vector3(...viewerPoint(app, camera.viewPoint)), direction);
  return hit ? (yUpToZUp(toModelPoint(hit.point.toArray(), app.model.offset.toArray())).map((x) => Math.round(x * 1000) / 1000 + 0) as Vec3) : undefined;
}
