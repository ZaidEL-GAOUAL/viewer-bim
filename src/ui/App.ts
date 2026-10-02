import { Box3 } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { PropertyStore, flattenProperties, mergeProperties, parseMetadata, type Metadata } from '../data/metadata.ts';
import { hexToRgb } from '../data/palette.ts';
import { buildModel } from '../engine/buildModel.ts';
import { ModelFileError, filesFromDrop, filesFromList, isModelFile, loadModelFiles, loadModelUrl, type InputFile } from '../engine/loadModel.ts';
import { Measure, type MeasureKind } from '../engine/Measure.ts';
import { convertIfc, isIfcFile } from '../ifc/convertIfc.ts';
import type { Model } from '../engine/Model.ts';
import { Viewer } from '../engine/Viewer.ts';
import { button, h, integer } from './dom.ts';
import { FilterPanel } from './FilterPanel.ts';
import { MeasurePanel } from './MeasurePanel.ts';
import { PropertiesPanel } from './PropertiesPanel.ts';
import { SectionPanel } from './SectionPanel.ts';
import { TreePanel } from './TreePanel.ts';

export type AppEvent = 'model' | 'selection' | 'visibility' | 'colors' | 'tool';
export type SelectionSource = 'view' | 'panel';
export type Tool = 'select' | MeasureKind;

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Sélection', hint: 'Cliquer un élément pour afficher ses propriétés' },
  { id: 'distance', label: 'Distance', hint: 'Cliquer deux points' },
  { id: 'area', label: 'Surface', hint: 'Cliquer une face plane' },
  { id: 'volume', label: 'Volume', hint: 'Cliquer un élément' },
];

// Laisse le navigateur afficher le message d'attente avant un calcul long. Le délai de secours
// évite de rester bloqué quand l'onglet est en arrière-plan (les images y sont suspendues).
const NO_MATCH =
  'Aucun identifiant du fichier JSON ne correspond aux éléments du modèle. Vérifiez le champ « extras.id » ou le nom des nœuds.';

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    window.setTimeout(resolve, 120);
  });

/** Chef d'orchestre : relie le moteur 3D, les données et les panneaux de l'interface. */
export class App {
  readonly viewer: Viewer;
  readonly measure: Measure;
  model: Model | null = null;
  store = new PropertyStore(0);
  metadata: Metadata | null = null;
  readonly selection = new Set<number>();
  selectionSource: SelectionSource = 'panel';
  /** Dernier élément ajouté à la sélection par un clic dans la vue 3D. */
  lastPicked: number | null = null;
  tool: Tool = 'select';

  private readonly listeners = new Map<AppEvent, Set<() => void>>();
  private readonly root: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly busyEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly toolButtons = new Map<Tool, HTMLButtonElement>();
  private readonly scratchBox = new Box3();
  private toastTimer = 0;
  private loadTicket = 0;
  /** Visibilité de chaque élément avant l'isolement en cours (1 = visible), ou null. */
  private isolation: Uint8Array | null = null;
  private isolateButton!: HTMLButtonElement;
  private metadataInput!: HTMLInputElement;
  private conversionEl!: HTMLElement;
  private conversionText!: HTMLElement;
  /** Fichiers produits par la dernière conversion d'IFC, proposés au téléchargement. */
  private conversion: { name: string; glb: Blob; json: string } | null = null;
  /** Nombre d'éléments du modèle qui ont trouvé leur bloc dans le JSON. */
  private matched = 0;
  private fileName = '';

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('app');

    // ---------------------------------------------------------------- vue 3D
    const canvasHost = h('div', { class: 'canvas-host' });
    const overlayRoot = h('div', { class: 'overlay-root' });
    this.viewer = new Viewer(canvasHost);
    this.measure = new Measure(this.viewer, overlayRoot);
    this.measure.onNotice = (message) => this.toast(message);

