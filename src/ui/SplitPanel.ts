import { Box3 } from 'three';
import { toModelPoint, type Vec3 } from '../data/modelFrame.ts';
import { sourceIndexOf } from '../data/federation.ts';
import { MAX_CUTS, MIN_INTERVAL, describeOutcome, type OriginalOf, type SplitDefinition, type SplitReferences } from '../data/splits.ts';
import { integer, plural } from '../data/text.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { newViewId } from './userViews.ts';

type Mode = 'lines' | 'levels' | 'axis';

/**
 * Carte « Découpage en pièces » : les éléments sélectionnés sont coupés en pièces le long de lignes dessinées en plan (chacune
 * de part en part), aux niveaux du modèle, ou le long d'un axe (N parts égales, un pas, des positions). Les pièces deviennent
 * des éléments (propriétés de l'original, `Pièce / …`, quantités propres) ; l'original est masqué, jamais modifié.
 * « Retirer le découpage » le rétablit : c'est l'inverse d'un découpage, qui n'est pas une étape d'« Annuler ». Deux pièces
 * voisines se réunissent. Désactivé en mode carte : le globe dessine sa propre copie de la maquette.
 */
export class SplitPanel {
  readonly label = 'Découpage en pièces';
  readonly summary = 'Couper des éléments en pièces : lignes, niveaux, axe';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly mode = h('select', { attrs: { 'aria-label': 'Comment couper' } },
    h('option', { text: 'Lignes dessinées en plan', attrs: { value: 'lines' } }),
    h('option', { text: 'Aux niveaux', attrs: { value: 'levels' } }),
    h('option', { text: 'Le long d’un axe', attrs: { value: 'axis' } }));
  private readonly lines = h('div');
  private readonly levels = h('div', { class: 'tool-checks' });
  private readonly axis = h('select', { attrs: { 'aria-label': 'Axe' } }, h('option', { text: 'Le long de X (est)', attrs: { value: 'x' } }), h('option', { text: 'Le long de Y (nord)', attrs: { value: 'z' } }));
  private readonly kind = h('select', { attrs: { 'aria-label': 'Répartition' } },
    h('option', { text: 'Parts égales (nombre)', attrs: { value: 'count' } }),
    h('option', { text: 'Tous les … m', attrs: { value: 'interval' } }),
    h('option', { text: 'À … m du bord ouest ou sud (liste)', attrs: { value: 'positions' } }));
  private readonly amount = h('input', { attrs: { type: 'text', value: '4', 'aria-label': 'Valeur', inputmode: 'decimal' } });
  private readonly status = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly report = h('div', { class: 'hint' });
  private readonly list = h('div', { class: 'views-list' });
  private readonly draw: HTMLButtonElement;
  private readonly run: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly merge: HTMLButtonElement;
  private controller: AbortController | null = null;
  /** La liste de niveaux dont les cases sont affichées. */
  private shownLevels: readonly unknown[] | null = null;

