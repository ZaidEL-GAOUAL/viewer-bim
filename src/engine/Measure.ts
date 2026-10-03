import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { analyzeSolid, coplanarRegion } from './meshMath.ts';
import type { PickHit } from './Model.ts';
import type { Viewer } from './Viewer.ts';

export type MeasureKind = 'distance' | 'area' | 'volume';

export interface Measurement {
  id: number;
  kind: MeasureKind;
  value: number;
  /** Valeur formatée avec son unité. */
  text: string;
  /** Précision sur la mesure (élément concerné, avertissement). */
  note: string;
  /** Vrai si la valeur n'est qu'indicative (maillage non fermé). */
  approximate: boolean;
}

interface Entry extends Measurement {
  /** Élément mesuré (surface, volume), pour ne pas enregistrer deux fois la même mesure. */
  element: number;
  points: Vector3[];
  label: HTMLElement;
  line: SVGLineElement | null;
  dots: SVGCircleElement[];
  mesh: Mesh | null;
}

interface LabelBox { left: number; right: number; top: number; bottom: number }

const SVG_NS = 'http://www.w3.org/2000/svg';
const SNAP_PIXELS = 12;
const large = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const small = new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 });
// Les petites valeurs gardent quatre chiffres significatifs : 0,005048 plutôt que 0,005.
const number = { format: (value: number): string => (Math.abs(value) < 1 && value !== 0 ? small : large).format(value) };

// Le format glTF impose le mètre comme unité.
export const formatLength = (value: number): string => `${number.format(value)} m`;
export const formatArea = (value: number): string => `${number.format(value)} m²`;
export const formatVolume = (value: number): string => `${number.format(value)} m³`;

/**
 * Outils de mesure. Les tracés (lignes, points, étiquettes) sont en SVG et HTML par-dessus la vue :
 * ils restent nets à toute distance et ne coûtent rien au rendu 3D.
 */
export class Measure {
  tool: MeasureKind | null = null;
  readonly results: Measurement[] = [];
  onChange: () => void = () => {};
  /** Message à afficher à l'utilisateur quand un clic ne peut pas être mesuré. */
  onNotice: (message: string) => void = () => {};

