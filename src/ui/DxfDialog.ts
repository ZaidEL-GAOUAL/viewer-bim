import { evaluateAppearanceRules } from '../data/appearanceRules.ts';
import { isMissing, valueAt } from '../data/conditions.ts';
import { NO_VALUE_LAYER, layerName, nearestAci, writeDxf, type DxfDrawing, type DxfLayer, type DxfLine, type DxfPolyline, type DxfTextItem } from '../data/dxf.ts';
import { withoutExtension } from '../engine/fileKinds.ts';
import { cadFrame, cutPaths } from '../engine/cutPaths.ts';
import { runSliced } from '../engine/sliced.ts';
import { integer, plural } from '../data/text.ts';
import type { App } from './App.ts';
import { button, clear, download, h } from './dom.ts';
import { viewFacts } from './printJob.ts';

export interface DxfOptions {
  /** La propriété dont la valeur nomme le calque de chaque élément ; null : un seul calque. */
  property: string | null;
  /** Ajouter des textes : la vue, l'altitude ou le repère de la coupe. */
  notes: boolean;
}

export const NO_PLANE_REASON = 'Ouvrez un plan ou une coupe vue de face : le DXF contient les lignes de coupe de la vue.';

/**
 * Le DXF de la coupe vue de face (un plan d'étage ou une coupe). Les mètres sont ceux du modèle d'origine, passés en axes de
 * CAO (Z vers le haut : (x, y, z) du modèle en Y vers le haut devient (x, −z, y)).
 * - Un plan horizontal est posé dans le plan XY à sa taille réelle, à son altitude : deux niveaux se superposent en CAO.
 * - Une coupe verticale est mise à plat dans XY avec son propre repère : X vers la droite de la vue, Y l'altitude réelle
 *   (une note le dit).
 * Un calque par valeur de la propriété choisie, de la couleur de la règle de couleur qui s'applique à ses éléments.
 */
export async function buildDxf(app: App, options: DxfOptions, onProgress: (progress: number) => void = () => {}, signal?: AbortSignal): Promise<DxfDrawing & { count: number }> {
  const { model } = app;
  const plane = viewFacts(app).facing[0];
  if (!model || !plane) throw new Error(NO_PLANE_REASON);
  const paths = await runSliced(cutPaths(model, plane), onProgress, signal);
  const { horizontal, toCad } = cadFrame(plane, model.offset);

  const identity = { keys: model.keys, label: (index: number) => app.elementLabel(index) };
  const colours = app.appearanceRules.length > 0 ? evaluateAppearanceRules(app.store, app.appearanceRules, identity) : null;
  const layers = new Map<string, DxfLayer>();
  const layerOf = (element: number): string => {
    const value = options.property ? valueAt(app.store, identity, element, options.property) : undefined;
    const name = options.property ? (isMissing(value) ? NO_VALUE_LAYER : layerName(value)) : 'Coupe';
    const colour = colours?.get(element)?.color;
    const existing = layers.get(name);
    if (!existing) layers.set(name, { name, color: colour ? nearestAci(colour) : 7 });
    else if (colour && existing.color === 7) existing.color = nearestAci(colour);
    return name;
  };

  const polylines: DxfPolyline[] = [], lines: DxfLine[] = [];
  const min = [Infinity, Infinity], max = [-Infinity, -Infinity];
  let elevation: number | undefined;
  for (const path of paths) {
    const layer = layerOf(path.element);
    const points: [number, number][] = [];
    for (let i = 0; i < path.points.length; i += 2) {
      const [x, y, z] = toCad(path.points[i], path.points[i + 1]);
      points.push([x, y]);
      elevation = horizontal ? z : undefined;
      min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y);
    }
    if (path.closed) polylines.push({ layer, points, closed: true, elevation });
    else for (let i = 0; i + 1 < points.length; i++) lines.push({ layer, from: points[i], to: points[i + 1], elevation });
  }

  const texts: DxfTextItem[] = [];
  if (options.notes && paths.length > 0) {
    const name = app.activeView?.name ?? 'Vue courante';
    const size = Math.max(0.1, Math.round(Math.max(max[0] - min[0], max[1] - min[1]) / 80 * 100) / 100);
    const notes = [`Vue : ${name}`, horizontal
      ? `Plan de coupe à Z = ${(elevation ?? 0).toFixed(3)} m, coordonnées d'origine du modèle (Z vers le haut), unités : mètres.`
      : 'Coupe verticale mise à plat : X vers la droite de la vue, Y = altitude réelle (m), Z = 0 ; repère propre à cette coupe, unités : mètres.'];
    notes.forEach((text, i) => texts.push({ layer: 'Notes', x: min[0], y: min[1] - size * 2 * (i + 1), height: size, text, elevation: horizontal ? elevation : undefined }));
    layers.set('Notes', { name: 'Notes', color: 7 });
  }
  return { layers: [...layers.values()], polylines, lines, texts, count: paths.length };
}

