import { Box3 } from 'three';
import { COMPARE_COLORS, compareCsv, compareJob, compareReport, elementSignature, statusLayer, type CompareResult, type CompareSide, type ComparedPair } from '../data/compare.ts';
import { framesApart, framesNotice, sourceBox, sourceIndexOf, sourceKey } from '../data/federation.ts';
import { formatValue } from '../data/metadata.ts';
import { integer } from '../data/text.ts';
import { filesFromList } from '../engine/loadModel.ts';
import { runSliced } from '../engine/sliced.ts';
import { addModelFiles, federationBlocked, removeLastModel } from './addModel.ts';
import type { App } from './App.ts';
import { button, clear, download, h } from './dom.ts';
import { MODEL_ACCEPT } from './ModelsPanel.ts';

/** Éléments montrés par statut ; les exports les contiennent tous. */
const MAX_ROWS = 200;

interface Shown {
  result: CompareResult;
  current: CompareSide;
  reference: CompareSide;
  /** `App.revision` du calcul : une renumérotation le rend périmé. */
  revision: number;
  notes: string[];
}

/**
 * Carte « Comparaison » : « Comparer avec… » charge l'autre version comme maquette de référence (voir data/federation.ts)
 * et la compare à la maquette ouverte (data/compare.ts) : ajoutés en vert, supprimés en rouge translucide (dessinés depuis
 * la référence), modifiés en orange, inchangés estompés. C'est un état passager de l'affichage, pas une propriété. Arbre par
 * statut, tableau avant / après de l'élément sélectionné, rapport CSV et JSON. Désactivée en mode carte.
 */
export class ComparePanel {
  readonly label = 'Comparaison';
  readonly summary = 'Comparer avec une autre version : ajouts, suppressions, modifications';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly input = h('input', { attrs: { type: 'file', multiple: '', accept: MODEL_ACCEPT, hidden: '' } });
  private readonly ignore = h('input', { attrs: { type: 'text', 'aria-label': 'Propriétés ignorées', placeholder: 'Révision ; Date* ; Qto_*' } });
  private readonly category = h('input', { attrs: { type: 'text', 'aria-label': 'Propriété de catégorie', list: 'compare-paths' } });
  private readonly paths = h('datalist', { attrs: { id: 'compare-paths' } });
  private readonly status = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly results = h('div', { class: 'requirement-results' });
  private readonly detail = h('div');
  private readonly run: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private controller: AbortController | null = null;
  private shown: Shown | null = null;

