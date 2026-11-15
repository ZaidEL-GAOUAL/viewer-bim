import { defined, imageSize, newGuid, readBcf, writeBcf, type BcfDocument } from '../data/bcf.ts';
import { levelPlans } from '../data/levels.ts';
import { toModelPoint, toViewerPoint, yUpToZUp, zUpToYUp, type Vec3 } from '../data/modelFrame.ts';
import {
  GROUP_LABELS, SORT_LABELS, addComment, allowedStatuses, changeStatus, extendLists, extensionsOf, filterObservations, frenchDate, fromBcfTopic, groupObservations,
  isAimed, isOverdue, locate, mergeBooks, newObservation, nextNumber, observationsCsv, orphans, sortObservations, statusColor, statusLayer, toBcfTopic, touched, viewOfViewpoint,
  viewpointOfView, type GroupKey, type Observation, type ObservationBook, type ObservationFilter, type ObservationLists, type SortKey,
} from '../data/observations.ts';
import type { ElementRef } from '../data/clashes.ts';
import type { SavedView } from '../data/savedViews.ts';
import { integer, plural } from '../data/text.ts';
import { capturePng } from '../engine/capture.ts';
import { withoutExtension } from '../engine/fileKinds.ts';
import { Pins } from '../engine/pins.ts';
import type { App } from './App.ts';
import { button, clear, download, h, stored } from './dom.ts';
import { aimedCamera, bcfContext, elementRef, elementsPoint, isRevitSession, lookPoint, refResolver } from './elementRefs.ts';
import { observationsPdf } from './observationReport.ts';
import { markerOf, snapshotFrom } from './observationSnapshot.ts';
import { reducePhoto, withPin } from './photo.ts';
import { captureView } from './userViews.ts';

const AUTHOR_KEY = 'viewer-bim.observations.author';
/** Le nom que l'utilisateur a tapé une fois, gardé dans ce navigateur : il signe observations et commentaires. */
export const authorName = (): string => stored.get(AUTHOR_KEY)?.trim() ?? '';
/** Lignes montrées par groupe ; le CSV, le rapport et le .bcf les ont toutes. */
const MAX_ROWS = 300;
const TODO = '#todo';
const localDay = () => new Date().toLocaleDateString('sv-SE');
const mm = (v: readonly number[]): Vec3 => v.map((x) => Math.round(x * 1000) / 1000 + 0) as Vec3;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function choice(values: readonly string[], value: string, label: string, empty?: string): HTMLSelectElement {
  const options = [...new Set([...values, ...(value ? [value] : [])])];
  const select = h('select', { attrs: { 'aria-label': label } }, ...(empty !== undefined ? [h('option', { text: empty, attrs: { value: '' } })] : []), ...options.map((option) => h('option', { text: option, attrs: { value: option } })));
  select.value = value;
  return select;
}
const field = (label: string, control: HTMLElement) => h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: label }), control);

/**
 * Carte « Observations » (menu « Chantier ») : le suivi de chantier dans le viewer, pour une personne, en fichiers. Une
 * observation se crée depuis la sélection ou d'un clic sur la maquette ou sur un plan ouvert : la vue, la coupe et une image
 * sont gardées avec elle. Photos (réduites à 1 500 px), commentaires signés, statut aux transitions permises. Liste filtrée,
 * triée, groupée ; un clic ouvre la vue et sélectionne l'élément. Repères dans la vue, couleurs par statut (état passager).
 * Enregistrement : section `observations` des JSON (sans photos) et fichier .bcf (avec) ; rapport PDF et CSV.
 */
