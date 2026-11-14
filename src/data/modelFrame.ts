// Repères (voir docs/superpowers/plans/2026-11-14-roadmap/README.md, « Coordinates, said once »).
//
// - Repère du viewer : celui du modèle recentré, `Model.offset` retranché (précision des flottants), Y vers le haut.
// - Repère du modèle : celui que le GLB donne, en mètres, Y vers le haut. C'est celui de tout ce qui sort du viewer en
//   mètres (vues, plans de coupe, niveaux) : il ne dépend pas du décalage choisi à l'ouverture.
// - Repère source : celui de l'IFC ou du .rvt, Z vers le haut : (x, y, z) source devient (x, z, −y) dans le GLB.

export type Vec3 = [number, number, number];

/** Un point du repère du viewer dans celui du modèle. */
export const toModelPoint = (p: readonly number[], offset: readonly number[]): Vec3 => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];

/** Un point du repère du modèle dans celui du viewer. */
export const toViewerPoint = (p: readonly number[], offset: readonly number[]): Vec3 => [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]];

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Un plan `n·p + c = 0` (convention de three.js) : sa constante dans le repère du modèle. La normale ne change pas, une
 * translation ne tourne rien.
 */
export const planeToModel = (normal: readonly number[], constant: number, offset: readonly number[]): number => constant - dot(normal, offset);

/** La constante d'un plan du repère du modèle dans celui du viewer. */
export const planeToViewer = (normal: readonly number[], constant: number, offset: readonly number[]): number => constant + dot(normal, offset);

/** Repère du modèle (Y vers le haut) vers le repère source (Z vers le haut). */
export const yUpToZUp = (p: readonly number[]): Vec3 => [p[0], -p[2], p[1]];

/** Repère source (Z vers le haut) vers le repère du modèle (Y vers le haut). */
export const zUpToYUp = (p: readonly number[]): Vec3 => [p[0], p[2], -p[1]];