    // ------------------------------------------------------------ barre d'outils
    const fileInput = h('input', {
      attrs: { type: 'file', multiple: '', accept: '.ifc,.glb,.gltf,.json,.bin,.png,.jpg,.jpeg,.webp', hidden: '' },
    });
    // Un .gltf vient souvent avec un .bin et un dossier de textures : on peut ouvrir le dossier entier.
    const folderInput = h('input', { attrs: { type: 'file', webkitdirectory: '', hidden: '' } });
    // Le JSON de métadonnées peut aussi être ajouté (ou remplacé) après coup, sur le modèle affiché.
    this.metadataInput = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });
    for (const input of [fileInput, folderInput, this.metadataInput]) {
      input.addEventListener('change', () => {
        if (input.files?.length) void this.loadFiles(filesFromList(input.files));
        input.value = '';
      });
    }

    const samples = h('select', { class: 'samples', title: 'Charger un modèle de démonstration' },
      h('option', { text: 'Exemples…', attrs: { value: '' } }),
      h('option', { text: 'Petit bâtiment (220 éléments)', attrs: { value: 'demo' } }),
      h('option', { text: 'Tour (22 500 éléments)', attrs: { value: 'demo-large' } }),
      h('option', { text: 'Maquette IFC (convertie dans le navigateur)', attrs: { value: 'ifc' } }),
    );
    samples.addEventListener('change', () => {
      if (samples.value) void this.loadSample(samples.value);
      samples.value = '';
    });

    const tools = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': 'Outils' } });
    for (const tool of TOOLS) {
      const element = button(tool.label, () => this.setTool(tool.id), { title: tool.hint });
      this.toolButtons.set(tool.id, element);
      tools.append(element);
    }

    const sectionPanel = new SectionPanel(this);
    const sectionToggle = button('Coupes', () => {
      const open = sectionPanel.toggle();
      sectionToggle.setAttribute('aria-pressed', String(open));
    }, { title: 'Plans de coupe', attrs: { 'aria-pressed': 'false' } });

    this.isolateButton = button('Isoler', () => this.toggleIsolate(), { attrs: { 'aria-pressed': 'false' } });

    // Boutons de repli des panneaux latéraux, aux deux extrémités de la barre.
    const panelToggle = (side: 'left' | 'right', label: string) => {
      const toggle = button('', () => {
        const collapsed = root.classList.toggle(`${side}-collapsed`);
        toggle.setAttribute('aria-pressed', String(!collapsed));
        toggle.title = `${collapsed ? 'Afficher' : 'Masquer'} ${label}`;
      }, { class: `panel-toggle ${side}`, title: `Masquer ${label}`, attrs: { 'aria-pressed': 'true', 'aria-label': `Afficher ou masquer ${label}` } });
      return toggle;
    };

    this.stats = h('div', { class: 'stats' });
    const topbar = h('header', { class: 'topbar' },
      panelToggle('left', 'le panneau de gauche (arborescence, filtres)'),
      h('div', { class: 'brand', text: 'Viewer BIM' }),
      h('div', { class: 'bar-group' },
        button('Ouvrir…', () => fileInput.click(), { class: 'primary', title: 'Ouvrir un .glb ou .gltf et son .json de métadonnées' }),
        button('Dossier…', () => folderInput.click(), { title: 'Ouvrir un dossier contenant un .gltf, son .bin et ses textures' }),
        button('Métadonnées…', () => this.chooseMetadata(), { title: 'Ajouter ou remplacer le fichier .json de métadonnées du modèle affiché' }),
        samples, fileInput, folderInput, this.metadataInput,
      ),
      tools,
      h('div', { class: 'bar-group' },
        sectionToggle,
        button('Cadrer', () => this.fitSelection(), { title: 'Cadrer la vue sur la sélection, ou sur ce qui est affiché (F)' }),
        this.isolateButton,
        button('Tout afficher', () => this.showWholeModel(), { title: 'Réafficher tous les éléments et cadrer le modèle entier (A)' }),
      ),
      h('div', { class: 'spacer' }),
      panelToggle('right', 'le panneau de droite (propriétés)'),
    );

    this.toastEl = h('div', { class: 'toast', attrs: { role: 'status', hidden: '' } });
    this.busyEl = h('div', { class: 'busy', attrs: { hidden: '' } });
    this.emptyEl = h('div', { class: 'empty' },
      h('div', { class: 'empty-card' },
        h('h1', { text: 'Déposez un modèle' }),
        h('p', { text: 'Un fichier .ifc (converti sur place), ou un .glb avec son .json de métadonnées, ou le dossier d’un .gltf (avec son .bin et ses textures).' }),
        h('div', { class: 'empty-actions' },
          button('Choisir des fichiers…', () => fileInput.click(), { class: 'primary' }),
          button('Choisir un dossier…', () => folderInput.click()),
          button('Charger l’exemple', () => void this.loadSample('demo')),
        ),
      ),
    );
    this.viewport = h('main', { class: 'viewport' }, canvasHost, overlayRoot, this.emptyEl, this.stats, this.toastEl, this.busyEl);

    // Après la conversion d'un IFC : rappel du résultat et téléchargement des deux fichiers produits.
    this.conversionText = h('p', { class: 'hint' });
    this.conversionEl = h('section', { class: 'card conversion-card', attrs: { hidden: '' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'IFC converti' }),
        button('×', () => (this.conversionEl.hidden = true), { class: 'measure-remove', title: 'Fermer' }),
      ),
      this.conversionText,
      h('div', { class: 'conversion-actions' },
        button('Télécharger le GLB', () => this.downloadConversion('glb')),
        button('Télécharger le JSON', () => this.downloadConversion('json')),
      ),
    );
    const measurePanel = new MeasurePanel(this);
    this.viewport.append(h('div', { class: 'cards' }, sectionPanel.el, measurePanel.el, this.conversionEl));

    // -------------------------------------------------------------- panneaux
    const tree = new TreePanel(this);
    const filters = new FilterPanel(this);
    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist' } });
    const panels: [string, HTMLElement][] = [['Arborescence', tree.el], ['Couleurs et filtres', filters.el]];
    const tabButtons = panels.map(([label, panel], index) => {
      const tab = button(label, () => {
        panels.forEach(([, other], i) => {
          other.hidden = i !== index;
          tabButtons[i].setAttribute('aria-selected', String(i === index));
        });
      }, { attrs: { role: 'tab', 'aria-selected': String(index === 0) } });
      panel.hidden = index !== 0;
      return tab;
    });
    tabs.append(...tabButtons);
    const left = h('aside', { class: 'sidebar left' }, tabs, tree.el, filters.el);
    const right = h('aside', { class: 'sidebar right' }, new PropertiesPanel(this).el);

    root.append(topbar, left, this.viewport, right);

    this.bindPointer();
    this.bindKeyboard();
    this.bindDrop();
    this.bindTheme();
    this.setTool('select');
    this.updateStats();
    this.on('visibility', () => this.updateStats());
    this.on('visibility', () => this.syncIsolateButton());
    this.on('selection', () => this.syncIsolateButton());
    this.syncIsolateButton();
  }

  // ------------------------------------------------------------- événements

  on(event: AppEvent, listener: () => void): void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
  }

  private emit(event: AppEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  // --------------------------------------------------------------- éléments

  elementLabel(index: number): string {
    return this.store.labelOf(index) || this.model?.names[index] || '';
  }

  /** Remplace la sélection, ou la complète si `additive` (un élément déjà sélectionné est alors retiré). */
  select(indices: Iterable<number>, source: SelectionSource, additive = false): void {
    const model = this.model;
    if (!model) return;
    const state = model.state;
    if (!additive) {
      for (const index of this.selection) state.setSelected(index, false);
      this.selection.clear();
    }
    const list = [...indices];
    const toggle = additive && list.length === 1 && this.selection.has(list[0]);
    for (const index of list) {
      if (toggle) this.selection.delete(index);
      else this.selection.add(index);
      state.setSelected(index, !toggle);
    }
    this.selectionSource = source;
    this.lastPicked = source === 'view' && list.length === 1 && !toggle ? list[0] : null;
    state.commit();
    this.viewer.invalidate();
    this.emit('selection');
  }

  setVisible(indices: Iterable<number>, visible: boolean): void {
    const model = this.model;
    if (!model) return;
    for (const index of indices) {
      model.state.setVisible(index, visible);
      // Un choix fait pendant un isolement est conservé quand on le quitte.
      if (this.isolation) this.isolation[index] = visible ? 1 : 0;
    }
    this.visibilityChanged();
  }

  /** Réaffiche tous les éléments (et met fin à un isolement). */
  showAll(): void {
    const model = this.model;
    if (!model) return;
    this.isolation = null;
    for (let i = 0; i < model.count; i++) model.state.setVisible(i, true);
    this.visibilityChanged();
  }

  /** Vue d'ensemble : tout réafficher et cadrer le modèle entier. */
  showWholeModel(): void {
    if (!this.model) return;
    this.showAll();
    this.viewer.fit(this.model.box);
  }

  get isolated(): boolean {
    return this.isolation !== null;
  }

  /**
   * Isole la sélection (elle seule reste affichée), ou quitte l'isolement en cours en rétablissant
   * l'affichage d'avant : ce qui était masqué le redevient.
   */
  toggleIsolate(): void {
    const model = this.model;
    if (!model) return;
    const state = model.state;
    if (this.isolation) {
      const saved = this.isolation;
      this.isolation = null;
      for (let i = 0; i < model.count; i++) state.setVisible(i, saved[i] === 1);
    } else {
      if (this.selection.size === 0) return;
      const saved = new Uint8Array(model.count);
      for (let i = 0; i < model.count; i++) {
        saved[i] = state.isVisible(i) ? 1 : 0;
        state.setVisible(i, false);
      }
      for (const index of this.selection) state.setVisible(index, true);
      this.isolation = saved;
    }
    this.visibilityChanged();
  }

  private syncIsolateButton(): void {
    const element = this.isolateButton;
    element.textContent = this.isolated ? 'Ne plus isoler' : 'Isoler';
    element.setAttribute('aria-pressed', String(this.isolated));
    element.disabled = !this.model || (!this.isolated && this.selection.size === 0);
    element.title = this.isolated
      ? 'Revenir à l’affichage d’avant l’isolement (I)'
      : 'N’afficher que la sélection (I). Un second clic rétablit l’affichage.';
  }

  private visibilityChanged(): void {
    this.model?.state.commit();
    this.viewer.invalidate();
    this.emit('visibility');
  }

  /** Impose une couleur (hexadécimale) à des groupes d'éléments. */
  applyColors(groups: Iterable<[number[], string]>): void {
    const model = this.model;
    if (!model) return;
    for (const [indices, hex] of groups) {
      const [r, g, b] = hexToRgb(hex);
      for (const index of indices) model.state.setColor(index, r, g, b);
    }
    model.state.commit();
    this.viewer.invalidate();
    this.emit('colors');
  }

  clearColors(): void {
    const model = this.model;
    if (!model) return;
    for (let i = 0; i < model.count; i++) model.state.clearColor(i);
    model.state.commit();
    this.viewer.invalidate();
    this.emit('colors');
  }

  fitTo(indices: Iterable<number>): void {
    if (!this.model) return;
    const box = this.model.boxOf(indices, this.scratchBox);
    this.viewer.fit(box.isEmpty() ? this.model.box : box);
  }

  /** Cadre la sélection ; sans sélection, ce qui est affiché (le modèle entier si rien n'est masqué). */
  fitSelection(): void {
    const model = this.model;
    if (!model) return;
    if (this.selection.size > 0) {
      this.fitTo(this.selection);
      return;
    }
    const visible: number[] = [];
    for (let i = 0; i < model.count; i++) if (model.state.isVisible(i)) visible.push(i);
    this.fitTo(visible);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.measure.setTool(tool === 'select' ? null : tool);
    for (const [id, element] of this.toolButtons) element.setAttribute('aria-pressed', String(id === tool));
    this.viewport.classList.toggle('measuring', tool !== 'select');
    this.emit('tool');
  }

  // ------------------------------------------------------------- chargement

  async loadFiles(inputs: InputFile[]): Promise<void> {
    // Dans un dossier, on prend le modèle et le JSON les plus proches de la racine.
    const depth = (input: InputFile) => input.path.split('/').length;
    const byDepth = (matches: InputFile[]) => matches.sort((a, b) => depth(a) - depth(b));
    const modelFiles = byDepth(inputs.filter((input) => isModelFile(input.file.name)));
    const modelFile = modelFiles[0] as InputFile | undefined;
    const jsonFiles = byDepth(inputs.filter((input) => /\.json$/i.test(input.file.name)));
    const ifcFile = byDepth(inputs.filter((input) => isIfcFile(input.file.name)))[0] as InputFile | undefined;
    if (!modelFile && !ifcFile && jsonFiles.length === 0) {
      this.toast('Déposez un fichier .ifc, .glb ou .gltf, avec éventuellement un .json de métadonnées.', true);
      return;
    }
    const ticket = this.beginLoad('Lecture des fichiers…');
    try {
      if (!modelFile && ifcFile) {
        await this.loadIfc(ticket, ifcFile.file);
      } else if (modelFile) {
        // Un dossier peut contenir des .json sans rapport : on lit tous ceux qui ont la forme d'un
        // fichier de métadonnées, et on retiendra celui qui correspond le mieux au modèle.
        // Un JSON illisible n'empêche pas d'afficher le modèle.
        const candidates: Metadata[] = [];
        let metadataError = '';
        for (const candidate of jsonFiles) {
          try {
            candidates.push(this.readMetadata(await candidate.file.text(), candidate.file.name));
          } catch (error) {
            metadataError ||= `« ${candidate.file.name} » : ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        const siblings = inputs.filter((input) => input !== modelFile);
        const { gltf, missingTextures, warnings } = await loadModelFiles(modelFile, siblings).catch((error: unknown) => {
          if (error instanceof ModelFileError) throw error;
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Impossible de lire « ${modelFile.file.name} » : ce n’est pas un fichier glTF valide (${detail}).`);
        });
        // Un JSON déposé seul avant le modèle reste en attente et s'applique au premier modèle chargé.
        if (candidates.length === 0 && !this.model && this.metadata) candidates.push(this.metadata);
        const installed = await this.installModel(ticket, gltf, candidates, modelFile.file.name);
        if (!installed) return;
        const metadata = this.metadata;
        if (missingTextures.length > 0) {
          this.toast(`Modèle affiché sans ${missingTextures.length > 1 ? 'ses textures' : 'sa texture'} (« ${missingTextures.join(' », « ')} ») : déposez le dossier complet pour ${missingTextures.length > 1 ? 'les' : 'la'} charger.`, true);
        } else if (warnings.length > 0) {
          this.toast(warnings.join(' '), true);
        } else if (!metadata && metadataError) {
          this.toast(`Modèle chargé sans métadonnées. ${metadataError}`, true);
        } else if (modelFiles.length > 1) {
          this.toast(`${modelFiles.length} modèles fournis : seul « ${modelFile.file.name} » est chargé.`);
        }
      } else {
        const metadata = this.readMetadata(await jsonFiles[0].file.text(), jsonFiles[0].file.name);
        if (ticket !== this.loadTicket) return;
        if (!this.model) {
          this.metadata = metadata;
          this.toast('Métadonnées chargées. Déposez maintenant le fichier .glb ou .gltf.');
        } else if (this.countMatches(metadata) === 0) {
          // Un JSON qui ne correspond à aucun élément ne remplace pas les métadonnées en place.
          this.toast(NO_MATCH, true);
        } else {
          this.metadata = metadata;
          this.rebuildStore();
          this.reportMatching();
        }
      }
    } catch (error) {
      if (ticket === this.loadTicket) this.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.endLoad(ticket);
    }
  }

  /**
   * Convertit un IFC dans le navigateur (même script que pipeline/ifc_to_glb.py), puis charge le
   * GLB et les métadonnées obtenus comme s'ils avaient été déposés.
   */
  private async loadIfc(ticket: number, file: File): Promise<void> {
    const base = file.name.replace(/\.ifc$/i, '');
    const result = await convertIfc(file, (message) => {
      if (ticket === this.loadTicket) this.busy(message);
    }).catch((error: unknown) => {
      // Une erreur Python arrive avec toute sa trace : seule la dernière ligne parle à l'utilisateur.
      const lines = (error instanceof Error ? error.message : String(error)).trim().split('\n');
      throw new Error(`Impossible de convertir « ${file.name} » : ${lines[lines.length - 1]}`);
    });
    if (ticket !== this.loadTicket) return;
    if (!result.report.elements) throw new Error(`« ${file.name} » ne contient aucun élément avec une géométrie.`);

    const glb = new File([result.glb], `${base}.glb`, { type: 'model/gltf-binary' });
    const metadata = this.readMetadata(result.metadata, `${base}.json`);
    const { gltf } = await loadModelFiles({ file: glb, path: glb.name }, []);
    if (!(await this.installModel(ticket, gltf, [metadata], file.name))) return;

    this.conversion = { name: base, glb, json: result.metadata };
    const { elements = 0, seconds = 0, without_geometry: failed = 0 } = result.report;
    this.conversionText.textContent =
      `${integer.format(elements)} éléments convertis en ${seconds.toLocaleString('fr-FR')} s, reliés à leurs propriétés par leur identifiant IFC.` +
      (failed > 0 ? ` ${integer.format(failed)} éléments n’ont pas pu être convertis en géométrie.` : '');
    this.conversionEl.hidden = false;
  }

  private downloadConversion(kind: 'glb' | 'json'): void {
    const conversion = this.conversion;
    if (!conversion) return;
    const blob = kind === 'glb' ? conversion.glb : new Blob([conversion.json], { type: 'application/json' });
    const link = h('a', { attrs: { href: URL.createObjectURL(blob), download: `${conversion.name}.${kind}` } });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  async loadSample(name: string): Promise<void> {
    if (name === 'ifc') {
      // L'exemple IFC passe par le vrai convertisseur, comme un fichier déposé.
      const response = await fetch(`${import.meta.env.BASE_URL}samples/ifc-demo.ifc`);
      await this.loadFiles([{ file: new File([await response.blob()], 'ifc-demo.ifc'), path: 'ifc-demo.ifc' }]);
      return;
    }
    const ticket = this.beginLoad('Chargement de l’exemple…');
    try {
      const base = `${import.meta.env.BASE_URL}samples/${name}`;
      const [gltf, text] = await Promise.all([loadModelUrl(`${base}.glb`), fetch(`${base}.json`).then((r) => r.text())]);
      await this.installModel(ticket, gltf, [this.readMetadata(text, `${name}.json`)], `${name}.glb`);
    } catch (error) {
      if (ticket === this.loadTicket) this.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.endLoad(ticket);
    }
  }

  /**
   * Chaque chargement reçoit un numéro. Si l'utilisateur en lance un autre avant la fin, le plus
   * ancien est abandonné : son résultat ne remplace pas le modèle le plus récent.
   */
  private beginLoad(message: string): number {
    this.busy(message);
    this.toastEl.hidden = true; // un message d'erreur précédent ne doit pas survivre à un nouvel essai
    return ++this.loadTicket;
  }

  private endLoad(ticket: number): void {
    if (ticket === this.loadTicket) this.busy(null);
  }

  /** Ouvre le sélecteur de fichier pour ajouter un JSON de métadonnées au modèle affiché. */
  chooseMetadata(): void {
    this.metadataInput.click();
  }

  private readMetadata(text: string, name: string): Metadata {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`« ${name} » n’est pas un fichier JSON valide.`);
    }
    const metadata = parseMetadata(json);
    metadata.source = name;
    return metadata;
  }

  /** Renvoie faux si le chargement a été abandonné au profit d'un plus récent. */
  private async installModel(ticket: number, gltf: GLTF, candidates: Metadata[], name: string): Promise<boolean> {
    if (ticket !== this.loadTicket) return false;
    this.busy('Optimisation de la géométrie…');
    await nextFrame();
    if (ticket !== this.loadTicket) return false;
    const model = buildModel(gltf, this.viewer.selectColor);

    const previous = this.model;
    this.measure.clear();
    this.selection.clear();
    this.isolation = null;
    this.conversion = null;
    this.conversionEl.hidden = true;
    this.model = model;
    // Parmi plusieurs fichiers de métadonnées, celui dont les identifiants correspondent le mieux.
    let metadata: Metadata | null = candidates[0] ?? null;
    let bestMatches = metadata ? this.countMatches(metadata) : 0;
    for (const candidate of candidates.slice(1)) {
      const matches = this.countMatches(candidate);
      if (matches > bestMatches) {
        metadata = candidate;
        bestMatches = matches;
      }
    }
    this.metadata = metadata;
    this.fileName = name;
    this.viewer.setModel(model);
    previous?.dispose();

    this.emptyEl.hidden = true;
    this.rebuildStore();
    this.emit('selection');
    this.emit('visibility');
    if (metadata) this.reportMatching();
    return true;
  }

  /** Associe à chaque élément ses propriétés : les `extras` du nœud glTF, complétés par le JSON. */
  private rebuildStore(): void {
    const model = this.model;
    if (!model) return;
    const store = new PropertyStore(model.count);
    for (let i = 0; i < model.count; i++) {
      const entry = this.metadata?.elements.get(model.keys[i]);
      const extras = model.extras[i];
      const props = mergeProperties(extras ? flattenProperties(extras) : undefined, entry?.props);
      if (props) store.set(i, props, entry?.label);
    }
    store.finalize();
    this.store = store;
    this.matched = this.metadata ? this.countMatches(this.metadata) : 0;
    for (let i = 0; i < model.count; i++) model.state.clearColor(i);
    model.state.commit();
    this.viewer.invalidate();
    this.updateStats();
    this.emit('model');
  }

  private countMatches(metadata: Metadata): number {
    let matched = 0;
    for (const key of this.model?.keys ?? []) if (metadata.elements.has(key)) matched++;
    return matched;
  }

  private reportMatching(): void {
    const model = this.model;
    const metadata = this.metadata;
    if (!model || !metadata) return;
    const matched = this.countMatches(metadata);
    if (matched === 0) {
      this.toast(NO_MATCH, true);
    } else if (matched < model.count) {
      this.toast(`Métadonnées associées à ${integer.format(matched)} éléments sur ${integer.format(model.count)}.`);
    }
  }

  // -------------------------------------------------------------- interface

  toast(message: string, isError = false): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle('error', isError);
    this.toastEl.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toastEl.hidden = true), isError ? 9000 : 5000);
  }

  private busy(message: string | null): void {
    this.busyEl.hidden = message === null;
    if (message !== null) this.busyEl.textContent = message;
  }

  private updateStats(): void {
    const model = this.model;
    if (!model) {
      this.stats.textContent = '';
      return;
    }
    let hidden = 0;
    for (let i = 0; i < model.count; i++) if (!model.state.isVisible(i)) hidden++;
    const parts = [
      this.fileName,
      `${integer.format(model.count)} éléments`,
      `${integer.format(model.triangleCount)} triangles`,
      `${model.chunks.length} lots`,
    ];
    parts.push(
      this.metadata
        ? `métadonnées : ${this.metadata.source ?? 'JSON'} (${integer.format(this.matched)} sur ${integer.format(model.count)})`
        : 'sans fichier de métadonnées',
    );
    if (hidden > 0) parts.push(`${integer.format(hidden)} masqué${hidden > 1 ? 's' : ''}`);
    this.stats.textContent = parts.join(' · ');
  }

  private bindPointer(): void {
    const canvas = this.viewer.renderer.domElement;
    let down: { x: number; y: number; button: number } | null = null;
    let hoverX = 0;
    let hoverY = 0;
    let hoverQueued = false;

    // Avec deux doigts (zoom ou déplacement tactile), aucun des deux contacts n'est un clic.
    const active = new Set<number>();
    const release = (event: PointerEvent) => active.delete(event.pointerId);
    canvas.addEventListener('pointerdown', (event) => {
      active.add(event.pointerId);
      down = active.size === 1 ? { x: event.clientX, y: event.clientY, button: event.button } : null;
    });
    canvas.addEventListener('pointercancel', (event) => {
      release(event);
      down = null;
    });
    canvas.addEventListener('lostpointercapture', release);
    canvas.addEventListener('pointerup', (event) => {
      release(event);
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      const wasLeft = down.button === 0;
      down = null;
      // Un clic qui a déplacé la caméra n'est pas une sélection.
      if (moved > 4 || !wasLeft) return;
      this.handleClick(event);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (this.tool === 'select' || event.buttons !== 0) return;
      hoverX = event.clientX;
      hoverY = event.clientY;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        this.measure.move(hoverX, hoverY);
      });
    });
    canvas.addEventListener('pointerleave', () => this.measure.leave());
    canvas.addEventListener('dblclick', (event) => {
      if (this.tool !== 'select') return;
      const hit = this.viewer.pick(event.clientX, event.clientY);
      if (hit) this.fitTo([hit.element]);
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private handleClick(event: PointerEvent): void {
    if (!this.model) return;
    if (this.tool === 'select') {
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const hit = this.viewer.pick(event.clientX, event.clientY);
      if (hit) this.select([hit.element], 'view', additive);
      else if (!additive) this.select([], 'view');
    } else {
      const hit = this.measure.click(event.clientX, event.clientY);
      if (hit && this.tool === 'volume') this.select([hit.element], 'view');
    }
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      // Les raccourcis ne se taisent que pendant une saisie de texte ; un curseur ou une case à
      // cocher qui a gardé le focus ne doit pas les bloquer.
      const typing =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && !/^(checkbox|radio|range|color|button|file)$/.test(target.type)) ||
        target?.isContentEditable === true;
      if (typing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      switch (event.key.toLowerCase()) {
        case 'escape':
          if (this.measure.hasPending) this.measure.cancelPending();
          else if (this.tool !== 'select') this.setTool('select');
          else this.select([], 'panel');
          break;
        case 'f':
          this.fitSelection();
          break;
        case 'h':
          if (this.selection.size > 0) this.setVisible(this.selection, false);
          break;
        case 'i':
          this.toggleIsolate();
          break;
        case 'a':
          this.showWholeModel();
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  private bindDrop(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('dragging');
    });
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('dragging');
    });
    window.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    window.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('dragging');
      if (!event.dataTransfer) return;
      void filesFromDrop(event.dataTransfer).then(
        (files) => {
          if (files.length > 0) void this.loadFiles(files);
        },
        () => this.toast('Impossible de lire les fichiers déposés.', true),
      );
    });
  }

  private bindTheme(): void {
    const apply = () => {
      const style = getComputedStyle(document.documentElement);
      this.viewer.setBackground(style.getPropertyValue('--viewport').trim() || '#e9ecef');
      this.viewer.setCapColor(style.getPropertyValue('--cap').trim() || '#39424f');
    };
    apply();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
  }
}