/** Carte « DXF » : la propriété qui nomme les calques, les textes, l'export. */
export class DxfDialog {
  readonly label = 'DXF (AutoCAD, BricsCAD, Revit)';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly property = h('select', { attrs: { 'aria-label': 'Propriété des calques' } });
  private readonly notes = h('input', { attrs: { type: 'checkbox', checked: '' } });
  private readonly status = h('p', { class: 'hint' });
  private readonly run: HTMLButtonElement;

  constructor(app: App) {
    this.app = app;
    this.run = button('Exporter le DXF', () => void this.export(), { class: 'primary' });
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer l’export DXF' } })),
      h('p', { class: 'hint', text: 'Les lignes de coupe du plan ou de la coupe affichée, en mètres, à leur taille réelle. Pas de DWG : le DXF s’ouvre dans AutoCAD, BricsCAD et Revit.' }),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Calques par' }), this.property),
      h('label', { class: 'tool-check' }, this.notes, h('span', { text: 'Ajouter les textes (vue, altitude, repère)' })),
      this.status,
      h('div', { class: 'dimensions-actions' }, this.run));
    for (const event of ['model', 'view', 'grouping'] as const) app.on(event, () => this.sync());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) this.sync();
    return open;
  }

  /** Remplit la liste des propriétés (la première du regroupement par défaut) et dit si la vue peut s'exporter. */
  private sync(): void {
    const { app } = this;
    if (this.el.hidden) return;
    const chosen = this.property.value || app.grouping[0] || '';
    clear(this.property);
    this.property.append(h('option', { text: 'Un seul calque', attrs: { value: '' } }), ...app.store.paths.map((path) => h('option', { text: path, attrs: { value: path } })));
    this.property.value = app.store.paths.includes(chosen) ? chosen : '';
    const ready = app.model !== null && !app.mapOpen && viewFacts(app).facing.length > 0;
    this.run.disabled = !ready;
    this.status.textContent = ready ? '' : NO_PLANE_REASON;
  }

  private async export(): Promise<void> {
    const { app } = this;
    this.run.disabled = true;
    try {
      app.busy('Export DXF…');
      const drawing = await buildDxf(app, { property: this.property.value || null, notes: this.notes.checked }, (progress) => app.busy(`Export DXF… ${Math.round(progress * 100)} %`));
      if (drawing.count === 0) {
        app.toast('Rien n’est coupé par ce plan : aucun fichier écrit.', true);
        return;
      }
      const view = app.activeView?.name ?? 'coupe';
      download(new Blob([writeDxf(drawing)], { type: 'application/dxf' }), `${withoutExtension(app.fileName || 'maquette')} - ${view}.dxf`.replace(/[\\/:*?"<>|]/g, '_'));
      app.toast(`DXF écrit : ${plural(drawing.polylines.length, 'boucle')} et ${plural(drawing.lines?.length ?? 0, 'segment')} sur ${integer.format(drawing.layers.length)} calque${drawing.layers.length > 1 ? 's' : ''}.`);
    } catch (error) {
      app.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      app.busy(null);
      this.sync();
    }
  }
}
