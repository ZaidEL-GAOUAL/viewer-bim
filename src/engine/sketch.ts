// Esquisse sur un plan de travail horizontal : des coupes (droites, ou tracé libre point par point) ou un polygone (zone).
// L'aimant est visible et facultatif (`snap`) : il attrape les points déjà posés, puis les sommets, les milieux et les arêtes
// vives des éléments, et le dit au curseur ; Alt tenu s'en passe, Maj trace droit (parallèle à X ou à Z). Une coupe droite
// est la ligne entière par ses deux points : avec `bounds`, elle est prolongée à travers cette boîte. Le tracé est en SVG
// par-dessus la vue, comme les mesures. Les points sont dans le repère du viewer, à la hauteur du plan de travail.

import { Box3, Raycaster, Vector2, Vector3 } from 'three';
import { weld, type MeshPart } from './meshMath.ts';
import type { Viewer } from './Viewer.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SNAP_PIXELS = 12;
/** Deux faces voisines dont les normales s'écartent de plus de 20° bordent une arête vive (pas la diagonale d'une face). */
const SHARP = Math.cos((20 * Math.PI) / 180);

export type SketchMode = 'lines' | 'free' | 'polygon';

/** Ce que l'aimant attrape, du plus fort au plus faible : un point posé, un sommet, le milieu ou un point d'une arête. */
export type SnapKind = 'point' | 'sommet' | 'milieu' | 'arête';
const RANK: Record<SnapKind, number> = { point: 0, sommet: 1, milieu: 2, 'arête': 3 };

export interface SnapCandidate {
  point: Vector3;
  kind: SnapKind;
}

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

/**
 * Le point retenu sous le curseur (`raw`, sur le plan de travail) : avec l'aimant, le candidat à moins de `tolerance` (en
 * plan) du rang le plus fort, le plus proche à rang égal ; sinon `raw`. Maj (`lock`) le ramène ensuite sur l'horizontale ou
 * la verticale de `from`. `label` : ce que le curseur affiche (ce qui a été attrapé, « horizontal », « vertical » ou rien).
 */
export function resolvePoint(raw: Vector3, candidates: readonly SnapCandidate[], options: { snap: boolean; tolerance: number; from?: Vector3 | null; lock?: boolean }): { point: Vector3; label: string } {
  let best: SnapCandidate | null = null, bestRank = Infinity, bestDistance = Infinity;
  if (options.snap) {
    for (const candidate of candidates) {
      const distance = Math.hypot(candidate.point.x - raw.x, candidate.point.z - raw.z), rank = RANK[candidate.kind];
      if (distance > options.tolerance || rank > bestRank || (rank === bestRank && distance >= bestDistance)) continue;
      best = candidate;
      bestRank = rank;
      bestDistance = distance;
    }
  }
  const point = (best?.point ?? raw).clone();
  if (options.lock && options.from) {
    const locked = lockAxis(options.from, point);
    return { point: locked, label: locked.z === options.from.z ? 'horizontal' : 'vertical' };
  }
  return { point, label: best?.kind ?? '' };
}

/**
 * La ligne par `a` et `b` (en plan), prolongée jusqu'aux bords de `box` et un peu au-delà (5 % de sa diagonale en plan,
 * 0,5 m au moins), jamais plus courte que [a, b]. Une ligne qui ne passe pas dans la boîte est rendue telle quelle.
 */
export function extendAcross(a: Vector3, b: Vector3, box: Box3): [Vector3, Vector3] {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (box.isEmpty() || Math.hypot(dx, dz) < 1e-12) return [a.clone(), b.clone()];
  const margin = Math.max(0.5, 0.05 * Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z));
  let low = -Infinity, high = Infinity;
  for (const [p, d, min, max] of [[a.x, dx, box.min.x - margin, box.max.x + margin], [a.z, dz, box.min.z - margin, box.max.z + margin]]) {
    if (Math.abs(d) < 1e-12) {
      if (p < min || p > max) return [a.clone(), b.clone()];
      continue;
    }
    const t1 = (min - p) / d, t2 = (max - p) / d;
    low = Math.max(low, Math.min(t1, t2));
    high = Math.min(high, Math.max(t1, t2));
  }
  if (!(low <= high)) return [a.clone(), b.clone()];
  const at = (t: number) => new Vector3(a.x + t * dx, a.y, a.z + t * dz);
  return [at(Math.min(low, 0)), at(Math.max(high, 1))];
}

