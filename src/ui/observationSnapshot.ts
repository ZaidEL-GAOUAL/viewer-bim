// L'image d'un point de vue d'observation : la maquette vue de sa caméra, un repère rouge sur le point qu'elle désigne (au plus
// 1 500 px de côté, fond blanc, comme l'image de la vue de l'utilisateur). Rien de ce qui est à l'écran ne change.

import { PerspectiveCamera, Vector3, type Camera } from 'three';
import type { BcfCamera } from '../data/bcf.ts';
import { toViewerPoint, zUpToYUp, type Vec3 } from '../data/modelFrame.ts';
import { capturePng } from '../engine/capture.ts';
import type { App } from './App.ts';
import { withPin } from './photo.ts';

/** Où le point (repère du modèle, Z vers le haut) tombe dans l'image de cette caméra, en fractions de sa largeur et de sa hauteur ; null hors champ. */
export function markerOf(app: App, camera: Camera, point: Vec3): { x: number; y: number } | null {
  const ndc = new Vector3(...toViewerPoint(zUpToYUp(point), app.model!.offset.toArray())).project(camera);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1 ? { x: (ndc.x + 1) / 2, y: (1 - ndc.y) / 2 } : null;
}

/** L'image vue de `camera` (une perspective), avec le repère de `point` s'il est dans le champ ; undefined si la capture échoue ou en mode carte. */
export async function snapshotFrom(app: App, camera: BcfCamera, point: Vec3 | undefined): Promise<Blob | undefined> {
  if (app.mapOpen || !app.model || camera.kind !== 'perspective') return undefined;
  const { width, height } = app.viewer.size;
  const scale = Math.min(1, 1500 / Math.max(width, height));
  const [w, h] = [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  const source = app.viewer.camera;
  const view = new PerspectiveCamera(camera.fieldOfView ?? 60, w / h, source.near, source.far);
  const offset = app.model.offset.toArray();
  view.position.set(...toViewerPoint(zUpToYUp(camera.viewPoint), offset));
  view.up.set(...zUpToYUp(camera.up));
  view.lookAt(view.position.clone().add(new Vector3(...zUpToYUp(camera.direction))));
  view.layers.mask = source.layers.mask;
  view.updateMatrixWorld(true);
  try {
    const image = await capturePng(app.viewer, w, h, { background: '#ffffff', camera: view });
    const marker = point ? markerOf(app, view, point) : null;
    return marker ? await withPin(image, marker.x, marker.y, '#dc2626') : image;
  } catch {
    return undefined;
  }
}
