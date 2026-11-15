import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, SRGBColorSpace, type Plane } from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { Model } from './Model.ts';
import { assembleCut, cutPlane, emptyPlaneCut, type CutDrawing, type PlaneCut } from './sectionCut.ts';
import type { Sections } from './Sections.ts';

/**
 * Jusqu'à ce nombre de triangles dans tout le modèle, la coupe est calculée d'un seul tenant ; au-delà, jamais : elle
 * avance par tranches entre deux images.
 */
export const SYNC_CUT_TRIANGLES = 300_000;
/** Temps de calcul accordé à chaque tranche, en millisecondes. */
const SLICE_MS = 8;
/** Deux extrémités de segments à moins de 0,1 mm sont le même point. */
const CHAIN_TOLERANCE = 1e-4;
/** Plans gardés en mémoire : déplacer un plan ne recalcule pas les autres. */
const CACHE_SIZE = 12;
const OUTLINE = 0x1b1f24;

export type CutColorMode = 'element' | 'single';

interface Slot {
  fill: Mesh<BufferGeometry, MeshBasicMaterial>;
  solid: LineSegments2;
  dashed: LineSegments2;
}

const planeKey = (plane: Plane) => `${plane.normal.x},${plane.normal.y},${plane.normal.z},${plane.constant}`;

/**
 * Le dessin de la coupe : un trait épais le long des lignes de coupe (`sectionCut`), en tirets pour un maillage ouvert, et le
 * remplissage des solides fermés, à la couleur de l'élément ou d'une seule couleur.
 *
 * Il n'est calculé qu'une fois la vue et les plans immobiles (`idle`, appelé par le viewer quand la résolution redevient
 * pleine). Tout le calcul (boîtes, triangles, boucles, remplissage, assemblage) est un seul travail par tranches de 8 ms au
 * plus, que tout changement de plan ou mouvement de caméra abandonne ; seule la géométrie à envoyer à la carte graphique est
 * créée d'un coup, à la fin. Pendant ce temps, seule la coupe des matériaux est dessinée. Un dessin à jour coûte un appel
 * par plan : il reste affiché pendant que la caméra tourne. En mode carte (caméra externe), il est caché : le globe dessine
 * la maquette, sans profondeur commune.
 */
export class CutDisplay {
  readonly group = new Group();
  /** Avancement du calcul (0 à 1), ou null quand rien n'est en cours. */
  readonly onProgress = new Set<(progress: number | null) => void>();
  colorMode: CutColorMode = 'element';
  private model: Model | null = null;
  private readonly cache = new Map<string, PlaneCut>();
  private readonly slots: Slot[] = [];
  private job: { cancelled: boolean } | null = null;
  /** Le dessin affiché correspond aux plans actuels. */
  private current = false;
  private readonly resolution = { width: 1, height: 1 };
  private readonly sections: Sections;
  private readonly singleColor: () => Color;
  private readonly redraw: () => void;
  private readonly mapMode: () => boolean;

  /** `singleColor` : la couleur unique de remplissage ; `redraw` demande une image ; `mapMode` : la caméra est au globe. */
  constructor(sections: Sections, singleColor: () => Color, redraw: () => void, mapMode: () => boolean) {
    this.sections = sections;
    this.singleColor = singleColor;
    this.redraw = redraw;
    this.mapMode = mapMode;
    this.group.name = 'Coupe';
    this.group.visible = false;
  }

  setModel(model: Model | null): void {
    this.model?.state.onChange.delete(this.refresh);
    this.model = model;
    model?.state.onChange.add(this.refresh);
    this.cache.clear();
    this.stale();
  }

  /** Le modèle a grandi d'un morceau : ses nouveaux éléments ne sont dans aucune coupe gardée. */
  modelGrown(): void {
    this.cache.clear();
    this.stale();
  }

  /** Les plans ont changé : le dessin est caché et le calcul en cours abandonné jusqu'au prochain `idle`. */
  stale(): void {
    this.cancel();
    this.current = false;
    this.group.visible = false;
  }

  /**
   * La caméra bouge : le calcul en cours est abandonné (les plans déjà coupés restent en mémoire) et reprendra à l'arrêt.
   * Un dessin à jour reste affiché.
   */
  interrupt(): void {
    if (!this.job) return;
    this.cancel();
    this.current = false;
  }