  constructor(app: App) {
    this.app = app;
    this.draw = button('Dessiner les lignes', () => this.toggleSketch(), { attrs: { 'aria-pressed': 'false' }, title: 'Vue de dessus conseillée (2D, puis « Haut »)' });
    this.run = button('Découper', () => void this.split(), { class: 'primary' });
    this.stop = button('Arrêter', () => this.controller?.abort(), { attrs: { hidden: '' } });
    this.merge = button('Réunir les 2 pièces sélectionnées', () => this.mergeSelected(), { title: 'Deux pièces voisines d’un même élément deviennent une seule (celle du plus petit numéro)' });
    this.lines.append(h('div', { class: 'tool-row' }, this.draw, button('Effacer les lignes', () => app.sketch.clearLines())));
    this.mode.addEventListener('change', () => this.sync());
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer le découpage' } })),
      this.status,
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Couper' }), this.mode),
      this.lines, this.levels,
      h('div', { class: 'tool-axis' }, this.axis, this.kind, this.amount),
      h('div', { class: 'dimensions-actions' }, this.stop, this.run),
      this.report,
      h('p', { class: 'field-label', text: 'Découpages' }), this.list, this.merge,
      h('p', { class: 'hint', text: 'Avec plusieurs maquettes, seuls les éléments de la première se découpent.' }),
      h('p', { class: 'hint', text: 'Les pièces copient les propriétés de l’original et reçoivent « Pièce / Numéro », « Pièce / Séquence » (à modifier pour l’ordre du planning) et leurs propres quantités. Elles s’enregistrent comme une définition de coupe avec « JSON ↓ » et « Modifications ↓ » ; « GLB ↓ » contient les pièces à la place des originaux.' }),
    );
    app.sketch.onChange = () => this.sync();
    for (const event of ['selection', 'model', 'metadata', 'tool'] as const) app.on(event, () => this.sync());
    this.sync();
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (!open && this.app.tool === 'sketch' && this.app.sketch.mode === 'lines') this.app.setTool('select');
    if (open) this.sync();
    return open;
  }

  private get blocked(): string {
    const { app } = this;
    if (!app.model || !app.splits) return 'Ouvrez d’abord un modèle.';
    if (app.mapOpen) return 'Fermez la carte pour découper : le globe dessine sa propre copie de la maquette, qui ne suit pas les pièces.';
    return '';
  }

  private sync(): void {
    if (this.el.hidden) return;
    const { app } = this;
    const mode = this.mode.value as Mode;
    const blocked = this.blocked;
    const originals = this.originals();
    this.status.textContent = blocked || (originals.length > 0 ? `${plural(originals.length, 'élément sélectionné', 'éléments sélectionnés')} à découper.` : 'Sélectionnez les éléments à découper.');
    this.lines.hidden = mode !== 'lines';
    this.levels.hidden = mode !== 'levels';
    (this.axis.parentElement as HTMLElement).hidden = mode !== 'axis';
    const sketching = app.tool === 'sketch' && app.sketch.mode === 'lines';
    this.draw.setAttribute('aria-pressed', String(sketching));
    this.draw.textContent = sketching ? 'Terminer le tracé' : `Dessiner les lignes${app.sketch.lines.length ? ` (${app.sketch.lines.length})` : ''}`;
    this.draw.disabled = blocked !== '';
    this.run.disabled = blocked !== '' || this.controller !== null || originals.length === 0 || (mode === 'lines' && app.sketch.lines.length === 0);
    if (mode === 'levels' && this.shownLevels !== app.levels) {
      this.shownLevels = app.levels;
      clear(this.levels);
      if (app.levels.length === 0) this.levels.append(h('p', { class: 'hint', text: 'Ce modèle n’a pas de niveaux (section « levels » de ses métadonnées).' }));
      for (const level of app.levels) this.levels.append(h('label', { class: 'tool-check' }, h('input', { attrs: { type: 'checkbox', value: level.name } }), `${level.name} (${level.elevation.toLocaleString('fr-FR')} m)`));
    }
    const pair = [...app.selection];
    const model = app.model;
    this.merge.hidden = !(pair.length === 2 && model && model.parents[pair[0]] >= 0 && model.parents[pair[0]] === model.parents[pair[1]]);
    this.merge.disabled = blocked !== '';
    this.renderList();
  }

  private renderList(): void {
    const { app } = this;
    const model = app.model, splits = app.splits;
    clear(this.list);
    if (!model || !splits || splits.definitions.length === 0) {
      this.list.append(h('p', { class: 'hint', text: 'Aucun découpage.' }));
      return;
    }
    splits.definitions.forEach((definition, index) => {
      const keys = new Set(definition.elements);
      const parts = model.parents.flatMap((parent, i) => (parent >= 0 && keys.has(model.keys[parent]) ? [i] : []));
      const how = definition.lines ? plural(definition.lines.length, 'ligne') : definition.references?.levels ? `niveaux ${definition.references.levels.join(', ')}` : 'le long d’un axe';
      const item = button('', () => { app.select(parts, 'panel'); if (parts.length) app.fitTo(parts); }, { class: 'view-item', title: 'Sélectionner les pièces' });
      item.append(h('span', { class: 'view-name', text: `Découpage ${index + 1} : ${plural(parts.length, 'pièce')}` }), h('span', { class: 'view-note', text: `${plural(definition.elements.length, 'élément')} · ${how}` }));
      const remove = button('×', () => this.remove(definition.id), { class: 'view-action', title: 'Retirer le découpage : les pièces disparaissent, les originaux reviennent', attrs: { 'aria-label': `Retirer le découpage ${index + 1}` } });
      remove.disabled = this.blocked !== '';
      this.list.append(h('div', { class: 'view-row' }, item, remove));
    });
  }

  /**
   * Les éléments sélectionnés à découper : des éléments du fichier, de la première maquette seulement quand il y en a
   * plusieurs (les découpages s'enregistrent avec elle, voir data/federation.ts).
   */
  private originals(): number[] {
    const model = this.app.model;
    if (!model) return [];
    return [...this.app.selection].filter((i) => model.parents[i] < 0 && sourceIndexOf(model, i) <= 0);
  }

  private toggleSketch(): void {
    const { app } = this;
    if (app.tool === 'sketch' && app.sketch.mode === 'lines') {
      app.setTool('select');
      return;
    }
    const model = app.model;
    if (!model) return;
    const box = model.boxOf(app.selection.size ? app.selection : Array.from({ length: model.count }, (_, i) => i), new Box3());
    app.sketch.start('lines', box.isEmpty() ? model.box.max.y : box.max.y);
    app.setTool('sketch');
  }

  private source(): OriginalOf {
    const { app } = this;
    return (i) => ({ props: app.store.propsOf(i), label: app.elementLabel(i) });
  }

  /** La définition décrite par la carte, ou la raison pour laquelle elle ne l'est pas. */
  private definition(elements: number[]): SplitDefinition | string {
    const { app } = this;
    const model = app.model!;
    const offset = model.offset.toArray();
    const base = { id: newViewId(), elements: elements.map((i) => model.keys[i]) };
    const mode = this.mode.value as Mode;
    if (mode === 'lines' && app.sketch.lines.length > MAX_CUTS) return `Au plus ${MAX_CUTS} lignes par découpage.`;
    if (mode === 'lines') return { ...base, lines: app.sketch.lines.map(([a, b]) => [toModelPoint(a.toArray(), offset), toModelPoint(b.toArray(), offset)] as [Vec3, Vec3]) };
    if (mode === 'levels') {
      const levels = [...this.levels.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
      return levels.length > 0 ? { ...base, references: { levels } } : 'Cochez au moins un niveau.';
    }
    const axis = this.axis.value as 'x' | 'z';
    const values = this.amount.value.split(/[;\s]+/).filter(Boolean).map((text) => Number(text.replace(',', '.'))).filter(Number.isFinite);
    const references: SplitReferences = { axis };
    if (this.kind.value === 'count') {
      if (!Number.isInteger(values[0]) || values[0] < 2 || values[0] > MAX_CUTS) return `Un nombre de parts entier, de 2 à ${MAX_CUTS}.`;
      references.count = values[0];
    } else if (this.kind.value === 'interval') {
      if (!(values[0] >= MIN_INTERVAL)) return 'Un pas en mètres, d’au moins 1 cm (0,01).';
      references.interval = values[0];
    } else {
      if (values.length === 0) return 'Une ou plusieurs distances en mètres, séparées par « ; ».';
      if (values.length > MAX_CUTS) return `Au plus ${MAX_CUTS} distances.`;
      // Des distances depuis le bord ouest (X) ou sud (Y, le nord étant −Z) de la sélection, en coordonnées du modèle.
      const box = model.boxOf(elements, new Box3());
      references.positions = values.map((d) => (axis === 'x' ? box.min.x + d + offset[0] : box.max.z - d + offset[2]));
    }
    return { ...base, references };
  }

  private async split(): Promise<void> {
    const { app } = this;
    const model = app.model, splits = app.splits;
    if (!model || !splits || this.blocked) return;
    const elements = this.originals();
    const definition = this.definition(elements);
    if (typeof definition === 'string') {
      this.report.textContent = definition;
      return;
    }
    const controller = (this.controller = new AbortController());
    this.stop.hidden = false;
    this.sync();
    try {
      const outcome = await runSliced(splits.compute(definition, app.levels), (progress) => (this.report.textContent = `Découpage… ${Math.round(progress * 100)} %`), controller.signal);
      if (model !== app.model || app.mapOpen) return;
      const notes = describeOutcome(outcome, (i) => app.elementLabel(i));
      if (outcome.splits.length === 0) {
        this.report.textContent = ['Rien n’a été découpé.', ...notes].join(' ');
        return;
      }
      // Seuls les éléments effectivement coupés entrent dans la définition enregistrée.
      const done = { ...definition, elements: outcome.splits.map((split) => model.keys[split.element]) };
      app.changeParts(splits.put(done, outcome.splits, this.source()));
      const parts = model.parents.flatMap((parent, i) => (outcome.splits.some((split) => split.element === parent) ? [i] : []));
      const invalid = parts.filter((i) => app.store.propsOf(i)?.['Pièce / Maillage valide'] === false).length;
      this.report.textContent = [`${plural(outcome.splits.length, 'élément découpé', 'éléments découpés')} en ${plural(parts.length, 'pièce')}.`,
        invalid ? `${integer.format(invalid)} pièce${invalid > 1 ? 's' : ''} au maillage non valide : quantités indicatives.` : '', ...notes].filter(Boolean).join(' ');
      if (this.mode.value === 'lines') {
        app.sketch.clearLines();
        if (app.tool === 'sketch') app.setTool('select');
      }
      app.select(parts, 'panel');
    } catch (error) {
      this.report.textContent = controller.signal.aborted ? 'Découpage arrêté : rien n’a changé.' : `Découpage impossible : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.controller = null;
      this.stop.hidden = true;
      this.sync();
    }
  }

  private remove(id: string): void {
    const { app } = this;
    if (!app.splits || this.blocked) return;
    const change = app.splits.remove(id, this.source());
    if (change) app.changeParts(change);
    this.report.textContent = 'Découpage retiré : les originaux sont de retour.';
  }

  private mergeSelected(): void {
    const { app } = this;
    if (!app.splits || this.blocked) return;
    const [a, b] = [...app.selection];
    const result = app.splits.mergeDefinition(a, b);
    if (typeof result === 'string') {
      this.report.textContent = `Réunion impossible : ${result}.`;
      return;
    }
    app.changeParts(app.splits.put(result.definition, null, this.source(), result.renew));
    const key = result.renew[0];
    app.select([app.model!.keys.indexOf(key)], 'panel');
    this.report.textContent = `Pièces réunies dans « ${key} » ; ses propriétés repartent de l’original.`;
  }
}
