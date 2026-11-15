import { Vector3 } from 'three';
import { coerceTo, ownValue, toPropertyPath, type PropValue } from '../data/metadata.ts';
import { toModelPoint, toViewerPoint } from '../data/modelFrame.ts';
import { integer, plural } from '../data/text.ts';
import { assignZones, type Zone } from '../data/zones.ts';
import { measureElement } from '../engine/dimensions.ts';
import type { Model } from '../engine/Model.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { holdDrawingView } from './SplitPanel.ts';

type Footprint = [number, number][] | null;

/** Les emprises (enveloppe convexe en plan, repère du viewer) de ces éléments, par tranches : la maquette entière peut y passer. */
function footprints(model: Model, indices: readonly number[], onProgress: (progress: number) => void, signal?: AbortSignal): Promise<Footprint[]> {
  const out: Footprint[] = [];
  function* job(): Generator<number, Footprint[], unknown> {
    let work = 0;
    for (let k = 0; k < indices.length; k++) {
      const parts = model.parts(indices[k]);
      out.push(measureElement(parts)?.hull ?? null);
      for (const part of parts) work += part.count / 3;
      if (work > 60_000) {
        work = 0;
        yield (k + 1) / indices.length;
      }
    }
    return out;
  }
  return runSliced(job(), onProgress, signal);
}

/**
 * Carte « Zones » : des zones dessinées en plan (polygones nommés), et chaque élément (ou pièce) rangé dans celle qui couvre la
 * plus grande part de son emprise, écrite dans une propriété (« Zone » par défaut), en une étape annulable. Le tracé est celui
 * du découpage : la vue passe de dessus, en projection parallèle, avec le même aimant, et les éléments que chaque zone prendra
 * se teintent pendant qu'on dessine ; la vue d'avant revient à la fin du tracé. Aucune géométrie n'est créée ; les zones
 * s'enregistrent avec les deux JSON.
 */
export class ZonesPanel {
  readonly label = 'Zones';
  readonly summary = 'Dessiner des zones et y ranger les éléments';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly list = h('div', { class: 'views-list' });
  private readonly property = h('input', { attrs: { type: 'text', value: 'Zone', 'aria-label': 'Propriété à écrire' } });
  private readonly draw: HTMLButtonElement;
  private readonly assign: HTMLButtonElement;
  private readonly snap = h('input', { attrs: { type: 'checkbox', checked: '' } });
  private readonly sentence = h('p', { class: 'split-sentence', attrs: { hidden: '' } });
  private readonly report = h('p', { class: 'hint', attrs: { role: 'status' } });
  /** Rétablit la vue d'avant le tracé ; null hors du tracé. */
  private restoreView: (() => Promise<void>) | null = null;
  /** Les emprises des éléments visés pendant le tracé, et combien chaque zone en prendrait. */
  private hulls: Footprint[] | null = null;
  private counts: number[] = [];
  private computing: AbortController | null = null;
  private readonly leave = () => this.stopDrawing();