  /**
   * Résolu quand le dessin de la coupe est à jour (tout de suite si rien ne se coupe) : lance le calcul s'il ne l'est pas.
   * Une capture ou un export attend ce moment pour avoir le remplissage de la coupe.
   */
  ready(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (this.current || !this.model || !this.sections.active || this.mapMode()) {
          this.onProgress.delete(listener);
          resolve();
        }
      };
      // `notify(null)` précède `apply` : l'état est relu une fois le calcul fini.
      const listener = (progress: number | null) => { if (progress === null) queueMicrotask(check); };
      this.onProgress.add(listener);
      this.idle();
      check();
    });
  }

  /**
   * Le temps d'une tuile de capture : traits `scale` fois plus épais, calculés pour une cible de `width` × `height` pixels,
   * et cachés si `lines` est faux. Renvoie le rétablissement.
   */
  captureStyle(scale: number, width: number, height: number, lines: boolean): () => void {
    const saved = this.slots.flatMap((slot) => [slot.solid, slot.dashed]).map((line) => ({ line, width: line.material.linewidth, visible: line.visible }));
    for (const { line, width: linewidth } of saved) {
      line.material.linewidth = linewidth * scale;
      line.material.resolution.set(width, height);
      line.visible = line.visible && lines;
    }
    return () => {
      for (const { line, width: linewidth, visible } of saved) {
        line.material.linewidth = linewidth;
        line.material.resolution.set(this.resolution.width, this.resolution.height);
        line.visible = visible;
      }
    };
  }

  /** Taille de la vue en pixels CSS : l'épaisseur des traits en dépend. */
  setResolution(width: number, height: number): void {
    this.resolution.width = width;
    this.resolution.height = height;
    for (const slot of this.slots) for (const line of [slot.solid, slot.dashed]) line.material.resolution.set(width, height);
  }

  setColorMode(mode: CutColorMode): void {
    this.colorMode = mode;
    this.refresh();
  }

  /** La vue est immobile : calcule ce qui manque (d'un tenant sur un petit modèle, par tranches sinon) et montre le dessin. */
  idle(): void {
    const model = this.model;
    if (this.current || this.job || !model || !this.sections.active || this.mapMode()) return;
    this.run(model, this.compute(model, this.activePlanes()));
  }

  /**
   * Visibilité, couleurs ou opacités des éléments changées (ou couleur de remplissage) : le dessin à jour est réassemblé
   * depuis les coupes gardées, sans recalculer les coupes ; l'ancien reste affiché jusque-là.
   */
  readonly refresh = (): void => {
    const model = this.model;
    if (!this.current || !model) return;
    this.cancel();
    this.run(model, this.assembleAll(model, this.activePlanes()));
  };

  private cancel(): void {
    if (this.job) this.job.cancelled = true;
    this.job = null;
    this.notify(null);
  }

  /** Exécute un travail : d'un tenant si le modèle est petit (en triangles), sinon par tranches de `SLICE_MS`. */
  private run(model: Model, work: Generator<number, CutDrawing[], unknown>): void {
    const planes = this.activePlanes();
    const job = { cancelled: false };
    this.job = job;
    const finish = (drawings: CutDrawing[]) => {
      this.job = null;
      this.notify(null);
      this.apply(planes, drawings);
      this.redraw();
    };
    if (model.triangleCount <= SYNC_CUT_TRIANGLES) {
      let next = work.next();
      while (!next.done) next = work.next();
      finish(next.value);
      return;
    }
    const step = () => {
      if (job.cancelled) {
        work.return([]);
        return;
      }
      const until = performance.now() + SLICE_MS;
      let next = work.next();
      while (!next.done && performance.now() < until) next = work.next();
      if (next.done) finish(next.value);
      else {
        this.notify(next.value);
        setTimeout(step, 0);
      }
    };
    this.notify(0);
    setTimeout(step, 0);
  }

  private notify(progress: number | null): void {
    for (const callback of this.onProgress) callback(progress);
  }

  private activePlanes(): Plane[] {
    return this.sections.clipPlanes.filter((_, k) => this.sections.planeEnabled(k));
  }

  /** Coupe les plans qui ne sont pas en mémoire (tous les éléments traversés : la visibilité est appliquée au dessin), puis assemble. */
  private *compute(model: Model, planes: Plane[]): Generator<number, CutDrawing[], unknown> {
    const missing = planes.filter((plane) => !this.cache.has(planeKey(plane)));
    for (let i = 0; i < missing.length; i++) {
      const cut = emptyPlaneCut();
      for (const progress of cutPlane(model, missing[i], cut, { filter: () => true, chainTolerance: CHAIN_TOLERANCE })) yield (0.9 * (i + progress)) / missing.length;
      this.cache.set(planeKey(missing[i]), cut);
      while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    const drawings = yield* this.assembleAll(model, planes);
    return drawings;
  }

  /** Le dessin de chaque plan, pour les éléments affichés en ce moment. */
  private *assembleAll(model: Model, planes: Plane[]): Generator<number, CutDrawing[], unknown> {
    const drawings: CutDrawing[] = [];
    const filled = (element: number) => {
      const opacity = model.state.opacityOf(element);
      return (opacity === null || opacity === 1) && !this.transparent(model, element);
    };
    const color = (element: number) => this.colorOf(model, element);
    for (const plane of planes) {
      const work = assembleCut(this.cache.get(planeKey(plane)) ?? emptyPlaneCut(), (element) => model.state.isRendered(element), filled, color);
      let next = work.next();
      for (; !next.done; next = work.next()) yield 0.9 + 0.1 * next.value;
      drawings.push(next.value);
    }
    return drawings;
  }

  /** Crée la géométrie du dessin, une fois par plan. Chaque plan est découpé par les autres (la boîte). */
  private apply(planes: Plane[], drawings: CutDrawing[]): void {
    planes.forEach((plane, k) => {
      const slot = this.slot(k);
      const drawing = drawings[k];
      const others = planes.filter((other) => other !== plane);
      for (const material of [slot.fill.material, slot.solid.material, slot.dashed.material]) material.clippingPlanes = others;
      setLines(slot.solid, drawing.solid);
      setLines(slot.dashed, drawing.dashed);
      slot.dashed.computeLineDistances();
      slot.fill.geometry.dispose();
      slot.fill.geometry = new BufferGeometry();
      slot.fill.geometry.setAttribute('position', new BufferAttribute(drawing.fill, 3));
      slot.fill.geometry.setAttribute('color', new BufferAttribute(drawing.colors, 3));
      slot.fill.visible = this.sections.fill && drawing.fill.length > 0;
      slot.solid.visible = slot.dashed.visible = true;
    });
    for (let k = planes.length; k < this.slots.length; k++) {
      const slot = this.slots[k];
      slot.fill.visible = slot.solid.visible = slot.dashed.visible = false;
    }
    this.current = true;
    this.group.visible = true;
  }

  private transparent(model: Model, element: number): boolean {
    const range = model.ranges[element][0];
    return range === undefined || model.chunks[range.chunk].transparent;
  }

  /** La couleur affichée de l'élément (celle d'une règle, sinon celle de son matériau), un peu assombrie : la matière coupée. */
  private colorOf(model: Model, element: number): [number, number, number] {
    if (this.colorMode === 'single') {
      const { r, g, b } = this.singleColor();
      return [r, g, b];
    }
    const state = model.state.data, at = element * 4;
    let r: number, g: number, b: number;
    if (state[at + 3] & 2 /* FLAG_COLORED */) [r, g, b] = [state[at] / 255, state[at + 1] / 255, state[at + 2] / 255];
    else {
      const range = model.ranges[element][0];
      const chunk = model.chunks[range.chunk];
      const vertex = chunk.index[range.start];
      const colors = chunk.mesh.geometry.getAttribute('color');
      [r, g, b] = colors ? [colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)] : [0.6, 0.6, 0.6];
    }
    const linear = new Color().setRGB(r, g, b, SRGBColorSpace).multiplyScalar(0.8);
    return [linear.r, linear.g, linear.b];
  }

  private slot(k: number): Slot {
    while (this.slots.length <= k) {
      const fill = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      const line = (dashed: boolean) => {
        // Un trait épais est un quadrilatère construit à l'écran, après la projection : il n'a pas d'envers, et une vue en miroir
        // (plan de plafond, voir `Viewer.setMirrored`), qui retourne le sens des faces, ne doit pas l'éliminer.
        const material = new LineMaterial({ color: OUTLINE, linewidth: 2.5, dashed, dashSize: 0.12, gapSize: 0.08, side: DoubleSide });
        material.resolution.set(this.resolution.width, this.resolution.height);
        const segments = new LineSegments2(new LineSegmentsGeometry(), material);
        segments.renderOrder = 1;
        return segments;
      };
      const slot = { fill, solid: line(false), dashed: line(true) };
      for (const object of [slot.fill, slot.solid, slot.dashed]) {
        object.frustumCulled = false;
        this.group.add(object);
      }
      this.slots.push(slot);
    }
    return this.slots[k];
  }
}

function setLines(lines: LineSegments2, positions: Float32Array): void {
  lines.geometry.dispose();
  lines.geometry = new LineSegmentsGeometry();
  // LineSegmentsGeometry refuse un tableau vide : un segment nul ne dessine rien.
  lines.geometry.setPositions(positions.length > 0 ? positions : new Float32Array(6));
}