  private readonly viewer: Viewer;
  private readonly svg: SVGSVGElement;
  private readonly labels: HTMLElement;
  private readonly entries: Entry[] = [];
  private readonly rubber: SVGLineElement;
  private readonly hoverDot: SVGCircleElement;
  private readonly pendingDot: SVGCircleElement;
  private readonly liveLabel: HTMLElement;
  private readonly areaMaterial = new MeshBasicMaterial({
    color: 0x1d8bff,
    transparent: true,
    opacity: 0.45,
    side: DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  private pending: Vector3 | null = null;
  private hover: { point: Vector3; snapped: boolean } | null = null;
  private nextId = 1;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly screen = { x: 0, y: 0 };
  private readonly labelSizes = new WeakMap<HTMLElement, { width: number; height: number }>();

  constructor(viewer: Viewer, root: HTMLElement) {
    this.viewer = viewer;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('measure-svg');
    this.labels = document.createElement('div');
    this.labels.className = 'measure-labels';
    root.append(this.svg, this.labels);

    this.rubber = this.createLine('measure-line pending');
    this.hoverDot = this.createDot('measure-dot hover');
    this.pendingDot = this.createDot('measure-dot');
    this.pendingDot.style.display = 'none';
    this.liveLabel = this.createLabel('measure-label live');
    this.rubber.style.display = 'none';
    this.hoverDot.style.display = 'none';
    this.liveLabel.style.display = 'none';

    viewer.afterRender.add(() => this.updateOverlay());
  }

  setTool(tool: MeasureKind | null): void {
    this.tool = tool;
    this.cancelPending();
  }

  /** Vrai si une mesure de distance attend son second point. */
  get hasPending(): boolean {
    return this.pending !== null;
  }

  cancelPending(): void {
    this.pending = null;
    this.hover = null;
    this.updateOverlay();
  }

  /** Clic dans la vue avec un outil de mesure actif. Renvoie l'élément touché, s'il y en a un. */
  click(clientX: number, clientY: number): PickHit | null {
    const hit = this.viewer.pick(clientX, clientY);
    const model = this.viewer.model;
    if (!hit || !model || !this.tool) return hit;

    if (this.tool === 'distance') {
      const { point } = this.snap(hit, clientX, clientY);
      if (!this.pending) {
        this.pending = point;
      } else if (this.pending.distanceToSquared(point) === 0) {
        // Second clic au même endroit (double-clic) : pas de mesure de longueur nulle.
        return hit;
      } else {
        const value = this.pending.distanceTo(point);
        const delta = point.clone().sub(this.pending);
        const note = `ΔX ${number.format(Math.abs(delta.x))} · ΔY ${number.format(Math.abs(delta.y))} · ΔZ ${number.format(Math.abs(delta.z))}`;
        const entry = this.addEntry('distance', value, formatLength(value), note, false, [this.pending, point]);
        entry.line = this.createLine('measure-line');
        entry.dots = [this.createDot('measure-dot'), this.createDot('measure-dot')];
        this.pending = null;
        this.hover = null;
      }
    } else if (this.tool === 'area') {
      if (hit.cap) {
        this.onNotice('La surface d’une section coupée n’est pas mesurable : cliquez une face de l’élément.');
        return hit;
      }
      const parts = model.parts(hit.element);
      const seedPart = model.ranges[hit.element].findIndex(
        (range) => range.chunk === hit.chunk && hit.tri >= range.start && hit.tri < range.start + range.count,
      );
      const region = coplanarRegion(parts, seedPart, hit.tri);
      const centroid = region ? new Vector3().fromArray(region.centroid) : null;
      // Un second clic sur la même face (double-clic) ne crée pas de doublon.
      const duplicate = this.entries.some((entry) => entry.kind === 'area' && entry.element === hit.element && centroid !== null && entry.points[0].distanceToSquared(centroid) < 1e-12);
      if (region && centroid && !duplicate) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(region.positions, 3));
        const mesh = new Mesh(geometry, this.areaMaterial);
        mesh.frustumCulled = false;
        this.viewer.overlay.add(mesh);
        const entry = this.addEntry('area', region.area, formatArea(region.area), `Face de « ${model.names[hit.element]} »`, false, [centroid]);
        entry.mesh = mesh;
        entry.element = hit.element;
      }
    } else if (!this.entries.some((entry) => entry.kind === 'volume' && entry.element === hit.element)) {
      const info = analyzeSolid(model.parts(hit.element));
      const center = model.elementBox(hit.element, new Box3()).getCenter(new Vector3());
      const note = info.closed
        ? `« ${model.names[hit.element]} » · surface ${formatArea(info.area)}`
        : `« ${model.names[hit.element]} » · maillage non fermé, valeur indicative`;
      this.addEntry('volume', info.volume, formatVolume(info.volume), note, !info.closed, [center]).element = hit.element;
    }

    this.viewer.invalidate();
    this.updateOverlay();
    this.onChange();
    return hit;
  }

  /** Survol : point d'accroche et tracé provisoire de la distance. */
  move(clientX: number, clientY: number): void {
    if (this.tool !== 'distance') return;
    const hit = this.viewer.pick(clientX, clientY);
    this.hover = hit ? this.snap(hit, clientX, clientY) : null;
    this.updateOverlay();
  }

  leave(): void {
    if (!this.hover) return;
    this.hover = null;
    this.updateOverlay();
  }

  remove(id: number): void {
    const at = this.entries.findIndex((entry) => entry.id === id);
    if (at < 0) return;
    this.destroy(this.entries[at]);
    this.entries.splice(at, 1);
    this.results.splice(at, 1);
    this.viewer.invalidate();
    this.onChange();
  }

