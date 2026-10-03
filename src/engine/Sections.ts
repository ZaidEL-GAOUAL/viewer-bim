import { Box3, Plane, Vector3 } from 'three';

export type Axis = 0 | 1 | 2;
export const AXES: readonly Axis[] = [0, 1, 2];
const UNIT = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const FAR_AWAY = 1e9;

/** Trois plans indépendants, initialement alignés sur X/Y/Z, déplaçables et orientables. */
export class Sections {
  /** Le côté conservé est le côté positif de la normale three.js. */
  readonly planes: Plane[] = [new Plane(), new Plane(), new Plane()];
  readonly normals = UNIT.map((normal) => normal.clone());
  /** Stable gesture pivots: rotation never reprojects them onto the model centre. */
  private readonly pivots = UNIT.map(() => new Vector3());
  readonly enabled = [false, false, false];
  /** Distance à l'origine mesurée suivant normals[axis]. */
  readonly position = [0, 0, 0];
  readonly flipped = [false, false, false];
  /** Bornes du modèle projetées suivant la normale actuelle de chaque plan. */
  readonly min = [0, 0, 0];
  readonly max = [1, 1, 1];
  readonly bounds = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
  fill = true;

  constructor() { for (const axis of AXES) this.update(axis); }
  get active(): boolean { return this.enabled.some(Boolean); }

  setBounds(box: Box3): void {
    this.bounds.copy(box);
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    for (const axis of AXES) {
      this.normals[axis].copy(UNIT[axis]);
      this.projectBounds(axis);
      this.position[axis] = (this.min[axis] + this.max[axis]) / 2;
      this.bounds.getCenter(this.pivots[axis]);
      this.enabled[axis] = false;
      this.flipped[axis] = false;
      this.update(axis);
    }
  }

  set(axis: Axis, change: { enabled?: boolean; position?: number; flipped?: boolean }): void {
    if (change.enabled !== undefined) this.enabled[axis] = change.enabled;
    if (change.flipped !== undefined) this.flipped[axis] = change.flipped;
    if (change.position !== undefined && Number.isFinite(change.position)) {
      const position = Math.max(this.min[axis], Math.min(this.max[axis], change.position));
      this.pivots[axis].addScaledVector(this.normals[axis], position - this.position[axis]);
      this.position[axis] = position;
    }
    this.update(axis);
  }

  /** Modifie réellement l'équation du plan, en conservant son côté visible. */
  setTransform(axis: Axis, point: Vector3, normal: Vector3): void {
    if (![...point.toArray(), ...normal.toArray()].every(Number.isFinite) || normal.lengthSq() < 1e-20) throw new Error('Plan de coupe invalide.');
    this.normals[axis].copy(normal).normalize();
    this.pivots[axis].copy(point);
    this.projectBounds(axis);
    this.position[axis] = this.normals[axis].dot(point);
    this.update(axis);
  }

  resetOrientation(axis: Axis): void {
    this.normals[axis].copy(UNIT[axis]);
    this.projectBounds(axis);
    this.position[axis] = this.normals[axis].dot(this.pivots[axis]);
    this.update(axis);
  }

  /** Pivot conservé entre les gestes et les changements de normale. */
  origin(axis: Axis, target: Vector3): Vector3 {
    return target.copy(this.pivots[axis]);
  }

  /** Rectangle dans le plan couvrant la projection du modèle, même après rotation. */
  outline(axis: Axis): Vector3[] {
    const normal = this.normals[axis], center = this.origin(axis, new Vector3());
    const reference = Math.abs(normal.y) < .9 ? UNIT[1] : UNIT[0];
    const u = new Vector3().crossVectors(reference, normal).normalize();
    const v = new Vector3().crossVectors(normal, u).normalize();
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const point = new Vector3();
    for (const x of [this.bounds.min.x, this.bounds.max.x]) for (const y of [this.bounds.min.y, this.bounds.max.y]) for (const z of [this.bounds.min.z, this.bounds.max.z]) {
      point.set(x, y, z).sub(center);
      const pu = point.dot(u), pv = point.dot(v);
      minU = Math.min(minU, pu); maxU = Math.max(maxU, pu); minV = Math.min(minV, pv); maxV = Math.max(maxV, pv);
    }
    return [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]].map(([a, b]) => center.clone().addScaledVector(u, a).addScaledVector(v, b));
  }

  private projectBounds(axis: Axis): void {
    const center = this.bounds.getCenter(new Vector3()), size = this.bounds.getSize(new Vector3()).multiplyScalar(.5), n = this.normals[axis];
    const half = Math.abs(n.x) * size.x + Math.abs(n.y) * size.y + Math.abs(n.z) * size.z;
    const middle = center.dot(n);
    this.min[axis] = middle - half; this.max[axis] = middle + half;
  }

  private update(axis: Axis): void {
    const plane = this.planes[axis];
    plane.normal.copy(this.normals[axis]);
    if (!this.enabled[axis]) { plane.constant = FAR_AWAY; return; }
    const sign = this.flipped[axis] ? 1 : -1;
    plane.normal.multiplyScalar(sign);
    plane.constant = -sign * this.position[axis];
  }

  readonly isClipped = (x: number, y: number, z: number): boolean => {
    for (const axis of AXES) {
      if (!this.enabled[axis]) continue;
      const { normal, constant } = this.planes[axis];
      if (normal.x * x + normal.y * y + normal.z * z + constant < 0) return true;
    }
    return false;
  };
}
