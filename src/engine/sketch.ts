// Esquisse sur un plan de travail horizontal : des lignes (coupes des pièces) ou un polygone (zone), point par point, avec
// accroche aux points déjà posés et aux sommets du modèle, et Maj pour tracer droit (parallèle à X ou à Z). Le tracé est en
// SVG par-dessus la vue, comme les mesures. Les points sont dans le repère du viewer, à la hauteur du plan de travail.

import { Raycaster, Vector2, Vector3 } from 'three';
import type { Viewer } from './Viewer.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SNAP_PIXELS = 12;

export type SketchMode = 'lines' | 'polygon';

/** Ce que l'esquisse lit de la vue : le Viewer, ou la scène de l'étude de site (sans modèle, `pick` rend null). */
export type SketchHost = Pick<Viewer, 'renderer' | 'camera' | 'afterRender' | 'toScreen' | 'pick' | 'model'>;

/** Le point où un rayon rencontre le plan horizontal y = `height`, ou null s'il ne le rencontre pas devant lui. */
export function planePoint(origin: Vector3, direction: Vector3, height: number): Vector3 | null {
  if (Math.abs(direction.y) < 1e-9) return null;
  const t = (height - origin.y) / direction.y;
  return t > 0 ? origin.clone().addScaledVector(direction, t) : null;
}

/** Le point `to` ramené sur la parallèle à X ou à Z qui passe par `from` (la plus proche). */
export function lockAxis(from: Vector3, to: Vector3): Vector3 {
  return Math.abs(to.x - from.x) >= Math.abs(to.z - from.z) ? new Vector3(to.x, from.y, from.z) : new Vector3(from.x, from.y, to.z);
}

