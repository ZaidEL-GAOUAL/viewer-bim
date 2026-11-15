import { Box3, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { runTool } from '../assistant/tools.ts';
import { sourceIndexOf } from '../data/federation.ts';
import { toModelPoint, toViewerPoint, type Vec3 } from '../data/modelFrame.ts';
import { MAX_CUTS, MIN_INTERVAL, PART_SEQUENCE, cutPlanes, describeOutcome, freeLineProblem, type OriginalOf, type SplitDefinition, type SplitOutcome, type SplitReferences } from '../data/splits.ts';
import { integer, plural } from '../data/text.ts';
import { holdView } from '../engine/capture.ts';
import { formatVolume } from '../engine/Measure.ts';
import { boxOnlyReason, type Model } from '../engine/Model.ts';
import { runSliced } from '../engine/sliced.ts';
import { solidFromParts, solidProblem } from '../engine/splitMesh.ts';
import { STANDARD_VIEWS } from '../engine/views.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { toolContext } from './toolContext.ts';
import { captureView, newViewId } from './userViews.ts';

/** La sortie de l'outil qui tient la vue de dessin (découpage ou zones) : un seul à la fois. */
let drawingOwner: (() => void) | null = null;

/**
 * La vue de dessin d'un outil (découpage, zones) : ce que l'utilisateur voyait est gardé comme à l'impression
 * (`captureView`), puis la vue passe en projection parallèle, de dessus (de face pour couper aux niveaux), sans rotation,
 * cadrée sur `elements` à côté de la carte de l'outil ; `isolate` n'affiche plus qu'eux. Rend de quoi rétablir exactement la
 * vue d'avant. Prendre et rendre la vue passent par la file des captures : une impression ne s'intercale jamais entre les
 * deux et ce qu'ils changent. `leave` : ce que fait l'outil quand un autre prend la vue à son tour.
 */
export async function holdDrawingView(app: App, elements: readonly number[], options: { from: 'top' | 'front'; isolate: boolean; card: HTMLElement; leave: () => void }): Promise<() => Promise<void>> {
  if (drawingOwner !== options.leave) drawingOwner?.();
  drawingOwner = options.leave;
  const model = app.model;
  const before = await holdView(async () => {
    if (!model || app.model !== model) return null;
    const saved = { view: captureView(app, 'avant le dessin'), active: app.activeView };
    if (options.isolate) app.isolate(elements);
    frameDrawing(app, elements, options.from, options.card);
    return saved;
  });
  return () => {
    if (drawingOwner === options.leave) drawingOwner = null;
    return holdView(async () => {
      if (before && app.model === model) app.openView(before.view, { activeView: before.active });
    });
  };
}

/**
 * Cadre `elements` en projection parallèle, vus de `from`, sans rotation, dans la place que la carte `card` laisse libre à sa
 * droite : elle ne les couvre pas. shortcut: la carte flotte à gauche de la vue ; la refonte (18) la range sur le côté.
 */
export function frameDrawing(app: App, elements: readonly number[], from: 'top' | 'front', card: HTMLElement): void {
  const { viewer, model } = app;
  if (!model) return;
  const box = model.boxOf(elements, new Box3());
  if (box.isEmpty()) box.copy(model.box);
  if (box.isEmpty()) return;
  const { direction, up } = STANDARD_VIEWS[from];
  const right = new Vector3().crossVectors(direction.clone().negate(), up);
  const size = box.getSize(new Vector3());
  const extent = (axis: Vector3) => Math.abs(axis.x) * size.x + Math.abs(axis.y) * size.y + Math.abs(axis.z) * size.z;
  const { width, height } = viewer.size;
  const covered = card.hidden ? 0 : card.getBoundingClientRect().right - viewer.renderer.domElement.getBoundingClientRect().left + 12;
  // Vue étroite : la carte en couvre l'essentiel, on ne l'évite pas.
  const free = covered > 0 && width - covered >= width / 3 ? width - covered : width;
  const halfHeight = Math.max(0.55 * extent(up), (0.55 * extent(right) * height) / free, 0.5);
  const target = box.getCenter(new Vector3()).addScaledVector(right, -((width - free) / 2) * ((2 * halfHeight) / height));
  const position = target.clone().addScaledVector(direction, size.length() + 10);
  if (viewer.setCameraPose({ projection: 'orthographic', position: position.toArray(), target: target.toArray(), up: up.toArray(), halfHeight })) viewer.setProjection('orthographic', false);
}

/**
 * Pourquoi l'étape 1 refuse de couper cet élément, sans regarder son maillage (vérifié à part), ou null. `split` : il a déjà
 * son découpage.
 */
export function cutRefusal(model: Model, element: number, split: boolean): string | null {
  return model.parents[element] >= 0 ? 'c’est une pièce : modifiez ou retirez son découpage ci-dessous'
    : sourceIndexOf(model, element) > 0 ? 'il vient d’une autre maquette : seuls les éléments de la première se découpent'
      : split ? 'déjà découpé : modifiez ou retirez son découpage ci-dessous'
        : model.ranges[element].length === 0 ? 'il n’a pas de géométrie'
          : boxOnlyReason(model, element);
}

type Step = 'what' | 'how' | 'where' | 'check' | 'done';
type Mode = 'lines' | 'levels' | 'axis';

const STEP_TITLES: Record<Step, string> = { what: 'Quoi couper', how: 'Comment', where: 'Où', check: 'Aperçu', done: 'Terminé' };
/** Couleurs des pièces de l'aperçu, en alternance (les mêmes que les teintes des zones, voir styles.css). */
const TONES = [0x4e79a7, 0xf28e2b, 0x59a14f, 0xe15759, 0xb07aa1, 0xedc948];
/** Au-delà de ces triangles sélectionnés, l'étape 1 ne vérifie plus que les maillages sont fermés : le découpage le dira. */
const CHECK_TRIANGLES = 300_000;
const metres = (value: number) => value.toLocaleString('fr-FR', { maximumFractionDigits: 3, useGrouping: false });

function pictogram(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

/**
 * Carte « Découpage en pièces », pas à pas, une étape visible à la fois : 1. quoi couper (la sélection, et ce qui ne peut pas
 * l'être, avec la raison), 2. comment (tracé, niveaux, intervalles réguliers), 3. où (la vue passe d'elle-même de dessus, en
 * projection parallèle, n'affiche que les éléments choisis et les cadre à côté de la carte ; une coupe droite traverse toute
 * la sélection), 4. aperçu des pièces en couleurs, numérotées, avant que rien ne soit créé. La vue d'avant revient à la
 * fermeture. Les pièces deviennent des éléments (propriétés de l'original, `Pièce / …`, quantités propres) ; l'original est
 * masqué, jamais modifié. « Retirer le découpage » le rétablit : c'est l'inverse d'un découpage, qui n'est pas une étape
 * d'« Annuler ». Deux pièces voisines se réunissent. Désactivé en mode carte : le globe dessine sa propre copie de la maquette.
 */
export class SplitPanel {
  readonly label = 'Découpage en pièces';
  readonly summary = 'Couper des éléments en pièces : tracé, niveaux, intervalles';
  readonly el: HTMLElement;
  private readonly app: App;
  private step: Step = 'what';
  private mode: Mode = 'lines';
  /** Les éléments choisis à l'étape 1 (ou ceux du découpage modifié). */
  private chosen: number[] = [];
  /** L'identifiant du découpage en préparation ; celui du découpage modifié le garde. */
  private draftId = '';
  /** Le découpage modifié (crayon de la liste) : ses pièces seront refaites. */
  private editing: SplitDefinition | null = null;
  /** Rétablit la vue d'avant le dessin ; null tant que la carte ne tient pas la vue. */
  private restoreView: (() => Promise<void>) | null = null;
  private preview: { definition: SplitDefinition; outcome: SplitOutcome } | null = null;
  private previewNote = '';
  private computing: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Les pièces créées, et ce qui est dit après (étape « Terminé »). */
  private created: number[] = [];
  private doneNote = '';
  /** Ce que la liste des découpages vient de faire (retrait, réunion). */
  private note = '';
  /** Quand l'autre outil de dessin prend la vue : la carte se ferme (et rend la vue). */
  private readonly leave = () => this.toggle(false);
  private readonly pieces = new Group();
  // Les pièces sont exactement sur les faces de l'élément : sans test de profondeur, elles le couvrent toujours. Vues dans le
  // sens de leurs coupes (de dessus, de face pour les niveaux), elles ne se recouvrent pas entre elles.
  private readonly materials = TONES.map((color) => new MeshBasicMaterial({ color, depthTest: false, depthWrite: false }));
  /** Maillages vérifiés à l'étape 1, par élément, pour ce modèle et cette révision. */
  private readonly meshChecks = new Map<number, string | null>();
  private checked: { model: unknown; revision: number } = { model: null, revision: -1 };
  private shownLevels: readonly unknown[] | null = null;

  private readonly progress = h('p', { class: 'split-progress' });
  private readonly sentence = h('p', { class: 'split-sentence' });
  private readonly body = h('div', { class: 'split-step' });
  private readonly status = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly actions = h('div', { class: 'dimensions-actions split-actions' });
  private readonly existing: HTMLElement;
  private readonly list = h('div', { class: 'views-list' });
  private readonly merge: HTMLButtonElement;
  private readonly choices: HTMLButtonElement[];
  private readonly levelsLine = h('span', { class: 'split-choice-line' });
  private readonly snap = h('input', { attrs: { type: 'checkbox', checked: '' } });
  private readonly freeTrace = h('input', { attrs: { type: 'checkbox' } });
  private readonly trace: HTMLButtonElement;
  private readonly cuts = h('div', { class: 'views-list' });
  private readonly levels = h('div', { class: 'tool-checks' });
  private readonly axis = h('select', { attrs: { 'aria-label': 'Axe' } }, h('option', { text: 'Le long de X (est)', attrs: { value: 'x' } }), h('option', { text: 'Le long de Y (nord)', attrs: { value: 'z' } }));
  private readonly kind = h('select', { attrs: { 'aria-label': 'Répartition' } },
    h('option', { text: 'Parts égales (nombre)', attrs: { value: 'count' } }),
    h('option', { text: 'Tous les … m', attrs: { value: 'interval' } }),
    h('option', { text: 'À … m du bord ouest ou sud (liste)', attrs: { value: 'positions' } }));
  private readonly amount = h('input', { attrs: { type: 'text', value: '4', 'aria-label': 'Valeur', inputmode: 'decimal' } });
  private readonly planStart = h('input', { attrs: { type: 'date', 'aria-label': 'Début du planning' } });
  private readonly planDays = h('input', { attrs: { type: 'text', value: '1', inputmode: 'numeric', 'aria-label': 'Jours par séquence' } });

  constructor(app: App) {
    this.app = app;
    app.viewer.overlay.add(this.pieces);
    this.trace = button('', () => (this.tracing ? app.setTool('select') : this.startTrace()), { attrs: { 'aria-pressed': 'false' } });
    this.merge = button('Réunir les 2 pièces sélectionnées', () => this.mergeSelected(), { title: 'Deux pièces voisines d’un même élément deviennent une seule (celle du plus petit numéro)' });
    const choice = (mode: Mode, title: string, line: HTMLElement, d: string) => {
      const element = button('', () => this.choose(mode), { class: 'split-choice' });
      element.append(pictogram(d), h('span', { class: 'split-choice-text' }, h('strong', { text: title }), line));
      return element;
    };
    this.choices = [
      choice('lines', 'Je trace les coupes', h('span', { class: 'split-choice-line', text: 'Deux clics dans le plan : la coupe traverse toute la sélection.' }), 'M3 7h18v10H3z M9 3l6 18'),
      choice('levels', 'Aux niveaux', this.levelsLine, 'M5 4h14v16H5z M2 9.5h20 M2 14.5h20'),
      choice('axis', 'À intervalles réguliers', h('span', { class: 'split-choice-line', text: 'Parts égales, tous les N mètres, ou à des distances choisies.' }), 'M3 6h18v12H3z M7.5 6v12 M12 6v12 M16.5 6v12'),
    ];
    this.snap.addEventListener('change', () => (app.sketch.snap = this.snap.checked));
    this.freeTrace.addEventListener('change', () => this.startTrace());
    for (const input of [this.axis, this.kind, this.amount, this.levels]) input.addEventListener(input === this.amount ? 'input' : 'change', () => this.schedulePreview());
    this.existing = h('div', { class: 'split-step' },
      h('p', { class: 'field-label', text: 'Découpages' }), this.list, this.merge,
      h('p', { class: 'hint', text: 'Avec plusieurs maquettes, seuls les éléments de la première se découpent.' }),
      h('p', { class: 'hint', text: 'Les pièces copient les propriétés de l’original et reçoivent « Pièce / Numéro », « Pièce / Séquence » (à modifier pour l’ordre du planning) et leurs propres quantités. Elles s’enregistrent comme une définition de coupe avec « Enregistrer mes modifications » et « Toutes les propriétés » (groupe Exporter) ; « Maquette 3D » contient les pièces à la place des originaux.' }));
    this.el = h('section', { class: 'card tool-card split-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer : la vue d’avant revient', attrs: { 'aria-label': 'Fermer le découpage' } })),
      this.progress, this.sentence, this.body, this.status, this.actions, this.existing,
    );
    let model = app.model;
    app.on('model', () => {
      if (app.model === model) return;
      model = app.model;
      // La vue gardée était celle de l'autre modèle : il n'y a rien à rétablir.
      if (this.step !== 'what') void this.go('what');
    });
    for (const event of ['selection', 'metadata', 'tool', 'map'] as const) app.on(event, () => this.render());
    this.render();
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (!open) void this.go('what');
    else this.render();
    return open;
  }

  private get blocked(): string {
    const { app } = this;
    if (!app.model || !app.splits) return 'Ouvrez d’abord un modèle.';
    if (app.mapOpen) return 'Fermez la carte pour découper : le globe dessine sa propre copie de la maquette, qui ne suit pas les pièces.';
    return '';
  }

  private get tracing(): boolean {
    const { app } = this;
    return app.tool === 'sketch' && (app.sketch.mode === 'lines' || app.sketch.mode === 'free');
  }

  // ------------------------------------------------------------------ étapes

  private async go(step: Step): Promise<void> {
    const { app } = this;
    const previous = this.step;
    this.step = step;
    this.note = '';
    if (step !== 'where' && this.tracing) app.setTool('select');
    if (step === 'what' || step === 'how') this.clearPreview();
    if (step === 'what') {
      app.sketch.lines.length = 0;
      app.sketch.guides = [];
      this.editing = null;
      this.created = [];
      const restore = this.restoreView;
      this.restoreView = null;
      void restore?.();
    }
    if (step === 'where') {
      const from = this.mode === 'levels' ? 'front' : 'top';
      if (!this.restoreView) {
        const restore = await holdDrawingView(app, this.chosen, { from, isolate: true, card: this.el, leave: this.leave });
        // Fermée ou revenue en arrière pendant l'attente : la vue est rendue aussitôt.
        if (this.step !== 'where') {
          void restore();
          return;
        }
        this.restoreView = restore;
      } else if (previous === 'how') frameDrawing(app, this.chosen, from, this.el);
      if (this.mode === 'lines') this.startTrace();
      this.schedulePreview();
    }
    this.render();
  }

  private render(): void {
    if (this.el.hidden) return;
    const { app } = this;
    const step = this.step;
    this.progress.textContent = step === 'done' ? 'Terminé' : `Étape ${['what', 'how', 'where', 'check'].indexOf(step) + 1} sur 4 · ${STEP_TITLES[step]}`;
    clear(this.body);
    clear(this.actions);
    this.status.textContent = this.blocked || this.note;
    this.existing.hidden = step !== 'what' && step !== 'done';
    if (step === 'what') this.renderWhat();
    else if (step === 'how') this.renderHow();
    else if (step === 'where') this.renderWhere();
    else if (step === 'check') this.renderCheck();
    else this.renderDone();
    if (!this.existing.hidden) {
      const pair = [...app.selection];
      const model = app.model;
      this.merge.hidden = !(pair.length === 2 && model && model.parents[pair[0]] >= 0 && model.parents[pair[0]] === model.parents[pair[1]]);
      this.merge.disabled = this.blocked !== '';
      this.renderList();
    }
  }

  private renderWhat(): void {
    const { app } = this;
    this.sentence.textContent = 'Sélectionnez les éléments à couper (dalle, mur, toiture), dans la vue ou dans l’arborescence.';
    const { ready, refused } = this.candidates();
    if (app.selection.size === 0) this.body.append(h('p', { class: 'hint', text: 'Aucun élément sélectionné.' }));
    if (ready.length > 0) this.body.append(h('p', { text: `${plural(ready.length, 'élément prêt', 'éléments prêts')} à couper : ${this.names(ready)}.` }));
    if (refused.length > 0) {
      const items = refused.slice(0, 8).map(([i, reason]) => h('li', { text: `« ${app.elementLabel(i)} » : ${reason}.` }));
      if (refused.length > 8) items.push(h('li', { text: `… et ${integer.format(refused.length - 8)} autres.` }));
      this.body.append(h('p', { class: 'field-label', text: 'Ne peuvent pas être coupés' }), h('ul', { class: 'warning' }, ...items));
    }
    const next = button('Continuer', () => {
      this.chosen = ready;
      this.draftId = newViewId();
      void this.go('how');
    }, { class: 'primary' });
    next.disabled = this.blocked !== '' || ready.length === 0;
    this.actions.append(next);
  }

  private renderHow(): void {
    const { app } = this;
    this.sentence.textContent = `Comment couper ${this.chosen.length === 1 ? `« ${app.elementLabel(this.chosen[0])} »` : `ces ${integer.format(this.chosen.length)} éléments`} ?`;
    const levels = app.levels.length > 0;
    this.choices[1].disabled = !levels;
    this.levelsLine.textContent = levels ? 'Une coupe horizontale à chaque niveau choisi.' : 'Ce modèle n’a pas de niveaux.';
    this.choices.forEach((choice, i) => choice.setAttribute('aria-pressed', String(['lines', 'levels', 'axis'][i] === this.mode)));
    this.body.append(h('div', { class: 'split-choices' }, ...this.choices));
    this.actions.append(button('Retour', () => void this.go('what')));
  }

  private renderWhere(): void {
    const { app } = this;
    if (this.mode === 'lines') {
      const free = this.freeTrace.checked;
      this.sentence.textContent = free
        ? 'Tracé libre : cliquez chaque point du tracé ; chaque segment doit traverser l’élément de part en part. Cliquez de nouveau le dernier point pour finir.'
        : 'Cliquez un point, puis un second : la coupe traverse toute la sélection. Un nouveau clic commence la coupe suivante.';
      this.trace.textContent = this.tracing ? 'Arrêter le tracé' : 'Reprendre le tracé';
      this.trace.setAttribute('aria-pressed', String(this.tracing));
      this.trace.disabled = this.blocked !== '';
      clear(this.cuts);
      app.sketch.lines.forEach((_, i) => {
        this.cuts.append(h('div', { class: 'view-row' }, h('span', { class: 'view-item', text: `Coupe ${i + 1}` }),
          button('×', () => app.sketch.removeLine(i), { class: 'view-action', title: 'Retirer cette coupe', attrs: { 'aria-label': `Retirer la coupe ${i + 1}` } })));
      });
      if (app.sketch.lines.length === 0) this.cuts.append(h('p', { class: 'hint', text: 'Aucune coupe pour l’instant.' }));
      this.body.append(
        h('div', { class: 'tool-row' }, h('label', { class: 'tool-check', title: 'Le curseur s’accroche aux sommets, milieux et arêtes ; Alt tenu : sans aimant' }, this.snap, 'Aimanter'),
          h('label', { class: 'tool-check', title: 'Plusieurs points ; chaque segment ne coupe que là où il passe' }, this.freeTrace, 'Tracé libre'), this.trace),
        h('p', { class: 'hint', text: 'Alt : sans aimant · Maj : horizontal ou vertical · Retour arrière : retirer la dernière coupe.' }),
        this.cuts);
    } else if (this.mode === 'levels') {
      this.sentence.textContent = 'Cochez les niveaux où couper : une coupe horizontale à chacun.';
      this.syncLevels();
      this.body.append(this.levels);
    } else {
      this.sentence.textContent = 'Choisissez l’axe et la répartition : les coupes s’affichent en pointillés, les pièces en couleurs.';
      this.body.append(h('div', { class: 'tool-axis' }, this.axis, this.kind, this.amount));
    }
    this.status.textContent = this.blocked || this.previewNote;
    const next = button('Voir l’aperçu', () => void this.go('check'), { class: 'primary' });
    next.disabled = this.blocked !== '' || !this.preview || this.preview.outcome.splits.length === 0;
    this.actions.append(button('Retour', () => void this.go('how')), next);
  }

  private renderCheck(): void {
    const { app } = this;
    const outcome = this.preview?.outcome;
    this.sentence.textContent = 'Vérifiez les pièces : rien n’est encore créé.';
    if (outcome) {
      const count = outcome.splits.reduce((sum, split) => sum + split.parts.length, 0);
      this.body.append(h('p', { text: `${plural(count, 'pièce')}, en couleurs et numérotées dans la vue.` }));
      for (const split of outcome.splits.slice(0, 12)) {
        this.body.append(h('p', { class: 'field-label', text: `${app.elementLabel(split.element)} : ${plural(split.parts.length, 'pièce')}` }),
          h('ol', {}, ...split.parts.slice(0, 30).map((part) => h('li', { text: `${formatVolume(part.volume)}${part.valid ? '' : ' (maillage non valide : indicatif)'}` }))));
      }
      if (outcome.splits.length > 12) this.body.append(h('p', { class: 'hint', text: `… et ${plural(outcome.splits.length - 12, 'autre élément', 'autres éléments')}.` }));
      const notes = describeOutcome(outcome, (i) => app.elementLabel(i));
      if (notes.length > 0) this.body.append(h('p', { class: 'warning', text: notes.join(' ') }));
    }
    const apply = button(this.editing ? 'Refaire les pièces' : 'Découper', () => this.apply(), { class: 'primary' });
    apply.disabled = this.blocked !== '' || !outcome || outcome.splits.length === 0;
    this.actions.append(button('Modifier', () => void this.go('where')), apply);
  }

  private renderDone(): void {
    this.sentence.textContent = `${plural(this.created.length, 'pièce créée', 'pièces créées')}.`;
    if (!this.planStart.value) this.planStart.value = new Date().toISOString().slice(0, 10);
    this.body.append(
      h('p', { text: this.doneNote }),
      button('Numéroter la séquence', () => this.numberSequence(), { title: 'Ouvre « Pièce / Séquence » de la première pièce dans les propriétés' }),
      h('div', { class: 'tool-row split-plan' },
        button('Planifier par séquence', () => this.plan(), { title: 'Écrit les dates des pièces dans l’ordre de « Pièce / Séquence » et ouvre le Planning 4D' }),
        h('label', { class: 'tool-check' }, 'à partir du', this.planStart), h('label', { class: 'tool-check' }, this.planDays, 'jour(s) par séquence')),
    );
    this.actions.append(button('Couper autre chose', () => void this.go('what')), button('Fermer', () => this.toggle(false), { title: 'La vue d’avant revient' }));
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
      const how = definition.lines ? plural(definition.lines.length, 'coupe tracée', 'coupes tracées') : definition.references?.levels ? `niveaux ${definition.references.levels.join(', ')}` : 'intervalles réguliers';
      const item = button('', () => { app.select(parts, 'panel'); if (parts.length) app.fitTo(parts); }, { class: 'view-item', title: 'Sélectionner les pièces' });
      item.append(h('span', { class: 'view-name', text: `Découpage ${index + 1} : ${plural(parts.length, 'pièce')}` }), h('span', { class: 'view-note', text: `${plural(definition.elements.length, 'élément')} · ${how}` }));
      const edit = button('✎', () => this.edit(definition), { class: 'view-action', title: 'Modifier ses coupes', attrs: { 'aria-label': `Modifier le découpage ${index + 1}` } });
      const remove = button('×', () => this.remove(definition.id), { class: 'view-action', title: 'Retirer le découpage : les pièces disparaissent, les originaux reviennent', attrs: { 'aria-label': `Retirer le découpage ${index + 1}` } });
      edit.disabled = remove.disabled = this.blocked !== '';
      this.list.append(h('div', { class: 'view-row' }, item, edit, remove));
    });
  }

  // ------------------------------------------------------------------ étape 1

  /** Les éléments sélectionnés qui peuvent être coupés, et les autres avec la raison. */
  private candidates(): { ready: number[]; refused: [number, string][] } {
    const { app } = this;
    const model = app.model;
    const ready: number[] = [], refused: [number, string][] = [];
    if (!model) return { ready, refused };
    if (this.checked.model !== model || this.checked.revision !== app.revision) {
      this.meshChecks.clear();
      this.checked = { model, revision: app.revision };
    }
    let budget = CHECK_TRIANGLES;
    for (const i of app.selection) {
      let reason = cutRefusal(model, i, app.splits?.definitionOf(i) !== undefined);
      if (!reason) {
        const triangles = model.ranges[i].reduce((sum, range) => sum + range.count / 3, 0);
        if (!this.meshChecks.has(i) && triangles <= budget) {
          budget -= triangles;
          this.meshChecks.set(i, solidProblem(solidFromParts(model.parts(i))));
        }
        reason = this.meshChecks.get(i) ?? null;
      }
      if (reason) refused.push([i, reason]);
      else ready.push(i);
    }
    return { ready, refused };
  }

  private names(indices: readonly number[]): string {
    const names = indices.slice(0, 4).map((i) => this.app.elementLabel(i)).join(', ');
    return indices.length > 4 ? `${names} et ${integer.format(indices.length - 4)} autres` : names;
  }

  // ------------------------------------------------------------- étapes 2 et 3

  private choose(mode: Mode): void {
    if (mode !== this.mode) this.app.sketch.lines.length = 0;
    this.mode = mode;
    void this.go('where');
  }

  private syncLevels(checked: readonly string[] | null = null): void {
    const { app } = this;
    if (this.shownLevels === app.levels && !checked) return;
    const keep = checked ?? [...this.levels.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
    this.shownLevels = app.levels;
    clear(this.levels);
    for (const level of app.levels) {
      const input = h('input', { attrs: { type: 'checkbox', value: level.name } });
      input.checked = keep.includes(level.name);
      this.levels.append(h('label', { class: 'tool-check' }, input, `${level.name} (${level.elevation.toLocaleString('fr-FR')} m)`));
    }
  }

  /** Le tracé dans la vue : coupes droites (prolongées à travers la sélection) ou tracé libre (refusé en rouge s'il ne traverse pas). */
  private startTrace(): void {
    const { app } = this;
    const model = app.model;
    if (!model || this.step !== 'where' || this.mode !== 'lines' || this.blocked) return;
    const sketch = app.sketch;
    const box = model.boxOf(this.chosen, new Box3());
    sketch.start(this.freeTrace.checked ? 'free' : 'lines', box.max.y);
    sketch.bounds = box;
    sketch.elements = this.chosen;
    sketch.snap = this.snap.checked;
    sketch.keyboard = true;
    const elements = this.chosen.map((i) => ({ label: app.elementLabel(i), parts: model.parts(i) }));
    sketch.check = (a, b) => freeLineProblem(elements, [a.x, a.z], [b.x, b.z]);
    sketch.onChange = () => {
      if (this.step === 'where') this.schedulePreview();
    };
    app.setTool('sketch');
  }

  /** La définition que décrit la carte, ou ce qui lui manque. */
  private definition(): SplitDefinition | string {
    const { app } = this;
    const model = app.model!;
    const offset = model.offset.toArray();
    const elements = this.chosen;
    const base = { id: this.draftId, elements: elements.map((i) => model.keys[i]) };
    if (this.mode === 'lines') {
      const lines = app.sketch.lines;
      if (lines.length === 0) return 'Tracez au moins une coupe dans la vue.';
      if (lines.length > MAX_CUTS) return `Au plus ${MAX_CUTS} coupes par découpage.`;
      return { ...base, lines: lines.map(([a, b]) => [toModelPoint(a.toArray(), offset), toModelPoint(b.toArray(), offset)] as [Vec3, Vec3]) };
    }
    if (this.mode === 'levels') {
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

  /** Les coupes ont changé : l'aperçu en cours s'arrête, les coupes calculées s'affichent aussitôt, les pièces un instant après. */
  private schedulePreview(): void {
    this.clearPreview();
    this.showGuides();
    if (this.step === 'where') this.timer = setTimeout(() => void this.computePreview(), 150);
    this.render();
  }

  private clearPreview(): void {
    clearTimeout(this.timer);
    this.computing?.abort();
    this.computing = null;
    this.preview = null;
    this.previewNote = '';
    this.showPieces(null);
  }

  private async computePreview(): Promise<void> {
    const { app } = this;
    const splits = app.splits;
    if (!splits || this.step !== 'where') return;
    const definition = this.definition();
    if (typeof definition === 'string') {
      this.previewNote = definition;
      this.render();
      return;
    }
    const controller = (this.computing = new AbortController());
    this.previewNote = 'Calcul de l’aperçu…';
    this.render();
    try {
      const outcome = await runSliced(splits.compute(definition, app.levels), (progress) => {
        this.status.textContent = this.previewNote = `Calcul de l’aperçu… ${Math.round(progress * 100)} %`;
      }, controller.signal);
      if (this.computing !== controller) return;
      this.preview = { definition, outcome };
      this.showPieces(outcome);
      const count = outcome.splits.reduce((sum, split) => sum + split.parts.length, 0);
      this.previewNote = [count > 0 ? `Aperçu : ${plural(count, 'pièce')}, en couleurs dans la vue.` : 'Ces coupes ne font aucune pièce.', ...describeOutcome(outcome, (i) => app.elementLabel(i))].join(' ');
    } catch (error) {
      if (controller.signal.aborted) return;
      this.previewNote = `Aperçu impossible : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (this.computing === controller) {
        this.computing = null;
        this.render();
      }
    }
  }

  /** Les coupes que la répartition ou les niveaux donnent, en pointillés sur chaque élément (avant le calcul des pièces). */
  private showGuides(): void {
    const { app } = this;
    const model = app.model;
    const guides: [Vector3, Vector3][] = [];
    const definition = this.mode === 'lines' || !model || this.step !== 'where' ? null : this.definition();
    if (model && definition && typeof definition !== 'string') {
      const offset = model.offset.toArray(), box = new Box3();
      for (const i of this.chosen) {
        const { min, max } = model.elementBox(i, box);
        for (const { normal: [nx, ny, nz], constant: c } of cutPlanes(definition, { min: min.toArray(), max: max.toArray() }, app.levels, offset).planes) {
          if (ny !== 0) {
            const y = -c / ny;
            if (y > min.y && y < max.y) guides.push([new Vector3(min.x, y, max.z), new Vector3(max.x, y, max.z)]);
          } else if (Math.abs(nx) >= Math.abs(nz)) {
            const x = (z: number) => -(c + nz * z) / nx;
            if (x(min.z) > min.x && x(min.z) < max.x) guides.push([new Vector3(x(min.z), max.y, min.z), new Vector3(x(max.z), max.y, max.z)]);
          } else {
            const z = (x: number) => -(c + nx * x) / nz;
            if (z(min.x) > min.z && z(min.x) < max.z) guides.push([new Vector3(min.x, max.y, z(min.x)), new Vector3(max.x, max.y, z(max.x))]);
          }
        }
      }
    }
    app.sketch.guides = guides;
    app.viewer.invalidate();
  }

  /** Les pièces de l'aperçu, en couleurs alternées par-dessus les éléments, avec leur numéro ; rien n'est ajouté au modèle. */
  private showPieces(outcome: SplitOutcome | null): void {
    for (const child of this.pieces.children) (child as Mesh).geometry.dispose();
    this.pieces.clear();
    const marks: { point: Vector3; label: string }[] = [];
    for (const split of outcome?.splits ?? []) {
      split.parts.forEach((part, i) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(Float32Array.from(part.solid.positions), 3));
        geometry.setIndex(part.solid.triangles);
        geometry.computeBoundingBox();
        this.pieces.add(new Mesh(geometry, this.materials[i % TONES.length]));
        marks.push({ point: geometry.boundingBox!.getCenter(new Vector3()), label: String(i + 1) });
      });
    }
    this.app.sketch.marks = marks;
    this.app.viewer.invalidate();
  }

  // ------------------------------------------------------------- étape 4 et après

  private apply(): void {
    const { app } = this;
    const model = app.model, splits = app.splits, preview = this.preview;
    if (!model || !splits || !preview || this.blocked) return;
    const { definition, outcome } = preview;
    // Modifier un découpage refait ses pièces : elles repartent de l'original (leur forme change), modifications comprises.
    const renew = this.editing ? this.partsOf(this.editing).map((i) => model.keys[i]) : [];
    if (renew.length > 0 && !this.confirmLoss(renew, 'Refaire les pièces ?')) return;
    // Seuls les éléments effectivement coupés entrent dans la définition enregistrée.
    const done = { ...definition, elements: outcome.splits.map((split) => model.keys[split.element]) };
    app.changeParts(splits.put(done, outcome.splits, this.source(), renew));
    this.created = this.partsOf(done);
    const invalid = this.created.filter((i) => app.store.propsOf(i)?.['Pièce / Maillage valide'] === false).length;
    this.doneNote = [invalid ? `${integer.format(invalid)} pièce${invalid > 1 ? 's' : ''} au maillage non valide : quantités indicatives.` : '',
      ...describeOutcome(outcome, (i) => app.elementLabel(i)), 'Elles sont sélectionnées. Ensuite :'].filter(Boolean).join(' ');
    this.clearPreview();
    app.sketch.lines.length = 0;
    app.sketch.guides = [];
    this.editing = null;
    this.draftId = newViewId();
    app.select(this.created, 'panel');
    // Toutes sélectionnées, les pièces se confondent : leurs numéros restent affichés.
    app.sketch.marks = this.created.map((i) => ({ point: model.elementBox(i, new Box3()).getCenter(new Vector3()), label: model.keys[i].slice(model.keys[i].lastIndexOf('~') + 1) }));
    void this.go('done');
  }

  private partsOf(definition: SplitDefinition): number[] {
    const model = this.app.model!;
    const keys = new Set(definition.elements);
    return model.parents.flatMap((parent, i) => (parent >= 0 && keys.has(model.keys[parent]) ? [i] : []));
  }

  private numberSequence(): void {
    const { app } = this;
    const first = this.created[0];
    if (first === undefined) return;
    app.select([first], 'panel');
    const field = document.querySelector<HTMLInputElement>('.properties-panel input[aria-label="Séquence (modifiable)"]');
    field?.scrollIntoView({ block: 'center' });
    field?.focus();
    field?.select();
    this.doneNote = `« ${app.elementLabel(first)} » est sélectionnée : tapez son numéro d’ordre dans « Séquence » (panneau Propriétés), puis cliquez la pièce suivante dans la vue.`;
    this.render();
  }

  private plan(): void {
    const { app } = this;
    if (this.created.length === 0) return;
    app.select(this.created, 'panel');
    const days = Number(this.planDays.value.replace(',', '.'));
    const outcome = runTool('plan_dates', { filters: [], scope: 'selection', start: this.planStart.value, daysPerGroup: days, orderBy: [PART_SEQUENCE] }, toolContext(app));
    this.doneNote = `${outcome.note}.`;
    this.render();
  }

  private edit(definition: SplitDefinition): void {
    const { app } = this;
    const model = app.model;
    if (!model || this.blocked) return;
    const index = new Map(model.keys.map((key, i) => [key, i]));
    const chosen = definition.elements.flatMap((key) => index.get(key) ?? []);
    if (chosen.length === 0) return;
    // Depuis « Terminé », la vue d'avant revient d'abord : celle du découpage modifié est prise depuis elle.
    if (this.step !== 'what') void this.go('what');
    this.chosen = chosen;
    this.editing = definition;
    this.draftId = definition.id;
    const offset = model.offset.toArray(), box = model.boxOf(this.chosen, new Box3());
    app.sketch.lines.length = 0;
    const references = definition.references;
    if (definition.lines) {
      this.mode = 'lines';
      this.freeTrace.checked = false;
      for (const line of definition.lines) app.sketch.lines.push(line.map((point) => new Vector3(...toViewerPoint(point, offset)).setY(box.max.y)) as [Vector3, Vector3]);
    } else if (references?.levels) {
      this.mode = 'levels';
      this.syncLevels(references.levels);
    } else if (references) {
      this.mode = 'axis';
      this.axis.value = references.axis ?? 'x';
      this.kind.value = references.count ? 'count' : references.interval ? 'interval' : 'positions';
      this.amount.value = references.count ? String(references.count) : references.interval ? metres(references.interval)
        : (references.positions ?? []).map((p) => metres(references.axis === 'x' ? p - box.min.x - offset[0] : box.max.z + offset[2] - p)).join(' ; ');
    }
    void this.go('where');
  }

  private source(): OriginalOf {
    const { app } = this;
    return (i) => ({ props: app.store.propsOf(i), label: app.elementLabel(i) });
  }

  /** Vrai si aucune pièce `keys` n'a de modification, ou si l'utilisateur accepte de les perdre. */
  private confirmLoss(keys: readonly string[], question: string): boolean {
    const { app } = this;
    const model = app.model!, edits = app.propertyEdits;
    const parts = new Set(keys);
    const modified = edits ? Object.keys(edits.diff(model.keys).elements).filter((key) => parts.has(key)).length : 0;
    return modified === 0 || window.confirm(`${plural(modified, 'pièce modifiée', 'pièces modifiées')} dans ce découpage : ces modifications seront perdues (« Enregistrer mes modifications » les enregistre d’abord). ${question}`);
  }

  private remove(id: string): void {
    const { app } = this;
    const model = app.model;
    const definition = app.splits?.definitions.find((item) => item.id === id);
    if (!app.splits || !model || !definition || this.blocked) return;
    // Les modifications faites sur ses pièces disparaissent avec elles (voir PropertyEdits.reindex).
    if (!this.confirmLoss(this.partsOf(definition).map((i) => model.keys[i]), 'Retirer le découpage ?')) return;
    const change = app.splits.remove(id, this.source());
    this.note = 'Découpage retiré : les originaux sont de retour.';
    if (change) app.changeParts(change);
    this.render();
  }

  private mergeSelected(): void {
    const { app } = this;
    if (!app.splits || this.blocked) return;
    const [a, b] = [...app.selection];
    const result = app.splits.mergeDefinition(a, b);
    const key = typeof result === 'string' ? '' : result.renew[0];
    this.note = typeof result === 'string' ? `Réunion impossible : ${result}.` : `Pièces réunies dans « ${key} » ; ses propriétés repartent de l’original.`;
    if (typeof result !== 'string') {
      app.changeParts(app.splits.put(result.definition, null, this.source(), result.renew));
      app.select([app.model!.keys.indexOf(key)], 'panel');
    }
    this.render();
  }
}