  constructor(app: App) {
    this.app = app;
    this.input.addEventListener('change', () => {
      const files = this.input.files?.length ? filesFromList(this.input.files) : [];
      this.input.value = '';
      if (files.length) void this.loadReference(files);
    });
    this.run = button('Comparer', () => void this.compare(), { class: 'primary', title: 'Comparer la maquette ouverte à la version de référence chargée' });
    this.stop = button('Arrêter', () => this.controller?.abort(), { attrs: { hidden: '' } });
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer la comparaison' } })),
      this.status,
      h('div', { class: 'tool-row' }, button('Comparer avec…', () => this.chooseReference(), { title: 'Charger l’ancienne version (.ifc, .glb, .usdz, avec son .json) et la comparer à celle qui est ouverte' }), this.input),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Ignorer' }), this.ignore),
      h('label', { class: 'tool-field', title: 'Pour reconnaître un élément dont l’identifiant a changé : même valeur de cette propriété, même nom, même forme' },
        h('span', { class: 'field-label', text: 'Catégorie' }), this.category, this.paths),
      h('div', { class: 'dimensions-actions' }, this.stop, button('Effacer les couleurs', () => this.clearColors()), this.run),
      this.results, this.detail,
      h('p', { class: 'hint', text: 'Les éléments sont appariés par leur identifiant. Une propriété ignorée : son nom exact, une catégorie entière, ou un début suivi de « * ». La géométrie compare la boîte au millimètre, le nombre de triangles, le volume et la surface.' }),
    );
    app.on('model', () => this.reset());
    app.on('metadata', () => {
      if (this.shown && this.shown.revision !== app.revision) {
        this.shown = null;
        this.render('La maquette a changé : relancez la comparaison.');
      }
    });
    app.on('selection', () => this.renderDetail());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) {
      if (!this.category.value) this.category.value = this.app.grouping[0] ?? '';
      clear(this.paths);
      for (const path of this.app.store.paths) this.paths.append(h('option', { attrs: { value: path } }));
      this.render();
    }
    return open;
  }

  private reset(): void {
    this.controller?.abort();
    this.shown = null;
    this.render();
  }

  private get referenceIndex(): number {
    return this.app.model?.sources.findIndex((source) => source.role === 'reference') ?? -1;
  }

  private chooseReference(): void {
    const blocked = federationBlocked(this.app);
    if (blocked) this.app.toast(blocked, true);
    else this.input.click();
  }

  /** Charge l'autre version comme référence (une seule à la fois : la précédente, si elle est la dernière, est retirée). */
  private async loadReference(files: ReturnType<typeof filesFromList>): Promise<void> {
    const { app } = this;
    const model = app.model;
    const existing = this.referenceIndex;
    if (model && existing >= 0) {
      if (existing !== model.sources.length - 1) {
        app.toast('Une version de référence est déjà chargée : retirez d’abord les maquettes ajoutées après elle (carte « Maquettes »).', true);
        return;
      }
      app.setTransient(null);
      removeLastModel(app);
    }
    if (await addModelFiles(app, files, 'reference')) await this.compare();
    else this.render();
  }

  /** Les deux côtés : la maquette ouverte (ses éléments du fichier, sans les pièces) et la référence. */
  private sides(): { current: CompareSide; reference: CompareSide } | string {
    const { app } = this;
    const model = app.model;
    if (!model) return 'Ouvrez d’abord une maquette.';
    const index = this.referenceIndex;
    if (index < 0) return 'Chargez l’autre version avec « Comparer avec… ».';
    const offset = model.offset.toArray();
    const category = this.category.value.trim();
    const current: number[] = [], reference: number[] = [];
    for (let i = 0; i < model.count; i++) {
      if (model.parents[i] >= 0) continue;
      (sourceIndexOf(model, i) === index ? reference : current).push(i);
    }
    const side = (elements: number[]): CompareSide => ({
      elements,
      key: (i) => sourceKey(model.keys[i], model.sources[sourceIndexOf(model, i)]),
      label: (i) => app.elementLabel(i),
      props: (i) => app.store.propsOf(i),
      category: category ? (i) => app.store.displayValue(i, category) : undefined,
      signature: (i) => elementSignature(model, i, offset),
      cost: (i) => model.ranges[i].reduce((sum, range) => sum + range.count / 3, 0),
    });
    return { current: side(current), reference: side(reference) };
  }

  private async compare(): Promise<void> {
    const { app } = this;
    const model = app.model;
    const blocked = app.mapOpen ? 'Fermez la carte pour comparer : le globe dessine sa propre copie de la maquette.' : '';
    const sides = blocked || this.sides();
    if (typeof sides === 'string') {
      this.render(sides);
      return;
    }
    const revision = app.revision;
    const controller = (this.controller = new AbortController());
    this.stop.hidden = false;
    this.run.disabled = true;
    try {
      const ignore = this.ignore.value.split(/[;,]/).map((part) => part.trim()).filter(Boolean);
      const result = await runSliced(compareJob(sides.current, sides.reference, { ignore }), (progress) => (this.status.textContent = `Comparaison… ${Math.round(progress * 100)} %`), controller.signal);
      if (model !== app.model || revision !== app.revision || !model) return;
      const layer = statusLayer(result);
      // Les pièces d'un original découpé portent son statut : l'original, remplacé, n'est pas dessiné.
      for (let i = 0; i < model.count; i++) {
        const look = model.parents[i] >= 0 ? layer.get(model.parents[i]) : undefined;
        if (look) layer.set(i, look);
      }
      app.setTransient(layer);
      const notes: string[] = [];
      if (result.unpairedShare > 0.5) notes.push(`${integer.format(Math.round(result.unpairedShare * 100))} % des éléments n’ont pas d’équivalent par leur identifiant : les identifiants ont sans doute été régénérés. Les éléments « identifiant changé » sont des rapprochements par nom et par forme, à vérifier.`);
      const reference = model.sources[this.referenceIndex];
      const others = new Box3();
      for (const source of model.sources) if (source !== reference) others.union(sourceBox(model, source));
      const frames = reference ? framesNotice(framesApart(others, sourceBox(model, reference)), reference.name) : '';
      if (frames) notes.push(frames);
      this.shown = { result, ...sides, revision: app.revision, notes };
      this.render();
    } catch (error) {
      this.render(controller.signal.aborted ? 'Comparaison arrêtée.' : `Comparaison impossible : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.controller = null;
      this.stop.hidden = true;
      this.run.disabled = false;
    }
  }

  private clearColors(): void {
    this.app.setTransient(null);
    this.shown = null;
    this.render('Couleurs de la comparaison retirées ; la version de référence reste chargée (carte « Maquettes »).');
  }

  private render(message = ''): void {
    if (this.el.hidden) return;
    const { app } = this;
    clear(this.results);
    const reference = app.model?.sources[this.referenceIndex];
    this.status.textContent = message || federationBlocked(app) || (reference ? `Référence : « ${reference.name} ».` : 'Aucune version de référence chargée.');
    this.run.disabled = this.controller !== null || !reference || app.mapOpen;
    const shown = this.shown;
    if (!shown) return;
    const { result, current, reference: before } = shown;
    const modified = [...new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved])];
    const groups: [string, string, number[]][] = [
      ['Ajoutés', COMPARE_COLORS.added, result.added],
      ['Supprimés', COMPARE_COLORS.removed, result.removed],
      ['Modifiés', COMPARE_COLORS.modified, modified.map((pair) => pair.current)],
      ['Identifiant changé (probablement les mêmes)', COMPARE_COLORS.renamed, result.renamedIds.map((pair) => pair.current)],
      ['Inchangés', COMPARE_COLORS.unchanged, result.unchanged.map((pair) => pair.current)],
    ];
    this.results.append(h('p', { class: 'dimensions-title', text: groups.map(([label, , list]) => `${label.split(' (')[0]} : ${integer.format(list.length)}`).join(' · ') }));
    if (modified.length) this.results.append(h('p', { class: 'hint', text: `Modifiés : ${integer.format(result.modified.properties.length)} aux propriétés changées, ${integer.format(result.modified.moved.length)} déplacés, ${integer.format(result.modified.geometry.length)} à la forme changée.` }));
    for (const note of shown.notes) this.results.append(h('p', { class: 'hint warning', text: note }));
    for (const [label, color, list] of groups) {
      if (list.length === 0) continue;
      const rows = h('ol', { class: 'dimensions-list' });
      const side = label === 'Supprimés' ? before : current;
      for (const element of list.slice(0, MAX_ROWS)) {
        const row = h('button', { class: 'dimensions-row', attrs: { type: 'button' } },
          h('span', { class: 'dimensions-name', text: side.label(element) }), h('span', { class: 'dimensions-values', text: side.key(element) }));
        row.addEventListener('click', () => { app.select([element], 'panel'); app.fitTo([element]); });
        rows.append(h('li', {}, row));
      }
      this.results.append(h('details', {},
        h('summary', {}, h('span', { class: 'compare-swatch', attrs: { style: `background:${color}` } }), `${label} (${integer.format(list.length)})`),
        rows, list.length > MAX_ROWS ? h('p', { class: 'hint', text: `… et ${integer.format(list.length - MAX_ROWS)} autres, dans les exports.` }) : null,
        h('div', { class: 'tool-row' }, button(`Sélectionner (${integer.format(list.length)})`, () => app.select(list, 'panel')))));
    }
    this.results.append(h('div', { class: 'dimensions-actions' },
      button('Exporter en CSV', () => download(new Blob(['﻿', compareCsv(result, current, before)], { type: 'text/csv' }), 'comparaison.csv')),
      button('Exporter en JSON', () => download(new Blob([JSON.stringify(compareReport(result, current, before), null, 2)], { type: 'application/json' }), 'comparaison.json'))));
    this.renderDetail();
  }

  /** Avant / après de l'élément sélectionné. */
  private renderDetail(): void {
    clear(this.detail);
    const shown = this.shown;
    if (!shown || this.el.hidden || this.app.selection.size !== 1) return;
    const [element] = this.app.selection;
    const { result, current, reference } = shown;
    const pairs = [...result.modified.properties, ...result.modified.geometry, ...result.modified.moved, ...result.unchanged, ...result.renamedIds];
    const pair: ComparedPair | undefined = pairs.find((item) => item.current === element || item.reference === element);
    let text = '';
    if (result.added.includes(element)) text = 'Ajouté dans cette version.';
    else if (result.removed.includes(element)) text = 'Supprimé dans cette version (dessiné depuis la référence).';
    else if (!pair) return;
    const table = h('table', { class: 'compare-table' }, h('tr', {}, h('th', { text: 'Propriété' }), h('th', { text: 'Avant' }), h('th', { text: 'Après' })));
    if (pair) {
      if (result.renamedIds.includes(pair)) text = `Identifiant changé : « ${reference.key(pair.reference)} » avant, « ${current.key(pair.current)} » après (probablement le même élément).`;
      for (const change of pair.changes) table.append(h('tr', {}, h('td', { text: change.path }), h('td', { text: change.before === undefined ? '(absente)' : formatValue(change.before) }), h('td', { text: change.after === undefined ? '(absente)' : formatValue(change.after) })));
      table.append(h('tr', {}, h('td', { text: 'Géométrie' }), h('td', { text: '' }), h('td', { text: pair.geometry === 'same' ? 'identique' : pair.geometry === 'moved' ? 'déplacée' : 'modifiée' })));
    }
    this.detail.append(h('div', {}, h('p', { class: 'field-label', text: `Avant / après : ${this.app.elementLabel(element)}` }), text && h('p', { class: 'hint', text }), pair && table));
  }
}