/** Le candidat le plus proche du curseur à l'écran, à moins de `tolerance` pixels, ou null. */
export function nearest(cursor: { x: number; y: number }, candidates: readonly { x: number; y: number; point: Vector3 }[], tolerance = SNAP_PIXELS): Vector3 | null {
  let best: Vector3 | null = null, bestDistance = tolerance;
  for (const { x, y, point } of candidates) {
    const distance = Math.hypot(x - cursor.x, y - cursor.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

export class Sketch {
  mode: SketchMode | null = null;
  /** Hauteur du plan de travail (repère du viewer). */
  height = 0;
  readonly lines: [Vector3, Vector3][] = [];
  polygon: Vector3[] = [];
  /** Polygones à montrer en pointillés pendant l'esquisse (les zones déjà tracées). */
  shapes: { points: Vector3[]; label: string }[] = [];
  onChange: () => void = () => {};
  /** Un polygone vient d'être fermé (clic sur son premier point). */
  onPolygon: (points: Vector3[]) => void = () => {};

  private readonly viewer: SketchHost;
  private readonly svg: SVGSVGElement;
  private pending: Vector3 | null = null;
  private hover: { point: Vector3; snapped: boolean } | null = null;
  private readonly raycaster = new Raycaster();
  private readonly screen = { x: 0, y: 0 };
  private queued = false;

  constructor(viewer: SketchHost, root: HTMLElement, surface: HTMLElement) {
    this.viewer = viewer;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('measure-svg', 'sketch-svg');
    root.append(this.svg);
    viewer.afterRender.add(() => this.draw());
    surface.addEventListener('pointermove', (event) => {
      if (!this.mode || event.buttons !== 0 || !(event.target instanceof HTMLCanvasElement) || this.queued) return;
      this.queued = true;
      requestAnimationFrame(() => {
        this.queued = false;
        this.hover = this.pointAt(event.clientX, event.clientY, event.shiftKey);
        this.draw();
      });
    });
  }

  get hint(): string {
    return this.mode === 'polygon'
      ? 'Cliquez les sommets de la zone ; cliquez le premier point pour la fermer. Maj : tracé droit. Échap : terminer.'
      : 'Cliquez deux points par ligne ; chaque ligne doit traverser les éléments de part en part. Maj : tracé droit. Échap : terminer.';
  }

  start(mode: SketchMode, height: number): void {
    this.mode = mode;
    this.height = height;
    this.pending = null;
    this.polygon = [];
    this.draw();
  }

  stop(): void {
    this.mode = null;
    this.pending = null;
    this.hover = null;
    this.polygon = [];
    this.draw();
  }

  clearLines(): void {
    this.lines.length = 0;
    this.pending = null;
    this.draw();
    this.onChange();
  }

  /** Clic dans la vue pendant l'esquisse. */
  click(clientX: number, clientY: number, lock: boolean): void {
    const point = this.pointAt(clientX, clientY, lock)?.point;
    if (!point || !this.mode) return;
    if (this.mode === 'lines') {
      if (!this.pending) this.pending = point;
      else if (this.pending.distanceTo(point) > 1e-6) {
        this.lines.push([this.pending, point]);
        this.pending = null;
        this.onChange();
      }
    } else {
      const first = this.polygon[0];
      if (first && this.polygon.length >= 3 && first.distanceTo(point) < 1e-9) {
        const points = this.polygon;
        this.polygon = [];
        this.onPolygon(points);
      } else if (!this.polygon.some((existing) => existing.distanceTo(point) < 1e-9)) this.polygon.push(point);
      this.onChange();
    }
    this.draw();
  }

  /** Le point du plan de travail sous le curseur, accroché à un point posé ou à un sommet du modèle s'il est tout près. */
  private pointAt(clientX: number, clientY: number, lock: boolean): { point: Vector3; snapped: boolean } | null {
    const viewer = this.viewer;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const cursor = { x: clientX - rect.left, y: clientY - rect.top };
    this.raycaster.setFromCamera(new Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1), viewer.camera);
    const candidates: { x: number; y: number; point: Vector3 }[] = [];
    const add = (point: Vector3) => {
      if (viewer.toScreen(point, this.screen)) candidates.push({ x: this.screen.x, y: this.screen.y, point: new Vector3(point.x, this.height, point.z) });
    };
    for (const line of this.lines) line.forEach(add);
    this.polygon.forEach(add);
    if (this.pending) add(this.pending);
    const hit = viewer.pick(clientX, clientY);
    const model = viewer.model;
    if (hit && model && !hit.cap) {
      const corners = [new Vector3(), new Vector3(), new Vector3()];
      model.triangle(hit.chunk, hit.tri, corners[0], corners[1], corners[2]);
      corners.forEach(add);
    }
    const snapped = nearest(cursor, candidates);
    let point = snapped ?? planePoint(this.raycaster.ray.origin, this.raycaster.ray.direction, this.height);
    if (!point) return null;
    const from = this.mode === 'polygon' ? this.polygon[this.polygon.length - 1] : this.pending;
    if (lock && from && !snapped) point = lockAxis(from, point);
    return { point, snapped: snapped !== null };
  }

  private draw(): void {
    const nodes: SVGElement[] = [];
    const at = (point: Vector3): [number, number] | null => (this.viewer.toScreen(point, this.screen) ? [this.screen.x, this.screen.y] : null);
    const node = (tag: string, className: string, attributes: Record<string, string>) => {
      const element = document.createElementNS(SVG_NS, tag);
      element.setAttribute('class', className);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      nodes.push(element);
    };
    const path = (points: Vector3[], closed: boolean, className: string) => {
      const screen = points.map(at);
      if (screen.length < 2 || screen.some((xy) => xy === null)) return;
      const list = (closed ? [...screen, screen[0]] : screen).map((xy) => `${xy![0].toFixed(1)},${xy![1].toFixed(1)}`);
      node('polyline', className, { points: list.join(' ') });
    };
    const dot = (point: Vector3, className: string) => {
      const xy = at(point);
      if (xy) node('circle', className, { r: '4', cx: xy[0].toFixed(1), cy: xy[1].toFixed(1) });
    };
    for (const shape of this.mode ? this.shapes : []) path(shape.points, true, 'sketch-shape');
    for (const line of this.lines) path(line, false, 'measure-line');
    if (this.mode === 'polygon') path(this.polygon, false, 'measure-line');
    const from = this.mode === 'polygon' ? this.polygon[this.polygon.length - 1] : this.pending;
    if (this.mode && from && this.hover) path([from, this.hover.point], false, 'measure-line pending');
    for (const point of [...this.lines.flat(), ...(this.mode === 'polygon' ? this.polygon : []), ...(this.pending ? [this.pending] : [])]) dot(point, 'measure-dot');
    if (this.mode && this.hover) dot(this.hover.point, `measure-dot hover${this.hover.snapped ? ' snapped' : ''}`);
    this.svg.replaceChildren(...nodes);
  }
}