/** Les arêtes vives d'un élément, en plan : (ax, az, bx, bz) à la suite. Les arêtes entre deux faces presque coplanaires n'y sont pas. */
export function sharpEdges(parts: readonly MeshPart[]): number[] {
  const { ids, vertexCount } = weld([...parts]);
  const edges = new Map<number, { n: number[]; faces: number; sharp: boolean; xz: number[] }>();
  let c = 0;
  for (const { positions: p, index, start, count } of parts) {
    for (let k = start; k + 2 < start + count; k += 3, c += 3) {
      const v = [index[k] * 3, index[k + 1] * 3, index[k + 2] * 3];
      const ux = p[v[1]] - p[v[0]], uy = p[v[1] + 1] - p[v[0] + 1], uz = p[v[1] + 2] - p[v[0] + 2];
      const wx = p[v[2]] - p[v[0]], wy = p[v[2] + 1] - p[v[0] + 1], wz = p[v[2] + 2] - p[v[0] + 2];
      const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
      const length = Math.hypot(n[0], n[1], n[2]);
      if (length === 0) continue;
      n.forEach((value, i) => (n[i] = value / length));
      for (let j = 0; j < 3; j++) {
        const i0 = ids[c + j], i1 = ids[c + (j + 1) % 3];
        if (i0 === i1) continue;
        const key = Math.min(i0, i1) * vertexCount + Math.max(i0, i1);
        const seen = edges.get(key);
        if (seen) {
          seen.faces++;
          if (seen.n[0] * n[0] + seen.n[1] * n[1] + seen.n[2] * n[2] < SHARP) seen.sharp = true;
        } else {
          const a = v[j], b = v[(j + 1) % 3];
          edges.set(key, { n, faces: 1, sharp: false, xz: [p[a], p[a + 2], p[b], p[b + 2]] });
        }
      }
    }
  }
  const out: number[] = [];
  for (const edge of edges.values()) if (edge.sharp || edge.faces === 1) out.push(...edge.xz);
  return out;
}

export class Sketch {
  mode: SketchMode | null = null;
  /** Hauteur du plan de travail (repère du viewer). */
  height = 0;
  readonly lines: [Vector3, Vector3][] = [];
  polygon: Vector3[] = [];
  /** Polygones à montrer en pointillés pendant l'esquisse (les zones déjà tracées). */
  shapes: { points: Vector3[]; label: string }[] = [];
  /** L'aimant (case « Aimanter ») ; Alt tenu s'en passe. */
  snap = true;
  /** Les coupes droites traversent toute cette boîte (les éléments choisis) ; null : une ligne s'arrête à ses deux points. */
  bounds: Box3 | null = null;
  /** Éléments dont les arêtes aimantent aussi hors de celui que le curseur survole (les éléments choisis). */
  elements: readonly number[] = [];
  /** Pourquoi un trait serait refusé (il est alors rouge, avec la raison, et le clic ne le pose pas), ou null. */
  check: ((from: Vector3, to: Vector3) => string | null) | null = null;
  /** Retour arrière, Échap et Entrée pilotent l'esquisse : l'outil qui la démarre le demande. */
  keyboard = false;
  /** Traits indicatifs (coupes calculées), étiquettes (numéros de pièces, noms de zones) et surfaces teintées par zone. */
  guides: [Vector3, Vector3][] = [];
  marks: { point: Vector3; label: string }[] = [];
  areas: { polygons: Vector3[][]; tone: number }[] = [];
  onChange: () => void = () => {};
  /** Un polygone vient d'être fermé (clic sur son premier point, ou Entrée). */
  onPolygon: (points: Vector3[]) => void = () => {};