export class ObservationsPanel {
  readonly label = 'Observations';
  readonly summary = 'Suivi de chantier : constats, photos, rapport';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly pins: Pins;
  private pinTopics: Observation[] = [];
  /** L'observation ouverte dans la fiche (son GUID). */
  private current: string | null = null;
  private layer: ReadonlyMap<number, unknown> | null = null;
  private urls: string[] = [];
  private lastPhase = '';
  /** Une modification venue de la fiche : la fiche n'est pas redessinée (le curseur reste où il est). */
  private quiet = false;
  private readonly note = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly counts = h('p', { class: 'hint' });
  private readonly list = h('div', { class: 'observation-list' });
  private readonly editor = h('div', { class: 'observation-editor', attrs: { hidden: '' } });
  private readonly author = h('input', { attrs: { type: 'text', 'aria-label': 'Votre nom', placeholder: 'Signe les observations', autocomplete: 'name' } });
  private readonly colour: HTMLButtonElement;
  private readonly filters = {
    status: h('select', { attrs: { 'aria-label': 'Statut' } }), company: h('select', { attrs: { 'aria-label': 'Entreprise' } }),
    trade: h('select', { attrs: { 'aria-label': 'Lot' } }), level: h('select', { attrs: { 'aria-label': 'Niveau' } }),
    due: h('select', { attrs: { 'aria-label': 'Échéance' } }, h('option', { text: 'Toutes échéances', attrs: { value: '' } }), h('option', { text: 'En retard', attrs: { value: 'overdue' } }), h('option', { text: 'Échéance au plus tard le…', attrs: { value: 'before' } })),
    before: h('input', { attrs: { type: 'date', 'aria-label': 'Échéance au plus tard le', hidden: '' } }),
    text: h('input', { attrs: { type: 'search', 'aria-label': 'Rechercher', placeholder: 'Rechercher' } }),
    sort: h('select', { attrs: { 'aria-label': 'Trier par' } }, ...Object.entries(SORT_LABELS).map(([value, text]) => h('option', { text: `Tri : ${text}`, attrs: { value } }))),
    group: h('select', { attrs: { 'aria-label': 'Grouper par' } }, ...Object.entries(GROUP_LABELS).map(([value, text]) => h('option', { text: value === 'none' ? text : `Par ${text.toLowerCase()}`, attrs: { value } }))),
  };
  private readonly settings = {
    level: h('input', { attrs: { type: 'text', list: 'observation-paths', 'aria-label': 'Propriété du niveau' } }),
    room: h('input', { attrs: { type: 'text', list: 'observation-paths', 'aria-label': 'Propriété du local' } }),
    zone: h('input', { attrs: { type: 'text', list: 'observation-paths', 'aria-label': 'Propriété de la zone' } }),
    lists: Object.fromEntries((['kinds', 'statuses', 'done', 'trades', 'priorities', 'phases', 'companies'] as const).map((name) => [name, h('textarea', { class: 'tool-text', attrs: { rows: '3', spellcheck: 'false', 'aria-label': name } })])) as Record<Exclude<keyof ObservationLists, 'transitions'>, HTMLTextAreaElement>,
  };
  private readonly paths = h('datalist', { attrs: { id: 'observation-paths' } });
  private readonly companies = h('datalist', { attrs: { id: 'observation-companies' } });

