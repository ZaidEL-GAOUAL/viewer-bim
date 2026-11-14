import { Box3 } from 'three';
import { CLASH_STATUSES, STATUS_LABELS, conditionsText, mergeClashes, pairKey, parseConditions, type ClashRecord, type ClashSet, type ClashStatus, type ClashTest, type ElementRef } from '../data/clashes.ts';
import { matchesCondition, valueAt, type RuleCondition } from '../data/conditions.ts';
import { sourceIndexOf, sourceKey } from '../data/federation.ts';
import { toModelPoint } from '../data/modelFrame.ts';
import { integer, plural } from '../data/text.ts';
import { boxAround } from '../engine/Sections.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

/** Conflits montrés par groupe ; les JSON les gardent tous. */
const MAX_ROWS = 200;
const ALL = '', SELECTION = '#sélection';

interface SetInput {
  model: HTMLSelectElement;
  conditions: HTMLInputElement;
}

/**
 * Carte « Conflits » : les conflits francs entre deux ensembles d'éléments (une maquette, la sélection, et des conditions
 * « Propriété = valeur »), au-delà d'une tolérance (10 mm par défaut), calculés par tranches (engine/clash.ts). Exclusions :
 * un élément avec lui-même, une pièce et son original, la version de référence d'une comparaison (sauf choisie comme
 * ensemble), les éléments qui répondent au filtre d'exclusion, et au choix les paires d'une même maquette de même valeur
 * d'une propriété (un même hôte). Résultats groupés par paire de valeurs d'une propriété (le premier niveau de l'arbre par
 * défaut), triés par profondeur ; un clic cadre la paire, l'isole et pose une boîte de coupe autour. Statut et commentaire
 * par conflit, gardés d'un calcul à l'autre et écrits dans les JSON (sections `clashTests` et `clashes`).
 */
export class ClashPanel {
  readonly label = 'Conflits';
  readonly summary = 'Détecter les conflits entre deux ensembles d’éléments';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly a: SetInput;
  private readonly b: SetInput;
  private readonly exclude = h('input', { attrs: { type: 'text', 'aria-label': 'Exclure', placeholder: 'Catégorie = Réservation' } });
  private readonly sameValue = h('input', { attrs: { type: 'text', 'aria-label': 'Ignorer les paires de même valeur de', list: 'clash-paths', placeholder: 'Hôte' } });
  private readonly tolerance = h('input', { attrs: { type: 'text', inputmode: 'decimal', value: '10', 'aria-label': 'Tolérance en millimètres' } });
  private readonly groupBy = h('input', { attrs: { type: 'text', 'aria-label': 'Grouper par', list: 'clash-paths' } });
  private readonly paths = h('datalist', { attrs: { id: 'clash-paths' } });
  private readonly status = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly results = h('div', { class: 'requirement-results' });
  private readonly run: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly sort: HTMLButtonElement;
  private deepestFirst = true;
  private controller: AbortController | null = null;
  private summaryText = '';

