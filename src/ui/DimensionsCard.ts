import { Box3, Vector3 } from 'three';
import { combineMeasures, measureElement, type Dimensions, type ElementMeasure } from '../engine/dimensions.ts';
import { formatArea, formatLength, formatVolume } from '../engine/Measure.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';

/** Au-delà, seule l'emprise de la sélection est donnée : le calcul ferait attendre. */
const MAX_ELEMENTS = 2000;
const MAX_TRIANGLES = 1_500_000;
/** Lignes détaillées affichées ; le tableau copié contient toujours tous les éléments mesurés. */
const MAX_ROWS = 200;

const decimal = new Intl.NumberFormat('fr-FR', { useGrouping: false, maximumFractionDigits: 4 });

/**
 * Carte « Cotes » de l'outil de mesure du même nom : longueur, largeur, hauteur, surface et
 * volume de la sélection, calculés depuis le maillage. Une sélection de plusieurs éléments donne
 * l'ensemble puis chaque élément. Les mesures sont gardées par élément tant que le modèle reste
 * le même : agrandir une sélection ne recalcule que les nouveaux éléments.
 */
export class DimensionsCard {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly body: HTMLElement;
  private readonly cache = new Map<number, ElementMeasure | null>();
  private table = '';

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'dimensions-body' });
    this.el = h('section', { class: 'card dimensions-card', attrs: { hidden: '', 'aria-live': 'polite' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Cotes' }),
        button('×', () => app.setTool('select'), { class: 'measure-remove', title: 'Fermer les cotes', attrs: { 'aria-label': 'Fermer les cotes' } }),
      ),
      this.body,
    );
    app.on('model', () => {
      this.cache.clear();
      this.render();
    });
    app.on('selection', () => this.render());
    app.on('tool', () => this.render());
  }

  private measure(index: number): ElementMeasure | null {
    if (!this.cache.has(index)) this.cache.set(index, measureElement(this.app.model!.parts(index)));
    return this.cache.get(index)!;
  }

  private render(): void {
    const { app } = this;
    this.el.hidden = app.tool !== 'dimensions';
    if (this.el.hidden) return;
    clear(this.body);
    this.table = '';
    const model = app.model;
    const indices = [...app.selection];
    if (!model || indices.length === 0) {
      this.body.append(h('p', { class: 'hint', text: 'Cliquez un élément dans la vue ou l’arborescence ; Ctrl, Cmd ou Maj + clic pour en ajouter.' }));
      return;
    }

    let triangles = 0;
    for (const index of indices) for (const range of model.ranges[index]) triangles += range.count / 3;
    if (indices.length > MAX_ELEMENTS || triangles > MAX_TRIANGLES) {
      const size = model.boxOf(indices, new Box3()).getSize(new Vector3());
      this.body.append(
        h('p', { class: 'dimensions-title', text: `${integer.format(indices.length)} éléments` }),
        this.list([['Emprise X', formatLength(size.x)], ['Hauteur', formatLength(size.y)], ['Emprise Z', formatLength(size.z)]]),
        h('p', { class: 'hint', text: 'Sélection trop grande pour la surface et le volume : seule l’emprise est donnée.' }),
      );
      return;
    }

    const measured: { index: number; measure: ElementMeasure }[] = [];
    for (const index of indices) {
      const measure = this.measure(index);
      if (measure) measured.push({ index, measure });
    }
    const total = combineMeasures(measured.map((item) => item.measure));
    if (!total) {
      this.body.append(h('p', { class: 'hint', text: 'Aucune géométrie dans la sélection.' }));
      return;
    }

    const single = indices.length === 1;
    this.body.append(h('p', { class: 'dimensions-title', text: single ? app.elementLabel(indices[0]) : `Ensemble de ${integer.format(indices.length)} éléments` }));
    this.body.append(this.list(this.rows(total, !single)));
    if (!single) this.body.append(this.details(measured));

    const notes = ['Longueur et largeur : rectangle minimal au sol, quelle que soit l’orientation.'];
    if (!single) notes.push('Ensemble : emprise commune, surfaces et volumes additionnés.');
    if (!total.closed) notes.push('« approx. » : maillage non fermé, surface et volume approchés.');
    if (measured.length < indices.length) notes.push(`${integer.format(indices.length - measured.length)} élément(s) sans géométrie ignoré(s).`);
    this.body.append(h('p', { class: 'hint', text: notes.join(' ') }));

    this.table = this.tsv(measured, total, single);
    const copy = button('Copier le tableau', () => void this.copy(copy), { title: 'Copier les cotes (une ligne par élément) pour un tableur' });
    this.body.append(h('div', { class: 'dimensions-actions' }, copy));
  }

  private rows(dims: Dimensions, group: boolean): [string, string][] {
    const approx = dims.closed ? '' : ' (approx.)';
    return [
      ['Longueur', formatLength(dims.length)],
      ['Largeur', formatLength(dims.width)],
      ['Hauteur', formatLength(dims.height)],
      [group ? 'Surface (somme)' : 'Surface', formatArea(dims.area) + approx],
      [group ? 'Volume (somme)' : 'Volume', formatVolume(dims.volume) + approx],
    ];
  }

  private list(rows: [string, string][]): HTMLElement {
    const list = h('dl', { class: 'props dimensions-props' });
    for (const [name, value] of rows) list.append(h('dt', { text: name, title: name }), h('dd', { text: value, title: value }));
    return list;
  }

  /** Une ligne par élément ; cliquer une ligne cadre la vue sur l'élément. */
  private details(measured: { index: number; measure: ElementMeasure }[]): HTMLElement {
    const list = h('ol', { class: 'dimensions-list' });
    for (const { index, measure } of measured.slice(0, MAX_ROWS)) {
      const dims = combineMeasures([measure])!;
      const approx = dims.closed ? '' : ' ~';
      const name = this.app.elementLabel(index);
      const line = `${formatLength(dims.length)} × ${formatLength(dims.width)} × ${formatLength(dims.height)} · ${formatArea(dims.area)}${approx} · ${formatVolume(dims.volume)}${approx}`;
      const row = h('button', { class: 'dimensions-row', title: `Cadrer « ${name} »`, attrs: { type: 'button' } },
        h('span', { class: 'dimensions-name', text: name }),
        h('span', { class: 'dimensions-values', text: line }),
      );
      row.addEventListener('click', () => this.app.fitTo([index]));
      list.append(h('li', {}, row));
    }
    const wrap = h('div', { class: 'dimensions-details' }, h('p', { class: 'dimensions-caption', text: 'Par élément : longueur × largeur × hauteur · surface · volume' }), list);
    if (measured.length > MAX_ROWS) wrap.append(h('p', { class: 'hint', text: `… et ${integer.format(measured.length - MAX_ROWS)} autres, présents dans le tableau copié.` }));
    return wrap;
  }

  private tsv(measured: { index: number; measure: ElementMeasure }[], total: Dimensions, single: boolean): string {
    const n = (value: number) => decimal.format(value);
    const header = ['Nom', 'Identifiant', 'Longueur (m)', 'Largeur (m)', 'Hauteur (m)', 'Surface (m²)', 'Volume (m³)', 'Maillage fermé'];
    const lines = [header.join('\t')];
    for (const { index, measure } of measured) {
      const dims = combineMeasures([measure])!;
      lines.push([this.app.elementLabel(index), this.app.model!.keys[index], n(dims.length), n(dims.width), n(dims.height), n(dims.area), n(dims.volume), dims.closed ? 'oui' : 'non'].join('\t'));
    }
    if (!single) lines.push(['Ensemble', '', n(total.length), n(total.width), n(total.height), n(total.area), n(total.volume), total.closed ? 'oui' : 'non'].join('\t'));
    return lines.join('\n');
  }

  private async copy(trigger: HTMLButtonElement): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.table);
      trigger.textContent = 'Copié';
    } catch {
      trigger.textContent = 'Copie impossible';
    }
    window.setTimeout(() => (trigger.textContent = 'Copier le tableau'), 1500);
  }
}
