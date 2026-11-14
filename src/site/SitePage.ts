// La page « Étude de site » : un site (origine, limite), son voisinage lu une fois (bâtiments, relief), des propositions
// faites de volumes paramétriques, leurs chiffres en direct, le Soleil et ses ombres, et deux analyses (heures de soleil,
// composante de ciel). L'étude est un fichier JSON (docs/contrat-etude.md) : ouvrir, enregistrer ; rien n'est gardé dans
// le navigateur. Une proposition s'exporte en GLB + JSON pour le viewer, géoréférencée.

import { Vector3 } from 'three';
import { fold, integer, oneDecimal } from '../data/text.ts';
import { Sketch } from '../engine/sketch.ts';
import { runSliced } from '../engine/sliced.ts';
import { button, download, h } from '../ui/dom.ts';
import type { SamplePoint } from './analysis.ts';
import { groundAt, heightCounts, loadContext } from './context.ts';
import { proposalGlb, proposalMetadata } from './exportGlb.ts';
import { bar, centroid, rectangle, toScene, translate, volumeMesh } from './massing.ts';
import { figureRows, polygonArea, toTsv } from './metrics.ts';
import { SiteScene } from './SiteScene.ts';
import { newId, newProposal, newStudy, parseStudy, studyToJson, type Proposal, type Study, type Volume, type XY } from './study.ts';
import { daySunPath, defaultUtcOffset, localTime, presetDays, sunPosition, sunVector } from './sun.ts';

type DrawMode = 'limit' | 'rectangle' | 'polygon' | 'bar';
type Selection = { kind: 'volume'; id: string } | { kind: 'neighbour'; index: number } | null;
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
const SUN_STEP_MINUTES = 10;
/** Points au plus par analyse : borne le nombre de rayons (≈ 6 000 × 432 pour la composante de ciel). */
const MAX_POINTS = 6000;
const SUN_GRADIENT = ['#253494', '#2c7fb8', '#41b6c4', '#a1dab4', '#ffffcc'];
const VSC_BINS: { min: number; color: string; label: string }[] = [
  { min: 27, color: '#1a9850', label: '≥ 27 %' },
  { min: 15, color: '#fee08b', label: '15 à 27 %' },
  { min: 5, color: '#fc8d59', label: '5 à 15 %' },
  { min: -Infinity, color: '#d73027', label: '< 5 %' },
];
const ANALYSIS_NAMES: Record<AnalysisKind, string> = {
  'sun-ground': 'Heures de soleil au sol',
  'sun-facade': 'Heures de soleil en façade',
  vsc: 'Ciel visible en façade (VSC)',
};

