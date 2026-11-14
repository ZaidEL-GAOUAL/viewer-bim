// Les lignes de coupe d'un plan, reliées en polylignes élément par élément : ce que l'impression PDF dessine en vectoriel
// et ce que l'export DXF écrit. Les points sont dans le repère 2D du plan (`planeBasis`) ; le repère du plan est celui du
// viewer (recentré) quand le plan l'est.

import { Vector3, type Plane } from 'three';
import { yUpToZUp } from '../data/modelFrame.ts';
import { CUT_BUDGET, chainLoops, cutJob, planeBasis, type CutModel, type CutOptions, type ElementCut } from './sectionCut.ts';
import type { Sections } from './Sections.ts';

/** Deux extrémités de segments à moins de 0,1 mm sont le même point (comme l'affichage de la coupe). */
const CHAIN_TOLERANCE = 1e-4;

export interface CutPath {
  element: number;
  /** x, y par point ; une boucle fermée ne répète pas son premier point. */
  points: Float32Array;
  closed: boolean;
  /** Boucle fermée d'un solide fermé : trait plein ; sinon, tirets. */
  solid: boolean;
}

/**
 * Les polylignes de coupe du plan, par tranches (avancement de 0 à 1). Les éléments coupés sont ceux de `options.filter`,
 * par défaut ceux qui sont affichés.
 */
export function* cutPaths(model: CutModel, plane: Plane, options: CutOptions = {}): Generator<number, CutPath[], unknown> {
  const cuts: ElementCut[] = [];
  for (const progress of cutJob(model, plane, options, cuts)) yield progress * 0.8;
  const budget = options.budget ?? CUT_BUDGET;
  const paths: CutPath[] = [];
  let work = 0;
  for (let i = 0; i < cuts.length; i++) {
    const { element, points } = cuts[i];
    const open = model.state.isOpen(element);
    for (const loop of chainLoops(points, CHAIN_TOLERANCE)) paths.push({ element, points: loop.points, closed: loop.closed, solid: loop.closed && !open });
    work += 8 + 2 * points.length;
    if (work >= budget) {
      work = 0;
      yield 0.8 + (0.2 * (i + 1)) / cuts.length;
    }
  }
  return paths;
}

/**
 * Les plans de coupe actifs que la caméra regarde de face : leur normale (côté conservé) est celle de la direction de vue,
 * à moins d'environ 2,5°. Dans un plan d'étage, c'est le plan du haut de la boîte, pas celui du bas ; dans une coupe, le
 * plan de coupe vu depuis le côté retiré.
 */
export function facingPlanes(sections: Sections, direction: Vector3): Plane[] {
  return sections.clipPlanes.filter((plane, k) => sections.planeEnabled(k) && plane.normal.dot(direction) > 0.999);
}

/**
 * Des points 2D d'un plan de coupe (repère du viewer, voir `planeBasis`) aux coordonnées de CAO : retour au repère du modèle
 * d'origine (`offset` rajouté), puis axes de CAO (Z vers le haut : (x, y, z) du modèle en Y vers le haut devient (x, −z, y)).
 * - Plan horizontal : le dessin est dans XY à sa taille réelle, à l'altitude du plan (le Z de sortie).
 * - Autre plan : mis à plat dans XY avec son propre repère, X vers la droite de la vue (face à la vue, la droite de l'écran
 *   est −u : le dessin n'est pas en miroir), Y l'altitude réelle, Z = 0.
 */
export function cadFrame(plane: Plane, offset: Vector3): { horizontal: boolean; toCad(x: number, y: number): [number, number, number] } {
  const { origin, u, v } = planeBasis(plane);
  const horizontal = Math.abs(plane.normal.y) > 0.999;
  const point = new Vector3();
  return {
    horizontal,
    toCad(x, y) {
      point.copy(origin).addScaledVector(u, x).addScaledVector(v, y).add(offset);
      return horizontal ? yUpToZUp(point.toArray()) : [-point.dot(u), point.dot(v), 0];
    },
  };
}
