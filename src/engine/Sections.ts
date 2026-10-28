import { Box3, Plane, Vector3 } from 'three';

export type Axis = 0 | 1 | 2;

/** Une boîte de coupe : coins avant rotation, et rotation autour de la verticale (degrés). */
export interface BoxCut {
  min: [number, number, number];
  max: [number, number, number];
  rotation: number;
}
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
  /**
   * Boîte de coupe (celle d'une vue enregistrée) : six plans, une tranche par axe, autour d'un centre et tournée autour de
   * la verticale. Elle s'ajoute aux trois plans : on peut couper davantage par-dessus. Les plans de la boîte ne se
   * saisissent pas dans la vue.
   */
  readonly boxPlanes: Plane[] = Array.from({ length: 6 }, () => new Plane());
  /** La boîte est posée et active ; sinon elle ne coupe rien (et ses plans ne sont pas rendus). */
  boxEnabled = false;
  private box: BoxCut | null = null;
  private readonly allPlanes: Plane[] = [...this.planes, ...this.boxPlanes];

  constructor() { for (const axis of AXES) this.update(axis); }
  get active(): boolean { return this.enabled.some(Boolean) || this.boxEnabled; }

  /** La boîte posée (active ou non), dans le repère du modèle recentré ; null s'il n'y en a pas. */
  get boxCut(): BoxCut | null { return this.box; }

  /**
   * Pose la boîte de coupe d'une vue (null la retire). `rotation` : degrés autour de Y, positive dans le sens
   * anti-horaire vu d'en haut. Le côté conservé est l'intérieur de la boîte.
   */
  setBox(box: BoxCut | null): void {
    if (box === null) {
      this.box = null;
      this.boxEnabled = false;
      return;
    }
    const values = [...box.min, ...box.max, box.rotation];
    if (!values.every(Number.isFinite) || box.min.some((x, axis) => x > box.max[axis])) throw new Error('Boîte de coupe invalide.');
    this.box = { min: [...box.min], max: [...box.max], rotation: box.rotation };
    this.boxEnabled = true;
    this.updateBox();
  }

  /** Active ou désactive la boîte posée sans la retirer. */
  setBoxEnabled(enabled: boolean): void {
    this.boxEnabled = enabled && this.box !== null;
  }

  /**
   * Les plans qui coupent : les trois plans libres, puis ceux de la boîte quand elle est active. Le tableau est réutilisé :
   * un plan désactivé reste dedans, repoussé au loin (voir `planeEnabled`).
   */
  get clipPlanes(): Plane[] {
    return this.boxEnabled ? this.allPlanes : this.planes;
  }

  /** Le plan d'indice `index` de `clipPlanes` coupe-t-il quelque chose ? */
  planeEnabled(index: number): boolean {
    return index < 3 ? this.enabled[index] : this.boxEnabled;
  }

  /** Les six plans de la boîte : normales vers l'intérieur, comme tout plan conservant son côté positif. */
  private updateBox(): void {
    const box = this.box;
    if (!box) return;
    const centre = new Vector3((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
    const half = [(box.max[0] - box.min[0]) / 2, (box.max[1] - box.min[1]) / 2, (box.max[2] - box.min[2]) / 2];
    const angle = (box.rotation * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
    // Rotation autour de Y d'un angle φ : x → (cos, 0, −sin), z → (sin, 0, cos).
    const axes = [new Vector3(c, 0, -s), new Vector3(0, 1, 0), new Vector3(s, 0, c)];
    axes.forEach((axis, i) => {
      const along = axis.dot(centre);
      // Garder (p − c)·axe ≤ demi-côté, puis ≥ −demi-côté.
      this.boxPlanes[2 * i].normal.copy(axis).negate();
      this.boxPlanes[2 * i].constant = half[i] + along;
      this.boxPlanes[2 * i + 1].normal.copy(axis);
      this.boxPlanes[2 * i + 1].constant = half[i] - along;
    });
  }

  setBounds(box: Box3): void {
    this.box = null;
    this.boxEnabled = false;
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

  /**
   * Le modèle a grandi (lecture par morceaux) : les bornes suivent sa nouvelle boîte, sans toucher à un plan que
   * l'utilisateur a réglé. Un plan au repos reste au milieu du modèle ; la boîte de coupe d'une vue n'existe pas encore.
   */
  growBounds(box: Box3): void {
    this.bounds.copy(box);
    if (this.bounds.isEmpty()) this.bounds.set(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
    for (const axis of AXES) {
      this.projectBounds(axis);
      if (this.enabled[axis]) continue;
      this.position[axis] = (this.min[axis] + this.max[axis]) / 2;
      this.bounds.getCenter(this.pivots[axis]);
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
    if (this.boxEnabled) {
      for (const { normal, constant } of this.boxPlanes) {
        if (normal.x * x + normal.y * y + normal.z * z + constant < 0) return true;
      }
    }
    return false;
  };
}
