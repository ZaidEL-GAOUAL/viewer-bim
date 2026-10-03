import { Plane, Vector3, type Box3 } from 'three';

export type Axis = 0 | 1 | 2;
export const AXES: readonly Axis[] = [0, 1, 2];

const UNIT = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
// Un plan désactivé est repoussé très loin : le nombre de plans vu par les shaders ne change
// jamais pendant qu'une coupe est active, donc aucun shader n'est recompilé en déplaçant ou
// en activant un plan supplémentaire.
const FAR_AWAY = 1e9;

/** Trois plans de coupe alignés sur les axes, chacun avec une position et un sens. */
export class Sections {
  /** Plans au format three.js : la partie conservée est du côté de la normale. */
  readonly planes: Plane[] = [new Plane(), new Plane(), new Plane()];
  readonly enabled = [false, false, false];
  readonly position = [0, 0, 0];
  /** Faux : on retire ce qui est au-delà de la position. Vrai : ce qui est en deçà. */
  readonly flipped = [false, false, false];
  readonly min = [0, 0, 0];
  readonly max = [1, 1, 1];
  /** Remplir la section des solides coupés. */
  fill = true;

  constructor() {
    for (const axis of AXES) this.update(axis);
  }

  get active(): boolean {
    return this.enabled[0] || this.enabled[1] || this.enabled[2];
  }

  /** Adapte les bornes au modèle chargé et replace chaque plan au milieu. */
  /** Élargit les bornes à une nouvelle boîte du modèle sans toucher aux plans en place. */
  extendBounds(box: Box3): void {
    const min = box.min.toArray();
    const max = box.max.toArray();
    for (const axis of AXES) {
      this.min[axis] = Math.min(this.min[axis], min[axis]);
      this.max[axis] = Math.max(this.max[axis], max[axis]);
      this.update(axis);
    }
  }

  setBounds(box: Box3): void {
    const min = box.min.toArray();
    const max = box.max.toArray();
    for (const axis of AXES) {
      this.min[axis] = min[axis];
      this.max[axis] = max[axis];
      this.position[axis] = (min[axis] + max[axis]) / 2;
      this.enabled[axis] = false;
      this.flipped[axis] = false;
      this.update(axis);
    }
  }

  set(axis: Axis, change: { enabled?: boolean; position?: number; flipped?: boolean }): void {
    if (change.enabled !== undefined) this.enabled[axis] = change.enabled;
    if (change.flipped !== undefined) this.flipped[axis] = change.flipped;
    if (change.position !== undefined) {
      this.position[axis] = Math.max(this.min[axis], Math.min(this.max[axis], change.position));
    }
    this.update(axis);
  }

  private update(axis: Axis): void {
    const plane = this.planes[axis];
    if (!this.enabled[axis]) {
      plane.normal.copy(UNIT[axis]);
      plane.constant = FAR_AWAY;
    } else if (this.flipped[axis]) {
      plane.normal.copy(UNIT[axis]);
      plane.constant = -this.position[axis];
    } else {
      plane.normal.copy(UNIT[axis]).negate();
      plane.constant = this.position[axis];
    }
  }

  /** Vrai si le point est retiré par au moins un plan actif. */
  readonly isClipped = (x: number, y: number, z: number): boolean => {
    for (const axis of AXES) {
      if (!this.enabled[axis]) continue;
      const { normal, constant } = this.planes[axis];
      if (normal.x * x + normal.y * y + normal.z * z + constant < 0) return true;
    }
    return false;
  };
}