  constructor(app: App) {
    this.app = app;
    const setInput = (name: string): SetInput => ({
      model: h('select', { attrs: { 'aria-label': `Maquette de l’ensemble ${name}` } }),
      conditions: h('input', { attrs: { type: 'text', 'aria-label': `Conditions de l’ensemble ${name}`, placeholder: name === 'A' ? 'Catégorie = Poutre' : 'Lot != Structure' } }),
    });
    this.a = setInput('A');
    this.b = setInput('B');
    this.run = button('Chercher', () => void this.detect(), { class: 'primary' });
    this.stop = button('Arrêter', () => this.controller?.abort(), { attrs: { hidden: '' } });
    this.sort = button('Plus profonds d’abord', () => { this.deepestFirst = !this.deepestFirst; this.render(); }, { title: 'Trier par profondeur de pénétration' });
    this.groupBy.addEventListener('change', () => this.render());
    const setRow = (name: string, set: SetInput) => h('div', { class: 'tool-field' }, h('span', { class: 'field-label', text: `Ensemble ${name}` }), h('div', { class: 'tool-row' }, set.model, set.conditions));
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les conflits' } })),
      this.status,
      setRow('A', this.a), setRow('B', this.b),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Exclure' }), this.exclude),
      h('label', { class: 'tool-field', title: 'Ignorer les paires d’une même maquette qui ont la même valeur de cette propriété (un élément et son hôte, par exemple)' }, h('span', { class: 'field-label', text: 'Même valeur de' }), this.sameValue),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Tolérance (mm)' }), this.tolerance),
      h('div', { class: 'dimensions-actions' }, this.stop, this.run),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Grouper par' }), this.groupBy, this.paths),
      h('div', { class: 'tool-row' }, this.sort),
      this.results,
      h('p', { class: 'hint', text: 'Conditions : « Propriété = valeur », « != » (différent), « ~ » (contient), séparées par « ; ». Un conflit franc pénètre de plus que la tolérance ; deux éléments qui se touchent n’en sont pas un. Statuts et commentaires s’enregistrent avec « JSON ↓ » et « Modifications ↓ ».' }),
    );
    app.on('model', () => {
      this.controller?.abort();
      this.summaryText = '';
      this.restore();
      this.render();
    });
    app.on('metadata', () => this.render());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) {
      if (!this.groupBy.value) this.groupBy.value = this.app.grouping[0] ?? '';
      clear(this.paths);
      for (const path of this.app.store.paths) this.paths.append(h('option', { attrs: { value: path } }));
      this.restore();
      this.render();
    }
    return open;
  }

  private get blocked(): string {
    const { app } = this;
    if (!app.model) return 'Ouvrez d’abord une maquette.';
    if (app.mapOpen) return 'Fermez la carte pour chercher les conflits : le globe dessine sa propre copie de la maquette.';
    return '';
  }

  /** Les maquettes proposées dans les deux listes (une seule maquette ouverte : « Toute la maquette » seulement). */
  private syncModels(): void {
    const sources = this.app.model?.sources ?? [];
    for (const set of [this.a, this.b]) {
      const value = set.model.value;
      clear(set.model);
      set.model.append(h('option', { text: sources.length ? 'Toutes les maquettes' : 'Toute la maquette', attrs: { value: ALL } }), h('option', { text: 'La sélection', attrs: { value: SELECTION } }),
        ...sources.map((source) => h('option', { text: `${source.name}${source.role === 'reference' ? ' (référence)' : ''}`, attrs: { value: source.name } })));
      set.model.value = [...set.model.options].some((option) => option.value === value) ? value : ALL;
    }
  }

  /** Les réglages du test enregistré dans le fichier, s'il y en a un. */
  private restore(): void {
    this.syncModels();
    const test = this.app.clashes.tests[0];
    if (!test) return;
    for (const [input, set] of [[this.a, test.a], [this.b, test.b]] as const) {
      input.model.value = set.model && [...input.model.options].some((option) => option.value === set.model) ? set.model : ALL;
      input.conditions.value = conditionsText(set.conditions);
    }
    this.exclude.value = conditionsText(test.exclude);
    this.sameValue.value = test.sameValue ?? '';
    this.tolerance.value = String(Math.round(test.tolerance * 10000) / 10);
  }

  private test(): ClashTest | string {
    const tolerance = Number(this.tolerance.value.replace(',', '.')) / 1000;
    if (!(tolerance >= 0)) return 'Une tolérance en millimètres, 0 ou plus.';
    const set = (input: SetInput): ClashSet => ({ ...(input.model.value && input.model.value !== SELECTION ? { model: input.model.value } : {}), conditions: parseConditions(input.conditions.value) });
    const name = (input: SetInput) => [input.model.selectedOptions[0]?.text ?? '', input.conditions.value.trim()].filter(Boolean).join(', ');
    const test: ClashTest = { id: this.app.clashes.tests[0]?.id ?? 't1', name: `${name(this.a)} × ${name(this.b)}`, a: set(this.a), b: set(this.b), type: 'hard', tolerance, exclude: parseConditions(this.exclude.value) };
    if (this.sameValue.value.trim()) test.sameValue = this.sameValue.value.trim();
    return test;
  }

  /** Les éléments d'un ensemble : 1 pour chaque élément retenu. */
  private members(input: SetInput, set: ClashSet, exclude: readonly RuleCondition[]): Uint8Array {
    const { app } = this;
    const model = app.model!;
    const identity = { keys: model.keys, label: (i: number) => app.elementLabel(i) };
    const matches = (i: number, conditions: readonly RuleCondition[]) => conditions.every((condition) => matchesCondition(valueAt(app.store, identity, i, condition.property), condition));
    const out = new Uint8Array(model.count);
    for (let i = 0; i < model.count; i++) {
      if (model.state.isReplaced(i)) continue;
      const source = model.sources[sourceIndexOf(model, i)];
      if (input.model.value === SELECTION) {
        if (!app.selection.has(i)) continue;
      } else if (set.model !== undefined ? source?.name !== set.model : source?.role === 'reference') continue;
      if (!matches(i, set.conditions) || (exclude.length > 0 && matches(i, exclude))) continue;
      out[i] = 1;
    }
    return out;
  }

  private refOf(element: number): ElementRef {
    const model = this.app.model!;
    const source = model.sources[sourceIndexOf(model, element)];
    return { key: sourceKey(model.keys[element], source), model: source?.name ?? this.app.sourceName };
  }

  /** Numéro de chaque élément de la session par sa maquette et sa clé. */
  private refIndex(): Map<string, number> {
    const model = this.app.model!;
    const index = new Map<string, number>();
    for (let i = 0; i < model.count; i++) {
      const ref = this.refOf(i);
      index.set(`${ref.model}\u0000${ref.key}`, i);
    }
    return index;
  }

  private async detect(): Promise<void> {
    const { app } = this;
    const model = app.model;
    const test = this.blocked || this.test();
    if (!model || typeof test === 'string') {
      this.render(typeof test === 'string' ? test : '');
      return;
    }
    const inA = this.members(this.a, test.a, test.exclude), inB = this.members(this.b, test.b, test.exclude);
    const listA: number[] = [], listB: number[] = [];
    for (let i = 0; i < model.count; i++) {
      if (inA[i]) listA.push(i);
      if (inB[i]) listB.push(i);
    }
    if (listA.length === 0 || listB.length === 0) {
      this.render(`L’ensemble ${listA.length === 0 ? 'A' : 'B'} est vide.`);
      return;
    }
    const parents = model.parents;
    const same = test.sameValue;
    const exclude = (x: number, y: number) => parents[x] === y || parents[y] === x || (parents[x] >= 0 && parents[x] === parents[y])
      || (same !== undefined && sourceIndexOf(model, x) === sourceIndexOf(model, y) && app.store.displayValue(x, same) === app.store.displayValue(y, same) && app.store.propsOf(x)?.[same] != null && app.store.propsOf(x)?.[same] !== '');
    const revision = app.revision;
    const controller = (this.controller = new AbortController());
    this.stop.hidden = false;
    this.run.disabled = true;
    const started = performance.now();
    try {
      // Le moteur (et three-mesh-bvh) n'est chargé qu'à la première recherche.
      const { MAX_CANDIDATES, clashJob } = await import('../engine/clash.ts');
      const outcome = await runSliced(clashJob(model, listA, listB, { tolerance: test.tolerance, exclude }), (progress) => (this.status.textContent = `Recherche… ${Math.round(progress * 100)} %`), controller.signal);
      if (model !== app.model || revision !== app.revision) return;
      const offset = model.offset.toArray();
      const found: ClashRecord[] = outcome.clashes.map((clash) => ({
        test: test.id, a: this.refOf(clash.a), b: this.refOf(clash.b), status: 'new', comment: '',
        depth: Math.round(clash.depth * 10000) / 10000, point: toModelPoint(clash.point, offset).map((x) => Math.round(x * 1000) / 1000) as [number, number, number],
      }));
      const index = this.refIndex();
      const resolve = (ref: ElementRef) => index.get(`${ref.model ?? app.sourceName}\u0000${ref.key}`);
      const inScope = (record: ClashRecord) => {
        const x = resolve(record.a), y = resolve(record.b);
        return x !== undefined && y !== undefined && ((inA[x] === 1 && inB[y] === 1) || (inA[y] === 1 && inB[x] === 1));
      };
      app.setClashes({ tests: [test], records: mergeClashes(app.clashes.records, found, inScope) });
      const seconds = ((performance.now() - started) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
      this.summaryText = [
        `${plural(outcome.clashes.length, 'conflit')} trouvé${outcome.clashes.length > 1 ? 's' : ''} sur ${plural(outcome.candidates, 'paire testée', 'paires testées')} (${listA.length.toLocaleString('fr-FR')} × ${listB.length.toLocaleString('fr-FR')} éléments), en ${seconds} s.`,
        outcome.capped ? `Plus de ${integer.format(MAX_CANDIDATES)} paires candidates : seules les ${integer.format(MAX_CANDIDATES)} premières ont été testées. Restreignez les ensembles.` : '',
      ].filter(Boolean).join(' ');
      this.render();
    } catch (error) {
      this.render(controller.signal.aborted ? 'Recherche arrêtée : les conflits précédents restent.' : `Recherche impossible : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.controller = null;
      this.stop.hidden = true;
      this.run.disabled = false;
    }
  }

  /** Cadre la paire, l'isole et pose une boîte de coupe autour de la zone du conflit. */
  private focus(x: number, y: number, record: ClashRecord): void {
    const { app } = this;
    const model = app.model;
    if (!model) return;
    const box = model.elementBox(x, new Box3()).intersect(model.elementBox(y, new Box3()));
    if (box.isEmpty()) model.boxOf([x, y], box);
    box.expandByScalar(Math.max(1, record.depth * 3));
    app.select([x, y], 'panel');
    app.isolate([x, y]);
    app.viewer.sections.setBox(boxAround(box));
    app.viewer.sectionsChanged();
    app.fitTo([x, y]);
  }

  private update(record: ClashRecord, change: Partial<Pick<ClashRecord, 'status' | 'comment'>>): void {
    const { app } = this;
    // Par la paire, pas par l'objet : une ligne peut changer deux fois (statut, puis commentaire) sans être redessinée.
    const key = pairKey(record.a, record.b);
    app.setClashes({ tests: app.clashes.tests, records: app.clashes.records.map((item) => (pairKey(item.a, item.b) === key ? { ...item, ...change } : item)) });
  }

  private render(message = ''): void {
    if (this.el.hidden) return;
    const { app } = this;
    this.syncModels();
    clear(this.results);
    this.status.textContent = message || this.blocked || this.summaryText || 'Choisissez les deux ensembles, puis « Chercher ».';
    this.run.disabled = this.controller !== null || this.blocked !== '';
    this.sort.textContent = this.deepestFirst ? 'Plus profonds d’abord' : 'Moins profonds d’abord';
    const records = app.clashes.records;
    if (!app.model || records.length === 0) return;
    const index = this.refIndex();
    const resolve = (ref: ElementRef) => index.get(`${ref.model ?? app.sourceName}\u0000${ref.key}`);
    const property = this.groupBy.value.trim();
    const groups = new Map<string, { record: ClashRecord; x: number; y: number }[]>();
    let elsewhere = 0;
    for (const record of records) {
      const x = resolve(record.a), y = resolve(record.b);
      if (x === undefined || y === undefined) {
        elsewhere++;
        continue;
      }
      const label = property ? [app.store.displayValue(x, property), app.store.displayValue(y, property)].sort((p, q) => p.localeCompare(q, 'fr')).join(' × ') : 'Tous les conflits';
      const list = groups.get(label);
      if (list) list.push({ record, x, y });
      else groups.set(label, [{ record, x, y }]);
    }
    const counts = CLASH_STATUSES.map((status) => [status, records.filter((record) => record.status === status).length] as const).filter(([, n]) => n > 0);
    this.results.append(h('p', { class: 'dimensions-title', text: counts.map(([status, n]) => `${STATUS_LABELS[status]} : ${integer.format(n)}`).join(' · ') }));
    if (elsewhere > 0) this.results.append(h('p', { class: 'hint', text: `${plural(elsewhere, 'conflit enregistré')} entre des maquettes qui ne sont pas toutes ouvertes : gardé${elsewhere > 1 ? 's' : ''} tel${elsewhere > 1 ? 's' : ''} quel${elsewhere > 1 ? 's' : ''}.` }));
    const order = (p: { record: ClashRecord }, q: { record: ClashRecord }) => (this.deepestFirst ? q.record.depth - p.record.depth : p.record.depth - q.record.depth);
    for (const [label, list] of [...groups].sort((p, q) => q[1].length - p[1].length)) {
      list.sort(order);
      const rows = h('div');
      for (const { record, x, y } of list.slice(0, MAX_ROWS)) {
        const pick = h('button', { class: 'dimensions-row', attrs: { type: 'button' } },
          h('span', { class: 'dimensions-name', text: `${app.elementLabel(x)} × ${app.elementLabel(y)}` }),
          h('span', { class: 'dimensions-values', text: `≈ ${integer.format(Math.round(record.depth * 1000))} mm` }));
        pick.addEventListener('click', () => this.focus(x, y, record));
        const status = h('select', { attrs: { 'aria-label': 'Statut' } }, ...CLASH_STATUSES.map((value) => h('option', { text: STATUS_LABELS[value], attrs: { value } })));
        status.value = record.status;
        status.addEventListener('change', () => this.update(record, { status: status.value as ClashStatus }));
        const comment = h('input', { attrs: { type: 'text', 'aria-label': 'Commentaire', placeholder: 'Commentaire' } });
        comment.value = record.comment;
        comment.addEventListener('change', () => this.update(record, { comment: comment.value }));
        rows.append(h('div', { class: 'clash-row' }, pick, status, comment));
      }
      this.results.append(h('details', { attrs: groups.size === 1 ? { open: '' } : {} },
        h('summary', { text: `${label} (${integer.format(list.length)})` }), rows,
        list.length > MAX_ROWS ? h('p', { class: 'hint', text: `… et ${integer.format(list.length - MAX_ROWS)} autres, dans le JSON.` }) : null));
    }
  }
}