  constructor(app: App) {
    this.app = app;
    this.draw = button('Dessiner une zone', () => void (this.restoreView ? this.stopDrawing() : this.startDrawing()), { attrs: { 'aria-pressed': 'false' }, title: 'La vue passe de dessus ; la vue d’avant revient à la fin du tracé' });
    this.assign = button('Ranger les éléments', () => void this.run(), { class: 'primary', title: 'La sélection, ou à défaut tout ce qui est affiché' });
    this.snap.addEventListener('change', () => (app.sketch.snap = this.snap.checked));
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les zones' } })),
      this.sentence,
      h('div', { class: 'tool-row' }, this.draw, h('label', { class: 'tool-check', title: 'Le curseur s’accroche aux sommets, milieux et arêtes ; Alt tenu : sans aimant' }, this.snap, 'Aimanter')),
      this.list,
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Propriété' }), this.property),
      h('div', { class: 'dimensions-actions' }, this.assign),
      this.report,
      h('p', { class: 'hint', text: 'Chaque élément va à la zone qui couvre la plus grande part de son emprise au sol ; hors de toute zone, il n’est pas modifié. Les zones s’enregistrent avec « Enregistrer mes modifications » et « Toutes les propriétés » (groupe Exporter).' }),
    );
    let model = app.model;
    app.on('model', () => {
      if (app.model === model) return;
      model = app.model;
      // La vue gardée était celle de l'autre modèle : il n'y a rien à rétablir.
      if (this.restoreView) this.stopDrawing();
    });
    app.on('tool', () => {
      // Échap, ou un autre outil : le tracé s'arrête et la vue d'avant revient.
      if (this.restoreView && !this.drawing) this.stopDrawing();
      this.render();
    });
    app.on('zones', () => this.preview());
    this.render();
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (!open && this.restoreView) this.stopDrawing();
    this.render();
    return open;
  }

  private get drawing(): boolean {
    return this.app.tool === 'sketch' && this.app.sketch.mode === 'polygon';
  }

  private render(): void {
    const { app } = this;
    const drawing = this.restoreView !== null;
    this.draw.textContent = drawing ? 'Terminer le tracé' : 'Dessiner une zone';
    this.draw.setAttribute('aria-pressed', String(drawing));
    this.draw.disabled = !app.model;
    this.sentence.hidden = !drawing;
    this.sentence.textContent = 'Cliquez les sommets de la zone dans la vue, puis le premier point (ou Entrée) pour la fermer. Les éléments qu’elle prendra se teintent.';
    this.assign.disabled = !app.model || app.zones.length === 0;
    clear(this.list);
    if (app.zones.length === 0) this.list.append(h('p', { class: 'hint', text: 'Aucune zone.' }));
    app.zones.forEach((zone, index) => {
      const note = drawing && this.hulls ? plural(this.counts[index] ?? 0, 'élément') : plural(zone.points.length, 'sommet');
      const item = h('div', { class: 'view-item' }, h('span', { class: 'view-name', text: zone.name }), h('span', { class: 'view-note', text: note }));
      this.list.append(h('div', { class: 'view-row' }, item, button('×', () => app.setZones(app.zones.filter((_, i) => i !== index)), { class: 'view-action', title: `Supprimer la zone « ${zone.name} »`, attrs: { 'aria-label': `Supprimer la zone ${zone.name}` } })));
    });
  }

  /** Les zones dans le repère du viewer, pour les montrer pendant le tracé. */
  private shapes(): { points: Vector3[]; label: string }[] {
    const offset = this.app.model?.offset.toArray() ?? [0, 0, 0];
    return this.app.zones.map((zone) => ({ label: zone.name, points: zone.points.map((point) => new Vector3(...toViewerPoint(point, offset)).setY(this.app.sketch.height)) }));
  }

  /** Les éléments que les zones visent : la sélection, à défaut ce qui est affiché. */
  private targets(model: Model): number[] {
    return this.app.selection.size > 0 ? [...this.app.selection] : Array.from({ length: model.count }, (_, i) => i).filter((i) => model.state.isRendered(i));
  }

  private async startDrawing(): Promise<void> {
    const { app } = this;
    const model = app.model;
    if (!model) return;
    const indices = this.targets(model);
    const restore = await holdDrawingView(app, indices, { from: 'top', isolate: false, card: this.el, leave: this.leave });
    if (this.el.hidden || app.model !== model) {
      void restore();
      return;
    }
    this.restoreView = restore;
    const sketch = app.sketch;
    sketch.start('polygon', model.box.isEmpty() ? 0 : model.box.min.y);
    sketch.snap = this.snap.checked;
    sketch.keyboard = true;
    sketch.shapes = this.shapes();
    sketch.onChange = () => this.preview();
    sketch.onPolygon = (points) => {
      const name = window.prompt('Nom de la zone', `Zone ${app.zones.length + 1}`)?.trim();
      if (!name) return;
      const offset = model.offset.toArray();
      const zone: Zone = { name, points: points.map((point) => toModelPoint(point.toArray(), offset)) };
      app.setZones([...app.zones, zone]);
      sketch.shapes = this.shapes();
    };
    app.setTool('sketch');
    const controller = (this.computing = new AbortController());
    try {
      const hulls = await footprints(model, indices, (progress) => (this.report.textContent = `Calcul des emprises pour l’aperçu… ${Math.round(progress * 100)} %`), controller.signal);
      if (this.computing !== controller) return;
      this.hulls = hulls;
      this.report.textContent = '';
      this.preview();
    } catch {
      // Tracé arrêté pendant le calcul.
    } finally {
      if (this.computing === controller) this.computing = null;
    }
  }

  private stopDrawing(): void {
    const { app } = this;
    const restore = this.restoreView;
    this.restoreView = null;
    this.computing?.abort();
    this.computing = null;
    this.hulls = null;
    this.counts = [];
    app.sketch.areas = [];
    app.sketch.marks = [];
    if (this.drawing) app.setTool('select');
    void restore?.();
    this.render();
  }

  /** Teinte, pendant le tracé, les éléments que chaque zone prendrait (celle en cours comprise) et met les noms des zones. */
  private preview(): void {
    const { app } = this;
    const model = app.model, sketch = app.sketch, hulls = this.hulls;
    if (!this.restoreView || !model || !hulls) {
      this.render();
      return;
    }
    const offset = model.offset.toArray();
    const zones = app.zones.map((zone) => zone.points.map((point): [number, number] => [point[0] - offset[0], point[2] - offset[2]]));
    if (sketch.polygon.length >= 3) zones.push(sketch.polygon.map((point): [number, number] => [point.x, point.z]));
    const areas = zones.map((_, tone) => ({ polygons: [] as Vector3[][], tone }));
    this.counts = zones.map(() => 0);
    assignZones(hulls, zones).forEach((zone, k) => {
      const hull = hulls[k];
      if (zone < 0 || !hull) return;
      this.counts[zone]++;
      areas[zone].polygons.push(hull.map(([x, z]) => new Vector3(x, sketch.height, z)));
    });
    sketch.areas = areas;
    sketch.marks = app.zones.map((zone) => {
      const centre = zone.points.reduce((sum, point) => sum.add(new Vector3(...toViewerPoint(point, offset))), new Vector3()).divideScalar(zone.points.length);
      return { point: centre.setY(sketch.height), label: zone.name };
    });
    app.viewer.invalidate();
    this.render();
  }

  private async run(): Promise<void> {
    const { app } = this;
    const model = app.model;
    const path = toPropertyPath(this.property.value);
    if (!model || !path) return;
    if (!app.store.isEditable(path)) {
      this.report.textContent = `« ${path} » est verrouillée par le fichier.`;
      return;
    }
    const indices = this.targets(model);
    const keys = indices.map((index) => model.keys[index]);
    this.assign.disabled = true;
    try {
      const hulls = await footprints(model, indices, (progress) => (this.report.textContent = `Calcul des emprises… ${Math.round(progress * 100)} %`));
      if (model !== app.model || indices.some((index, k) => model.keys[index] !== keys[k])) {
        this.report.textContent = 'Le modèle a changé pendant le calcul : relancez-le.';
        return;
      }
      const offset = model.offset.toArray();
      const zones = app.zones.map((zone) => zone.points.map((point): [number, number] => [point[0] - offset[0], point[2] - offset[2]]));
      const assigned = assignZones(hulls, zones);
      const updates: [number, string, PropValue][] = [];
      assigned.forEach((zone, k) => {
        if (zone < 0) return;
        const index = indices[k];
        updates.push([index, path, coerceTo(ownValue(app.store.propsOf(index), path), app.zones[zone].name)]);
      });
      if (updates.length > 0) app.editProperties(updates);
      const outside = assigned.filter((zone) => zone < 0).length;
      this.report.textContent = `${plural(updates.length, 'élément rangé', 'éléments rangés')} dans « ${path} »${outside ? `, ${integer.format(outside)} hors de toute zone` : ''}.${updates.length ? ' « Annuler » revient en arrière en une fois.' : ''}`;
    } catch (error) {
      this.report.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.assign.disabled = false;
    }
  }
}
