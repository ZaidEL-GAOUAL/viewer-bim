import { Vector3 } from 'three';
import { coerceTo, ownValue, toPropertyPath, type PropValue } from '../data/metadata.ts';
import { toModelPoint, toViewerPoint } from '../data/modelFrame.ts';
import { integer, plural } from '../data/text.ts';
import { assignZones, type Zone } from '../data/zones.ts';
import { measureElement } from '../engine/dimensions.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

/**
 * Carte « Zones » : des zones dessinées en plan (polygones nommés), et chaque élément (ou pièce) rangé dans celle qui couvre la
 * plus grande part de son emprise, écrite dans une propriété (« Zone » par défaut), en une étape annulable. Aucune géométrie
 * n'est créée ; les zones s'enregistrent avec les deux JSON.
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
  private readonly report = h('p', { class: 'hint', attrs: { role: 'status' } });

  constructor(app: App) {
    this.app = app;
    this.draw = button('Dessiner une zone', () => this.toggleSketch(), { attrs: { 'aria-pressed': 'false' }, title: 'Vue de dessus conseillée (2D, puis « Haut »)' });
    this.assign = button('Ranger les éléments', () => void this.run(), { class: 'primary', title: 'La sélection, ou à défaut tout ce qui est affiché' });
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les zones' } })),
      h('div', { class: 'tool-row' }, this.draw),
      this.list,
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Propriété' }), this.property),
      h('div', { class: 'dimensions-actions' }, this.assign),
      this.report,
      h('p', { class: 'hint', text: 'Chaque élément va à la zone qui couvre la plus grande part de son emprise au sol ; hors de toute zone, il n’est pas modifié. Les zones s’enregistrent avec « JSON ↓ » et « Modifications ↓ ».' }),
    );
    for (const event of ['model', 'tool', 'zones'] as const) app.on(event, () => this.render());
    this.render();
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (!open && this.app.tool === 'sketch' && this.app.sketch.mode === 'polygon') this.app.setTool('select');
    this.render();
    return open;
  }

  private render(): void {
    const { app } = this;
    const sketching = app.tool === 'sketch' && app.sketch.mode === 'polygon';
    this.draw.textContent = sketching ? 'Arrêter le tracé' : 'Dessiner une zone';
    this.draw.setAttribute('aria-pressed', String(sketching));
    this.draw.disabled = !app.model;
    this.assign.disabled = !app.model || app.zones.length === 0;
    clear(this.list);
    if (app.zones.length === 0) this.list.append(h('p', { class: 'hint', text: 'Aucune zone.' }));
    app.zones.forEach((zone, index) => {
      const item = h('div', { class: 'view-item' }, h('span', { class: 'view-name', text: zone.name }), h('span', { class: 'view-note', text: plural(zone.points.length, 'sommet') }));
      this.list.append(h('div', { class: 'view-row' }, item, button('×', () => app.setZones(app.zones.filter((_, i) => i !== index)), { class: 'view-action', title: `Supprimer la zone « ${zone.name} »`, attrs: { 'aria-label': `Supprimer la zone ${zone.name}` } })));
    });
    if (sketching) app.sketch.shapes = this.shapes();
  }

  /** Les zones dans le repère du viewer, pour les montrer pendant le tracé. */
  private shapes(): { points: Vector3[]; label: string }[] {
    const offset = this.app.model?.offset.toArray() ?? [0, 0, 0];
    return this.app.zones.map((zone) => ({ label: zone.name, points: zone.points.map((point) => new Vector3(...toViewerPoint(point, offset)).setY(this.app.sketch.height)) }));
  }

  private toggleSketch(): void {
    const { app } = this;
    const model = app.model;
    if (!model) return;
    if (app.tool === 'sketch' && app.sketch.mode === 'polygon') {
      app.setTool('select');
      return;
    }
    app.sketch.start('polygon', model.box.isEmpty() ? 0 : model.box.min.y);
    app.sketch.shapes = this.shapes();
    app.sketch.onPolygon = (points) => {
      const name = window.prompt('Nom de la zone', `Zone ${app.zones.length + 1}`)?.trim();
      if (!name) return;
      const offset = model.offset.toArray();
      const zone: Zone = { name, points: points.map((point) => toModelPoint(point.toArray(), offset)) };
      app.setZones([...app.zones, zone]);
      app.sketch.shapes = this.shapes();
    };
    app.setTool('sketch');
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
    const indices = app.selection.size > 0 ? [...app.selection] : Array.from({ length: model.count }, (_, i) => i).filter((i) => model.state.isRendered(i));
    const keys = indices.map((index) => model.keys[index]);
    const footprints: ([number, number][] | null)[] = [];
    // Emprises (enveloppe convexe en plan) par tranches : la maquette entière peut y passer.
    function* job(): Generator<number, void, unknown> {
      let work = 0;
      for (let k = 0; k < indices.length; k++) {
        const parts = model!.parts(indices[k]);
        footprints.push(measureElement(parts)?.hull ?? null);
        for (const part of parts) work += part.count / 3;
        if (work > 60_000) {
          work = 0;
          yield (k + 1) / indices.length;
        }
      }
    }
    this.assign.disabled = true;
    try {
      await runSliced(job(), (progress) => (this.report.textContent = `Calcul des emprises… ${Math.round(progress * 100)} %`));
      if (model !== app.model || indices.some((index, k) => model.keys[index] !== keys[k])) {
        this.report.textContent = 'Le modèle a changé pendant le calcul : relancez-le.';
        return;
      }
      const offset = model.offset.toArray();
      const zones = app.zones.map((zone) => zone.points.map((point): [number, number] => [point[0] - offset[0], point[2] - offset[2]]));
      const assigned = assignZones(footprints, zones);
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
