import type { Vector3 } from 'three';

/**
 * Plans proche et lointain de la caméra autour de la sphère englobante du modèle.
 *
 * Les plans se mesurent le long de l'axe de vue, pas en ligne droite : une maquette poussée
 * dans un coin de l'écran a son centre de biais, moins profond que sa distance. Le point le plus
 * proche est à `profondeur du centre − rayon`.
 *
 * Le plan proche est aussi loin que possible, pour la précision en profondeur, sans couper ce
 * que l'on regarde. Caméra dans la maquette : il se resserre avec la distance au point de pivot.
 * `direction` est l'axe de vue, normé.
 */
export function clipRange(camera: Vector3, direction: Vector3, center: Vector3, radius: number, pivotDistance: number): { near: number; far: number } {
  const depth = (center.x - camera.x) * direction.x + (center.y - camera.y) * direction.y + (center.z - camera.z) * direction.z;
  // Le lointain reste borné par la distance en ligne droite : toujours au moins la profondeur.
  const far = (camera.distanceTo(center) + radius) * 1.02;
  const inside = Math.max(far * 1e-6, Math.min(far * 1e-4, pivotDistance * 0.05));
  const near = Math.max(inside, (depth - radius) * 0.98);
  return { near, far };
}
