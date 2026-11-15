// La page « Étude de site », guidée : un écran d'accueil (« Où est votre projet ? » : recherche d'un lieu, carte du
// monde à cliquer, études gardées dans ce navigateur), puis cinq étapes dans un rail toujours visible — Lieu, Terrain,
// Voisinage, Volumes, Analyses —, faites dans l'ordre mais libres d'être revues ; chacune a une phrase d'instruction, un
// seul bouton principal, et dit ce qui lui manque. Le sol est drapé d'un fond de carte dès le lieu choisi ; voisins et
// relief se chargent seuls. Les chiffres restent visibles en bas de la vue, les propositions en onglets au-dessus.
// L'étude est gardée dans le navigateur (IndexedDB) à chaque changement et s'enregistre en fichier JSON
// (docs/contrat-etude.md) ; une maquette BIM (Revit, IFC, glb…) peut être posée sur le site. Une proposition s'exporte
// en GLB + JSON pour le viewer, géoréférencée.

import { pageTabs, themeButton } from '../ui/Shell.ts';
import { Vector3 } from 'three';
import { fold, integer, oneDecimal } from '../data/text.ts';
import { Sketch } from '../engine/sketch.ts';
import { runSliced } from '../engine/sliced.ts';
import { IMAGERY_SOURCES, MERCATOR_MAX_LATITUDE, imagerySource, type ImageryId } from '../geo/imageryTiles.ts';
import { button, download, h } from '../ui/dom.ts';
import type { SamplePoint } from './analysis.ts';
import { groundAt, heightCounts, loadContext, neighbourBase, toEnu, toGeo } from './context.ts';
import { proposalGlb, proposalMetadata } from './exportGlb.ts';
import { GEOCODER_CREDIT, MIN_QUERY_LENGTH, reversePlace, searchPlaces, type Place } from './geocode.ts';
import { bar, centroid, rectangle, toScene, translate, volumeMesh } from './massing.ts';
import { figureRows, polygonArea, proposalFigures, toTsv } from './metrics.ts';
import { PARCEL_CREDIT, fetchParcel } from './parcel.ts';
import { placementFor, type ModelSnapshot } from './placedModel.ts';
import { ASSUMED_CSS, SiteScene } from './SiteScene.ts';
import { STEPS, isDone, missingFor, nextStep, warningFor, type NeighbourStatus, type StepId, type StepState } from './steps.ts';
import { StudyStore, openStudyStore, type StudySummary } from './store.ts';
import { MAX_FLOORS, MAX_FLOOR_HEIGHT, MAX_MODELS, MAX_OUTLINE_POINTS, MAX_PROPOSALS, MAX_VOLUMES, MIN_FLOOR_HEIGHT, newId, newProposal, newStudy, parseStudy, safeColor, studyToJson, type ModelRole, type PlacedModel, type Proposal, type Study, type Volume, type XY } from './study.ts';
import { daySunPath, defaultUtcOffset, localTime, presetDays, sunPosition, sunVector } from './sun.ts';
import { zoneCity, zoneFor, zoneOffset } from './timeZones.ts';
import { WorldMap } from './WorldMap.ts';

type DrawMode = 'limit' | 'parcel' | 'rectangle' | 'polygon' | 'bar';
type Selection = { kind: 'volume'; id: string } | { kind: 'neighbour'; index: number } | { kind: 'model'; id: string } | null;
type AnalysisKind = 'sun-ground' | 'sun-facade' | 'vsc';

interface AnalysisResult {
  kind: AnalysisKind;
  key: string;
  values: Float32Array;
  /** Positions affichées (décollées de leur surface) et taille des points (m). */
  display: Float32Array;
  size: number;
  label: string;
  /** Durée du jour (heures de soleil) : le haut de l'échelle. */
  dayLength: number;
}

const SQUARE_FEET = 10.763910416709722;
const DEFAULT_RADIUS = 300;
const RADII = [150, 300, 450, 600];
const SUN_STEP_MINUTES = 10;
/** Points au plus par analyse : borne le nombre de rayons (≈ 6 000 × 432 pour la composante de ciel). */
const MAX_POINTS = 6000;
const SUN_GRADIENT = ['#253494', '#2c7fb8', '#41b6c4', '#a1dab4', '#ffffcc'];
const MODEL_ACCEPT = '.rvt,.rfa,.rte,.rft,.ifc,.glb,.gltf,.bin,.json,.usdz,.usda,.usd,.png,.jpg,.jpeg,.webp';
const PLAY_SECONDS = 10;

/** Pastille de couleur ; la couleur passe par `safeColor` puis par la propriété DOM, jamais par une chaîne de style. */
function swatch(color: string): HTMLElement {
  const el = h('span', { class: 'site-swatch' });
  el.style.backgroundColor = safeColor(color, '#9b7fd1');
  return el;
}

const VSC_BINS: { min: number; color: string; label: string }[] = [
  { min: 27, color: '#1a9850', label: '≥ 27 %' },
  { min: 15, color: '#fee08b', label: '15 à 27 %' },
  { min: 5, color: '#fc8d59', label: '5 à 15 %' },
  { min: -Infinity, color: '#d73027', label: '< 5 %' },
];
const ANALYSES: { kind: AnalysisKind; name: string; intro: string }[] = [
  { kind: 'sun-ground', name: 'Heures de soleil au sol', intro: 'Combien d’heures chaque point du terrain reçoit le soleil direct le jour choisi ; le relief ne fait pas d’ombre dans ce calcul.' },
  { kind: 'sun-facade', name: 'Heures de soleil en façade', intro: 'La même chose sur les façades de vos volumes, niveau par niveau ; une façade ne compte que le soleil qui est devant elle.' },
  { kind: 'vsc', name: 'Ciel visible en façade (VSC)', intro: 'La part du ciel couvert que voit chaque point de façade : 39,6 % sans obstacle, repères à 27, 15 et 5 %.' },
];
const ANALYSIS_NAMES = Object.fromEntries(ANALYSES.map((a) => [a.kind, a.name])) as Record<AnalysisKind, string>;
const USE_LIMITS = 'Résultats indicatifs, pour comparer des options en début de projet : ce n’est pas une étude réglementaire d’ensoleillement ou de lumière naturelle.';

const today = () => new Date().toLocaleDateString('fr-FR');
const dayText = (day: string) => day.split('-').reverse().join('/');
/** « UTC+5:30 », « UTC−3 ». */
function offsetText(offset: number): string {
  const minutes = Math.round(Math.abs(offset) * 60);
  return `UTC${offset >= 0 ? '+' : '−'}${Math.floor(minutes / 60)}${minutes % 60 ? `:${String(minutes % 60).padStart(2, '0')}` : ''}`;
}
const slug = (text: string) => fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'etude';
const clockText = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`;
const round1 = (value: number) => Math.round(value * 10) / 10;
const twoDecimals = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const fourDecimals = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const coordinates = (latitude: number, longitude: number) =>
  `${fourDecimals.format(Math.abs(latitude))}° ${latitude >= 0 ? 'N' : 'S'}, ${fourDecimals.format(Math.abs(longitude))}° ${longitude >= 0 ? 'E' : 'O'}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Remplace le contenu d'un conteneur ; les enfants vides (null, false) sont ignorés. */
function fill(box: HTMLElement, ...children: (Node | string | null | false | undefined)[]): void {
  box.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: label }), control);
}

const note = (text: string) => h('p', { class: 'site-note', text });
const para = (text: string, className = 'site-text') => h('p', { class: className, text });

/** Un champ numérique : `apply` reçoit la valeur validée (à `change`) ; une valeur hors limites est refusée. */
function numberInput(value: number, apply: (value: number) => void, options: { min?: number; max?: number; step?: number; integer?: boolean } = {}): HTMLInputElement {
  const input = h('input', { attrs: { type: 'number', value: String(value), step: String(options.step ?? 'any') } });
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  input.addEventListener('change', () => {
    const next = Number(input.value.replace(',', '.'));
    if (input.value.trim() === '' || !Number.isFinite(next) || (options.min !== undefined && next < options.min) || (options.max !== undefined && next > options.max) || (options.integer && !Number.isInteger(next))) {
      input.value = String(value);
      return;
    }
    value = next;
    apply(next);
  });
  return input;
}

