// Les vues que l'utilisateur enregistre (voir docs/contrat-metadonnees.md, § « Vues enregistrées ») : ce qu'il voit,
// capturé depuis l'application, et rétabli à l'ouverture de la vue. Tout ce qui est en mètres est dans le repère du modèle
// (voir data/modelFrame.ts) ; les éléments sont désignés par leur clé.

import { Vector3 } from 'three';
import { cameraFromPose, missingKeys, planRangeOfBox, type SavedPlane, type SavedView } from '../data/savedViews.ts';
import { toModelPoint, toViewerPoint } from '../data/modelFrame.ts';
import { integer, s } from '../data/text.ts';
import { AXES, PLANE_NAMES } from '../engine/Sections.ts';
import type { App } from './App.ts';

/** Un identifiant stable pour une vue nouvelle. */
export const newViewId = (): string => globalThis.crypto?.randomUUID?.() ?? `vue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * La vue telle que l'utilisateur la voit : caméra, plans de coupe libres, boîte, éléments masqués et isolés, phase, règles
 * de présentation et regroupement. Ouverte depuis une vue 2D (plan d'étage ou de plafond, coupe, façade : vue parallèle, sans
 * rotation, avec sa boîte), elle en garde la sorte : l'étendue d'un plan est celle de la boîte du moment, la boîte d'une coupe
 * est la sienne, et un plan de plafond, regardé d'en dessous, s'enregistre comme son fichier le décrit (vu de dessus).
 */
export function captureView(app: App, name: string, id = newViewId()): SavedView {
  const { viewer, model } = app;
  if (!model) throw new Error('Aucun modèle ouvert.');
  const offset = model.offset.toArray();
  const { projection, pose } = viewer.capturePose();
  const { width, height } = viewer.size;
  const box = viewer.sections.boxEnabled ? viewer.sections.boxCut : null;
  const flat = projection === 'orthographic' && !viewer.controls.enableRotate && box !== null;
  const kind = flat ? app.activeView?.kind ?? '3d' : '3d';
  const view: SavedView = {
    name, id, origin: 'user', kind,
    camera: cameraFromPose({ position: pose.position.toArray(), target: pose.target.toArray(), up: pose.up.toArray(), fov: pose.fov, halfHeight: pose.halfHeight }, projection, offset, width / Math.max(height, 1)),
  };
  if ((kind === 'plan' || kind === 'ceiling') && box) view.range = planRangeOfBox(box, offset, kind);
  if (kind === 'ceiling') view.camera.direction = [-view.camera.direction[0], -view.camera.direction[1], -view.camera.direction[2]];
  if (box) view.sectionBox = { min: toModelPoint(box.min, offset), max: toModelPoint(box.max, offset), rotation: box.rotation };

  const { sections } = viewer;
  view.sections = AXES.filter((axis) => sections.enabled[axis]).map((axis): SavedPlane => {
    const normal = sections.normals[axis].clone().multiplyScalar(sections.flipped[axis] ? -1 : 1);
    return { name: sections.names[axis], point: toModelPoint(sections.origin(axis, new Vector3()).toArray(), offset), normal: normal.toArray(), enabled: true };
  });

  // Les éléments masqués par la phase ne sont pas écrits : la phase de la vue les masque de nouveau.
  const phaseHidden = app.phaseEvaluation?.hidden;
  const before = app.isolationBase;
  const hidden: string[] = [], isolated: string[] = [];
  for (let i = 0; i < model.count; i++) {
    if (phaseHidden?.[i]) continue;
    const visible = model.state.isVisible(i);
    if (before && visible) isolated.push(model.keys[i]);
    if (before ? before[i] === 0 : !visible) hidden.push(model.keys[i]);
  }
  if (hidden.length > 0) view.hiddenElements = hidden;
  if (before) view.isolated = isolated;
  if (app.phaseSelection) {
    view.phase = app.phaseSelection.phase;
    if (app.phaseSelection.filter) view.phaseFilter = app.phaseSelection.filter;
  }
  view.appearanceRules = structuredClone(app.appearanceRules);
  view.grouping = [...app.grouping];
  return view;
}

/**
 * Ce qu'une vue de l'utilisateur règle en plus de ce que règle toute vue (`App.openView`) : les plans de coupe libres, les
 * règles de présentation, le regroupement et l'isolement. Les clés que le modèle n'a plus sont ignorées, et comptées.
 */
export function applyUserView(app: App, view: SavedView): void {
  const { viewer, model } = app;
  if (!model) return;
  const offset = model.offset.toArray();
  const { sections } = viewer;
  for (const axis of AXES) {
    const plane = view.sections?.[axis];
    if (plane) {
      sections.setTransform(axis, new Vector3(...toViewerPoint(plane.point, offset)), new Vector3(...plane.normal));
      sections.set(axis, { enabled: plane.enabled, flipped: false });
    } else sections.set(axis, { enabled: false });
    sections.names[axis] = plane?.name ?? PLANE_NAMES[axis];
  }
  // Les poignées restent celles que la carte « Coupes » montre : un plan désactivé n'en a pas.
  viewer.sectionsChanged();
  if (view.appearanceRules) app.setAppearanceRules(view.appearanceRules);
  if (view.grouping) app.groupBy(view.grouping.filter((path) => app.store.paths.includes(path)));
  const index = new Map(model.keys.map((key, i) => [key, i]));
  if (view.isolated) app.isolate(view.isolated.flatMap((key) => index.get(key) ?? []));
  const missing = missingKeys(view, index);
  if (missing > 0) app.toast(`${integer.format(missing)} élément${s(missing)} de la vue introuvable${s(missing)} dans ce modèle : ignoré${s(missing)}.`);
}