  private readonly viewer: SketchHost;
  private readonly svg: SVGSVGElement;
  private pending: Vector3 | null = null;
  private hover: { point: Vector3; label: string; refusal: string | null } | null = null;
  private alt = false;
  /** Arêtes vives par élément, calculées une fois par esquisse. */
  private readonly sharp = new Map<number, number[]>();
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
        this.alt = event.altKey;
        this.hover = this.pointAt(event.clientX, event.clientY, event.shiftKey);
        this.draw();
      });
    });
    // Avant les raccourcis de l'application (inscrits après) : Échap efface d'abord le trait en cours.
    globalThis.addEventListener?.('keydown', (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!this.keyboard || event.ctrlKey || event.metaKey || target?.closest?.('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
      if (!this.key(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  }

  get hint(): string {
    if (this.mode === 'polygon') return 'Cliquez les sommets de la zone ; cliquez le premier point (ou Entrée) pour la fermer. Alt : sans aimant. Maj : tracé droit. Échap : terminer.';
    if (this.mode === 'free') return 'Tracé libre : cliquez chaque point ; chaque segment doit traverser l’élément de part en part. Cliquez de nouveau le dernier point pour finir. Retour arrière : effacer.';
    return 'Cliquez deux points par coupe ; la coupe traverse toute la sélection. Alt : sans aimant. Maj : tracé droit. Retour arrière : effacer la dernière.';
  }

  start(mode: SketchMode, height: number): void {
    this.mode = mode;
    this.height = height;
    this.pending = null;
    this.polygon = [];
    this.sharp.clear();
    this.draw();
  }

  stop(): void {
    this.mode = null;
    this.pending = null;
    this.hover = null;
    this.polygon = [];
    this.bounds = null;
    this.check = null;
    this.elements = [];
    this.keyboard = false;
    this.draw();
  }

  clearLines(): void {
    this.lines.length = 0;
    this.pending = null;
    this.draw();
    this.onChange();
  }

  removeLine(index: number): void {
    this.lines.splice(index, 1);
    this.draw();
    this.onChange();
  }

  /** Retire le dernier point du tracé en cours, sinon la dernière coupe. Vrai s'il y avait quelque chose à retirer. */
  undo(): boolean {
    if (this.mode === 'polygon') {
      if (!this.polygon.pop()) return false;
    } else if (this.pending) {
      // Tracé libre : le dernier segment revient au point d'avant.
      const last = this.lines[this.lines.length - 1];
      if (this.mode === 'free' && last?.[1].equals(this.pending)) {
        this.lines.pop();
        this.pending = last[0];
      } else this.pending = null;
    } else if (!this.lines.pop()) return false;
    this.draw();
    this.onChange();
    return true;
  }

  /** Une touche pendant l'esquisse (Retour arrière, Suppr, Échap, Entrée) : vrai si elle a servi. */
  key(key: string): boolean {
    if (!this.mode) return false;
    if (key === 'Backspace' || key === 'Delete') return this.undo();
    if (key !== 'Escape' && key !== 'Enter') return false;
    if (this.mode === 'polygon') {
      if (this.polygon.length === 0) return false;
      const points = this.polygon;
      this.polygon = [];
      if (key === 'Enter' && points.length >= 3) this.onPolygon(points);
    } else if (this.pending) this.pending = null;
    else return false;
    this.draw();
    this.onChange();
    return true;
  }

  /** Clic dans la vue pendant l'esquisse. */
  click(clientX: number, clientY: number, lock: boolean): void {
    const hit = this.pointAt(clientX, clientY, lock);
    if (!hit || !this.mode) return;
    const { point } = hit;
    if (this.mode === 'polygon') {
      const first = this.polygon[0];
      if (first && this.polygon.length >= 3 && first.distanceTo(point) < 1e-9) {
        const points = this.polygon;
        this.polygon = [];
        this.onPolygon(points);
      } else if (!this.polygon.some((existing) => existing.distanceTo(point) < 1e-9)) this.polygon.push(point);
      this.onChange();
    } else if (!this.pending) {
      this.pending = point;
    } else if (this.pending.distanceTo(point) <= 1e-6) {
      if (this.mode === 'free') this.pending = null; // le dernier point cliqué de nouveau : le tracé libre est fini
    } else if (!hit.refusal) {
      this.lines.push(this.mode === 'lines' && this.bounds ? extendAcross(this.pending, point, this.bounds) : [this.pending, point]);
      this.pending = this.mode === 'free' ? point : null;
      this.onChange();
    }
    this.hover = hit;
    this.draw();
  }

  private get from(): Vector3 | null {
    return this.mode === 'polygon' ? this.polygon[this.polygon.length - 1] ?? null : this.pending;
  }

  /** Le trait de `from` à `to` tel qu'il serait posé : prolongé pour une coupe droite. */
  private stroke(from: Vector3, to: Vector3): [Vector3, Vector3] {
    return this.mode === 'lines' && this.bounds ? extendAcross(from, to, this.bounds) : [from, to];
  }

  /** Le point du plan de travail sous le curseur, aimanté s'il y a lieu, ce qu'il dit, et pourquoi le trait jusqu'à lui serait refusé. */
  private pointAt(clientX: number, clientY: number, lock: boolean): { point: Vector3; label: string; refusal: string | null } | null {
    const viewer = this.viewer;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const onPlane = (x: number, y: number) => {
      this.raycaster.setFromCamera(new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), viewer.camera);
      return planePoint(this.raycaster.ray.origin, this.raycaster.ray.direction, this.height);
    };
    const raw = onPlane(clientX, clientY);
    if (!raw) return null;
    const tolerance = onPlane(clientX + SNAP_PIXELS, clientY)?.distanceTo(raw) ?? 0;
    const candidates = this.snap && !this.alt ? this.candidates(raw, tolerance, clientX, clientY) : [];
    const from = this.from;
    const { point, label } = resolvePoint(raw, candidates, { snap: true, tolerance, from, lock });
    const refusal = from && this.mode !== 'polygon' && this.check && from.distanceTo(point) > 1e-6 ? this.check(...this.stroke(from, point)) : null;
    return { point, label, refusal };
  }

  /** Ce que l'aimant peut attraper près de `raw` : les points posés, et les arêtes vives de l'élément survolé et des éléments choisis. */
  private candidates(raw: Vector3, tolerance: number, clientX: number, clientY: number): SnapCandidate[] {
    const out: SnapCandidate[] = [];
    const at = (x: number, z: number, kind: SnapKind) => out.push({ point: new Vector3(x, this.height, z), kind });
    for (const point of [...this.lines.flat(), ...this.polygon, ...(this.pending ? [this.pending] : [])]) at(point.x, point.z, 'point');
    const model = this.viewer.model;
    const hit = model ? this.viewer.pick(clientX, clientY) : null;
    const elements = new Set(this.elements);
    if (hit && !hit.cap) elements.add(hit.element);
    for (const element of elements) {
      let edges = this.sharp.get(element);
      if (!edges) this.sharp.set(element, (edges = model ? sharpEdges(model.parts(element)) : []));
      for (let e = 0; e < edges.length; e += 4) {
        const ax = edges[e], az = edges[e + 1], bx = edges[e + 2], bz = edges[e + 3];
        if (raw.x < Math.min(ax, bx) - tolerance || raw.x > Math.max(ax, bx) + tolerance || raw.z < Math.min(az, bz) - tolerance || raw.z > Math.max(az, bz) + tolerance) continue;
        at(ax, az, 'sommet');
        at(bx, bz, 'sommet');
        at((ax + bx) / 2, (az + bz) / 2, 'milieu');
        const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
        const t = length > 0 ? Math.min(1, Math.max(0, ((raw.x - ax) * dx + (raw.z - az) * dz) / length)) : 0;
        at(ax + t * dx, az + t * dz, 'arête');
      }
    }
    return out;
  }

  private draw(): void {
    const nodes: SVGElement[] = [];
    const at = (point: Vector3): [number, number] | null => (this.viewer.toScreen(point, this.screen) ? [this.screen.x, this.screen.y] : null);
    const node = (tag: string, className: string, attributes: Record<string, string>, text?: string) => {
      const element = document.createElementNS(SVG_NS, tag);
      element.setAttribute('class', className);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      if (text !== undefined) element.textContent = text;
      nodes.push(element);
    };
    const coords = (points: Vector3[], closed: boolean): string | null => {
      const screen = points.map(at);
      if (screen.length < 2 || screen.some((xy) => xy === null)) return null;
      return (closed ? [...screen, screen[0]] : screen).map((xy) => `${xy![0].toFixed(1)},${xy![1].toFixed(1)}`).join(' ');
    };
    const path = (points: Vector3[], closed: boolean, className: string) => {
      const list = coords(points, closed);
      if (list) node('polyline', className, { points: list });
    };
    const dot = (point: Vector3, className: string) => {
      const xy = at(point);
      if (xy) node('circle', className, { r: '4', cx: xy[0].toFixed(1), cy: xy[1].toFixed(1) });
    };
    for (const area of this.areas) {
      const d = area.polygons.map((polygon) => coords(polygon, false)).filter(Boolean).map((list) => `M${list}Z`).join('');
      if (d) node('path', `sketch-area tone-${area.tone % 6}`, { d });
    }
    for (const shape of this.mode ? this.shapes : []) path(shape.points, true, 'sketch-shape');
    for (const guide of this.guides) path(guide, false, 'sketch-guide');
    for (const line of this.lines) path(line, false, 'measure-line');
    if (this.mode === 'polygon') path(this.polygon, false, 'measure-line');
    const from = this.from;
    if (this.mode && from && this.hover) path(this.stroke(from, this.hover.point), false, `measure-line pending${this.hover.refusal ? ' refused' : ''}`);
    for (const point of [...this.lines.flat(), ...(this.mode === 'polygon' ? this.polygon : []), ...(this.pending ? [this.pending] : [])]) dot(point, 'measure-dot');
    for (const mark of this.marks) {
      const xy = at(mark.point);
      if (xy) node('text', 'sketch-mark', { x: xy[0].toFixed(1), y: xy[1].toFixed(1) }, mark.label);
    }
    if (this.mode && this.hover) {
      dot(this.hover.point, `measure-dot hover${this.hover.label ? ' snapped' : ''}`);
      const xy = at(this.hover.point);
      // Dans la moitié droite de la vue, le texte part vers la gauche : il reste lisible au bord.
      const side: Record<string, string> = xy && xy[0] >this.viewer.renderer.domElement.clientWidth / 2 ? { x: (xy[0] - 10).toFixed(1), 'text-anchor': 'end' } : { x: ((xy?.[0] ?? 0) + 10).toFixed(1) };
      if (xy && this.hover.label) node('text', 'sketch-snap', { ...side, y: (xy[1] - 10).toFixed(1) }, this.hover.label);
      if (xy && this.hover.refusal) node('text', 'sketch-refusal', { ...side, y: (xy[1] + 20).toFixed(1) }, this.hover.refusal);
    }
    this.svg.replaceChildren(...nodes);
  }
}