  clear(): void {
    for (const entry of this.entries) this.destroy(entry);
    this.entries.length = 0;
    this.results.length = 0;
    this.cancelPending();
    this.viewer.invalidate();
    this.onChange();
  }

  private addEntry(kind: MeasureKind, value: number, text: string, note: string, approximate: boolean, points: Vector3[]): Entry {
    const label = this.createLabel(`measure-label ${kind}`);
    const kindLabel = { distance: 'Distance', area: 'Surface', volume: 'Volume' }[kind];
    const valueLabel = document.createElement('span');
    valueLabel.textContent = approximate ? `≈ ${text}` : text;
    valueLabel.title = `${kindLabel} · ${note}`;
    label.setAttribute('role', 'group');
    label.setAttribute('aria-label', `${kindLabel} : ${valueLabel.textContent}. ${note}`);
    const entry: Entry = { id: this.nextId++, kind, value, text, note, approximate, element: -1, points, label, line: null, dots: [], mesh: null };
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'measure-label-remove'; remove.textContent = '×';
    remove.title = `Supprimer cette mesure de ${kindLabel.toLocaleLowerCase('fr')}`;
    remove.setAttribute('aria-label', `Supprimer la mesure ${kindLabel} ${text}`);
    remove.addEventListener('click', (event) => { event.stopPropagation(); this.remove(entry.id); });
    label.append(valueLabel, remove);
    this.entries.push(entry);
    this.results.push(entry);
    return entry;
  }

  private destroy(entry: Entry): void {
    entry.label.remove();
    entry.line?.remove();
    for (const dot of entry.dots) dot.remove();
    if (entry.mesh) {
      entry.mesh.removeFromParent();
      entry.mesh.geometry.dispose();
    }
  }