/** Couleur d'une échelle (couleurs CSS « #rrggbb » mélangées en sRGB), rendue en linéaire pour three.js. */
function colorRamp(stops: readonly string[], t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(Math.max(0, stops.length - 2), Math.floor(x)), f = x - i;
  const parse = (css: string) => [1, 3, 5].map((at) => parseInt(css.slice(at, at + 2), 16) / 255);
  const [a, b] = [parse(stops[i]), parse(stops[Math.min(stops.length - 1, i + 1)])];
  return a.map((v, k) => {
    const c = v + (b[k] - v) * f;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

const perimeter = (footprint: readonly XY[]): number => footprint.reduce((sum, [x, y], i) => {
  const [nx, ny] = footprint[(i + 1) % footprint.length];
  return sum + Math.hypot(nx - x, ny - y);
}, 0);

export class SitePage {
  private study: Study | null = null;
  private step: StepId = 'lieu';
  private proposalId = '';
  private selection: Selection = null;
  private mode: DrawMode | null = null;
  /** Augmente à chaque changement du voisinage (chargement, hauteur corrigée, voisin supprimé) : les analyses en dépendent. */
  private contextRevision = 0;
  private store = new StudyStore(null);
  private storeChecked = false;
  private recent: StudySummary[] = [];
  private saveTimer = 0;
  private saveState: 'saved' | 'pending' | 'failed' = 'saved';
  /** Des changements que seul un fichier garderait (magasin indisponible ou plein). */
  private unsavedFile = false;
  private readonly search = { busy: false, status: '', error: false, query: '', results: [] as Place[] };
  private neighbourStatus: NeighbourStatus = 'none';
  private neighbourMessage = '';
  private readonly snapshots = new Map<string, ModelSnapshot>();
  /** Une maquette reçue du viewer sans géoréférence : posée dès que le lieu est choisi. */
  private pendingModel: ModelSnapshot | null = null;
  private imageryId: ImageryId | 'none' = 'osm';
  /** La carte du monde est montrée par-dessus la scène (écran d'accueil, ou « Choisir sur la carte »). */
  private mapOpen = true;
  /** Premier point d'un rectangle ou d'une barre en cours de tracé (pour les cotes affichées). */
  private drawStart: XY | null = null;
  private playFrame = 0;
  private readonly cache = new Map<string, AnalysisResult>();
  private shown: AnalysisResult | null = null;
  private running: AbortController | null = null;
  private loading: AbortController | null = null;
  private drag: { apply: (de: number, dn: number) => void; start: XY; height: number; moved: boolean; x: number; y: number } | null = null;
  private day = presetDays(new Date().getFullYear())[3].day;
  private minutes = 12 * 60;
  private shadows = true;
  private threshold = { sun: 2, vsc: 27 };
  private barWidth = 12;
  /** Le volet « Réglages des chiffres » reste ouvert d'un rendu à l'autre. */
  private settingsOpen = false;

  private readonly root: HTMLElement;
  private readonly scene: SiteScene;
  private readonly sketch: Sketch;
  private readonly worldMap = new WorldMap();
  private readonly viewport: HTMLElement;
  private readonly rail = h('aside', { class: 'sidebar left site-rail', attrs: { 'aria-label': 'Étapes de l’étude' } });
  private readonly hintEl = h('div', { class: 'site-hint', attrs: { hidden: '' } });
  private readonly measureEl = h('div', { class: 'site-measure', attrs: { hidden: '' } });
  private readonly readoutEl = h('div', { class: 'site-readout', attrs: { hidden: '' } });
  private readonly tabsEl = h('div', { class: 'site-tabs', attrs: { role: 'tablist', 'aria-label': 'Propositions' } });
  private readonly figuresEl = h('div', { class: 'site-figures', attrs: { 'aria-label': 'Chiffres de la proposition' } });
  private readonly cardEl = h('div', { class: 'card site-card', attrs: { hidden: '' } });
  private readonly viewTools = h('div', { class: 'site-view-tools' });
  private readonly creditsEl = h('div', { class: 'site-credits' });
  private readonly mapBack = h('div', { class: 'site-map-back', attrs: { hidden: '' } });
  private readonly toastEl = h('div', { class: 'toast', attrs: { role: 'status', hidden: '' } });
  private readonly busyEl = h('div', { class: 'busy', attrs: { hidden: '' } });
  private toastTimer = 0;
  private readonly nameInput = h('input', { class: 'site-name', attrs: { type: 'text', 'aria-label': 'Nom de l’étude' } });
  private readonly saveStateEl = h('span', { class: 'site-save-state' });
  private readonly studyButtons = h('div', { class: 'bar-group' });
  private readonly searchInput = h('input', { class: 'site-search-input', attrs: { type: 'search', placeholder: 'Adresse, ville ou lieu (tout pays)', 'aria-label': 'Adresse ou lieu du projet', autocomplete: 'off' } });
  private readonly studyFileInput = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });
  private readonly modelInput = h('input', { attrs: { type: 'file', accept: MODEL_ACCEPT, multiple: '', hidden: '' } });
  private modelRole: ModelRole = 'context';
  private readonly sunReadout = h('p', { class: 'site-note' });
  private readonly progressEl = h('p', { class: 'site-note', attrs: { hidden: '' } });
  private readonly sunBox = h('div', { class: 'site-stack' });
  private timeInput!: HTMLInputElement;
  private playButton!: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.studyFileInput.addEventListener('change', () => {
      const file = this.studyFileInput.files?.[0];
      this.studyFileInput.value = '';
      if (file) void this.openFile(file);
    });
    this.modelInput.addEventListener('change', () => {
      const files = [...(this.modelInput.files ?? [])];
      this.modelInput.value = '';
      if (files.length > 0) void this.addModelFiles(files, this.modelRole);
    });
    this.nameInput.addEventListener('change', () => {
      if (!this.study) return;
      this.study.name = this.nameInput.value.trim() || 'Étude';
      this.changed();
    });
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.runSearch();
    });
    const topbar = h('header', { class: 'topbar' },
      h('span', { class: 'brand', text: 'Viewer BIM' }),
      pageTabs('etude'),
      this.nameInput,
      this.studyButtons,
      this.saveStateEl,
      this.studyFileInput, this.modelInput,
      h('div', { class: 'spacer' }),
      themeButton(),
    );

    const canvasHost = h('div', { class: 'canvas-host' });
    const overlayRoot = h('div', { class: 'overlay-root' });
    this.viewport = h('main', { class: 'viewport' }, canvasHost, overlayRoot, this.tabsEl, this.viewTools, this.hintEl, this.measureEl, this.readoutEl,
      this.cardEl, this.figuresEl, this.creditsEl, this.worldMap.el, this.mapBack, this.toastEl, this.busyEl);
    root.className = 'app site-app';
    root.append(topbar, this.rail, this.viewport);

    this.scene = new SiteScene(canvasHost);
    this.sketch = new Sketch(this.scene, overlayRoot, this.viewport);
    this.sketch.onChange = () => this.onSketchLine();
    this.sketch.onPolygon = (points) => this.onSketchPolygon(points.map((p): XY => [p.x, -p.z]));
    this.scene.afterRender.add(() => this.placeCard());
    this.worldMap.onPick = (latitude, longitude) => void this.pickOnMap(latitude, longitude);
    this.bindPointer();
    document.addEventListener('keydown', (event) => this.onKey(event));
    window.addEventListener('beforeunload', (event) => {
      if (this.study && this.unsavedFile) event.preventDefault();
    });
    // Onglet caché ou fermé : l'enregistrement en attente part tout de suite.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.saveState === 'pending') void this.persist();
    });
    this.buildSun();
    this.worldMap.show(20, 10, 2, false);
    this.render();
    void this.start();
  }

  /** Ouvre le magasin du navigateur, liste les études, reprend une maquette envoyée par le viewer. */
  private async start(): Promise<void> {
    this.store = await openStudyStore();
    this.storeChecked = true;
    this.recent = await this.store.list();
    const handoff = await this.store.takeHandoff();
    if (handoff) await this.receiveModel(handoff);
    else if (new URLSearchParams(location.search).has('maquette')) this.toast('Aucune maquette reçue du viewer : renvoyez-la depuis le groupe « Chantier » du viewer.', true);
    this.render();
  }

  // ------------------------------------------------------------------ état

  private get proposal(): Proposal {
    const study = this.study!;
    return study.proposals.find((p) => p.id === this.proposalId) ?? study.proposals[0];
  }

  private get selectedVolume(): Volume | null {
    const selection = this.selection;
    return selection?.kind === 'volume' && this.study ? this.proposal.volumes.find((v) => v.id === selection.id) ?? null : null;
  }

  private get selectedModel(): PlacedModel | null {
    const selection = this.selection;
    return selection?.kind === 'model' && this.study ? this.study.models.find((m) => m.id === selection.id) ?? null : null;
  }

  private get stepState(): StepState {
    const study = this.study;
    return { placed: study !== null, limit: (study?.site.limit.length ?? 0) >= 3, neighbours: this.neighbourStatus, volumes: study ? this.proposal.volumes.length : 0 };
  }

  /** Décalage horaire du site ce jour-là : celui de son fuseau (heure d'été comprise), sinon le décalage noté. */
  private offsetFor(day: string): number {
    const site = this.study?.site;
    if (!site) return 0;
    return (site.timeZone ? zoneOffset(site.timeZone, localTime(day, 12 * 60, site.utcOffset)) : null) ?? site.utcOffset;
  }

  private toast(message: string, error = false): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle('error', error);
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, error ? 9000 : 6000);
  }

  private busy(message: string | null): void {
    this.busyEl.hidden = message === null;
    if (message !== null) this.busyEl.textContent = message;
  }

  private areaText(m2: number): string {
    return this.study?.settings.units === 'ft2' ? `${integer.format(Math.round(m2 * SQUARE_FEET))} ft²` : `${integer.format(Math.round(m2))} m²`;
  }

  // ------------------------------------------------------------ garder l'étude

  /** Après tout changement de l'étude : elle sera gardée dans le navigateur dans un instant. */
  private changed(): void {
    this.unsavedFile = true;
    if (!this.store.available) {
      this.renderSaveState();
      return;
    }
    this.saveState = 'pending';
    this.renderSaveState();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.persist(), 600);
  }

  private async persist(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    const study = this.study;
    if (!study || !this.store.available) return;
    const ok = await this.store.save(study);
    if (this.study !== study) return;
    this.saveState = ok ? 'saved' : 'failed';
    if (ok) this.unsavedFile = false;
    this.renderSaveState();
  }

  private renderSaveState(): void {
    const text = !this.study ? ''
      : !this.store.available ? 'Rien n’est gardé dans ce navigateur : enregistrez le fichier.'
        : this.saveState === 'pending' ? 'Enregistrement…'
          : this.saveState === 'failed' ? 'Pas gardée (espace plein ?) : enregistrez le fichier.'
            : 'Gardée dans ce navigateur.';
    this.saveStateEl.textContent = text;
    this.saveStateEl.classList.toggle('warning', Boolean(this.study) && (!this.store.available || this.saveState === 'failed'));
  }

  private saveFile(): void {
    const study = this.study;
    if (!study) return;
    download(new Blob([studyToJson(study)], { type: 'application/json' }), `${slug(study.name)}.etude.json`);
    if (!this.store.available) this.unsavedFile = false;
    const missing = study.models.length > 0 ? ' Les maquettes posées ne sont pas dans le fichier : seule leur position y est.' : '';
    this.toast(`Étude enregistrée dans « ${slug(study.name)}.etude.json ».${missing}`);
  }

  private async openFile(file: File): Promise<void> {
    if (this.study && this.unsavedFile && !this.store.available && !window.confirm('Les modifications non enregistrées seront perdues. Ouvrir une autre étude ?')) return;
    let study: Study;
    try {
      study = parseStudy(JSON.parse(await file.text()));
    } catch (error) {
      this.toast(`Étude illisible : ${errorText(error)}`, true);
      return;
    }
    await this.persist();
    await this.load(study);
    // Un fichier ouvert rejoint la liste des études gardées.
    if (this.store.available) await this.persist();
    this.toast(`Étude « ${study.name} » ouverte${this.store.available ? ' et gardée dans ce navigateur' : ''}.`);
  }

  private async openStored(id: string): Promise<void> {
    try {
      const study = await this.store.open(id);
      if (!study) throw new Error('elle n’est plus dans ce navigateur');
      await this.load(study);
    } catch (error) {
      this.toast(`Étude impossible à rouvrir : ${errorText(error)}`, true);
    }
  }

  private async removeStored(summary: StudySummary): Promise<void> {
    if (!window.confirm(`Retirer l’étude « ${summary.name} » de ce navigateur ? Un fichier enregistré, s’il existe, n’est pas touché.`)) return;
    await this.store.remove(summary.id);
    this.recent = await this.store.list();
    this.render();
  }

  /** Retour à l'écran d'accueil (l'étude en cours est déjà gardée). */
  private async goHome(): Promise<void> {
    if (this.study && this.unsavedFile && !this.store.available && !window.confirm('Rien n’est gardé dans ce navigateur : l’étude non enregistrée sera perdue. Revenir à l’accueil ?')) return;
    await this.persist();
    this.stopPlaying();
    this.running?.abort();
    this.loading?.abort();
    this.setMode(null);
    for (const id of this.snapshots.keys()) this.scene.removeModel(id);
    this.snapshots.clear();
    this.study = null;
    this.selection = null;
    this.mapOpen = true;
    this.search.results = [];
    this.search.status = '';
    this.recent = await this.store.list();
    this.render();
  }

  // ------------------------------------------------------------------ étude

  private async load(study: Study): Promise<void> {
    this.running?.abort();
    this.loading?.abort();
    this.stopPlaying();
    for (const id of this.snapshots.keys()) this.scene.removeModel(id);
    this.snapshots.clear();
    this.study = study;
    this.proposalId = study.proposals[0].id;
    this.selection = null;
    this.cache.clear();
    this.shown = null;
    this.contextRevision++;
    this.unsavedFile = false;
    this.saveState = 'saved';
    this.neighbourStatus = study.context.fetchedAt ? 'loaded' : 'none';
    this.neighbourMessage = '';
    this.imageryId = study.site.country === 'fr' ? 'ign-ortho' : 'osm';
    this.mapOpen = false;
    this.setMode(null);
    this.nameInput.value = study.name;
    this.scene.setGround(study);
    this.applyImagery();
    this.scene.setAnalysis(null, null, 1);
    if (study.site.limit.length >= 3 || this.proposal.volumes.length > 0) this.scene.frame(Math.max(150, study.context.radius || DEFAULT_RADIUS) * 0.8);
    else this.scene.topView(180);
    this.step = nextStep(this.stepState);
    this.refresh();
    // Un voisinage jamais lu (lieu tout juste choisi, ou lecture interrompue) se charge seul ; un voisinage déjà lu
    // n'est jamais relu à l'ouverture.
    if (!study.context.fetchedAt) void this.loadNeighbourhood(DEFAULT_RADIUS, true);
    // La géométrie des maquettes posées est dans ce navigateur, pas dans le fichier.
    for (const placed of study.models) {
      const snapshot = await this.store.model(placed.id);
      if (this.study !== study) return;
      if (!snapshot) continue;
      this.snapshots.set(placed.id, snapshot);
      this.scene.addModel(snapshot);
    }
    this.refresh();
  }

  /** Pose le site sur un lieu : origine, nom, pays, fuseau ; le voisinage d'un ancien lieu est effacé. */
  private placeAt(study: Study, place: Place): void {
    const { site } = study;
    site.origin = { ...site.origin, latitude: place.latitude, longitude: place.longitude, altitude: 0 };
    site.place = place.label;
    if (place.country) site.country = place.country;
    else delete site.country;
    const zone = zoneFor(place.country, place.latitude, place.longitude);
    const offset = zone ? zoneOffset(zone, new Date()) : null;
    if (zone && offset !== null) {
      site.timeZone = zone;
      site.utcOffset = offset;
    } else {
      delete site.timeZone;
      site.utcOffset = defaultUtcOffset(place.longitude);
    }
    study.context = { ...study.context, buildings: [], terrain: null, credits: [], radius: 0, fetchedAt: null };
  }

  /** Un lieu choisi (recherche, carte, coordonnées) : une nouvelle étude, ou l'étude en cours déplacée. */
  private async choosePlace(place: Place): Promise<void> {
    this.search.results = [];
    this.search.status = '';
    this.searchInput.value = '';
    if (this.study) return this.movePlace(place);
    await this.persist();
    const study = newStudy();
    study.name = place.name;
    this.placeAt(study, place);
    await this.load(study);
    this.step = 'terrain';
    const pending = this.pendingModel;
    this.pendingModel = null;
    if (pending) this.placeSnapshot(pending, 'proposal');
    this.changed();
    this.render();
  }

  private movePlace(place: Place): void {
    const study = this.study!;
    const drawn = study.site.limit.length >= 3 || study.proposals.some((p) => p.volumes.length > 0);
    if (drawn && !window.confirm(`Déplacer le projet à « ${place.name} » ? La limite et les volumes gardent leur place par rapport au point du projet ; le voisinage est rechargé.`)) return;
    this.loading?.abort();
    this.placeAt(study, place);
    this.imageryId = study.site.country === 'fr' ? 'ign-ortho' : this.imageryId === 'none' ? 'none' : 'osm';
    this.contextRevision++;
    this.selection = null;
    this.mapOpen = false;
    this.neighbourStatus = 'none';
    this.scene.setGround(study);
    this.applyImagery();
    this.scene.topView(180);
    this.changed();
    this.refresh();
    void this.loadNeighbourhood(DEFAULT_RADIUS, true);
  }

  private async runSearch(): Promise<void> {
    const text = this.searchInput.value.trim();
    if (this.search.busy) return;
    if (text.length < MIN_QUERY_LENGTH) {
      Object.assign(this.search, { status: 'Tapez au moins trois caractères, puis Entrée.', error: true, results: [] });
      this.renderRail();
      return;
    }
    // La même recherche, déjà faite : pas de nouvelle demande au service.
    if (text === this.search.query && this.search.results.length > 0) return;
    Object.assign(this.search, { busy: true, status: 'Recherche…', error: false, results: [], query: text });
    this.renderRail();
    try {
      const results = await searchPlaces(text);
      Object.assign(this.search, { results, status: results.length > 0 ? 'Choisissez le bon lieu :' : `Aucun lieu trouvé pour « ${text} ». Essayez une autre orthographe ou une ville proche, ou cliquez sur la carte.`, error: results.length === 0 });
    } catch (error) {
      Object.assign(this.search, { query: '', status: `Recherche impossible : ${errorText(error)}. Cliquez sur la carte, ou entrez des coordonnées.`, error: true });
    } finally {
      this.search.busy = false;
      this.renderRail();
    }
  }

  /** Un clic sur la carte du monde : le nom du lieu est demandé au service (une demande), puis le lieu est choisi. */
  private async pickOnMap(latitude: number, longitude: number): Promise<void> {
    const fallback: Place = { label: coordinates(latitude, longitude), name: `Site ${coordinates(latitude, longitude)}`, latitude, longitude, country: null };
    this.busy('Recherche du nom du lieu…');
    let place = fallback;
    try {
      place = (await reversePlace(latitude, longitude, { signal: AbortSignal.timeout(8000) })) ?? fallback;
    } catch {
      // Sans nom : le lieu reste celui du clic, le fuseau est déduit de la longitude.
    } finally {
      this.busy(null);
    }
    await this.choosePlace(place);
  }

  /** Une maquette envoyée par le viewer : posée par sa géoréférence, ou en attente du lieu. */
  private async receiveModel(snapshot: ModelSnapshot): Promise<void> {
    const g = snapshot.georeference;
    if (!g) {
      this.pendingModel = snapshot;
      this.toast(`Maquette « ${snapshot.name} » reçue du viewer, sans géoréférence : choisissez le lieu du projet, elle sera posée au centre.`);
      return;
    }
    this.pendingModel = snapshot;
    let place: Place = { label: coordinates(g.latitude, g.longitude), name: snapshot.name, latitude: g.latitude, longitude: g.longitude, country: null };
    this.busy('Maquette reçue du viewer : recherche du lieu…');
    try {
      const found = await reversePlace(g.latitude, g.longitude, { signal: AbortSignal.timeout(8000) });
      if (found) place = { ...found, name: snapshot.name };
    } catch {
      // Le nom du lieu n'est qu'un confort : l'étude part des coordonnées.
    } finally {
      this.busy(null);
    }
    await this.choosePlace(place);
  }

  /** Tout redessiner (changement d'étude, de proposition, de sélection). */
  private refresh(): void {
    const study = this.study;
    if (study) {
      this.scene.setNeighbours(study, this.selection?.kind === 'neighbour' ? this.selection.index : null);
      this.scene.setVolumes(study, this.proposal, this.selection?.kind === 'volume' ? this.selection.id : null);
      this.scene.setLimit(study);
      this.placeModels();
      this.updateSun();
    }
    this.render();
  }

  private render(): void {
    const study = this.study;
    this.root.classList.toggle('site-home', !study);
    this.worldMap.el.hidden = !(this.mapOpen || !study);
    this.mapBack.hidden = !(study && this.mapOpen);
    fill(this.mapBack, study ? button('Revenir à la vue du site', () => { this.mapOpen = false; this.render(); }, { class: 'primary' }) : null);
    this.nameInput.hidden = !study;
    if (study) this.nameInput.value = study.name;
    fill(this.studyButtons,
      study ? button('Mes études', () => void this.goHome(), { title: 'Revenir à l’accueil : rechercher un autre lieu, rouvrir une étude gardée' }) : null,
      button('Ouvrir…', () => this.studyFileInput.click(), { title: 'Ouvrir une étude enregistrée (.json)' }),
      study ? button('Enregistrer', () => this.saveFile(), { title: 'Écrire l’étude dans un fichier .json, pour la garder ailleurs ou la partager' }) : null,
      study ? button('Exporter la proposition', () => this.exportProposal(), { title: 'GLB + JSON pour le viewer : un élément par volume, avec ses propriétés et sa position sur Terre' }) : null);
    this.renderSaveState();
    this.renderRail();
    this.renderTabs();
    this.renderFigures();
    this.renderViewTools();
    this.renderCredits();
    this.renderCard();
  }

  // ------------------------------------------------------------------- rail

  private renderRail(): void {
    if (!this.study) {
      fill(this.rail, this.startPanel());
      return;
    }
    const state = this.stepState;
    const items = STEPS.map((step, i) => {
      const active = step.id === this.step;
      const done = isDone(step.id, state);
      const loading = step.id === 'voisinage' && state.neighbours === 'loading';
      const status = loading ? 'chargement…' : done ? 'fait' : missingFor(step.id, state) ? 'à venir' : '';
      const head = h('button', { class: 'site-step-head', attrs: { type: 'button', 'aria-expanded': String(active) } },
        h('span', { class: `site-step-number${done ? ' done' : ''}`, text: done ? '✓' : String(i + 1) }),
        h('span', { class: 'site-step-title', text: step.title }),
        status ? h('span', { class: 'site-step-status', text: status }) : null);
      head.addEventListener('click', () => this.goTo(step.id));
      const section = h('section', { class: `site-step${active ? ' active' : ''}` }, head);
      if (active) section.append(h('div', { class: 'site-step-body' }, para(step.instruction, 'site-instruction'), ...this.stepBody(step.id)));
      return section;
    });
    fill(this.rail, ...items);
  }

  private goTo(step: StepId): void {
    if (this.mode) this.setMode(null);
    this.step = step;
    if (step !== 'lieu') this.mapOpen = false;
    this.render();
  }

  private stepBody(step: StepId): (HTMLElement | null)[] {
    const missing = missingFor(step, this.stepState);
    if (missing) {
      return [h('div', { class: 'site-missing' }, para(missing.message), button(`Aller à l’étape ${STEPS.findIndex((s) => s.id === missing.goTo) + 1}`, () => this.goTo(missing.goTo), { class: 'primary' }))];
    }
    switch (step) {
      case 'lieu': return this.placeStep();
      case 'terrain': return this.terrainStep();
      case 'voisinage': return this.neighbourStep();
      case 'volumes': return this.volumeStep();
      case 'analyses': return this.analysisStep();
    }
  }

  /** Le champ de recherche et ses résultats (accueil et étape « Lieu »). */
  private searchBlock(): HTMLElement {
    const results = this.search.results.map((place) => {
      const item = button('', () => void this.choosePlace(place), { class: 'site-result', title: place.label });
      item.replaceChildren(h('span', { class: 'site-result-name', text: place.name }), h('span', { class: 'site-result-label', text: place.label }));
      return item;
    });
    return h('div', { class: 'site-search' },
      h('div', { class: 'site-search-row' }, this.searchInput, button(this.search.busy ? 'Recherche…' : 'Chercher', () => void this.runSearch(), { class: this.study ? '' : 'primary', attrs: this.search.busy ? { disabled: '' } : {} })),
      this.search.status ? para(this.search.status, this.search.error ? 'site-note warning' : 'site-note') : null,
      results.length > 0 ? h('div', { class: 'site-results' }, ...results) : null);
  }

  private startPanel(): HTMLElement {
    const storage = !this.storeChecked ? ''
      : this.store.available ? 'Vos études sont gardées dans ce navigateur, sur cet appareil (les comptes viendront plus tard). Pour les garder ailleurs ou les partager : « Enregistrer » écrit un fichier.'
        : 'Ce navigateur ne garde rien (navigation privée ?) : pensez à « Enregistrer » votre étude dans un fichier.';
    const list = this.recent.map((summary) => {
      const open = button('', () => void this.openStored(summary.id), { class: 'site-recent-open', title: 'Rouvrir cette étude' });
      open.replaceChildren(h('span', { class: 'site-result-name', text: summary.name }),
        h('span', { class: 'site-result-label', text: `${summary.place} · ${new Date(summary.updatedAt).toLocaleDateString('fr-FR')}` }));
      return h('div', { class: 'site-recent' }, open, button('Retirer', () => void this.removeStored(summary), { title: 'Retirer cette étude de ce navigateur' }));
    });
    return h('div', { class: 'site-start' },
      h('h1', { text: 'Où est votre projet ?' }),
      para('Cherchez une adresse ou un lieu, dans n’importe quel pays, puis appuyez sur Entrée ; ou cliquez sur la carte.'),
      this.pendingModel ? para(`Maquette « ${this.pendingModel.name} » reçue du viewer : choisissez le lieu du projet, elle y sera posée.`, 'site-note warning') : null,
      this.searchBlock(),
      h('h2', { text: 'Vos études' }),
      list.length > 0 ? h('div', { class: 'site-recents' }, ...list) : para(this.store.available ? 'Aucune étude gardée pour l’instant.' : 'Aucune étude gardée.', 'site-note'),
      h('div', { class: 'tool-row' }, button('Ouvrir une étude (fichier .json)…', () => this.studyFileInput.click())),
      storage ? note(storage) : null,
      note(GEOCODER_CREDIT));
  }

  // ------------------------------------------------------------ 1. lieu

  private placeStep(): (HTMLElement | null)[] {
    const study = this.study!;
    const { site } = study;
    const offset = this.offsetFor(this.day);
    const latitude = h('input', { attrs: { type: 'number', step: 'any', min: '-90', max: '90', value: String(site.origin.latitude) } });
    const longitude = h('input', { attrs: { type: 'number', step: 'any', min: '-180', max: '180', value: String(site.origin.longitude) } });
    const altitude = h('input', { attrs: { type: 'number', step: 'any', value: String(site.origin.altitude) } });
    const apply = async () => {
      const [lat, lon, alt] = [latitude, longitude, altitude].map((input) => (input.value.trim() ? Number(input.value.replace(',', '.')) : NaN));
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(alt)) {
        this.toast('Latitude entre −90 et 90, longitude entre −180 et 180, altitude en mètres.', true);
        return;
      }
      if (lat === site.origin.latitude && lon === site.origin.longitude) {
        // Même lieu : seule l'altitude change ; le sol local et le pied des voisins se recalent.
        site.origin.altitude = alt;
        this.contextRevision++;
        this.scene.setGround(study);
        this.applyImagery();
        this.changed();
        this.refresh();
        return;
      }
      let place: Place = { label: coordinates(lat, lon), name: study.name, latitude: lat, longitude: lon, country: null };
      try {
        const found = await reversePlace(lat, lon, { signal: AbortSignal.timeout(8000) });
        if (found) place = { ...found, name: study.name };
      } catch {
        // Sans nom de lieu : le fuseau sera déduit de la longitude.
      }
      this.movePlace(place);
    };
    const offsetInput = numberInput(round1(offset * 4) / 4, (value) => {
      delete site.timeZone;
      site.utcOffset = value;
      this.changed();
      this.updateSun();
      this.checkAnalysis();
      this.renderRail();
    }, { min: -12, max: 14, step: 0.25 });
    const coordinatesBox = h('details', {},
      h('summary', { text: 'Coordonnées' }),
      h('div', { class: 'site-stack' },
        field('Latitude', latitude), field('Longitude', longitude), field('Altitude (m)', altitude),
        h('div', { class: 'tool-row' }, button('Placer le projet à ces coordonnées', () => void apply())),
        note(`La carte s’arrête vers ${Math.floor(MERCATOR_MAX_LATITUDE)}° de latitude (projection Web Mercator) : au-delà, entrez les coordonnées ici ; le soleil et les analyses fonctionnent à toutes les latitudes.`)));
    const zoneText = site.timeZone
      ? `Heure du site : heure de ${zoneCity(site.timeZone)} (${offsetText(offset)} le ${dayText(this.day)}), trouvée d’après le lieu.`
      : `Heure du site : ${offsetText(offset)}${site.utcOffset === defaultUtcOffset(site.origin.longitude) ? ', déduite de la longitude ; corrigez-la si l’heure légale diffère' : ', corrigée à la main'}.`;
    return [
      h('div', { class: 'site-place' }, h('strong', { text: study.name }), para(site.place ?? coordinates(site.origin.latitude, site.origin.longitude), 'site-note'),
        para(`${coordinates(site.origin.latitude, site.origin.longitude)} · altitude ${oneDecimal.format(site.origin.altitude)} m`, 'site-note')),
      h('div', { class: 'tool-row' }, site.limit.length >= 3
        ? button('Continuer : le terrain', () => this.goTo('terrain'), { class: 'primary' })
        : button('Tracer la limite du terrain', () => { this.goTo('terrain'); this.setMode('limit'); }, { class: 'primary' })),
      para('Pas le bon endroit ? Cherchez un autre lieu ou choisissez-le sur la carte :', 'site-note'),
      this.searchBlock(),
      h('div', { class: 'tool-row' }, button('Choisir sur la carte', () => {
        this.mapOpen = true;
        this.worldMap.show(site.origin.latitude, site.origin.longitude, 16, true);
        this.render();
      }, { title: 'Ouvre la carte sur le lieu actuel : cliquez le terrain exact' })),
      para(zoneText, 'site-note'),
      h('details', {}, h('summary', { text: 'Corriger l’heure du site' }), field('Décalage (h)', offsetInput), note('Heures par rapport au temps universel, heure d’été comprise (ex. 5,5 pour UTC+5:30).')),
      coordinatesBox,
    ];
  }

  // ---------------------------------------------------------- 2. terrain

  private terrainStep(): (HTMLElement | null)[] {
    const study = this.study!;
    const limit = study.site.limit;
    const drawing = this.mode === 'limit' || this.mode === 'parcel';
    const france = study.site.country === 'fr';
    const primary = drawing ? null
      : limit.length >= 3 ? button('Continuer : le voisinage', () => this.goTo('voisinage'), { class: 'primary' })
        : button('Tracer la limite', () => this.setMode('limit'), { class: 'primary' });
    return [
      limit.length >= 3 ? h('p', { class: 'site-figure-line' }, 'Terrain : ', h('strong', { text: this.areaText(polygonArea(limit)) }), ` · périmètre ${integer.format(Math.round(perimeter(limit)))} m`) : null,
      this.mode === 'limit' ? para('Cliquez les coins du terrain sur la carte ; la surface s’affiche pendant le tracé. Cliquez le premier point pour fermer. Échap : annuler.', 'site-note warning') : null,
      this.mode === 'parcel' ? para('Cliquez une parcelle sur la carte : sa limite est lue au cadastre.', 'site-note warning') : null,
      h('div', { class: 'tool-row' }, primary,
        drawing ? button('Annuler le tracé', () => this.setMode(null)) : null,
        !drawing && limit.length >= 3 ? button('Retracer la limite', () => this.setMode('limit')) : null,
        !drawing && limit.length >= 3 ? button('Effacer', () => { study.site.limit = []; this.changed(); this.refresh(); this.checkAnalysis(); }) : null),
      france && !drawing ? h('div', { class: 'tool-row' }, button('Choisir la parcelle (cadastre)', () => this.setMode('parcel'), { title: 'France : cliquez une parcelle, sa limite est lue au cadastre (IGN, API Carto)' })) : null,
      france ? note(PARCEL_CREDIT) : null,
    ];
  }

  // -------------------------------------------------------- 3. voisinage

  private neighbourStep(): (HTMLElement | null)[] {
    const study = this.study!;
    const { context } = study;
    const counts = heightCounts(context.buildings);
    const edited = context.buildings.filter((b) => b.edited).length;
    const radius = h('select', { attrs: { 'aria-label': 'Rayon du voisinage' } }, ...RADII.map((r) => h('option', { text: `${r} m`, attrs: { value: String(r) } })));
    radius.value = String(RADII.includes(context.radius) ? context.radius : DEFAULT_RADIUS);
    const status = this.neighbourStatus;
    const legend = h('p', { class: 'site-uses' }, h('span', { class: 'site-use' }, swatch(ASSUMED_CSS), 'hauteur supposée (8 m) : à vérifier'), h('span', { class: 'site-use' }, swatch('#d9d4cb'), 'hauteur connue'));
    return [
      status === 'loading' ? h('p', { class: 'site-progress' }, this.neighbourMessage || 'Lecture du voisinage…') : null,
      status === 'failed' ? para(this.neighbourMessage, 'site-note warning') : null,
      context.fetchedAt
        ? para(`${integer.format(context.buildings.length)} bâtiments dans un rayon de ${integer.format(context.radius)} m : ${integer.format(counts.measured)} hauteurs mesurées, ${integer.format(counts.tagged)} renseignées dans OpenStreetMap, ${integer.format(counts.assumed)} supposées${edited ? `, ${integer.format(edited)} corrigées par vous` : ''}. Relief : ${context.terrain ? `grille de ${context.terrain.step} m` : 'aucun (sol plat)'}.`)
        : status !== 'loading' ? para('Rien de chargé : sol plat, pas de voisins.', 'site-note') : null,
      context.fetchedAt ? legend : null,
      h('div', { class: 'tool-row' },
        status === 'loading' ? button('Arrêter', () => this.loading?.abort())
          : status === 'failed' || !context.fetchedAt ? button(status === 'failed' ? 'Réessayer' : 'Charger le voisinage', () => void this.loadNeighbourhood(Number(radius.value), false), { class: 'primary' })
            : button('Continuer : dessiner les volumes', () => this.goTo('volumes'), { class: 'primary' })),
      context.fetchedAt && status !== 'loading' ? h('div', { class: 'tool-row' }, radius, button('Recharger avec un autre rayon', () => void this.loadNeighbourhood(Number(radius.value), false))) : null,
      context.buildings.length > 0 ? note('Cliquez un bâtiment dans la vue pour corriger sa hauteur ou le retirer ; une hauteur fausse donne une ombre fausse.') : null,
      ...this.modelsBlock('context'),
      context.credits.length > 0 ? note(`Sources : ${context.credits.join(' ; ')}.`) : null,
    ];
  }

  private async loadNeighbourhood(radius: number, auto: boolean): Promise<void> {
    const study = this.study;
    if (!study) return;
    if (!auto && study.context.fetchedAt && study.context.buildings.length > 0 && !window.confirm('Recharger le voisinage remplace les bâtiments chargés et vos corrections de hauteur. Continuer ?')) return;
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    this.neighbourStatus = 'loading';
    this.neighbourMessage = `Lecture du voisinage dans un rayon de ${radius} m…`;
    this.renderRail();
    try {
      const { context, altitude, notes } = await loadContext(study.site.origin, Math.min(600, Math.max(100, radius)), {
        signal: controller.signal,
        onProgress: (message) => {
          this.neighbourMessage = message;
          if (this.loading === controller) this.renderRail();
        },
      });
      if (controller.signal.aborted || this.study !== study) return;
      study.context = context;
      if (altitude !== null) study.site.origin.altitude = altitude;
      // L'altitude de l'origine vient d'être lue : une maquette posée par sa géoréférence se recale en hauteur.
      for (const model of study.models) {
        const snapshot = this.snapshots.get(model.id);
        if (model.georeferenced && snapshot) Object.assign(model, placementFor(snapshot, study).placement);
      }
      this.contextRevision++;
      this.loading = null;
      this.neighbourStatus = 'loaded';
      if (this.selection?.kind === 'neighbour') this.selection = null;
      this.scene.setGround(study);
      this.applyImagery();
      this.changed();
      this.refresh();
      this.checkAnalysis();
      const counts = heightCounts(context.buildings);
      this.toast([`Voisinage chargé : ${integer.format(context.buildings.length)} bâtiments, dont ${integer.format(counts.assumed)} de hauteur supposée.`, ...notes].join(' '), notes.length > 0);
    } catch (error) {
      if (this.loading === controller) this.loading = null;
      if (this.study !== study) return;
      this.neighbourStatus = study.context.fetchedAt ? 'loaded' : controller.signal.aborted ? 'none' : 'failed';
      this.neighbourMessage = controller.signal.aborted ? '' : `Le voisinage n’a pas pu être chargé : ${errorText(error)}`;
      this.renderRail();
    }
  }

  private neighboursChanged(): void {
    const study = this.study!;
    this.contextRevision++;
    this.changed();
    this.scene.setNeighbours(study, this.selection?.kind === 'neighbour' ? this.selection.index : null);
    this.renderRail();
    this.renderCard();
    this.checkAnalysis();
  }

  // --------------------------------------------------------- maquettes

  private modelsBlock(role: ModelRole): HTMLElement[] {
    const study = this.study!;
    const models = study.models.filter((m) => m.role === role && (role === 'context' || m.proposal === this.proposal.id));
    const rows = models.map((model) => {
      const missing = !this.snapshots.has(model.id);
      const row = button('', () => this.select({ kind: 'model', id: model.id }), { class: 'dimensions-row', attrs: { 'aria-pressed': String(this.selection?.kind === 'model' && this.selection.id === model.id) } });
      row.replaceChildren(h('span', { class: 'dimensions-name', text: model.name }),
        h('span', { class: 'dimensions-values', text: missing ? 'absente de ce navigateur : à rajouter' : `${integer.format(model.triangles)} triangles${model.georeferenced ? ' · géoréférencée' : ''}` }));
      return row;
    });
    const add = button(role === 'context' ? 'Ajouter une maquette (contexte)…' : 'Ajouter une maquette comme proposition…', () => {
      if (study.models.length >= MAX_MODELS) return this.toast(`Au plus ${MAX_MODELS} maquettes par étude.`, true);
      this.modelRole = role;
      this.modelInput.click();
    }, { title: 'Revit (.rvt), IFC, glb ou gltf avec son .json, usdz : posée par sa géoréférence, sinon au centre du terrain' });
    return [
      h('p', { class: 'field-label', text: role === 'context' ? 'Maquettes autour du projet' : 'Maquettes de cette proposition' }),
      ...(rows.length > 0 ? [h('div', { class: 'site-list' }, ...rows)] : []),
      h('div', { class: 'tool-row' }, add),
    ];
  }

  async addModelFiles(files: File[], role: ModelRole): Promise<void> {
    const study = this.study;
    if (!study) return;
    this.busy('Lecture de la maquette…');
    try {
      const { readModelFiles } = await import('./bringModel.ts');
      const used = study.models.reduce((sum, m) => sum + (this.snapshots.has(m.id) ? m.triangles : 0), 0);
      const snapshot = await readModelFiles(files, (message) => this.busy(message), used);
      if (this.study !== study) return;
      this.placeSnapshot(snapshot, role);
    } catch (error) {
      this.toast(`Maquette non ajoutée : ${errorText(error)}`, true);
    } finally {
      this.busy(null);
    }
  }

  private placeSnapshot(snapshot: ModelSnapshot, role: ModelRole): void {
    const study = this.study!;
    const { placement, georeferenced, distance } = placementFor(snapshot, study);
    const entry: PlacedModel = { id: snapshot.id, name: snapshot.name, role, ...placement, georeferenced, triangles: snapshot.triangles };
    if (role === 'proposal') entry.proposal = this.proposal.id;
    study.models.push(entry);
    this.snapshots.set(snapshot.id, snapshot);
    this.scene.addModel(snapshot);
    this.selection = { kind: 'model', id: snapshot.id };
    this.changed();
    this.refresh();
    this.checkAnalysis();
    void this.store.saveModel(study.id, snapshot).then((ok) => {
      if (!ok && this.store.available) this.toast(`« ${snapshot.name} » n’a pas pu être gardée dans ce navigateur (espace plein ?) : il faudra la rajouter à la prochaine ouverture.`, true);
    });
    this.toast(georeferenced
      ? `« ${snapshot.name} » posée par sa géoréférence, à ${integer.format(Math.round(distance))} m du point du projet.`
      : snapshot.georeference
        ? `« ${snapshot.name} » : sa géoréférence la pose à ${oneDecimal.format(distance / 1000)} km du projet ; elle est posée au centre du terrain. Glissez-la pour la déplacer.`
        : `« ${snapshot.name} » n’a pas de géoréférence : posée au centre du terrain. Glissez-la pour la déplacer, tournez-la dans sa fiche.`);
  }

  private removeModel(model: PlacedModel): void {
    const study = this.study!;
    study.models = study.models.filter((m) => m !== model);
    this.scene.removeModel(model.id);
    this.snapshots.delete(model.id);
    void this.store.removeModel(model.id);
    this.selection = null;
    this.changed();
    this.refresh();
    this.checkAnalysis();
  }

  private placeModels(): void {
    const study = this.study!;
    const current = this.proposal.id;
    this.scene.placeModels(study.models.map((m) => ({ id: m.id, placement: m, visible: m.role === 'context' || (m.proposal ?? current) === current })),
      this.selection?.kind === 'model' ? this.selection.id : null);
  }

  // --------------------------------------------------------- 4. volumes

  private volumeStep(): (HTMLElement | null)[] {
    const study = this.study!;
    const useName = (id: string) => study.settings.uses.find((use) => use.id === id)?.name ?? id;
    const draw = (mode: DrawMode, label: string, title: string, primary = false) => button(label, () => this.setMode(this.mode === mode ? null : mode), { title, class: primary ? 'primary' : '', attrs: { 'aria-pressed': String(this.mode === mode) } });
    const volumes = this.proposal.volumes;
    const barWidth = numberInput(this.barWidth, (value) => { this.barWidth = value; if (this.mode === 'bar') this.setMode('bar'); }, { min: 1, max: 200, step: 0.5 });
    const rows = volumes.map((volume) => {
      const row = button('', () => this.select({ kind: 'volume', id: volume.id }), { class: 'dimensions-row', attrs: { 'aria-pressed': String(this.selection?.kind === 'volume' && this.selection.id === volume.id) } });
      row.replaceChildren(h('span', { class: 'dimensions-name', text: volume.name }),
        h('span', { class: 'dimensions-values', text: `${useName(volume.use)} · ${volume.floors} niv. · ${this.areaText(polygonArea(volume.footprint) * volume.floors)}` }));
      return row;
    });
    const hints: Partial<Record<DrawMode, string>> = {
      rectangle: 'Cliquez deux coins opposés ; les cotes s’affichent pendant le tracé.',
      polygon: 'Cliquez les sommets, puis le premier point pour fermer.',
      bar: `Cliquez le début puis la fin de l’axe ; largeur ${oneDecimal.format(this.barWidth)} m.`,
    };
    return [
      h('div', { class: 'tool-row' },
        draw('rectangle', 'Rectangle', 'Deux clics : deux coins opposés', volumes.length === 0),
        draw('polygon', 'Polygone', 'Cliquez les sommets, puis le premier pour fermer'),
        draw('bar', 'Barre', 'Deux clics : l’axe de la barre')),
      this.mode && hints[this.mode] ? para(hints[this.mode]!, 'site-note warning') : null,
      field('Largeur barre (m)', barWidth),
      h('div', { class: 'site-uses' }, ...study.settings.uses.map((use) => h('span', { class: 'site-use' }, swatch(use.color), use.name))),
      rows.length > 0 ? h('div', { class: 'site-list' }, ...rows) : para('Aucun volume dans cette proposition.', 'site-note'),
      rows.length > 0 ? note('Cliquez un volume pour régler ses niveaux et son usage ; glissez-le pour le déplacer.') : null,
      volumes.length > 0 ? h('div', { class: 'tool-row' }, button('Continuer : les analyses', () => this.goTo('analyses'), { class: 'primary' })) : null,
      ...this.modelsBlock('proposal'),
    ];
  }

  /** Faux, et dit pourquoi, si la proposition a déjà ses `MAX_VOLUMES` volumes. */
  private roomForVolume(): boolean {
    if (this.proposal.volumes.length < MAX_VOLUMES) return true;
    this.toast(`Au plus ${MAX_VOLUMES} volumes par proposition.`, true);
    return false;
  }

  private addVolume(footprint: XY[]): void {
    if (!this.roomForVolume()) return;
    if (polygonArea(footprint) < 0.5) {
      this.toast('Volume trop petit : tracez plus grand.', true);
      return;
    }
    const study = this.study!;
    const n = this.proposal.volumes.length + 1;
    const volume: Volume = { id: newId(), name: `Volume ${n}`, footprint, baseLevel: round1(groundAt(study, ...centroid(footprint))), floors: 4, floorHeight: 3, use: study.settings.uses[0]?.id ?? 'autre' };
    this.proposal.volumes.push(volume);
    this.selection = { kind: 'volume', id: volume.id };
    this.changed();
    this.refresh();
    this.checkAnalysis();
  }

  private duplicateVolume(volume: Volume): void {
    if (!this.roomForVolume()) return;
    const copy: Volume = { ...structuredClone(volume), id: newId(), name: `${volume.name} (copie)`, footprint: translate(volume.footprint, 5, -5) };
    this.proposal.volumes.push(copy);
    this.selection = { kind: 'volume', id: copy.id };
    this.changed();
    this.refresh();
    this.checkAnalysis();
  }

  private deleteVolume(volume: Volume): void {
    this.proposal.volumes = this.proposal.volumes.filter((v) => v !== volume);
    this.selection = null;
    this.changed();
    this.refresh();
    this.checkAnalysis();
  }

  private select(selection: Selection): void {
    this.selection = selection;
    this.refresh();
  }

  /** Après une modification d'un champ de la fiche : la vue, les chiffres et les listes suivent ; la fiche reste. */
  private edited(): void {
    this.changed();
    this.scene.setVolumes(this.study!, this.proposal, this.selection?.kind === 'volume' ? this.selection.id : null);
    this.placeModels();
    this.renderRail();
    this.renderFigures();
    this.checkAnalysis();
  }

  // ------------------------------------------------------ fiche flottante

  /** La fiche de ce qui est sélectionné (volume, voisin, maquette), posée à côté de lui dans la vue. */
  private renderCard(): void {
    const study = this.study;
    const selection = this.selection;
    if (!study || !selection || this.mapOpen) {
      this.cardEl.hidden = true;
      return;
    }
    const close = button('×', () => this.select(null), { class: 'close-button', title: 'Fermer (Échap)' });
    const head = (title: string) => h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: title }), close);
    if (selection.kind === 'volume') {
      const volume = this.selectedVolume;
      if (!volume) return void (this.cardEl.hidden = true);
      const uses = study.settings.uses;
      const name = h('input', { attrs: { type: 'text', value: volume.name, 'aria-label': 'Nom du volume' } });
      name.addEventListener('change', () => { volume.name = name.value.trim() || 'Volume'; this.edited(); });
      const use = h('select', {}, ...uses.map((u) => h('option', { text: u.name, attrs: { value: u.id } })));
      use.value = volume.use;
      use.addEventListener('change', () => { volume.use = use.value; this.edited(); });
      const ground = h('select', {}, h('option', { text: 'Même usage', attrs: { value: '' } }), ...uses.map((u) => h('option', { text: u.name, attrs: { value: u.id } })));
      ground.value = volume.floorUses?.[0] ?? '';
      ground.addEventListener('change', () => {
        if (ground.value) volume.floorUses = [ground.value, ...(volume.floorUses?.slice(1) ?? [])];
        else if (volume.floorUses) {
          volume.floorUses[0] = '';
          if (!volume.floorUses.some(Boolean)) delete volume.floorUses;
        }
        this.edited();
      });
      const area = polygonArea(volume.footprint);
      fill(this.cardEl, head(volume.name),
        field('Nom', name),
        field('Niveaux', numberInput(volume.floors, (value) => { volume.floors = value; this.edited(); this.renderCard(); }, { min: 1, max: MAX_FLOORS, step: 1, integer: true })),
        field('Hauteur d’étage (m)', numberInput(volume.floorHeight, (value) => { volume.floorHeight = value; this.edited(); this.renderCard(); }, { min: MIN_FLOOR_HEIGHT, max: MAX_FLOOR_HEIGHT, step: 0.1 })),
        field('Usage', use),
        field('Rez-de-chaussée', ground),
        field('Niveau bas (m)', numberInput(volume.baseLevel, (value) => { volume.baseLevel = value; this.edited(); }, { min: -500, max: 2000, step: 0.1 })),
        note(`Emprise ${this.areaText(area)} · plancher ${this.areaText(area * volume.floors)} · hauteur ${oneDecimal.format(volume.floors * volume.floorHeight)} m. Glissez le volume pour le déplacer.`),
        h('div', { class: 'tool-row' },
          button('Poser au sol', () => { volume.baseLevel = round1(groundAt(study, ...centroid(volume.footprint))); this.edited(); this.renderCard(); }, { title: 'Niveau bas = sol sous le centre du volume' }),
          button('Dupliquer', () => this.duplicateVolume(volume)),
          button('Supprimer', () => this.deleteVolume(volume))));
    } else if (selection.kind === 'neighbour') {
      const building = study.context.buildings[selection.index];
      if (!building) return void (this.cardEl.hidden = true);
      const source = { measured: 'mesurée', tagged: 'renseignée dans OpenStreetMap', assumed: 'supposée (aucune donnée)' }[building.heightSource];
      fill(this.cardEl, head('Bâtiment voisin'),
        field('Hauteur (m)', numberInput(building.height, (value) => {
          building.height = value;
          building.edited = true;
          this.neighboursChanged();
        }, { min: 0.5, max: 1000, step: 0.5 })),
        note(`Hauteur ${source}${building.edited ? ', corrigée par vous' : ''}.`),
        h('div', { class: 'tool-row' }, button('Retirer ce bâtiment', () => {
          study.context.buildings.splice(selection.index, 1);
          this.selection = null;
          this.neighboursChanged();
        })));
    } else {
      const model = this.selectedModel;
      if (!model) return void (this.cardEl.hidden = true);
      const role = h('select', { attrs: { 'aria-label': 'Rôle de la maquette' } }, h('option', { text: 'Contexte (toutes les propositions)', attrs: { value: 'context' } }), h('option', { text: `Proposition « ${this.proposal.name} »`, attrs: { value: 'proposal' } }));
      role.value = model.role === 'proposal' && model.proposal === this.proposal.id ? 'proposal' : 'context';
      role.addEventListener('change', () => {
        model.role = role.value === 'proposal' ? 'proposal' : 'context';
        if (model.role === 'proposal') model.proposal = this.proposal.id;
        else delete model.proposal;
        this.edited();
        this.renderCard();
      });
      const snapshot = this.snapshots.get(model.id);
      fill(this.cardEl, head(model.name),
        field('Compte comme', role),
        field('Rotation (°)', numberInput(round1(model.rotation), (value) => { model.rotation = value; this.edited(); }, { min: -360, max: 360, step: 1 })),
        field('Hauteur (m)', numberInput(round1(model.up), (value) => { model.up = value; this.edited(); }, { min: -500, max: 2000, step: 0.1 })),
        note(snapshot
          ? `${integer.format(model.triangles)} triangles ; ${model.georeferenced ? 'posée par sa géoréférence' : 'posée à la main'}. Glissez-la pour la déplacer. Elle porte des ombres et compte dans les analyses ; ses surfaces ne comptent pas dans les chiffres.`
          : 'Sa géométrie n’est pas dans ce navigateur (elle n’est pas dans le fichier de l’étude) : retirez-la et ajoutez-la de nouveau.'),
        h('div', { class: 'tool-row' },
          snapshot?.georeference ? button('Replacer par sa géoréférence', () => { Object.assign(model, placementFor(snapshot, study).placement); model.georeferenced = true; this.edited(); this.renderCard(); }) : null,
          button('Retirer', () => this.removeModel(model))));
    }
    this.cardEl.hidden = false;
    this.placeCard();
  }

  /** Le point (scène) au-dessus duquel la fiche se pose. */
  private anchor(): Vector3 | null {
    const study = this.study, selection = this.selection;
    if (!study || !selection) return null;
    if (selection.kind === 'volume') {
      const volume = this.selectedVolume;
      return volume ? new Vector3(...toScene(...centroid(volume.footprint), volume.baseLevel + volume.floors * volume.floorHeight)) : null;
    }
    if (selection.kind === 'neighbour') {
      const building = study.context.buildings[selection.index];
      return building ? new Vector3(...toScene(...centroid(building.footprint), neighbourBase(study, building.footprint) + building.height)) : null;
    }
    const model = this.selectedModel, snapshot = model && this.snapshots.get(model.id);
    if (!model || !snapshot) return null;
    const [minX, , minZ, maxX, maxY, maxZ] = snapshot.box;
    const a = (model.rotation * Math.PI) / 180, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    return new Vector3(cx * Math.cos(a) + cz * Math.sin(a) + model.east, maxY + model.up, -cx * Math.sin(a) + cz * Math.cos(a) - model.north);
  }

  private placeCard(): void {
    if (this.cardEl.hidden) return;
    const point = this.anchor();
    const width = this.viewport.clientWidth, height = this.viewport.clientHeight;
    const cardWidth = this.cardEl.offsetWidth, cardHeight = this.cardEl.offsetHeight;
    const screen = { x: width - cardWidth - 12, y: 60 };
    if (point && this.scene.toScreen(point, screen)) screen.x += 24;
    this.cardEl.style.left = `${Math.max(8, Math.min(width - cardWidth - 8, screen.x))}px`;
    this.cardEl.style.top = `${Math.max(48, Math.min(height - cardHeight - 56, screen.y - cardHeight / 2))}px`;
  }

  // ---------------------------------------------------------------- esquisse

  private setMode(mode: DrawMode | null): void {
    this.mode = mode;
    this.drawStart = null;
    this.measureEl.hidden = true;
    this.root.classList.toggle('sketching', mode !== null);
    if (!mode || mode === 'parcel') this.sketch.stop();
    if (mode && mode !== 'parcel') {
      const limit = this.study?.site.limit ?? [];
      this.sketch.shapes = limit.length >= 3 && mode !== 'limit' ? [{ points: limit.map(([e, n]) => new Vector3(...toScene(e, n, 0))), label: 'Limite' }] : [];
      this.sketch.start(mode === 'rectangle' || mode === 'bar' ? 'lines' : 'polygon', 0);
    }
    // Tracer une limite se fait mieux vu du dessus, sur l'imagerie.
    if ((mode === 'limit' || mode === 'parcel') && this.scene.controls.getPolarAngle() > 0.35) this.scene.topView(180);
    const hints: Record<DrawMode, string> = {
      limit: 'Limite du terrain : cliquez ses coins, puis le premier point pour fermer. Maj : tracé droit. Échap : annuler.',
      parcel: 'Cliquez une parcelle sur la carte. Échap : annuler.',
      rectangle: 'Rectangle : cliquez deux coins opposés. Échap : annuler.',
      polygon: 'Polygone : cliquez les sommets, puis le premier point pour fermer. Maj : tracé droit. Échap : annuler.',
      bar: `Barre de ${oneDecimal.format(this.barWidth)} m : cliquez le début puis la fin de son axe. Maj : tracé droit. Échap : annuler.`,
    };
    this.hintEl.textContent = mode ? hints[mode] : '';
    this.hintEl.hidden = !mode;
    if (this.study) this.renderRail();
  }

  private onSketchLine(): void {
    const line = this.sketch.lines.pop();
    if (!line) return;
    this.sketch.lines.length = 0;
    const [a, b] = line.map((p): XY => [p.x, -p.z]);
    const mode = this.mode;
    this.setMode(null);
    if (mode === 'rectangle') this.addVolume(rectangle(a, b));
    else if (mode === 'bar') this.addVolume(bar(a, b, this.barWidth));
  }

  private onSketchPolygon(points: XY[]): void {
    const mode = this.mode;
    this.setMode(null);
    if (points.length > MAX_OUTLINE_POINTS) {
      this.toast(`Au plus ${MAX_OUTLINE_POINTS} points par contour.`, true);
      return;
    }
    if (mode === 'limit') this.setLimit(points);
    else if (mode === 'polygon') this.addVolume(points);
  }

  private setLimit(points: XY[], credit?: string): void {
    const study = this.study!;
    study.site.limit = points;
    if (credit && !study.context.credits.includes(credit)) study.context.credits.push(credit);
    this.changed();
    this.refresh();
    this.checkAnalysis();
    this.toast(`Terrain de ${this.areaText(polygonArea(points))}. Étape suivante : ${this.neighbourStatus === 'loaded' ? 'vérifier le voisinage, puis dessiner vos volumes' : 'le voisinage (il se charge), puis vos volumes'}.`);
  }

  private async pickParcel(clientX: number, clientY: number): Promise<void> {
    const study = this.study!;
    const point = this.scene.planePoint(clientX, clientY, 0);
    if (!point) return;
    const [lon, lat] = toGeo(study.site.origin, point[0], point[1]);
    this.busy('Lecture de la parcelle au cadastre…');
    try {
      const parcel = await fetchParcel(lon, lat, { signal: AbortSignal.timeout(10000) });
      if (this.study !== study) return;
      if (!parcel) {
        this.toast('Aucune parcelle ici (voirie, ou hors de France) : cliquez à l’intérieur d’une parcelle, ou tracez la limite.', true);
        return;
      }
      this.setMode(null);
      this.setLimit(parcel.ring.map(([x, y]) => toEnu(study.site.origin, x, y)), `${parcel.label} — ${PARCEL_CREDIT}`);
    } catch (error) {
      this.toast(`Cadastre indisponible : ${errorText(error)}. Tracez la limite à la main.`, true);
    } finally {
      this.busy(null);
    }
  }

  /** Les cotes du tracé en cours, à côté du curseur : côté et surface, ou largeur × profondeur. */
  private showMeasure(clientX: number, clientY: number): void {
    const mode = this.mode;
    const cursor = mode && mode !== 'parcel' ? this.scene.planePoint(clientX, clientY, 0) : null;
    let text = '';
    if (cursor && (mode === 'limit' || mode === 'polygon')) {
      const points = this.sketch.polygon.map((p): XY => [p.x, -p.z]);
      const last = points[points.length - 1];
      if (last) text = `Côté ${oneDecimal.format(Math.hypot(cursor[0] - last[0], cursor[1] - last[1]))} m`;
      if (points.length >= 2) text += ` · surface ${this.areaText(polygonArea([...points, cursor]))}`;
    } else if (cursor && this.drawStart && mode === 'rectangle') {
      const [w, d] = [Math.abs(cursor[0] - this.drawStart[0]), Math.abs(cursor[1] - this.drawStart[1])];
      text = `${oneDecimal.format(w)} × ${oneDecimal.format(d)} m · ${this.areaText(w * d)}`;
    } else if (cursor && this.drawStart && mode === 'bar') {
      const length = Math.hypot(cursor[0] - this.drawStart[0], cursor[1] - this.drawStart[1]);
      text = `Longueur ${oneDecimal.format(length)} m × ${oneDecimal.format(this.barWidth)} m · ${this.areaText(length * this.barWidth)}`;
    }
    this.measureEl.hidden = !text;
    if (!text) return;
    const rect = this.viewport.getBoundingClientRect();
    this.measureEl.textContent = text;
    this.measureEl.style.left = `${clientX - rect.left}px`;
    this.measureEl.style.top = `${clientY - rect.top}px`;
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (event.key === 'Escape') {
      if (this.mode) this.setMode(null);
      else if (this.selection) this.select(null);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedVolume) {
      event.preventDefault();
      this.deleteVolume(this.selectedVolume);
    }
  }

  // ------------------------------------------------------------- pointeur

  private bindPointer(): void {
    let down: { x: number; y: number } | null = null;
    let queued = false;
    const canvas = this.scene.renderer.domElement;
    // Phase de capture : décider avant les contrôles d'orbite si le geste déplace un volume ou une maquette.
    this.viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target !== canvas || !this.study) return;
      down = { x: event.clientX, y: event.clientY };
      if (this.mode) return;
      const volume = this.selectedVolume, model = this.selectedModel;
      let height: number, apply: (de: number, dn: number) => void;
      if (volume) {
        const hit = this.scene.pickVolume(event.clientX, event.clientY);
        if (hit?.id !== volume.id) return;
        const original = volume.footprint;
        height = hit.point.y;
        apply = (de, dn) => { volume.footprint = translate(original, de, dn); };
      } else if (model) {
        const hit = this.scene.pickModel(event.clientX, event.clientY);
        if (hit?.id !== model.id) return;
        const [east, north] = [model.east, model.north];
        height = hit.point.y;
        apply = (de, dn) => { model.east = east + de; model.north = north + dn; model.georeferenced = false; };
      } else return;
      const start = this.scene.planePoint(event.clientX, event.clientY, height);
      if (!start) return;
      this.scene.controls.enabled = false;
      this.drag = { apply, start, height, moved: false, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }, { capture: true });
    this.viewport.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (drag) {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        const point = this.scene.planePoint(event.clientX, event.clientY, drag.height);
        if (!point) return;
        drag.moved = true;
        drag.apply(point[0] - drag.start[0], point[1] - drag.start[1]);
        if (!queued) {
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            if (!this.study) return;
            this.scene.setVolumes(this.study, this.proposal, this.selection?.kind === 'volume' ? this.selection.id : null);
            this.placeModels();
          });
        }
        return;
      }
      if (event.buttons === 0 && this.mode && event.target === canvas) this.showMeasure(event.clientX, event.clientY);
      else if (event.buttons === 0 && this.shown) this.hover(event.clientX, event.clientY);
    });
    this.viewport.addEventListener('pointerup', (event) => {
      const drag = this.drag;
      if (drag) {
        this.drag = null;
        this.scene.controls.enabled = true;
        if (drag.moved) {
          down = null;
          this.edited();
          this.renderCard();
          return;
        }
      }
      const start = down;
      down = null;
      if (!start || event.target !== canvas || !this.study || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      if (this.mode === 'parcel') return void this.pickParcel(event.clientX, event.clientY);
      if (this.mode) {
        if ((this.mode === 'rectangle' || this.mode === 'bar') && !this.drawStart) this.drawStart = this.scene.planePoint(event.clientX, event.clientY, 0);
        this.sketch.click(event.clientX, event.clientY, event.shiftKey);
        return;
      }
      const hit = this.scene.pickAt(event.clientX, event.clientY);
      this.select(!hit ? null : hit.kind === 'neighbour' ? { kind: 'neighbour', index: hit.index } : { kind: hit.kind, id: hit.id });
    });
    this.viewport.addEventListener('pointerleave', () => {
      this.readoutEl.hidden = true;
      this.measureEl.hidden = true;
    });
  }

  private hover(clientX: number, clientY: number): void {
    const shown = this.shown;
    const index = shown ? this.scene.pickAnalysis(clientX, clientY, shown.size) : null;
    if (!shown || index === null) {
      this.readoutEl.hidden = true;
      return;
    }
    const value = shown.values[index];
    const rect = this.viewport.getBoundingClientRect();
    this.readoutEl.textContent = shown.kind === 'vsc' ? `${oneDecimal.format(value)} %` : `${oneDecimal.format(value)} h`;
    this.readoutEl.style.left = `${clientX - rect.left}px`;
    this.readoutEl.style.top = `${clientY - rect.top}px`;
    this.readoutEl.hidden = false;
  }

  // ------------------------------------------------------------ propositions

  /** Les propositions en onglets au-dessus de la vue ; celle qui est affichée se renomme, se duplique, se supprime. */
  private renderTabs(): void {
    const study = this.study;
    this.tabsEl.hidden = !study || this.mapOpen;
    if (!study) return;
    const current = this.proposal;
    const tabs = study.proposals.map((proposal) => {
      const tab = button(proposal.name, () => this.showProposal(proposal.id), { class: 'site-tab', attrs: { role: 'tab', 'aria-selected': String(proposal === current) } });
      tab.addEventListener('dblclick', () => this.renameProposal(proposal));
      return tab;
    });
    fill(this.tabsEl, ...tabs,
      button('+', () => this.addProposal(newProposal(`Proposition ${study.proposals.length + 1}`)), { class: 'site-tab', title: 'Nouvelle proposition, vide, sur le même site' }),
      h('span', { class: 'site-tab-actions' },
        button('Renommer', () => this.renameProposal(current), { title: 'Renommer la proposition affichée' }),
        button('Dupliquer', () => {
          const copy = structuredClone(current);
          copy.id = newId();
          copy.name = `${current.name} (copie)`;
          for (const volume of copy.volumes) volume.id = newId();
          this.addProposal(copy);
        }, { title: 'Copier la proposition affichée pour la varier' }),
        study.proposals.length > 1 ? button('Supprimer', () => {
          if (!window.confirm(`Supprimer la proposition « ${current.name} » et ses volumes ?`)) return;
          study.proposals = study.proposals.filter((p) => p !== current);
          this.proposalId = study.proposals[0].id;
          this.selection = null;
          this.changed();
          this.refresh();
          this.checkAnalysis();
        }, { title: 'Supprimer la proposition affichée' }) : null));
  }

  private showProposal(id: string): void {
    const kind = this.shown?.kind;
    this.proposalId = id;
    this.selection = null;
    this.shown = null;
    this.scene.setAnalysis(null, null, 1);
    this.refresh();
    // Même analyse, gardée pour l'autre proposition si rien n'a changé depuis : on passe de l'une à l'autre pour comparer.
    const cached = kind ? this.cache.get(`${this.proposalId}|${kind}`) : undefined;
    if (kind && cached?.key === this.analysisKey(kind)) this.show(cached);
    else if (kind) this.analysisNote = `${ANALYSIS_NAMES[kind]} : à lancer pour cette proposition.`;
    this.renderRail();
  }

  private renameProposal(proposal: Proposal): void {
    const name = window.prompt('Nom de la proposition', proposal.name)?.trim();
    if (!name) return;
    proposal.name = name;
    this.changed();
    this.render();
  }

  private addProposal(proposal: Proposal): void {
    const study = this.study!;
    if (study.proposals.length >= MAX_PROPOSALS) {
      this.toast(`Au plus ${MAX_PROPOSALS} propositions par étude.`, true);
      return;
    }
    study.proposals.push(proposal);
    this.proposalId = proposal.id;
    this.selection = null;
    this.changed();
    this.refresh();
    this.checkAnalysis();
  }

  // ----------------------------------------------------------------- chiffres

  /** Les chiffres clés de la proposition affichée, en bas de la vue, à partir de l'étape 2. */
  private renderFigures(): void {
    const study = this.study;
    this.figuresEl.hidden = !study || this.mapOpen || this.step === 'lieu';
    if (!study || this.figuresEl.hidden) return;
    const f = proposalFigures(study.site.limit, this.proposal.volumes, study.settings);
    const item = (label: string, value: string) => h('span', { class: 'site-figure' }, h('span', { class: 'site-figure-label', text: label }), h('strong', { text: value }));
    const limit = study.site.limit.length >= 3;
    fill(this.figuresEl,
      item('Terrain', limit ? this.areaText(f.siteArea) : 'à tracer'),
      item('Emprise', limit ? `${this.areaText(f.footprint)} · ${oneDecimal.format(f.coverage * 100)} %` : this.areaText(f.footprint)),
      item('Plancher', this.areaText(f.gfa)),
      item('COS', limit ? twoDecimals.format(f.plotRatio) : '—'),
      item('Plus haut', Number.isFinite(f.highestPoint) ? `${oneDecimal.format(f.highestPoint)} m` : '—'),
      item('Pleine terre', limit ? this.areaText(f.openGround) : '—'),
      item('Logements', integer.format(f.dwellings)));
  }

  private table(rows: string[][]): HTMLElement {
    return h('table', { class: 'compare-table site-table' },
      h('thead', {}, h('tr', {}, ...rows[0].map((cell) => h('th', { text: cell })))),
      h('tbody', {}, ...rows.slice(1).map((row) => h('tr', {}, h('th', { text: row[0] }), ...row.slice(1).map((cell) => h('td', { text: cell }))))));
  }

  private copy(rows: string[][]): void {
    navigator.clipboard.writeText(toTsv(rows)).then(() => this.toast('Tableau copié : collez-le dans un tableur.'), () => this.toast('Copie refusée par le navigateur.', true));
  }

  /** Le tableau complet, la comparaison des propositions et les réglages (étape 5). */
  private figuresBlock(): HTMLElement {
    const study = this.study!;
    const { settings } = study;
    const box = h('div', { class: 'site-stack' });
    box.append(this.table(figureRows(study, [this.proposal])), h('div', { class: 'tool-row' }, button('Copier (TSV)', () => this.copy(figureRows(study, [this.proposal])))));
    if (study.proposals.length > 1) {
      box.append(h('p', { class: 'field-label', text: 'Comparaison des propositions' }), this.table(figureRows(study, study.proposals)),
        h('div', { class: 'tool-row' }, button('Copier la comparaison (TSV)', () => this.copy(figureRows(study, study.proposals)))));
    }
    const units = h('select', {}, h('option', { text: 'm²', attrs: { value: 'm2' } }), h('option', { text: 'ft²', attrs: { value: 'ft2' } }));
    units.value = settings.units;
    units.addEventListener('change', () => { settings.units = units.value === 'ft2' ? 'ft2' : 'm2'; this.changed(); this.refresh(); });
    const usesList = h('div', { class: 'site-stack' }, ...settings.uses.map((use) => {
      const name = h('input', { attrs: { type: 'text', value: use.name, 'aria-label': 'Nom de l’usage' } });
      name.addEventListener('change', () => { use.name = name.value.trim() || use.name; this.changed(); this.refresh(); });
      const color = h('input', { attrs: { type: 'color', value: use.color, 'aria-label': `Couleur de ${use.name}` } });
      color.addEventListener('change', () => { use.color = safeColor(color.value, use.color); this.changed(); this.refresh(); });
      const housing = h('input', { attrs: { type: 'checkbox', title: 'Compte pour les logements' } });
      housing.checked = use.housing;
      housing.addEventListener('change', () => { use.housing = housing.checked; this.changed(); this.render(); });
      return h('div', { class: 'site-use-row' }, color, name, h('label', { class: 'tool-check', title: 'Compte pour l’estimation des logements' }, housing, 'logements'));
    }));
    const addUse = button('Ajouter un usage', () => {
      settings.uses.push({ id: newId(), name: `Usage ${settings.uses.length + 1}`, color: '#7f8c8d', housing: false });
      this.changed();
      this.refresh();
    });
    const details = h('details', {},
      h('summary', { text: 'Réglages des chiffres' }),
      h('div', { class: 'site-stack' },
        field('Unité', units),
        field('Logement (m²)', numberInput(settings.dwellingSize, (value) => { settings.dwellingSize = value; this.changed(); this.render(); }, { min: 10, max: 500, step: 1 })),
        field('Rendement (%)', numberInput(Math.round(settings.efficiency * 100), (value) => { settings.efficiency = value / 100; this.changed(); this.render(); }, { min: 10, max: 100, step: 1 })),
        note('Logements estimés = surface de plancher des usages cochés × rendement ÷ surface moyenne d’un logement.'),
        usesList,
        addUse));
    details.open = this.settingsOpen;
    details.addEventListener('toggle', () => { this.settingsOpen = details.open; });
    box.append(details);
    return box;
  }

  // -------------------------------------------------------------- 5. analyses

  private analysisNote = '';

  private analysisStep(): (HTMLElement | null)[] {
    const warning = warningFor('analyses', this.stepState);
    const analyses = ANALYSES.map(({ kind, name, intro }) => h('div', { class: 'site-analysis' },
      h('div', { class: 'site-analysis-head' }, h('strong', { text: name }),
        button(this.shown?.kind === kind ? 'Affichée' : 'Calculer', () => void this.runAnalysis(kind), { attrs: this.running ? { disabled: '' } : { 'aria-pressed': String(this.shown?.kind === kind) } })),
      note(intro)));
    return [
      warning ? para(warning, 'site-note warning') : null,
      h('p', { class: 'field-label', text: 'Soleil et ombres' }),
      this.sunBox,
      h('p', { class: 'field-label', text: 'Analyses' }),
      ...analyses,
      this.running ? h('div', { class: 'tool-row' }, this.progressEl, button('Arrêter', () => this.running?.abort())) : null,
      this.analysisNote ? para(this.analysisNote, 'site-note warning') : null,
      this.shownBlock(),
      note(USE_LIMITS),
      h('p', { class: 'field-label', text: 'Chiffres' }),
      this.figuresBlock(),
    ];
  }

  // -------------------------------------------------------------------- soleil

  private buildSun(): void {
    const date = h('input', { attrs: { type: 'date', value: this.day, 'aria-label': 'Date' } });
    const presets = h('select', { attrs: { 'aria-label': 'Dates usuelles' } }, h('option', { text: 'Dates usuelles…', attrs: { value: '' } }),
      ...presetDays(new Date().getFullYear()).map((preset) => h('option', { text: `${preset.label} (${dayText(preset.day).slice(0, 5)})`, attrs: { value: preset.day } })));
    const time = h('input', { attrs: { type: 'range', min: '0', max: '1430', step: '10', value: String(this.minutes), 'aria-label': 'Heure du site' } });
    this.timeInput = time;
    const shadows = h('input', { attrs: { type: 'checkbox' } });
    shadows.checked = this.shadows;
    const setDay = (day: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      this.day = day;
      date.value = day;
      this.updateSun();
      this.checkAnalysis();
    };
    date.addEventListener('change', () => setDay(date.value));
    presets.addEventListener('change', () => { if (presets.value) setDay(presets.value); presets.value = ''; });
    time.addEventListener('input', () => { this.stopPlaying(); this.minutes = Number(time.value); this.updateSun(); });
    shadows.addEventListener('change', () => { this.shadows = shadows.checked; this.updateSun(); });
    this.playButton = button('▶ Jouer les ombres de la journée', () => this.togglePlay(), { class: 'primary', title: 'Fait avancer l’heure du lever au coucher du soleil' });
    this.sunBox.append(
      note('Les ombres des volumes, des voisins, des maquettes et du relief, à l’heure du site.'),
      h('div', { class: 'tool-row' }, date, presets),
      h('div', { class: 'tool-row' }, this.playButton),
      h('div', { class: 'tool-row' }, time),
      this.sunReadout,
      h('label', { class: 'tool-check' }, shadows, 'Ombres portées'),
    );
  }

  private togglePlay(): void {
    if (this.playFrame) return this.stopPlaying();
    const study = this.study;
    if (!study) return;
    const path = daySunPath(this.day, study.site.origin.latitude, study.site.origin.longitude, this.offsetFor(this.day), SUN_STEP_MINUTES);
    if (path.length === 0) {
      this.toast('Le soleil ne se lève pas ce jour-là à cette latitude (nuit polaire).', true);
      return;
    }
    const from = Math.max(0, path[0].minutes - SUN_STEP_MINUTES / 2), to = Math.min(1430, path[path.length - 1].minutes + SUN_STEP_MINUTES / 2);
    const started = performance.now();
    this.playButton.textContent = '❚❚ Pause';
    const frame = (now: number) => {
      const t = Math.min(1, (now - started) / (PLAY_SECONDS * 1000));
      this.minutes = Math.round((from + (to - from) * t) / 5) * 5;
      this.timeInput.value = String(this.minutes);
      this.updateSun();
      if (t < 1) this.playFrame = requestAnimationFrame(frame);
      else this.stopPlaying();
    };
    this.playFrame = requestAnimationFrame(frame);
  }

  private stopPlaying(): void {
    if (this.playFrame) cancelAnimationFrame(this.playFrame);
    this.playFrame = 0;
    if (this.playButton) this.playButton.textContent = '▶ Jouer les ombres de la journée';
  }

  private updateSun(): void {
    const study = this.study;
    if (!study) return;
    const { origin } = study.site;
    const offset = this.offsetFor(this.day);
    const position = sunPosition(localTime(this.day, this.minutes, offset), origin.latitude, origin.longitude);
    const up = position.elevation > 0;
    this.scene.setSun(up ? toScene(...sunVector(position)) : null, this.shadows);
    this.sunReadout.textContent = `${dayText(this.day)} à ${clockText(this.minutes)} (heure du site, ${offsetText(offset)}) : ${up ? `soleil à ${oneDecimal.format(position.elevation)}° de haut, azimut ${integer.format(Math.round(position.azimuth))}°` : 'soleil sous l’horizon'}.`;
  }

  // ------------------------------------------------------------------ analyses

  /** Ce dont dépend une analyse : si la clé change, le résultat affiché n'est plus valable. */
  private analysisKey(kind: AnalysisKind): string {
    const study = this.study!;
    const { site } = study;
    const models = study.models.map((m) => [m.id, m.east, m.north, m.up, m.rotation, m.role, m.proposal]);
    return JSON.stringify([kind, kind === 'vsc' ? '' : this.day, kind === 'vsc' ? 0 : this.offsetFor(this.day), site.origin.latitude, site.origin.longitude, kind === 'sun-ground' ? site.limit : 0, this.proposal.volumes, models, this.contextRevision]);
  }

  private checkAnalysis(): void {
    const shown = this.shown;
    if (!shown || !this.study || shown.key === this.analysisKey(shown.kind)) return;
    this.shown = null;
    this.scene.setAnalysis(null, null, 1);
    this.readoutEl.hidden = true;
    this.analysisNote = 'Les volumes, le voisinage ou la date ont changé : relancez l’analyse.';
    if (this.step === 'analyses') this.renderRail();
  }

  private shownBlock(): HTMLElement | null {
    const shown = this.shown;
    if (!shown) return null;
    const legend = h('div', { class: 'site-legend' });
    if (shown.kind === 'vsc') {
      legend.append(h('div', { class: 'site-bins' }, ...VSC_BINS.map((bin) => h('span', {}, swatch(bin.color), bin.label))));
    } else {
      const gradient = h('div', { class: 'site-gradient' });
      gradient.style.background = `linear-gradient(to right, ${SUN_GRADIENT.join(', ')})`;
      legend.append(gradient, h('div', { class: 'site-scale' }, h('span', { text: '0 h' }), h('span', { text: `${oneDecimal.format(shown.dayLength)} h (jour entier)` })));
    }
    const isSun = shown.kind !== 'vsc';
    const share = h('p', { class: 'site-note' });
    const updateShare = () => {
      const limit = isSun ? this.threshold.sun : this.threshold.vsc;
      let above = 0;
      for (const value of shown.values) if (value >= limit - 1e-6) above++;
      share.textContent = `${oneDecimal.format((100 * above) / Math.max(1, shown.values.length))} % des ${integer.format(shown.values.length)} points ≥ ${oneDecimal.format(limit)} ${isSun ? 'h' : '%'}.`;
    };
    const threshold = numberInput(isSun ? this.threshold.sun : this.threshold.vsc, (value) => {
      if (isSun) this.threshold.sun = value;
      else this.threshold.vsc = value;
      updateShare();
    }, { min: 0, max: isSun ? 24 : 40, step: isSun ? 0.5 : 1 });
    updateShare();
    return h('div', { class: 'site-shown' },
      h('p', { class: 'field-label', text: ANALYSIS_NAMES[shown.kind] }),
      legend,
      field(isSun ? 'Seuil (h)' : 'Seuil (%)', threshold),
      share,
      note(shown.label),
      note('Survolez un point pour lire sa valeur.'),
      h('div', { class: 'tool-row' }, button('Effacer l’analyse', () => {
        this.shown = null;
        this.scene.setAnalysis(null, null, 1);
        this.renderRail();
      })));
  }

  private async runAnalysis(kind: AnalysisKind): Promise<void> {
    const study = this.study!, proposal = this.proposal;
    this.analysisNote = '';
    const key = this.analysisKey(kind), cacheKey = `${proposal.id}|${kind}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.key === key) return this.show(cached);
    if (kind !== 'sun-ground' && proposal.volumes.length === 0) {
      this.analysisNote = 'Dessinez d’abord un volume : l’analyse porte sur ses façades.';
      return this.renderRail();
    }
    // Zone au sol : la limite, sinon l'emprise des volumes élargie de 30 m.
    let area: XY[] = study.site.limit;
    if (kind === 'sun-ground' && area.length < 3) {
      const all = proposal.volumes.flatMap((v) => v.footprint);
      if (all.length === 0) {
        this.analysisNote = 'Tracez la limite du terrain ou un volume : la grille au sol les couvre.';
        return this.renderRail();
      }
      const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
      area = rectangle([Math.min(...xs) - 30, Math.min(...ys) - 30], [Math.max(...xs) + 30, Math.max(...ys) + 30]);
    }
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.progressEl.textContent = 'Préparation…';
    this.progressEl.hidden = false;
    this.renderRail();
    try {
      // Le lancer de rayons (et three-mesh-bvh) n'est chargé qu'à la première analyse.
      const analysis = await import('./analysis.ts');
      const parts = proposal.volumes.map((v) => volumeMesh(v).positions);
      const neighbours = this.scene.neighbourTriangles();
      if (neighbours) parts.push(neighbours);
      parts.push(...this.scene.modelTriangles());
      const occluder = analysis.buildOccluder(parts);
      let points: SamplePoint[], size: number, method: string;
      if (kind === 'sun-ground') {
        const step = Math.max(1, Math.ceil(2 * Math.sqrt(polygonArea(area) / MAX_POINTS)) / 2);
        const obstacles = [...proposal.volumes.map((v) => v.footprint), ...study.context.buildings.map((b) => b.footprint)];
        points = analysis.groundPoints(area, step, obstacles, (e, n) => groundAt(study, e, n));
        size = step;
        method = `grille au sol de ${oneDecimal.format(step)} m${study.site.limit.length >= 3 ? ' dans la limite' : ' autour des volumes'}`;
      } else {
        const perimeterFloors = proposal.volumes.reduce((sum, v) => sum + v.floors * perimeter(v.footprint), 0);
        const spacing = Math.max(2, perimeterFloors / MAX_POINTS);
        points = analysis.facadePoints(proposal.volumes, spacing);
        size = Math.min(1.5, spacing * 0.6);
        method = `points de façade tous les ${oneDecimal.format(spacing)} m, à mi-hauteur de chaque niveau`;
      }
      const offset = this.offsetFor(this.day);
      const path = daySunPath(this.day, study.site.origin.latitude, study.site.origin.longitude, offset, SUN_STEP_MINUTES);
      const dayLength = path.reduce((sum, sample) => sum + sample.hours, 0);
      const job = kind === 'vsc' ? analysis.skyComponentJob(points, occluder) : analysis.sunHoursJob(points, occluder, path);
      const values = await runSliced(job, (progress) => { this.progressEl.textContent = `Calcul… ${Math.round(progress * 100)} %`; }, controller.signal);
      const display = new Float32Array(points.length * 3);
      points.forEach(({ position, normal }, i) => {
        // Décollés de leur surface pour rester visibles : 0,3 m au-dessus du sol, 0,6 m devant une façade.
        const lift = normal ? normal.map((v) => v * 0.6) : [0, 0.3, 0];
        display.set([position[0] + lift[0], position[1] + lift[1], position[2] + lift[2]], i * 3);
      });
      const models = study.models.length > 0 ? `, les maquettes posées` : '';
      const obstacles = `obstacles : volumes de la proposition${models} et ${integer.format(study.context.buildings.length)} voisins ; le relief ne fait pas obstacle`;
      const label = kind === 'vsc'
        ? `Composante de ciel (VSC) : part du ciel couvert normalisé CIE vue par une façade verticale (39,6 % sans obstacle), ${analysis.SKY_RAYS} directions par point ; ${method} ; ${obstacles}. Repères 27 / 15 / 5 %. Calculé le ${today()}.`
        : `Heures de soleil direct le ${dayText(this.day)} (heure du site ${offsetText(offset)}) : course du Soleil tous les ${SUN_STEP_MINUTES} min (formules NOAA), ${method} ; ${obstacles}${kind === 'sun-facade' ? ' ; une façade ne compte le Soleil que devant elle' : ''}. Calculé le ${today()}.`;
      const result: AnalysisResult = { kind, key, values, display, size, label, dayLength };
      this.cache.set(cacheKey, result);
      this.running = null;
      // L'étude a pu changer pendant le calcul : le résultat n'est montré que s'il est encore valable.
      if (this.study === study && this.proposal === proposal && this.analysisKey(kind) === key) this.show(result);
      else {
        this.analysisNote = 'L’étude a changé pendant le calcul : relancez l’analyse.';
        this.renderRail();
      }
    } catch (error) {
      if (this.running === controller) this.running = null;
      this.analysisNote = controller.signal.aborted ? 'Calcul interrompu.' : `Analyse impossible : ${errorText(error)}`;
      this.renderRail();
    } finally {
      this.progressEl.hidden = true;
    }
  }

  private show(result: AnalysisResult): void {
    const colors = new Float32Array(result.values.length * 3);
    result.values.forEach((value, i) => {
      if (result.kind === 'vsc') {
        const bin = VSC_BINS.find((b) => value >= b.min)!;
        colors.set(colorRamp([bin.color], 0), i * 3);
      } else {
        colors.set(colorRamp(SUN_GRADIENT, result.dayLength > 0 ? value / result.dayLength : 0), i * 3);
      }
    });
    this.shown = result;
    this.scene.setAnalysis(result.display, colors, result.size);
    this.renderRail();
  }

  // --------------------------------------------------- vue, sources, export

  /** Le fond de carte choisi, drapé sur le sol de l'étude. */
  private applyImagery(): void {
    const id = this.imageryId;
    if (this.study) this.scene.setImagery(this.study, id === 'none' ? null : imagerySource(id));
  }

  private renderViewTools(): void {
    const study = this.study;
    this.viewTools.hidden = !study || this.mapOpen;
    if (!study) return;
    const background = h('select', { attrs: { 'aria-label': 'Fond de carte', title: 'Fond de carte posé sur le sol (décor : les analyses n’en dépendent pas)' } },
      ...IMAGERY_SOURCES.filter((source) => !source.franceOnly || study.site.country === 'fr').map((source) => h('option', { text: source.label, attrs: { value: source.id } })),
      h('option', { text: 'Sans fond', attrs: { value: 'none' } }));
    background.value = this.imageryId;
    background.addEventListener('change', () => {
      this.imageryId = background.value as ImageryId | 'none';
      this.applyImagery();
      this.renderCredits();
    });
    const radius = Math.max(150, study.context.radius || DEFAULT_RADIUS);
    fill(this.viewTools,
      button('Vue du dessus', () => this.scene.topView(Math.min(radius, 220)), { title: 'Plan, nord en haut' }),
      button('Vue 3D', () => this.scene.frame(radius * 0.8), { title: 'Vue en perspective sur le site' }),
      background);
  }

  private renderCredits(): void {
    const study = this.study;
    this.creditsEl.hidden = !study || this.mapOpen;
    if (!study) return;
    const source = this.imageryId === 'none' ? null : imagerySource(this.imageryId);
    fill(this.creditsEl,
      source ? h('a', { text: `Fond : ${source.credit}`, attrs: { href: source.creditUrl, target: '_blank', rel: 'noopener' } }) : null,
      ...study.context.credits.map((credit) => h('span', { text: credit })));
    // Sur une seule ligne dans la vue ; le texte entier au survol, et dans l'étape « Voisinage ».
    this.creditsEl.title = [source ? `Fond : ${source.credit}` : '', ...study.context.credits].filter(Boolean).join('\n');
  }

  private exportProposal(): void {
    const study = this.study;
    if (!study) return;
    const proposal = this.proposal;
    if (proposal.volumes.length === 0) {
      this.toast('Cette proposition n’a aucun volume à exporter : dessinez-en un (étape 4).', true);
      return;
    }
    const name = `${slug(study.name)}-${slug(proposal.name)}`;
    download(new Blob([proposalGlb(study, proposal)], { type: 'model/gltf-binary' }), `${name}.glb`);
    download(new Blob([JSON.stringify(proposalMetadata(study, proposal), null, 1)], { type: 'application/json' }), `${name}.json`);
    this.toast('Déposez les deux fichiers ensemble dans le viewer : la proposition s’y place sur la carte.');
  }
}