const today = () => new Date().toLocaleDateString('fr-FR');
const dayText = (day: string) => day.split('-').reverse().join('/');
const offsetText = (offset: number) => `UTC${offset >= 0 ? '+' : '−'}${Math.abs(offset)}`;
const slug = (text: string) => fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'etude';
const clockText = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`;
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Remplace le contenu d'un conteneur ; les enfants vides (null, false) sont ignorés. */
function fill(box: HTMLElement, ...children: (Node | string | null | false)[]): void {
  box.replaceChildren(...children.filter((child): child is Node | string => Boolean(child)));
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: label }), control);
}

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
  private study: Study = newStudy();
  private proposalId = this.study.proposals[0].id;
  private selection: Selection = null;
  private mode: DrawMode | null = null;
  /** Augmente à chaque changement du voisinage (chargement, hauteur corrigée, voisin supprimé) : les analyses en dépendent. */
  private contextRevision = 0;
  private dirty = false;
  private readonly cache = new Map<string, AnalysisResult>();
  private shown: AnalysisResult | null = null;
  private running: AbortController | null = null;
  private loading: AbortController | null = null;
  private drag: { volume: Volume; original: XY[]; start: XY; height: number; moved: boolean; x: number; y: number } | null = null;
  private day = presetDays(new Date().getFullYear())[3].day;
  private minutes = 12 * 60;
  private shadows = true;
  private threshold = { sun: 2, vsc: 27 };
  /** Le volet « Réglages des chiffres » reste ouvert d'un rendu à l'autre. */
  private settingsOpen = false;

  private readonly root: HTMLElement;
  private readonly scene: SiteScene;
  private readonly sketch: Sketch;
  private readonly viewport: HTMLElement;
  private readonly hintEl = h('div', { class: 'site-hint', attrs: { hidden: '' } });
  private readonly readoutEl = h('div', { class: 'site-readout', attrs: { hidden: '' } });
  private readonly toastEl = h('div', { class: 'toast', attrs: { role: 'status', hidden: '' } });
  private toastTimer = 0;
  private readonly nameInput = h('input', { class: 'site-name', attrs: { type: 'text', 'aria-label': 'Nom de l’étude' } });
  private readonly siteBox = h('div', { class: 'site-stack' });
  private readonly contextBox = h('div', { class: 'site-stack' });
  private readonly volumesBox = h('div', { class: 'site-stack' });
  private readonly proposalsBox = h('div', { class: 'site-stack' });
  private readonly figuresBox = h('div', { class: 'site-stack' });
  private readonly sunBox = h('div', { class: 'site-stack' });
  private readonly analysisBox = h('div', { class: 'site-stack' });
  private readonly creditsBox = h('div', { class: 'site-stack' });
  private readonly sunReadout = h('p', { class: 'hint' });
  private readonly progressEl = h('p', { class: 'hint', attrs: { hidden: '' } });

  constructor(root: HTMLElement) {
    this.root = root;
    const fileInput = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) void this.open(file);
    });
    this.nameInput.addEventListener('change', () => {
      this.study.name = this.nameInput.value.trim() || 'Étude';
      this.dirty = true;
    });
    const topbar = h('header', { class: 'topbar' },
      h('span', { class: 'brand', text: 'Étude de site' }),
      this.nameInput,
      h('div', { class: 'bar-group' },
        button('Nouvelle', () => this.newStudy(), { title: 'Commencer une étude vide' }),
        button('Ouvrir…', () => fileInput.click(), { title: 'Ouvrir une étude (.json)' }),
        button('Enregistrer', () => this.save(), { class: 'primary', title: 'Télécharger l’étude en JSON (site, voisinage, propositions)' }),
        fileInput),
      h('div', { class: 'spacer' }),
      h('a', { class: 'site-back', text: 'Viewer BIM', attrs: { href: 'index.html', title: 'Ouvrir le viewer de maquettes' } }),
    );

    const canvasHost = h('div', { class: 'canvas-host' });
    const overlayRoot = h('div', { class: 'overlay-root' });
    this.viewport = h('main', { class: 'viewport' }, canvasHost, overlayRoot, this.hintEl, this.readoutEl, this.toastEl);
    const left = h('aside', { class: 'sidebar left site-panel', attrs: { 'aria-label': 'Site, voisinage et volumes' } },
      this.section('Site', this.siteBox),
      this.section('Voisinage', this.contextBox),
      this.section('Volumes', this.volumesBox));
    const right = h('aside', { class: 'sidebar right site-panel', attrs: { 'aria-label': 'Propositions, chiffres et analyses' } },
      this.section('Propositions', this.proposalsBox),
      this.section('Chiffres', this.figuresBox),
      this.section('Soleil et ombres', this.sunBox),
      this.section('Analyses', this.analysisBox),
      this.section('Sources et limites', this.creditsBox));
    root.className = 'app site-app';
    root.append(topbar, left, this.viewport, right);

    this.scene = new SiteScene(canvasHost);
    this.sketch = new Sketch(this.scene, overlayRoot, this.viewport);
    this.sketch.onChange = () => this.onSketchLine();
    this.sketch.onPolygon = (points) => this.onSketchPolygon(points.map((p): XY => [p.x, -p.z]));
    this.bindPointer();
    document.addEventListener('keydown', (event) => this.onKey(event));
    window.addEventListener('beforeunload', (event) => {
      if (this.dirty) event.preventDefault();
    });
    this.buildSun();
    this.load(this.study);
  }

  private section(title: string, body: HTMLElement): HTMLElement {
    return h('section', { class: 'site-section' }, h('h2', { text: title }), body);
  }

  private get proposal(): Proposal {
    return this.study.proposals.find((p) => p.id === this.proposalId) ?? this.study.proposals[0];
  }

  private get selectedVolume(): Volume | null {
    const selection = this.selection;
    return selection?.kind === 'volume' ? this.proposal.volumes.find((v) => v.id === selection.id) ?? null : null;
  }

  private toast(message: string, error = false): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle('error', error);
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, error ? 8000 : 4500);
  }

  private areaText(m2: number): string {
    return this.study.settings.units === 'ft2' ? `${integer.format(Math.round(m2 * SQUARE_FEET))} ft²` : `${integer.format(Math.round(m2))} m²`;
  }

  // ------------------------------------------------------------------ étude

  private load(study: Study): void {
    this.running?.abort();
    this.loading?.abort();
    this.study = study;
    this.proposalId = study.proposals[0].id;
    this.selection = null;
    this.cache.clear();
    this.shown = null;
    this.contextRevision++;
    this.dirty = false;
    this.setMode(null);
    this.nameInput.value = study.name;
    this.scene.setGround(study);
    this.scene.setAnalysis(null, null, 1);
    this.scene.frame(Math.max(150, study.context.radius || DEFAULT_RADIUS) * 0.8);
    this.refresh();
  }

  private newStudy(): void {
    if (this.dirty && !window.confirm('Les modifications non enregistrées seront perdues. Commencer une nouvelle étude ?')) return;
    this.load(newStudy());
  }

  private async open(file: File): Promise<void> {
    if (this.dirty && !window.confirm('Les modifications non enregistrées seront perdues. Ouvrir une autre étude ?')) return;
    try {
      this.load(parseStudy(JSON.parse(await file.text())));
      this.toast(`Étude « ${this.study.name} » ouverte.`);
    } catch (error) {
      this.toast(`Étude illisible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private save(): void {
    download(new Blob([studyToJson(this.study)], { type: 'application/json' }), `${slug(this.study.name)}.etude.json`);
    this.dirty = false;
  }

  /** Tout redessiner (changement d'étude, de proposition, de sélection). */
  private refresh(): void {
    this.renderSite();
    this.renderContext();
    this.renderVolumes();
    this.renderProposals();
    this.renderFigures();
    this.renderAnalysis();
    this.renderCredits();
    this.scene.setNeighbours(this.study, this.selection?.kind === 'neighbour' ? this.selection.index : null);
    this.scene.setVolumes(this.study, this.proposal, this.selection?.kind === 'volume' ? this.selection.id : null);
    this.scene.setLimit(this.study);
    this.updateSun();
  }

  /** Après une modification d'un champ : la vue, les chiffres et les listes suivent ; le formulaire en cours reste. */
  private edited(): void {
    this.dirty = true;
    this.scene.setVolumes(this.study, this.proposal, this.selection?.kind === 'volume' ? this.selection.id : null);
    this.renderVolumeList();
    this.renderFigures();
    this.checkAnalysis();
  }

  // ------------------------------------------------------------------- site

  private renderSite(): void {
    const { site } = this.study;
    const latitude = h('input', { attrs: { type: 'number', step: 'any', min: '-90', max: '90', value: String(site.origin.latitude) } });
    const longitude = h('input', { attrs: { type: 'number', step: 'any', min: '-180', max: '180', value: String(site.origin.longitude) } });
    const altitude = h('input', { attrs: { type: 'number', step: 'any', value: String(site.origin.altitude) } });
    const apply = () => {
      const [lat, lon, alt] = [latitude, longitude, altitude].map((input) => (input.value.trim() ? Number(input.value.replace(',', '.')) : NaN));
      if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(alt)) {
        this.toast('Latitude entre −90 et 90, longitude entre −180 et 180, altitude en mètres.', true);
        return;
      }
      const moved = lat !== site.origin.latitude || lon !== site.origin.longitude;
      if (moved && this.study.context.fetchedAt && !window.confirm('Le voisinage chargé correspond à l’ancienne origine : il sera effacé. Continuer ?')) {
        this.renderSite();
        return;
      }
      site.origin = { ...site.origin, latitude: lat, longitude: lon, altitude: alt };
      if (moved) {
        this.study.context = { ...this.study.context, buildings: [], terrain: null, credits: [], radius: 0, fetchedAt: null };
        site.utcOffset = defaultUtcOffset(lon);
        this.selection = null;
      }
      // Le sol local (et le pied des voisins) se compte depuis l'altitude de l'origine : tout se recale.
      this.contextRevision++;
      this.scene.setGround(this.study);
      this.dirty = true;
      this.refresh();
    };
    const offset = numberInput(site.utcOffset, (value) => {
      site.utcOffset = value;
      this.dirty = true;
      this.updateSun();
      this.checkAnalysis();
    }, { min: -12, max: 14, step: 0.5 });
    const area = site.limit.length >= 3 ? polygonArea(site.limit) : 0;
    fill(this.siteBox,
      field('Latitude', latitude),
      field('Longitude', longitude),
      field('Altitude (m)', altitude),
      h('div', { class: 'tool-row' }, button('Placer l’origine', apply, { class: 'primary', title: 'Origine du repère local : est, nord, haut en mètres' }),
        h('span', { class: 'hint', text: 'Ex. Paris : 48,8566 ; 2,3522' })),
      field('Fuseau (h)', offset),
      h('p', { class: 'site-note', text: `Heure du site : ${offsetText(site.utcOffset)}, déduit de la longitude (${offsetText(defaultUtcOffset(site.origin.longitude))}). Corrigez-le selon l’heure légale (heure d’été comprise).` }),
      h('div', { class: 'tool-row' },
        button(site.limit.length >= 3 ? 'Redessiner la limite' : 'Dessiner la limite', () => this.setMode('limit'), { attrs: { 'aria-pressed': String(this.mode === 'limit') } }),
        site.limit.length >= 3 ? button('Effacer', () => { site.limit = []; this.dirty = true; this.refresh(); }) : null),
      h('p', { class: 'hint', text: site.limit.length >= 3 ? `Terrain : ${this.areaText(area)}` : 'Pas encore de limite : les ratios restent vides.' }),
    );
  }

  // ------------------------------------------------------------- voisinage

  private renderContext(): void {
    const { context } = this.study;
    const counts = heightCounts(context.buildings);
    const edited = context.buildings.filter((b) => b.edited).length;
    const radius = numberInput(context.radius || DEFAULT_RADIUS, () => {}, { min: 100, max: 600, step: 50 });
    fill(this.contextBox,
      field('Rayon (m)', radius),
      h('div', { class: 'tool-row' },
        button(context.fetchedAt ? 'Relire le voisinage' : 'Charger le voisinage', () => void this.loadNeighbourhood(Number(radius.value) || DEFAULT_RADIUS), { class: context.fetchedAt ? '' : 'primary', title: 'Bâtiments d’OpenStreetMap (Overpass) et relief gratuit, lus une fois et gardés dans l’étude' }),
        this.loading ? button('Arrêter', () => this.loading?.abort()) : null),
      this.loading ? h('p', { class: 'hint', text: 'Lecture des bâtiments et du relief…' }) : null,
      context.fetchedAt
        ? h('p', { class: 'hint', text: `${integer.format(context.buildings.length)} bâtiments (lus le ${new Date(context.fetchedAt).toLocaleDateString('fr-FR')}, ${integer.format(context.radius)} m) : ${integer.format(counts.measured)} hauteurs mesurées, ${integer.format(counts.tagged)} renseignées, ${integer.format(counts.assumed)} supposées${edited ? `, dont ${integer.format(edited)} corrigées` : ''}. Relief : ${context.terrain ? `grille de ${context.terrain.step} m` : 'aucun (sol plat)'}.` })
        : h('p', { class: 'hint', text: 'Rien de chargé : sol plat, pas de voisins.' }),
    );
    const selection = this.selection;
    if (selection?.kind === 'neighbour') {
      const building = context.buildings[selection.index];
      if (building) {
        const source = { measured: 'mesurée', tagged: 'renseignée (OSM)', assumed: 'supposée' }[building.heightSource];
        this.contextBox.append(h('div', { class: 'site-selected' },
          h('p', { class: 'field-label', text: `Voisin ${building.id}` }),
          field('Hauteur (m)', numberInput(building.height, (value) => {
            building.height = value;
            building.edited = true;
            this.neighboursChanged();
          }, { min: 0.5, max: 1000, step: 0.5 })),
          h('p', { class: 'site-note', text: `Hauteur ${source}${building.edited ? ', corrigée' : ''}.` }),
          h('div', { class: 'tool-row' }, button('Supprimer ce voisin', () => {
            context.buildings.splice(selection.index, 1);
            this.selection = null;
            this.neighboursChanged();
          }))));
      }
    } else if (context.buildings.length > 0) {
      this.contextBox.append(h('p', { class: 'site-note', text: 'Cliquez un bâtiment dans la vue pour corriger sa hauteur ou le supprimer.' }));
    }
  }

  private neighboursChanged(): void {
    this.contextRevision++;
    this.dirty = true;
    this.scene.setNeighbours(this.study, this.selection?.kind === 'neighbour' ? this.selection.index : null);
    this.renderContext();
    this.checkAnalysis();
  }

  private async loadNeighbourhood(radius: number): Promise<void> {
    if (this.study.context.fetchedAt && !window.confirm('Relire le voisinage remplace les bâtiments chargés et vos corrections. Continuer ?')) return;
    this.loading?.abort();
    const controller = new AbortController();
    this.loading = controller;
    this.renderContext();
    try {
      const { context, altitude, notes } = await loadContext(this.study.site.origin, Math.min(600, Math.max(100, radius)), { signal: controller.signal });
      if (controller.signal.aborted) return;
      this.study.context = context;
      if (altitude !== null) this.study.site.origin.altitude = altitude;
      this.contextRevision++;
      this.dirty = true;
      this.selection = null;
      this.loading = null;
      this.scene.setGround(this.study);
      this.refresh();
      this.toast([`${integer.format(context.buildings.length)} bâtiments chargés.`, altitude !== null ? `Altitude de l’origine : ${oneDecimal.format(altitude)} m.` : '', ...notes].filter(Boolean).join(' '), notes.length > 0);
    } catch (error) {
      if (this.loading === controller) this.loading = null;
      this.renderContext();
      if (!controller.signal.aborted) this.toast(`Voisinage indisponible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  // ---------------------------------------------------------------- volumes

  private renderVolumes(): void {
    const barWidth = numberInput(this.barWidth, (value) => { this.barWidth = value; }, { min: 1, max: 200, step: 0.5 });
    const draw = (mode: DrawMode, label: string, title: string) => button(label, () => this.setMode(this.mode === mode ? null : mode), { title, attrs: { 'aria-pressed': String(this.mode === mode) } });
    fill(this.volumesBox,
      h('div', { class: 'tool-row' },
        draw('rectangle', 'Rectangle', 'Deux clics : deux coins opposés'),
        draw('polygon', 'Polygone', 'Cliquez les sommets, puis le premier pour fermer'),
        draw('bar', 'Barre', 'Deux clics : l’axe de la barre')),
      field('Largeur barre (m)', barWidth),
      h('div', { class: 'site-uses' }, ...this.study.settings.uses.map((use) => h('span', { class: 'site-use' }, h('span', { class: 'site-swatch', attrs: { style: `background:${use.color}` } }), use.name))),
      this.volumeList,
      this.volumeForm,
    );
    this.renderVolumeList();
    this.renderVolumeForm();
  }

  private barWidth = 12;
  private readonly volumeList = h('div', { class: 'site-list' });
  private readonly volumeForm = h('div', { class: 'site-stack' });

  private renderVolumeList(): void {
    const useName = (id: string) => this.study.settings.uses.find((use) => use.id === id)?.name ?? id;
    fill(this.volumeList);
    if (this.proposal.volumes.length === 0) {
      this.volumeList.append(h('p', { class: 'hint', text: 'Aucun volume : dessinez-en un (rectangle, polygone ou barre).' }));
      return;
    }
    for (const volume of this.proposal.volumes) {
      const row = h('button', { class: 'dimensions-row', attrs: { type: 'button', 'aria-pressed': String(this.selection?.kind === 'volume' && this.selection.id === volume.id) } },
        h('span', { class: 'dimensions-name', text: volume.name }),
        h('span', { class: 'dimensions-values', text: `${useName(volume.use)} · ${volume.floors} niv. · ${this.areaText(polygonArea(volume.footprint) * volume.floors)}` }));
      row.addEventListener('click', () => this.select({ kind: 'volume', id: volume.id }));
      this.volumeList.append(row);
    }
  }

  private renderVolumeForm(): void {
    fill(this.volumeForm);
    const volume = this.selectedVolume;
    if (!volume) return;
    const uses = this.study.settings.uses;
    const name = h('input', { attrs: { type: 'text', value: volume.name } });
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
    this.volumeForm.append(
      h('p', { class: 'field-label', text: 'Volume sélectionné' }),
      field('Nom', name),
      field('Usage', use),
      field('Rez-de-chaussée', ground),
      field('Niveaux', numberInput(volume.floors, (value) => { volume.floors = value; this.edited(); }, { min: 1, max: 200, step: 1, integer: true })),
      field('Hauteur d’étage (m)', numberInput(volume.floorHeight, (value) => { volume.floorHeight = value; this.edited(); }, { min: 1, max: 20, step: 0.1 })),
      field('Niveau bas (m)', numberInput(volume.baseLevel, (value) => { volume.baseLevel = value; this.edited(); }, { min: -500, max: 2000, step: 0.1 })),
      h('p', { class: 'site-note', text: 'Glissez le volume dans la vue pour le déplacer. Niveau bas : depuis l’altitude de l’origine.' }),
      h('div', { class: 'tool-row' },
        button('Poser au sol', () => { volume.baseLevel = round1(groundAt(this.study, ...centroid(volume.footprint))); this.renderVolumeForm(); this.edited(); }, { title: 'Niveau bas = sol sous le centre du volume' }),
        button('Dupliquer', () => this.duplicateVolume(volume)),
        button('Supprimer', () => this.deleteVolume(volume))),
    );
  }

  private addVolume(footprint: XY[]): void {
    if (polygonArea(footprint) < 0.5) {
      this.toast('Volume trop petit : tracez plus grand.', true);
      return;
    }
    const n = this.proposal.volumes.length + 1;
    const volume: Volume = { id: newId(), name: `Volume ${n}`, footprint, baseLevel: round1(groundAt(this.study, ...centroid(footprint))), floors: 4, floorHeight: 3, use: this.study.settings.uses[0]?.id ?? 'autre' };
    this.proposal.volumes.push(volume);
    this.selection = { kind: 'volume', id: volume.id };
    this.dirty = true;
    this.refresh();
  }

  private duplicateVolume(volume: Volume): void {
    const copy: Volume = { ...structuredClone(volume), id: newId(), name: `${volume.name} (copie)`, footprint: translate(volume.footprint, 5, -5) };
    this.proposal.volumes.push(copy);
    this.selection = { kind: 'volume', id: copy.id };
    this.dirty = true;
    this.refresh();
  }

  private deleteVolume(volume: Volume): void {
    this.proposal.volumes = this.proposal.volumes.filter((v) => v !== volume);
    this.selection = null;
    this.dirty = true;
    this.refresh();
  }

  private select(selection: Selection): void {
    this.selection = selection;
    this.refresh();
  }

  // ---------------------------------------------------------------- esquisse

  private setMode(mode: DrawMode | null): void {
    this.mode = mode;
    this.root.classList.toggle('sketching', mode !== null);
    if (!mode) this.sketch.stop();
    else {
      const limit = this.study.site.limit;
      this.sketch.shapes = limit.length >= 3 && mode !== 'limit' ? [{ points: limit.map(([e, n]) => new Vector3(...toScene(e, n, 0))), label: 'Limite' }] : [];
      this.sketch.start(mode === 'rectangle' || mode === 'bar' ? 'lines' : 'polygon', 0);
    }
    const hints: Record<DrawMode, string> = {
      limit: 'Limite du terrain : cliquez les sommets, puis le premier point pour fermer. Maj : tracé droit. Échap : annuler.',
      rectangle: 'Rectangle : cliquez deux coins opposés. Échap : annuler.',
      polygon: 'Polygone : cliquez les sommets, puis le premier point pour fermer. Maj : tracé droit. Échap : annuler.',
      bar: `Barre de ${oneDecimal.format(this.barWidth)} m : cliquez le début puis la fin de son axe. Maj : tracé droit. Échap : annuler.`,
    };
    this.hintEl.textContent = mode ? hints[mode] : '';
    this.hintEl.hidden = !mode;
    this.renderSite();
    this.renderVolumes();
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
    if (mode === 'limit') {
      this.study.site.limit = points;
      this.dirty = true;
      this.refresh();
      this.checkAnalysis();
    } else if (mode === 'polygon') this.addVolume(points);
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
    // Phase de capture : décider avant les contrôles d'orbite si le geste déplace un volume.
    this.viewport.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target !== canvas) return;
      down = { x: event.clientX, y: event.clientY };
      const volume = this.selectedVolume;
      if (this.mode || !volume) return;
      const hit = this.scene.pickVolume(event.clientX, event.clientY);
      if (hit?.id !== volume.id) return;
      const start = this.scene.planePoint(event.clientX, event.clientY, hit.point.y);
      if (!start) return;
      this.scene.controls.enabled = false;
      this.drag = { volume, original: volume.footprint, start, height: hit.point.y, moved: false, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    }, { capture: true });
    this.viewport.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (drag) {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        const point = this.scene.planePoint(event.clientX, event.clientY, drag.height);
        if (!point) return;
        drag.moved = true;
        drag.volume.footprint = translate(drag.original, point[0] - drag.start[0], point[1] - drag.start[1]);
        if (!queued) {
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            this.scene.setVolumes(this.study, this.proposal, drag.volume.id);
          });
        }
        return;
      }
      if (event.buttons === 0 && this.shown) this.hover(event.clientX, event.clientY);
    });
    this.viewport.addEventListener('pointerup', (event) => {
      const drag = this.drag;
      if (drag) {
        this.drag = null;
        this.scene.controls.enabled = true;
        if (drag.moved) {
          down = null;
          this.edited();
          return;
        }
      }
      const start = down;
      down = null;
      if (!start || event.target !== canvas || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      if (this.mode) {
        this.sketch.click(event.clientX, event.clientY, event.shiftKey);
        return;
      }
      const volume = this.scene.pickVolume(event.clientX, event.clientY);
      if (volume) return this.select({ kind: 'volume', id: volume.id });
      const neighbour = this.scene.pickNeighbour(event.clientX, event.clientY);
      this.select(neighbour !== null ? { kind: 'neighbour', index: neighbour } : null);
    });
    this.viewport.addEventListener('pointerleave', () => { this.readoutEl.hidden = true; });
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

  private renderProposals(): void {
    const current = this.proposal;
    const select = h('select', { attrs: { 'aria-label': 'Proposition affichée' } }, ...this.study.proposals.map((p) => h('option', { text: p.name, attrs: { value: p.id } })));
    select.value = current.id;
    select.addEventListener('change', () => {
      const kind = this.shown?.kind;
      this.proposalId = select.value;
      this.selection = null;
      this.shown = null;
      this.scene.setAnalysis(null, null, 1);
      this.refresh();
      // Même analyse, gardée pour l'autre proposition si rien n'a changé depuis : on passe de l'une à l'autre pour comparer.
      const cached = kind ? this.cache.get(`${this.proposalId}|${kind}`) : undefined;
      if (kind && cached?.key === this.analysisKey(kind)) this.show(cached);
      else if (kind) this.renderAnalysis(`${ANALYSIS_NAMES[kind]} : à lancer pour cette proposition.`);
    });
    const name = h('input', { attrs: { type: 'text', value: current.name, 'aria-label': 'Nom de la proposition' } });
    name.addEventListener('change', () => {
      current.name = name.value.trim() || current.name;
      this.dirty = true;
      this.renderProposals();
      this.renderFigures();
    });
    fill(this.proposalsBox,
      field('Affichée', select),
      field('Nom', name),
      h('div', { class: 'tool-row' },
        button('Nouvelle', () => this.addProposal(newProposal(`Proposition ${this.study.proposals.length + 1}`))),
        button('Dupliquer', () => {
          const copy = structuredClone(current);
          copy.id = newId();
          copy.name = `${current.name} (copie)`;
          for (const volume of copy.volumes) volume.id = newId();
          this.addProposal(copy);
        }),
        button('Supprimer', () => {
          if (!window.confirm(`Supprimer la proposition « ${current.name} » et ses volumes ?`)) return;
          this.study.proposals = this.study.proposals.filter((p) => p !== current);
          this.proposalId = this.study.proposals[0].id;
          this.selection = null;
          this.dirty = true;
          this.refresh();
          this.checkAnalysis();
        }, { attrs: this.study.proposals.length > 1 ? {} : { disabled: '' } })),
    );
  }

  private addProposal(proposal: Proposal): void {
    this.study.proposals.push(proposal);
    this.proposalId = proposal.id;
    this.selection = null;
    this.dirty = true;
    this.refresh();
    this.checkAnalysis();
  }

  // ----------------------------------------------------------------- chiffres

  private table(rows: string[][]): HTMLElement {
    return h('table', { class: 'compare-table site-table' },
      h('thead', {}, h('tr', {}, ...rows[0].map((cell) => h('th', { text: cell })))),
      h('tbody', {}, ...rows.slice(1).map((row) => h('tr', {}, h('th', { text: row[0] }), ...row.slice(1).map((cell) => h('td', { text: cell }))))));
  }

  private copy(rows: string[][]): void {
    navigator.clipboard.writeText(toTsv(rows)).then(() => this.toast('Tableau copié : collez-le dans un tableur.'), () => this.toast('Copie refusée par le navigateur.', true));
  }

  private renderFigures(): void {
    const { settings } = this.study;
    const current = figureRows(this.study, [this.proposal]);
    fill(this.figuresBox, this.table(current), h('div', { class: 'tool-row' }, button('Copier (TSV)', () => this.copy(figureRows(this.study, [this.proposal])))));
    if (this.study.proposals.length > 1) {
      this.figuresBox.append(h('p', { class: 'field-label', text: 'Comparaison des propositions' }), this.table(figureRows(this.study, this.study.proposals)),
        h('div', { class: 'tool-row' }, button('Copier la comparaison (TSV)', () => this.copy(figureRows(this.study, this.study.proposals)))));
    }
    const units = h('select', {}, h('option', { text: 'm²', attrs: { value: 'm2' } }), h('option', { text: 'ft²', attrs: { value: 'ft2' } }));
    units.value = settings.units;
    units.addEventListener('change', () => { settings.units = units.value === 'ft2' ? 'ft2' : 'm2'; this.dirty = true; this.refresh(); });
    const usesList = h('div', { class: 'site-stack' }, ...settings.uses.map((use) => {
      const name = h('input', { attrs: { type: 'text', value: use.name, 'aria-label': 'Nom de l’usage' } });
      name.addEventListener('change', () => { use.name = name.value.trim() || use.name; this.dirty = true; this.refresh(); });
      const color = h('input', { attrs: { type: 'color', value: use.color, 'aria-label': `Couleur de ${use.name}` } });
      color.addEventListener('change', () => { use.color = color.value; this.dirty = true; this.refresh(); });
      const housing = h('input', { attrs: { type: 'checkbox', title: 'Compte pour les logements' } });
      housing.checked = use.housing;
      housing.addEventListener('change', () => { use.housing = housing.checked; this.dirty = true; this.renderFigures(); });
      return h('div', { class: 'site-use-row' }, color, name, h('label', { class: 'tool-check', title: 'Compte pour l’estimation des logements' }, housing, 'logements'));
    }));
    const addUse = button('Ajouter un usage', () => {
      settings.uses.push({ id: newId(), name: `Usage ${settings.uses.length + 1}`, color: '#7f8c8d', housing: false });
      this.dirty = true;
      this.refresh();
    });
    const details = h('details', {},
      h('summary', { text: 'Réglages des chiffres' }),
      h('div', { class: 'site-stack' },
        field('Unité', units),
        field('Logement (m²)', numberInput(settings.dwellingSize, (value) => { settings.dwellingSize = value; this.dirty = true; this.renderFigures(); }, { min: 10, max: 500, step: 1 })),
        field('Rendement (%)', numberInput(Math.round(settings.efficiency * 100), (value) => { settings.efficiency = value / 100; this.dirty = true; this.renderFigures(); }, { min: 10, max: 100, step: 1 })),
        h('p', { class: 'site-note', text: 'Logements estimés = surface de plancher des usages cochés × rendement ÷ surface moyenne d’un logement.' }),
        usesList,
        addUse));
    details.open = this.settingsOpen;
    details.addEventListener('toggle', () => { this.settingsOpen = details.open; });
    this.figuresBox.append(details);
  }

  // -------------------------------------------------------------------- soleil

  private buildSun(): void {
    const date = h('input', { attrs: { type: 'date', value: this.day, 'aria-label': 'Date' } });
    const presets = h('select', { attrs: { 'aria-label': 'Dates usuelles' } }, h('option', { text: 'Dates usuelles…', attrs: { value: '' } }),
      ...presetDays(new Date().getFullYear()).map((preset) => h('option', { text: `${preset.label} (${dayText(preset.day).slice(0, 5)})`, attrs: { value: preset.day } })));
    const time = h('input', { attrs: { type: 'range', min: '0', max: '1430', step: '10', value: String(this.minutes), 'aria-label': 'Heure du site' } });
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
    time.addEventListener('input', () => { this.minutes = Number(time.value); this.updateSun(); });
    shadows.addEventListener('change', () => { this.shadows = shadows.checked; this.updateSun(); });
    this.sunBox.append(
      h('div', { class: 'tool-row' }, date, presets),
      h('div', { class: 'tool-row' }, time),
      this.sunReadout,
      h('label', { class: 'tool-check' }, shadows, 'Ombres portées (volumes, voisins, relief)'),
    );
  }

  private updateSun(): void {
    const { origin, utcOffset } = this.study.site;
    const position = sunPosition(localTime(this.day, this.minutes, utcOffset), origin.latitude, origin.longitude);
    const up = position.elevation > 0;
    this.scene.setSun(up ? toScene(...sunVector(position)) : null, this.shadows);
    this.sunReadout.textContent = `${dayText(this.day)} à ${clockText(this.minutes)} (${offsetText(utcOffset)}) : ${up ? `Soleil à ${oneDecimal.format(position.elevation)}° de haut, azimut ${integer.format(Math.round(position.azimuth))}°` : 'Soleil sous l’horizon'}. Position calculée (formules NOAA).`;
  }

  // ------------------------------------------------------------------ analyses

  /** Ce dont dépend une analyse : si la clé change, le résultat affiché n'est plus valable. */
  private analysisKey(kind: AnalysisKind): string {
    const { site } = this.study;
    return JSON.stringify([kind, kind === 'vsc' ? '' : this.day, kind === 'vsc' ? 0 : site.utcOffset, site.origin.latitude, site.origin.longitude, kind === 'sun-ground' ? site.limit : 0, this.proposal.volumes, this.contextRevision]);
  }

  private checkAnalysis(): void {
    const shown = this.shown;
    if (!shown || shown.key === this.analysisKey(shown.kind)) return;
    this.shown = null;
    this.scene.setAnalysis(null, null, 1);
    this.readoutEl.hidden = true;
    this.renderAnalysis('Les volumes, le voisinage ou la date ont changé : relancez l’analyse.');
  }

  private renderAnalysis(note = ''): void {
    const run = (kind: AnalysisKind, title: string) => button(ANALYSIS_NAMES[kind], () => void this.runAnalysis(kind), { title });
    const buttons = [
      run('sun-ground', 'Heures de soleil direct sur une grille au sol (dans la limite), à la date choisie'),
      run('sun-facade', 'Heures de soleil direct sur les façades des volumes, à la date choisie'),
      run('vsc', 'Composante de ciel (VSC) sur les façades des volumes, ciel couvert CIE'),
    ];
    if (this.running) buttons.forEach((b) => { b.disabled = true; });
    fill(this.analysisBox,
      h('div', { class: 'site-stack' }, ...buttons),
      this.running ? h('div', { class: 'tool-row' }, this.progressEl, button('Arrêter', () => this.running?.abort())) : null,
      note ? h('p', { class: 'hint', text: note }) : null,
    );
    this.progressEl.hidden = !this.running;
    const shown = this.shown;
    if (!shown) return;
    const legend = h('div', { class: 'site-legend' });
    if (shown.kind === 'vsc') {
      legend.append(h('div', { class: 'site-bins' }, ...VSC_BINS.map((bin) => h('span', {}, h('span', { class: 'site-swatch', attrs: { style: `background:${bin.color}` } }), bin.label))));
    } else {
      legend.append(h('div', { class: 'site-gradient', attrs: { style: `background:linear-gradient(to right, ${SUN_GRADIENT.join(', ')})` } }),
        h('div', { class: 'site-scale' }, h('span', { text: '0 h' }), h('span', { text: `${oneDecimal.format(shown.dayLength)} h (jour entier)` })));
    }
    const isSun = shown.kind !== 'vsc';
    const share = h('p', { class: 'hint' });
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
    this.analysisBox.append(
      h('p', { class: 'field-label', text: ANALYSIS_NAMES[shown.kind] }),
      legend,
      field(isSun ? 'Seuil (h)' : 'Seuil (%)', threshold),
      share,
      h('p', { class: 'site-note', text: shown.label }),
      h('p', { class: 'site-note', text: 'Survolez un point pour lire sa valeur.' }),
      h('div', { class: 'tool-row' }, button('Effacer l’analyse', () => {
        this.shown = null;
        this.scene.setAnalysis(null, null, 1);
        this.renderAnalysis();
      })),
    );
  }

  private async runAnalysis(kind: AnalysisKind): Promise<void> {
    const study = this.study, proposal = this.proposal;
    const key = this.analysisKey(kind), cacheKey = `${proposal.id}|${kind}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.key === key) return this.show(cached);
    if (kind !== 'sun-ground' && proposal.volumes.length === 0) return this.renderAnalysis('Dessinez d’abord un volume : l’analyse porte sur ses façades.');
    // Zone au sol : la limite, sinon l'emprise des volumes élargie de 30 m.
    let area: XY[] = study.site.limit;
    if (kind === 'sun-ground' && area.length < 3) {
      const all = proposal.volumes.flatMap((v) => v.footprint);
      if (all.length === 0) return this.renderAnalysis('Dessinez la limite du terrain ou un volume : la grille au sol les couvre.');
      const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
      area = rectangle([Math.min(...xs) - 30, Math.min(...ys) - 30], [Math.max(...xs) + 30, Math.max(...ys) + 30]);
    }
    this.running?.abort();
    const controller = new AbortController();
    this.running = controller;
    this.progressEl.textContent = 'Préparation…';
    this.renderAnalysis();
    try {
      // Le lancer de rayons (et three-mesh-bvh) n'est chargé qu'à la première analyse.
      const analysis = await import('./analysis.ts');
      const parts = proposal.volumes.map((v) => volumeMesh(v).positions);
      const neighbours = this.scene.neighbourTriangles();
      if (neighbours) parts.push(neighbours);
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
      const path = daySunPath(this.day, study.site.origin.latitude, study.site.origin.longitude, study.site.utcOffset, SUN_STEP_MINUTES);
      const dayLength = path.reduce((sum, sample) => sum + sample.hours, 0);
      const job = kind === 'vsc' ? analysis.skyComponentJob(points, occluder) : analysis.sunHoursJob(points, occluder, path);
      const values = await runSliced(job, (progress) => { this.progressEl.textContent = `Calcul… ${Math.round(progress * 100)} %`; }, controller.signal);
      const display = new Float32Array(points.length * 3);
      points.forEach(({ position, normal }, i) => {
        // Décollés de leur surface pour rester visibles : 0,3 m au-dessus du sol, 0,6 m devant une façade.
        const lift = normal ? normal.map((v) => v * 0.6) : [0, 0.3, 0];
        display.set([position[0] + lift[0], position[1] + lift[1], position[2] + lift[2]], i * 3);
      });
      const obstacles = `obstacles : volumes de la proposition et ${integer.format(study.context.buildings.length)} voisins ; le relief ne fait pas obstacle`;
      const label = kind === 'vsc'
        ? `Composante de ciel (VSC) : part du ciel couvert normalisé CIE vue par une façade verticale (39,6 % sans obstacle), ${analysis.SKY_RAYS} directions par point ; ${method} ; ${obstacles}. Repères 27 / 15 / 5 %. Calculé le ${today()}. Indicatif, pour comparer des options ; ce n’est pas une étude réglementaire.`
        : `Heures de soleil direct le ${dayText(this.day)} (heure du site ${offsetText(study.site.utcOffset)}) : course du Soleil tous les ${SUN_STEP_MINUTES} min (formules NOAA), ${method} ; ${obstacles}${kind === 'sun-facade' ? ' ; une façade ne compte le Soleil que devant elle' : ''}. Calculé le ${today()}. Indicatif, pour comparer des options ; ce n’est pas une étude réglementaire.`;
      const result: AnalysisResult = { kind, key, values, display, size, label, dayLength };
      this.cache.set(cacheKey, result);
      this.running = null;
      // L'étude a pu changer pendant le calcul : le résultat n'est montré que s'il est encore valable.
      if (this.study === study && this.proposal === proposal && this.analysisKey(kind) === key) this.show(result);
      else this.renderAnalysis('L’étude a changé pendant le calcul : relancez l’analyse.');
    } catch (error) {
      if (this.running === controller) this.running = null;
      this.renderAnalysis(controller.signal.aborted ? 'Calcul interrompu.' : `Analyse impossible : ${error instanceof Error ? error.message : String(error)}`);
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
    this.renderAnalysis();
  }

  // --------------------------------------------------------- sources, export

  private renderCredits(): void {
    const { context } = this.study;
    const exportButton = button('Exporter la proposition (GLB + JSON)', () => {
      const proposal = this.proposal;
      const name = `${slug(this.study.name)}-${slug(proposal.name)}`;
      download(new Blob([proposalGlb(this.study, proposal)], { type: 'model/gltf-binary' }), `${name}.glb`);
      download(new Blob([JSON.stringify(proposalMetadata(this.study, proposal), null, 1)], { type: 'application/json' }), `${name}.json`);
      this.toast('Déposez les deux fichiers ensemble dans le viewer : la proposition s’y place sur la carte.');
    }, { title: 'Un élément par volume, avec ses propriétés ; le JSON porte la position sur Terre' });
    fill(this.creditsBox,
      h('div', { class: 'tool-row' }, exportButton),
      h('p', { class: 'site-note', text: 'Les résultats servent à comparer des options en début de projet. Ce n’est pas une étude réglementaire d’ensoleillement ou de lumière naturelle.' }),
      context.credits.length > 0
        ? h('ul', { class: 'site-credits' }, ...context.credits.map((credit) => h('li', { text: credit })))
        : h('p', { class: 'site-note', text: 'Données : © les contributeurs d’OpenStreetMap (bâtiments) et Terrain Tiles d’AWS Open Data (relief), une fois le voisinage chargé.' }),
    );
  }
}