  constructor(app: App) {
    this.app = app;
    this.pins = new Pins(app.viewer.overlay);
    this.author.value = authorName();
    this.author.addEventListener('change', () => stored.set(AUTHOR_KEY, this.author.value.trim()));
    const bcfInput = h('input', { attrs: { type: 'file', accept: '.bcf,.bcfzip', hidden: '' } });
    bcfInput.addEventListener('change', () => {
      const file = bcfInput.files?.[0];
      bcfInput.value = '';
      if (file) void this.importBcf(file);
    });
    this.colour = button('Couleurs par statut', () => this.setColouring(this.layer === null), { title: 'Colorer les éléments selon le statut de leurs observations (affichage seulement)', attrs: { 'aria-pressed': 'false' } });
    for (const control of Object.values(this.filters)) control.addEventListener(control instanceof HTMLInputElement && control.type === 'search' ? 'input' : 'change', () => this.refresh(false));
    const labels: Record<string, string> = { kinds: 'Types', statuses: 'Statuts', done: 'Statuts terminés', trades: 'Lots', priorities: 'Priorités', phases: 'Phases', companies: 'Entreprises' };
    this.el = h('section', { class: 'card tool-card observations-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les observations' } })),
      this.note,
      field('Votre nom', this.author),
      h('div', { class: 'tool-row' },
        button('Depuis la sélection', () => void this.fromSelection(), { class: 'primary', title: 'Une observation sur les éléments sélectionnés, avec la vue et la coupe du moment' }),
        button('Pointer sur la maquette', () => this.app.setTool('pin'), { title: 'Le prochain clic sur la maquette, ou sur un plan ouvert, pose l’observation' })),
      h('div', { class: 'tool-row' },
        button('Ouvrir un .bcf…', () => bcfInput.click(), { title: 'Ajouter les observations d’un fichier BCF (2.1 ou 3.0) ; une observation déjà là est mise à jour' }),
        button('Exporter .bcf', () => void this.exportBcf(), { title: 'Toutes les observations, avec photos et images, en BCF 3.0' }),
        button('Rapport PDF', () => void this.report(), { title: 'Les observations de la liste : tableau, puis une fiche chacune, par entreprise et par niveau' }),
        button('CSV', () => this.csv(), { title: 'Les observations de la liste, pour un tableur' }),
        this.colour, bcfInput),
      h('details', {},
        h('summary', { text: 'Réglages' }),
        h('p', { class: 'hint', text: 'Propriétés des éléments lues comme emplacement d’une observation :' }),
        field('Niveau', this.settings.level), field('Local', this.settings.room), field('Zone', this.settings.zone), this.paths,
        h('p', { class: 'hint', text: 'Listes, une valeur par ligne :' }),
        ...Object.entries(this.settings.lists).map(([name, area]) => field(labels[name], area)),
        h('div', { class: 'dimensions-actions' }, button('Appliquer', () => this.applySettings(), { title: 'Garder les réglages et recalculer l’emplacement des observations' }))),
      h('div', { class: 'tool-row' }, this.filters.status, this.filters.company, this.filters.trade, this.filters.level),
      h('div', { class: 'tool-row' }, this.filters.due, this.filters.before, this.filters.text),
      h('div', { class: 'tool-row' }, this.filters.sort, this.filters.group),
      this.counts, this.list, this.editor, this.companies,
    );
    app.viewClick = (event) => this.click(event);
    app.on('observations', () => this.refresh(!this.quiet));
    app.on('model', () => {
      this.current = null;
      this.setColouring(false);
      this.syncSettings();
      this.refresh();
    });
    app.on('map', () => this.refresh(false));
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (!open) {
      if (this.layer) this.setColouring(false);
      if (this.app.tool === 'pin') this.app.setTool('select');
    } else this.syncSettings();
    this.refresh();
    return open;
  }

  // ------------------------------------------------------------- état

  private get book(): ObservationBook {
    return this.app.observations;
  }

  private cache: { model: unknown; revision: number; resolve: (ref: ElementRef) => number | undefined } | null = null;
  /** Le numéro d'élément d'une référence ; refait seulement quand les éléments changent (modèle, pièces, maquettes). */
  private resolve(ref: ElementRef): number | undefined {
    const { app } = this;
    if (!this.cache || this.cache.model !== app.model || this.cache.revision !== app.revision) this.cache = { model: app.model, revision: app.revision, resolve: refResolver(app) };
    return this.cache.resolve(ref);
  }

  private requireAuthor(): string {
    const name = this.author.value.trim();
    if (!name) {
      this.app.toast('Indiquez d’abord votre nom (en haut de la carte) : il signe les observations et les commentaires.', true);
      this.author.focus();
    } else stored.set(AUTHOR_KEY, name);
    return name;
  }

  /** Remplace une observation ; `quiet` : la fiche n'est pas redessinée. */
  private commit(topic: Observation, quiet = false): void {
    const book = this.book;
    this.quiet = quiet;
    try {
      this.app.setObservations({ ...book, lists: extendLists(book.lists, [topic]), topics: book.topics.map((item) => (item.guid === topic.guid ? topic : item)) });
    } finally {
      this.quiet = false;
    }
  }

  private update(guid: string, change: (topic: Observation, author: string, now: Date) => Observation, quiet = false): void {
    const topic = this.book.topics.find((item) => item.guid === guid);
    const author = topic ? this.requireAuthor() : '';
    if (!topic || !author) return;
    try {
      this.commit(change(topic, author, new Date()), quiet);
    } catch (error) {
      this.app.toast(errorText(error), true);
      this.refresh();
    }
  }

  private filtered(): Observation[] {
    const { lists } = this.book;
    const f = this.filters;
    const filter: ObservationFilter = {
      statuses: f.status.value === TODO ? lists.statuses.filter((status) => !lists.done.includes(status)) : f.status.value ? [f.status.value] : undefined,
      company: f.company.value || undefined, trade: f.trade.value || undefined, level: f.level.value || undefined,
      overdue: f.due.value === 'overdue', dueBefore: f.due.value === 'before' && f.before.value ? f.before.value : undefined, text: f.text.value.trim() || undefined,
    };
    return sortObservations(filterObservations(this.book.topics, filter, lists, localDay()), f.sort.value as SortKey, lists);
  }

  private planViews(): SavedView[] {
    const { app } = this;
    return [...app.savedViews, ...app.userViews, ...levelPlans(app.levels, app.savedViews)].filter((view) => view.kind === 'plan');
  }

  // ------------------------------------------------------------- création

  private async fromSelection(): Promise<void> {
    if (!this.app.model) return;
    if (this.app.selection.size === 0) {
      this.app.toast('Sélectionnez d’abord un ou plusieurs éléments, ou utilisez « Pointer sur la maquette ».');
      return;
    }
    await this.create([...this.app.selection]);
  }

  /** Un clic dans la vue : la pose d'une observation (outil « pin »), ou un repère qui ouvre la sienne. */
  private click(event: PointerEvent): boolean {
    const { app } = this;
    if (app.tool === 'pin') {
      app.setTool('select');
      if (app.mapOpen) {
        app.toast('Fermez la carte pour poser une observation par clic : le globe dessine sa propre copie de la maquette.');
        return true;
      }
      const hit = app.viewer.pick(event.clientX, event.clientY);
      if (!hit) {
        app.toast('Aucun élément sous le pointeur : cliquez sur la maquette.');
        return true;
      }
      const rect = app.viewer.renderer.domElement.getBoundingClientRect();
      void this.create([hit.element], { point: hit.point.toArray(), x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
      return true;
    }
    if (this.el.hidden || app.mapOpen || app.tool !== 'select') return false;
    const index = this.pins.nearest(app.viewer, event.clientX, event.clientY);
    if (index < 0) return false;
    this.open(this.pinTopics[index]);
    return true;
  }

  /** L'image de la vue (au plus 1 500 px de côté, fond blanc), avec le repère du clic s'il y en a un. */
  private async snapshot(marker?: { x: number; y: number }): Promise<Blob | undefined> {
    const { app } = this;
    if (app.mapOpen) return undefined;
    const { width, height } = app.viewer.size;
    const scale = Math.min(1, 1500 / Math.max(width, height));
    try {
      const image = await capturePng(app.viewer, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), { background: '#ffffff' });
      return marker ? await withPin(image, marker.x, marker.y, '#dc2626') : image;
    } catch {
      return undefined;
    }
  }

  private async create(elements: number[], at?: { point: number[]; x: number; y: number }): Promise<void> {
    const { app } = this;
    const model = app.model;
    const author = model ? this.requireAuthor() : '';
    if (!model || !author) return;
    const point = at ? mm(yUpToZUp(toModelPoint(at.point, model.offset.toArray()))) : elementsPoint(app, elements);
    const plan = app.activeView?.kind === 'plan' ? app.activeView : null;
    const { width, height } = app.viewer.size;
    const viewpoint = viewpointOfView(captureView(app, 'observation'), width / Math.max(height, 1), newGuid());
    if (app.mapOpen) app.toast('Mode carte : l’image de la vue n’est pas disponible, l’observation est créée sans image.');
    // Le repère de l'image : le clic ; sans clic, le centre des éléments projeté dans la vue.
    const marker = at ?? (point ? markerOf(app, app.viewer.camera, point) ?? undefined : undefined);
    const snapshot = await this.snapshot(marker);
    // Un second point de vue regarde le point (c'est lui qu'ouvrent les autres outils), avec sa propre image.
    let viewpoints = [snapshot ? { ...viewpoint, snapshot } : viewpoint];
    if (point && !(viewpoint.camera && isAimed(viewpoint.camera, point))) {
      const camera = aimedCamera(app, point, elements);
      const aimedSnapshot = await snapshotFrom(app, camera, point);
      viewpoints = [defined({ guid: newGuid(), camera, clippingPlanes: viewpoint.clippingPlanes, selection: [], snapshot: aimedSnapshot }), ...viewpoints];
    }
    if (model !== app.model) return;
    const book = this.book;
    const observation = newObservation(defined({
      elements: elements.map((element) => elementRef(app, element)), point,
      pin: plan && point ? { plan: plan.id ?? plan.name, x: point[0], y: point[1] } : undefined,
      location: locate(app.store.propsOf(elements[0]), book.settings), stage: this.lastPhase || undefined,
      viewpoints,
    }), author, new Date(), book.lists, nextNumber(book.topics));
    this.current = observation.guid;
    app.setObservations({ ...book, topics: [...book.topics, observation] });
    if (this.el.hidden) this.toggle(true);
    this.editor.querySelector('input')?.focus();
  }

  /** Ouvre la vue de l'observation (son plan, sinon son point de vue) et sélectionne ses éléments. */
  private open(topic: Observation): void {
    const { app } = this;
    if (!app.model) return;
    const plan = topic.pin ? this.planViews().find((view) => (view.id ?? view.name) === topic.pin!.plan) : undefined;
    const view = plan ?? (topic.viewpoints[0] ? viewOfViewpoint(topic.viewpoints[0], `Observation ${topic.number}`) : null);
    if (view) app.openView(view);
    const resolve = (ref: ElementRef) => this.resolve(ref);
    const elements = topic.elements.flatMap((ref) => resolve(ref) ?? []);
    app.select(elements, 'panel');
    if (!view && elements.length > 0) app.fitTo(elements);
    this.current = topic.guid;
    this.refresh();
  }

  // ------------------------------------------------------------- fichiers

  private get baseName(): string {
    return withoutExtension(this.app.fileName || 'maquette');
  }

  private async importBcf(file: File): Promise<void> {
    const { app } = this;
    app.busy('Lecture du .bcf…');
    try {
      const read = await readBcf(file);
      const resolve = (ref: ElementRef) => this.resolve(ref);
      const revit = isRevitSession(app);
      const known = new Set(this.book.topics.map((topic) => topic.guid.toLowerCase()));
      const topics: Observation[] = [];
      for (const topic of read.topics) {
        const observation = fromBcfTopic(topic, 0, { revit, resolves: (key) => resolve({ key }) !== undefined });
        // Une image trop grande pour le BCF 3.0 (fichier d'un autre outil) est réduite une fois pour toutes.
        for (const viewpoint of observation.viewpoints) {
          const size = viewpoint.snapshot ? imageSize(new Uint8Array(await viewpoint.snapshot.arrayBuffer())) : null;
          if (viewpoint.snapshot && size && Math.max(size.width, size.height) > 1500) viewpoint.snapshot = await reducePhoto(viewpoint.snapshot);
        }
        const elements = observation.elements.flatMap((ref) => resolve(ref) ?? []);
        // Le point : celui du fichier (viewer-bim.json, croix), sinon le centre des éléments, sinon où la caméra regarde ; sinon aucun.
        // Une observation déjà connue garde son point : seul celui du fichier est proposé à la fusion.
        const point = observation.point ?? (known.has(observation.guid.toLowerCase()) ? undefined : elementsPoint(app, elements) ?? lookPoint(app, observation.viewpoints.find((viewpoint) => viewpoint.camera)?.camera));
        topics.push(defined({ ...observation, point, location: elements.length > 0 ? locate(app.store.propsOf(elements[0]), this.book.settings) : observation.location }));
      }
      const ext = read.extensions;
      const { book, added, updated } = mergeBooks(this.book, { settings: {}, topics, lists: { kinds: ext.topicTypes, statuses: ext.topicStatuses, done: [], trades: ext.topicLabels, priorities: ext.priorities, phases: ext.stages, companies: [], transitions: {} } });
      app.setObservations(book, false);
      app.toast([`BCF ${read.version} : ${plural(added, 'observation ajoutée', 'observations ajoutées')}, ${plural(updated, 'mise à jour', 'mises à jour')}.`, ...read.notes].join(' '), read.notes.length > 0);
    } catch (error) {
      app.toast(`Fichier BCF illisible : ${errorText(error)}`, true);
    } finally {
      app.busy(null);
    }
  }

  private async exportBcf(): Promise<void> {
    const { app } = this;
    const book = this.book;
    if (book.topics.length === 0) {
      app.toast('Aucune observation à exporter.');
      return;
    }
    const missing = book.topics.reduce((sum, topic) => sum + topic.documents.filter((document) => !document.data && document.url === undefined).length, 0);
    app.busy('Écriture du .bcf…');
    try {
      const context = bcfContext(app);
      download(await writeBcf(book.topics.map((topic) => toBcfTopic(topic, context)), extensionsOf(book)), `${this.baseName} - observations.bcf`);
      app.observationsUnsaved = false;
      if (missing > 0) app.toast(`${plural(missing, 'photo')} absente${missing > 1 ? 's' : ''} de cette session (restée${missing > 1 ? 's' : ''} dans un autre .bcf) : non écrite${missing > 1 ? 's' : ''}.`, true);
    } catch (error) {
      app.toast(`Export BCF impossible : ${errorText(error)}`, true);
    } finally {
      app.busy(null);
    }
  }

  private async report(): Promise<void> {
    const { app } = this;
    app.busy('Rapport…');
    try {
      download(await observationsPdf(this.filtered(), this.book.lists, { title: this.baseName, author: this.author.value.trim() }, (text) => app.busy(text)), `${this.baseName} - observations.pdf`);
    } catch (error) {
      app.toast(`Rapport impossible : ${errorText(error)}`, true);
    } finally {
      app.busy(null);
    }
  }

  private csv(): void {
    download(new Blob(['﻿', observationsCsv(this.filtered())], { type: 'text/csv' }), `${this.baseName} - observations.csv`);
  }

  // ------------------------------------------------------------- réglages

  private syncSettings(): void {
    const { settings, lists } = this.book;
    this.settings.level.value = settings.level ?? '';
    this.settings.room.value = settings.room ?? '';
    this.settings.zone.value = settings.zone ?? '';
    for (const [name, area] of Object.entries(this.settings.lists)) area.value = lists[name as keyof typeof this.settings.lists].join('\n');
    clear(this.paths);
    for (const path of this.app.store.paths) this.paths.append(h('option', { attrs: { value: path } }));
  }

  private applySettings(): void {
    const { app } = this;
    const book = this.book;
    const lines = (area: HTMLTextAreaElement) => [...new Set(area.value.split('\n').map((line) => line.trim()).filter(Boolean))];
    const lists: ObservationLists = { ...book.lists };
    for (const [name, area] of Object.entries(this.settings.lists)) lists[name as keyof typeof this.settings.lists] = lines(area);
    if (lists.statuses.length === 0) lists.statuses = book.lists.statuses;
    const settings = defined({ level: this.settings.level.value.trim() || undefined, room: this.settings.room.value.trim() || undefined, zone: this.settings.zone.value.trim() || undefined });
    const resolve = (ref: ElementRef) => this.resolve(ref);
    const topics = book.topics.map((topic) => {
      const element = topic.elements.map(resolve).find((index) => index !== undefined);
      return element === undefined ? topic : { ...topic, location: { ...topic.location, ...locate(app.store.propsOf(element), settings) } };
    });
    app.setObservations({ settings, lists, topics });
    app.toast('Réglages appliqués, emplacements recalculés.');
  }

  // ------------------------------------------------------------- affichage

  private setColouring(on: boolean): void {
    const { app } = this;
    if (on && app.model) {
      this.layer = statusLayer(this.filtered(), (ref: ElementRef) => this.resolve(ref), this.book.lists);
      app.setTransient(this.layer as ReturnType<typeof statusLayer>);
    } else {
      if (this.layer && app.transient === this.layer) app.setTransient(null);
      this.layer = null;
    }
    this.colour.setAttribute('aria-pressed', String(this.layer !== null));
  }

  private syncFilters(): void {
    const { lists, topics } = this.book;
    const fill = (select: HTMLSelectElement, all: string, values: readonly string[], extra: [string, string][] = []) => {
      const value = select.value;
      clear(select);
      select.append(h('option', { text: all, attrs: { value: '' } }), ...extra.map(([v, text]) => h('option', { text, attrs: { value: v } })), ...[...new Set(values)].map((v) => h('option', { text: v, attrs: { value: v } })));
      select.value = [...select.options].some((option) => option.value === value) ? value : '';
    };
    fill(this.filters.status, 'Tous les statuts', lists.statuses, [[TODO, 'Non terminées']]);
    fill(this.filters.company, 'Toutes les entreprises', [...lists.companies, ...topics.flatMap((t) => (t.assignedTo ? [t.assignedTo] : []))]);
    fill(this.filters.trade, 'Tous les lots', lists.trades);
    fill(this.filters.level, 'Tous les niveaux', topics.flatMap((t) => (t.location.level ? [t.location.level] : [])).sort());
    this.filters.before.hidden = this.filters.due.value !== 'before';
    clear(this.companies);
    for (const company of lists.companies) this.companies.append(h('option', { attrs: { value: company } }));
  }

  private syncPins(list: readonly Observation[]): void {
    const { app } = this;
    const model = app.model;
    const show = !this.el.hidden && model !== null && !app.mapOpen;
    this.pinTopics = show ? list.filter((topic) => topic.point) : [];
    if (model && show) {
      const offset = model.offset.toArray();
      this.pins.set(this.pinTopics.map((topic) => ({ position: toViewerPoint(zUpToYUp(topic.point!), offset), color: statusColor(topic.status, this.book.lists) })));
    }
    this.pins.object.visible = show && this.pinTopics.length > 0;
    app.viewer.invalidate();
  }

  /** Remet à jour liste, repères, couleurs ; `editor` : la fiche aussi. */
  private refresh(editor = true): void {
    const { app } = this;
    const list = this.el.hidden ? [] : this.filtered();
    this.syncPins(list);
    if (this.layer) this.setColouring(true);
    if (this.el.hidden) return;
    this.syncFilters();
    this.note.textContent = !app.model ? 'Ouvrez d’abord une maquette.'
      : app.mapOpen ? 'Carte ouverte : les repères sont masqués et la pose par clic attend sa fermeture ; la liste reste utilisable.'
        : 'Chaque observation garde la vue, la coupe et une image. Enregistrez avec « Exporter .bcf » (photos comprises) et « Enregistrer mes modifications » ou « Toutes les propriétés » (groupe Exporter) (repères sur plan, réglages).';
    this.renderCounts(list);
    this.renderList(list);
    if (editor) this.renderEditor();
  }

  private renderCounts(list: readonly Observation[]): void {
    const { topics, lists } = this.book;
    const open = topics.filter((topic) => !lists.done.includes(topic.status));
    const late = topics.filter((topic) => isOverdue(topic, lists, localDay())).length;
    const byCompany = groupObservations(open, 'company', lists.companies).map((group) => `${group.label} ${integer.format(group.topics.length)}`);
    const resolve = this.app.model ? (ref: ElementRef) => this.resolve(ref) : null;
    const lost = resolve ? orphans(topics, (ref) => resolve(ref) !== undefined).length : 0;
    this.counts.textContent = [
      `${plural(topics.length, 'observation')}${list.length !== topics.length ? ` (${integer.format(list.length)} affichée${list.length > 1 ? 's' : ''})` : ''}`,
      `${integer.format(open.length)} non terminée${open.length > 1 ? 's' : ''}`, `${integer.format(late)} en retard`,
      lost > 0 ? `${plural(lost, 'élément introuvable', 'éléments introuvables')}` : '',
    ].filter(Boolean).join(' · ') + (byCompany.length > 0 ? `. Non terminées par entreprise : ${byCompany.join(' · ')}.` : '');
  }

  private renderList(list: readonly Observation[]): void {
    clear(this.list);
    const { lists } = this.book;
    const key = this.filters.group.value as GroupKey;
    const order: Partial<Record<GroupKey, readonly string[]>> = { status: lists.statuses, company: lists.companies, phase: lists.phases, kind: lists.kinds, trade: lists.trades };
    const groups = groupObservations(list, key, order[key]);
    const resolve = this.app.model ? (ref: ElementRef) => this.resolve(ref) : null;
    for (const group of groups) {
      const rows = h('div');
      for (const topic of group.topics.slice(0, MAX_ROWS)) {
        const lost = resolve !== null && topic.elements.some((ref) => resolve(ref) === undefined);
        const details = [topic.status, topic.assignedTo, topic.dueDate ? `échéance ${frenchDate(topic.dueDate)}` : '', isOverdue(topic, lists, localDay()) ? 'en retard' : '', lost ? 'élément introuvable' : '', !topic.point && !topic.pin ? 'sans position' : ''].filter(Boolean).join(' · ');
        const row = h('button', { class: 'dimensions-row', attrs: { type: 'button', ...(topic.guid === this.current ? { 'aria-current': 'true' } : {}) } },
          h('span', { class: 'dimensions-name' }, h('span', { class: 'compare-swatch', attrs: { style: `background:${statusColor(topic.status, lists)}` } }), `N° ${topic.number} · ${topic.title || '(sans titre)'}`),
          h('span', { class: 'dimensions-values', text: details }));
        row.addEventListener('click', () => this.open(topic));
        rows.append(row);
      }
      this.list.append(key === 'none' ? rows : h('details', { attrs: groups.length <= 3 ? { open: '' } : {} }, h('summary', { text: `${group.label} (${integer.format(group.topics.length)})` }), rows));
      if (group.topics.length > MAX_ROWS) this.list.append(h('p', { class: 'hint', text: `… et ${integer.format(group.topics.length - MAX_ROWS)} autres : filtrez, ou voyez le CSV.` }));
    }
  }

  private renderEditor(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    clear(this.editor);
    const topic = this.book.topics.find((item) => item.guid === this.current);
    this.editor.hidden = !topic;
    if (!topic) return;
    const { lists } = this.book;
    const guid = topic.guid;
    const edit = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, change: (value: string) => Partial<Observation>) =>
      control.addEventListener('change', () => this.update(guid, (t, author, now) => touched(t, change(control.value.trim()), author, now), true));
    const title = h('input', { attrs: { type: 'text', 'aria-label': 'Titre', placeholder: 'Titre' } });
    title.value = topic.title;
    edit(title, (value) => ({ title: value }));
    const kind = choice(lists.kinds, topic.type, 'Type');
    edit(kind, (value) => ({ type: value }));
    const status = choice([topic.status, ...allowedStatuses(lists, topic.status)], topic.status, 'Statut');
    status.addEventListener('change', () => this.update(guid, (t, author, now) => changeStatus(t, status.value, lists, author, now)));
    const company = h('input', { attrs: { type: 'text', list: 'observation-companies', 'aria-label': 'Entreprise' } });
    company.value = topic.assignedTo ?? '';
    edit(company, (value) => ({ assignedTo: value || undefined }));
    const trade = choice(lists.trades, topic.labels[0] ?? '', 'Lot', '—');
    edit(trade, (value) => ({ labels: value ? [value] : [] }));
    const phase = choice(lists.phases, topic.stage ?? '', 'Phase', '—');
    phase.addEventListener('change', () => { this.lastPhase = phase.value; });
    edit(phase, (value) => ({ stage: value || undefined }));
    const priority = choice(lists.priorities, topic.priority ?? '', 'Priorité', '—');
    edit(priority, (value) => ({ priority: value || undefined }));
    const due = h('input', { attrs: { type: 'date', 'aria-label': 'Échéance' } });
    due.value = topic.dueDate?.slice(0, 10) ?? '';
    edit(due, (value) => ({ dueDate: value ? `${value}T00:00:00Z` : undefined }));
    const description = h('textarea', { class: 'tool-text observation-description', attrs: { rows: '3', 'aria-label': 'Description', placeholder: 'Description' } });
    description.value = topic.description ?? '';
    edit(description, (value) => ({ description: value || undefined }));

    const resolve = (ref: ElementRef) => this.resolve(ref);
    const lost = topic.elements.filter((ref) => resolve(ref) === undefined).length;
    const where = [topic.location.level && `Niveau ${topic.location.level}`, topic.location.room && `Local ${topic.location.room}`, topic.location.zone && `Zone ${topic.location.zone}`, topic.pin && `plan « ${topic.pin.plan} »`].filter(Boolean).join(' · ');

    const photoInput = h('input', { attrs: { type: 'file', accept: 'image/*', capture: 'environment', multiple: '', hidden: '' } });
    photoInput.addEventListener('change', () => {
      const files = [...(photoInput.files ?? [])];
      photoInput.value = '';
      if (files.length > 0) void this.addPhotos(guid, files);
    });
    const image = (blob: Blob, alt: string) => {
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const img = h('img', { class: 'observation-image', attrs: { src: url, alt, title: 'Ouvrir l’image' } });
      img.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
      return img;
    };
    const photos = h('div', { class: 'observation-photos' });
    const snapshot = topic.viewpoints.find((viewpoint) => viewpoint.snapshot)?.snapshot;
    if (snapshot) photos.append(image(snapshot, 'Vue de l’observation'));
    for (const document of topic.documents) {
      const remove = button('×', () => {
        if (window.confirm(`Retirer « ${document.filename} » de l’observation ?`)) this.update(guid, (t, author, now) => touched(t, { documents: t.documents.filter((d) => d.guid !== document.guid) }, author, now));
      }, { class: 'view-action', title: 'Retirer cette photo' });
      photos.append(h('span', { class: 'observation-photo' }, document.data && document.data.type.startsWith('image/') ? image(document.data, document.filename) : h('span', { class: 'hint', text: `${document.filename}${document.data || document.url ? '' : ' (dans le .bcf)'}` }), remove));
    }
    const comment = h('textarea', { class: 'tool-text', attrs: { rows: '2', 'aria-label': 'Commentaire', placeholder: 'Commentaire' } });
    const comments = h('ol', { class: 'observation-comments' }, ...topic.comments.map((item) => h('li', {},
      h('span', { class: 'dimensions-values', text: `${new Date(item.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${item.author}` }), h('span', { text: item.text }))));

    this.editor.append(
      h('h3', { class: 'dimensions-title', text: `Observation N° ${topic.number}` }),
      title,
      h('div', { class: 'tool-row' }, kind, status),
      field('Entreprise', company), field('Lot', trade), field('Phase', phase), field('Priorité', priority), field('Échéance', due),
      description,
      h('p', { class: lost > 0 ? 'hint warning' : 'hint', text: [where || 'Emplacement : désignez les propriétés dans « Réglages ».', lost > 0 ? `${plural(lost, 'élément introuvable')} dans la maquette ouverte (fichier réexporté ?) : le point et le niveau restent.` : ''].filter(Boolean).join(' ') }),
      photos,
      h('div', { class: 'tool-row' }, button('Ajouter des photos', () => photoInput.click(), { title: 'Depuis le disque ou l’appareil photo ; réduites à 1 500 px' }), photoInput),
      comments,
      comment,
      h('div', { class: 'tool-row' },
        button('Commenter', () => {
          const text = comment.value.trim();
          if (text) this.update(guid, (t, author, now) => addComment(t, text, author, now));
        }),
        button('Voir', () => this.open(topic), { title: 'Ouvrir la vue de l’observation et sélectionner ses éléments' }),
        button('Supprimer', () => {
          if (!window.confirm(`Supprimer l’observation N° ${topic.number} ?`)) return;
          this.current = null;
          this.app.setObservations({ ...this.book, topics: this.book.topics.filter((t) => t.guid !== guid) });
        }),
        button('Fermer', () => { this.current = null; this.refresh(); })),
    );
  }

  /** Les photos, réduites une à une (une seule pleine taille en mémoire), puis ajoutées d'un coup. */
  private async addPhotos(guid: string, files: readonly File[]): Promise<void> {
    const { app } = this;
    if (!this.requireAuthor()) return;
    const documents: BcfDocument[] = [];
    try {
      for (const [i, file] of files.entries()) {
        app.busy(`Réduction des photos… ${i + 1} sur ${files.length}`);
        documents.push({ guid: newGuid(), filename: `${withoutExtension(file.name) || 'photo'}.jpg`, data: await reducePhoto(file) });
      }
    } catch (error) {
      app.toast(`Photo illisible : ${errorText(error)}`, true);
    } finally {
      app.busy(null);
    }
    if (documents.length > 0) this.update(guid, (t, author, now) => touched(t, { documents: [...t.documents, ...documents] }, author, now));
  }
}
