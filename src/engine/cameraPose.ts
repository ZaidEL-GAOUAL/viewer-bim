// Poses de caméra et transition entre deux poses : parties pures du déplacement vers une vue enregistrée, sans
// rendu ni DOM, pour être testées seules (voir Viewer.setCameraPose pour le branchement).

import { Vector3 } from 'three';

/** Ce qui définit une caméra du viewer : où elle est, ce qu'elle regarde, son haut, son champ ou sa fenêtre. */
export interface PoseState {
  position: Vector3;
  /** Point autour duquel la caméra tourne. */
  target: Vector3;
  up: Vector3;
  /** Perspective : champ vertical, en degrés. */
  fov: number;
  /** Projection parallèle : demi-hauteur de la fenêtre, en mètres. */
  halfHeight: number;
}

export const clonePose = (pose: PoseState): PoseState => ({
  position: pose.position.clone(), target: pose.target.clone(), up: pose.up.clone(), fov: pose.fov, halfHeight: pose.halfHeight,
});

/** Départ et arrivée lents, milieu rapide : le mouvement ne démarre ni ne s'arrête d'un coup. */
export const easeInOut = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * Interpolation de `a` à `b` (t de 0 à 1, déjà adouci), écrite dans `out`. Position, pivot et champ varient
 * linéairement ; le haut varie linéairement puis se renormalise (un haut qui se retournerait de 180° garde le sien).
 */
export function interpolatePose(a: PoseState, b: PoseState, t: number, out: PoseState): PoseState {
  out.position.lerpVectors(a.position, b.position, t);
  out.target.lerpVectors(a.target, b.target, t);
  out.up.lerpVectors(a.up, b.up, t);
  if (out.up.lengthSq() < 1e-12) out.up.copy(b.up);
  out.up.normalize();
  out.fov = a.fov + (b.fov - a.fov) * t;
  out.halfHeight = a.halfHeight + (b.halfHeight - a.halfHeight) * t;
  return out;
}

/** Deux poses sont-elles les mêmes à l'œil ? Alors il n'y a rien à animer. */
export function samePose(a: PoseState, b: PoseState, scale: number): boolean {
  const near = scale * 1e-4;
  return a.position.distanceTo(b.position) < near && a.target.distanceTo(b.target) < near && a.up.angleTo(b.up) < 1e-4
    && Math.abs(a.fov - b.fov) < 1e-3 && Math.abs(a.halfHeight - b.halfHeight) < near;
}

const VERTICAL = new Vector3(0, 1, 0);

/**
 * Le haut qu'une caméra reçoit : la verticale quand la vue enregistrée n'a pas de roulis (le haut de Revit est alors la
 * verticale projetée perpendiculairement au regard), pour que l'orbite garde son axe vertical ; le haut enregistré
 * sinon (une vue de dessus, ou une caméra penchée). `direction` est unitaire.
 */
export function cameraUp(up: Vector3, direction: Vector3): Vector3 {
  if (Math.abs(direction.y) > 0.99) return up.clone();
  const rollFree = VERTICAL.clone().addScaledVector(direction, -VERTICAL.dot(direction)).normalize();
  return up.angleTo(rollFree) < (2 * Math.PI) / 180 ? VERTICAL.clone() : up.clone();
}