  /** Accroche le point au sommet le plus proche du triangle touché, s'il est à portée du curseur. */
  private snap(hit: PickHit, clientX: number, clientY: number): { point: Vector3; snapped: boolean } {
    // Sur une section coupée, le triangle touché est à l'intérieur du solide : pas d'accroche.
    if (hit.cap) return { point: hit.point.clone(), snapped: false };
    const model = this.viewer.model!;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    model.triangle(hit.chunk, hit.tri, this.a, this.b, this.c);
    let best: Vector3 | null = null;
    let bestDistance = SNAP_PIXELS;
    const sections = this.viewer.sections;
    for (const vertex of [this.a, this.b, this.c]) {
      // Un sommet retiré par une coupe n'est pas visible : on ne s'y accroche pas.
      if (sections.active && sections.isClipped(vertex.x, vertex.y, vertex.z)) continue;
      if (!this.viewer.toScreen(vertex, this.screen)) continue;
      const distance = Math.hypot(this.screen.x - x, this.screen.y - y);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = vertex;
      }
    }
    return best ? { point: best.clone(), snapped: true } : { point: hit.point.clone(), snapped: false };
  }

  private createLine(className: string): SVGLineElement {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', className);
    this.svg.append(line);
    return line;
  }

  private createDot(className: string): SVGCircleElement {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', className);
    dot.setAttribute('r', '4');
    this.svg.append(dot);
    return dot;
  }

  private createLabel(className: string): HTMLElement {
    const label = document.createElement('div');
    label.className = className;
    this.labels.append(label);
    return label;
  }

  private placeDot(dot: SVGCircleElement, point: Vector3): void {
    if (this.viewer.toScreen(point, this.screen)) {
      dot.style.display = '';
      dot.setAttribute('cx', this.screen.x.toFixed(1));
      dot.setAttribute('cy', this.screen.y.toFixed(1));
    } else {
      dot.style.display = 'none';
    }
  }

  private placeLabel(label: HTMLElement, point: Vector3, occupied?: LabelBox[]): void {
    if (this.viewer.toScreen(point, this.screen)) {
      label.style.display = '';
      let { x, y } = this.screen;
      if (occupied) {
        // Completed labels never change size. Cache it to avoid layout reads on every frame.
        let size = this.labelSizes.get(label);
        if (!size) {
          size = { width: label.offsetWidth, height: label.offsetHeight };
          this.labelSizes.set(label, size);
        }
        const { width, height } = this.viewer.size;
        const halfW = size.width / 2, halfH = size.height / 2, gap = 4;
        x = Math.max(halfW, Math.min(width - halfW, x));
        y = Math.max(halfH, Math.min(height - halfH, y));
        const neighbours = occupied.filter((box) => x + halfW + gap > box.left && x - halfW - gap < box.right);
        const candidates = [y, ...neighbours.flatMap((box) => [box.top - halfH - gap, box.bottom + halfH + gap])];
        candidates.sort((a, b) => Math.abs(a - y) - Math.abs(b - y));
        y = candidates.find((candidate) => candidate >= halfH && candidate <= height - halfH
          && neighbours.every((box) => candidate + halfH + gap <= box.top || candidate - halfH - gap >= box.bottom)) ?? y;
        occupied.push({ left: x - halfW, right: x + halfW, top: y - halfH, bottom: y + halfH });
      }
      label.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    } else {
      label.style.display = 'none';
    }
  }

  /** Trace un segment 3D en le coupant au plan proche de la caméra s'il passe derrière elle. */
  private placeLine(line: SVGLineElement, from: Vector3, to: Vector3): void {
    const camera = this.viewer.camera;
    const { width, height } = this.viewer.size;
    const a = this.a.copy(from).applyMatrix4(camera.matrixWorldInverse);
    const b = this.b.copy(to).applyMatrix4(camera.matrixWorldInverse);
    const limit = -camera.near;
    if (a.z > limit && b.z > limit) {
      line.style.display = 'none';
      return;
    }
    if (a.z > limit) a.lerp(b, (limit - a.z) / (b.z - a.z));
    else if (b.z > limit) b.lerp(a, (limit - b.z) / (a.z - b.z));
    a.applyMatrix4(camera.projectionMatrix);
    b.applyMatrix4(camera.projectionMatrix);
    line.style.display = '';
    line.setAttribute('x1', ((a.x * 0.5 + 0.5) * width).toFixed(1));
    line.setAttribute('y1', ((0.5 - a.y * 0.5) * height).toFixed(1));
    line.setAttribute('x2', ((b.x * 0.5 + 0.5) * width).toFixed(1));
    line.setAttribute('y2', ((0.5 - b.y * 0.5) * height).toFixed(1));
  }

  private updateOverlay(): void {
    const occupied: LabelBox[] = [];
    for (const entry of this.entries) {
      if (entry.line) {
        this.placeLine(entry.line, entry.points[0], entry.points[1]);
        this.placeDot(entry.dots[0], entry.points[0]);
        this.placeDot(entry.dots[1], entry.points[1]);
        this.placeLabel(entry.label, this.c.copy(entry.points[0]).add(entry.points[1]).multiplyScalar(0.5), occupied);
      } else {
        this.placeLabel(entry.label, entry.points[0], occupied);
      }
    }

    if (this.hover) {
      this.placeDot(this.hoverDot, this.hover.point);
      this.hoverDot.classList.toggle('snapped', this.hover.snapped);
    } else {
      this.hoverDot.style.display = 'none';
    }

    if (this.pending) this.placeDot(this.pendingDot, this.pending);
    else this.pendingDot.style.display = 'none';

    if (this.pending && this.hover) {
      this.placeLine(this.rubber, this.pending, this.hover.point);
      this.liveLabel.textContent = formatLength(this.pending.distanceTo(this.hover.point));
      this.placeLabel(this.liveLabel, this.c.copy(this.pending).add(this.hover.point).multiplyScalar(0.5));
    } else {
      this.rubber.style.display = 'none';
      this.liveLabel.style.display = 'none';
    }
  }
}
