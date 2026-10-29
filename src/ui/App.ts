import { Box3, Sphere } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { IFC_READ_ONLY, PropertyStore, flattenProperties, unflattenProperties, mergeProperties, ownValue, parseMetadata, type Metadata, type PropValue } from '../data/metadata.ts';
import { evaluatePhases, mergeAppearance, phasesToJson, type PhaseEvaluation, type PhaseSelection, type Phases } from '../data/phases.ts';
import { cameraPose, hiddenByView, hiddenInEveryView, planCameraPose, planSectionBox, sectionBoxLocal, viewsToJson, type SavedView } from '../data/savedViews.ts';
import { combineHidden, layerChanges } from '../data/viewLayer.ts';
import { writeGlb } from '../engine/writeGlb.ts';
import { PropertyEdits } from '../data/PropertyEdits.ts';
import { evaluateAppearanceRules, validateAppearanceRules, type AppearanceRule } from '../data/appearanceRules.ts';
import { updateGlbMetadata } from '../engine/updateGlbMetadata.ts';
import { hexToRgb } from '../data/palette.ts';
import { ModelBuilder, buildModel, gltfSource } from '../engine/buildModel.ts';
import { ModelFileError, filesFromDrop, filesFromList, isModelFile, loadModelFiles, loadModelUrl, type InputFile } from '../engine/loadModel.ts';
import { Measure, type MeasureKind } from '../engine/Measure.ts';
import { IfcTooLargeError, convertIfc, isIfcFile, packageUsd } from '../ifc/convertIfc.ts';
import { isUsdFile, loadUsdFile, loadUsda, usdaFromUsdz } from '../usd/loadUsd.ts';
import { isRevitFile, readRevit, splitRevitName, type RevitRead } from '../revit/readRevit.ts';
import { describeRevitReport } from '../revit/revitReport.ts';
import type { ModelSource, RawInput } from '../engine/buildModel.ts';
import { Model } from '../engine/Model.ts';
import { Viewer } from '../engine/Viewer.ts';
import { AXES } from '../engine/Sections.ts';
import { STANDARD_VIEWS, VIEW_ORDER } from '../engine/views.ts';
import { button, h, integer } from './dom.ts';
import { iconButton } from './icons.ts';
import { AssistantPanel } from './AssistantPanel.ts';
import { DimensionsCard } from './DimensionsCard.ts';
import { MEASURES, MeasureMenu } from './MeasureMenu.ts';
import { ApplePreview } from './ApplePreview.ts';
import { FilterPanel } from './FilterPanel.ts';
import { PropertiesPanel } from './PropertiesPanel.ts';
import { SectionPanel } from './SectionPanel.ts';
import { ViewsPanel } from './ViewsPanel.ts';
import { WalkPanel } from './WalkPanel.ts';
import { MapPanel } from './MapPanel.ts';
import { georeferenceToJson, type Georeference } from '../geo/georeference.ts';
import { TreePanel } from './TreePanel.ts';
import { SchedulePanel } from './SchedulePanel.ts';
import { isScheduleDocument, parseSchedule, type Schedule } from '../data/schedule.ts';

/** Viewer state and local metadata events. */
export type AppEvent = 'model' | 'selection' | 'visibility' | 'colors' | 'tool' | 'metadata' | 'history' | 'appearance' | 'grouping' | 'georeference' | 'phase' | 'view';
export type SelectionSource = 'view' | 'panel';
/** Outils du menu « Mesures » : les mesures par clics, et les cotes de la sélection. */
export type MeasureTool = MeasureKind | 'dimensions';
/** « section » : le prochain clic sur une surface y pose un plan de coupe. */
export type Tool = 'select' | MeasureTool | 'section';

/** Fenêtre étroite : les panneaux latéraux s'ouvrent par-dessus la vue 3D (même seuil que styles.css). */
const NARROW_LAYOUT = '(max-width: 960px)';
const SECTION_HINT = 'Cliquez une surface : un plan de coupe s’y pose, orienté comme elle, et retire ce qui est devant. Échap annule.';
/** Format des fichiers 3D produits par la conversion d'un IFC, et viewer associé. */
export type ModelFormat = 'glb' | 'usd';

/** Vrai pour les outils qui mesurent par clics dans la vue (les cotes, elles, sélectionnent). */
const isPointMeasure = (tool: Tool): tool is MeasureKind => tool === 'distance' || tool === 'area' || tool === 'volume';

// Laisse le navigateur afficher le message d'attente avant un calcul long. Le délai de secours
// évite de rester bloqué quand l'onglet est en arrière-plan (les images y sont suspendues).
/** Taille de fichier 3D au-delà de laquelle l'ouverture est refusée d'emblée. */
const MAX_MODEL_BYTES = 1500e6;

/** Vrai si l'erreur traduit un manque de mémoire du navigateur. */
function isOutOfMemory(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /rangeerror|out of memory|allocation failed|invalid (typed )?array length|array buffer/i.test(message);
}

/** « 1 élément », « 2 éléments » : le singulier en dessous de 2, comme le veut le français (« 0 élément »). */
const counted = (n: number, singular: string, plural = `${singular}s`) => `${integer.format(n)} ${n < 2 ? singular : plural}`;

const tooHeavyMessage = (name: string) =>
  `« ${name} » est trop lourd pour la mémoire dont dispose le navigateur. Fermez d’autres onglets et réessayez, ou ouvrez un modèle plus léger (découpé par bâtiment ou par lot, par exemple).`;

/** Exemples qui sont des fichiers sources (pas des GLB) : ils passent par le convertisseur IFC ou le lecteur Revit. */
const RAW_SAMPLES = new Map([['ifc', 'ifc-demo.ifc'], ['revit', 'revit-demo.rvt']]);

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
  /** Position de la maquette sur Terre : lue dans le fichier, ou saisie dans la carte. */
  georeference: Georeference | null = null;
  private mapPanel!: MapPanel;
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
  private maskButton!: HTMLButtonElement;
  private readonly measureHint = h('p', { class: 'measure-hint', attrs: { hidden: '', role: 'status' } });
  private viewBar!: HTMLElement;
  private twoDButton!: HTMLButtonElement;
  private downloads!: HTMLElement;
  /** Éléments masqués par le bouton « Masquer », que « Démasquer » fait revenir. */
  private readonly masked = new Set<number>();
  private metadataInput!: HTMLInputElement;
  private conversionEl!: HTMLElement;
  private conversionText!: HTMLElement;
  private conversionTitle!: HTMLElement;
  /**
   * Lecture d'un fichier Revit en cours : l'ouverture d'un autre modèle l'interrompt (`controller`), pour ne pas garder
   * deux lecteurs en mémoire. `candidates` : les JSON de métadonnées que `installModel` départagera à la fin ; un JSON
   * déposé seul pendant la lecture y est ajouté au lieu de l'interrompre.
   */
  private revitReading: { controller: AbortController; candidates: Metadata[] } | null = null;
  /** Fichiers produits par la dernière conversion d'IFC, proposés au téléchargement. */
  private conversion: { name: string; model: Blob; extension: string; glb: ArrayBuffer } | null = null;
  /** Nombre de valeurs modifiées dans le panneau Propriétés depuis le chargement du modèle. */
  edits = 0;
  /** Dernière modification, pour que les panneaux ne refassent que ce qui en dépend. */
  lastEdit: { path: string } | null = null;
  /** Local metadata changes only; the model geometry is immutable. */
  propertyEdits: PropertyEdits | null = null;
  appearanceRules: AppearanceRule[] = [];
  groupingPaths: string[] = [];
  /** Phase et filtre de phase choisis (section `phases` des métadonnées), ou null : tout le modèle, sans filtre. */
  phaseSelection: PhaseSelection | null = null;
  /** Ce que la phase choisie fait de chaque élément (voir data/phases.ts). */
  phaseEvaluation: PhaseEvaluation | null = null;
  /** Vue enregistrée ouverte (section `views`), ou null : l'affichage normal. */
  activeView: SavedView | null = null;
  /** Éléments que la vue enregistrée masque (éléments et catégories), ou null. */
  private viewHidden: Uint8Array | null = null;
  /** Éléments que toutes les vues enregistrées masquent : masqués à l'ouverture, comme dans Revit ; « Vue par défaut » y revient. */
  private openingHidden: Uint8Array | null = null;
  /** Éléments que la phase et la vue masquent en ce moment : de quoi les réafficher quand elles changent. */
  private layerHidden: Uint8Array | null = null;
  /** La caméra d'avant l'ouverture de la première vue enregistrée : « Vue par défaut » la rétablit. */
  private cameraBeforeViews: ReturnType<Viewer['capturePose']> | null = null;
  private keyIndex: Map<string, number> | null = null;
  private readonly planning: SchedulePanel;
  get grouping(): readonly string[] { return this.groupingPaths; }
  private originalGlb: ArrayBuffer | Blob | null = null;
  private originalNodeKeys = new Map<number, string>();
  private jsonDownload!: HTMLButtonElement;
  format: ModelFormat = 'glb';
  private readonly formatButtons = new Map<ModelFormat, HTMLButtonElement>();
  private modelDownload!: HTMLButtonElement;
  private quickLookLink!: HTMLAnchorElement;
  private quickLookUrl: string | null = null;
  private quickLookRevision = 0;
  private quickLookPreparing = false;
  private readonly applePreview = new ApplePreview();
  /** Nombre d'éléments du modèle qui ont trouvé leur bloc dans le JSON. */
  private matched = 0;
  fileName = '';

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
      attrs: { type: 'file', multiple: '', accept: '.ifc,.rvt,.rfa,.rte,.rft,.glb,.gltf,.usdz,.usda,.usd,.json,.bin,.png,.jpg,.jpeg,.webp', hidden: '' },
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
      h('option', { text: 'Maquette Revit (2023)', attrs: { value: 'revit' } }),
    );
    samples.addEventListener('change', () => {
      if (samples.value) void this.loadSample(samples.value);
      samples.value = '';
    });

    // Sélection, puis le menu qui réunit les mesures (distance, surface, volume, cotes).
    const selectTool = iconButton('select', 'Sélection', () => this.setTool('select'), 'Sélection — cliquer un élément pour afficher ses propriétés');
    this.toolButtons.set('select', selectTool);
    const tools = h('div', { class: 'bar-group tools', attrs: { role: 'group', 'aria-label': 'Outils' } }, selectTool, new MeasureMenu(this).el);

    const mapToggle = button('Carte', () => {
      void this.mapPanel.toggle().then((open) => mapToggle.setAttribute('aria-pressed', String(open)));
    }, { title: 'Poser la maquette sur la carte (globe, plan ou photo aérienne)', attrs: { 'aria-pressed': 'false' } });
    const sectionPanel = new SectionPanel(this);
    const viewsPanel = new ViewsPanel(this);
    // Mode visite : touche V ou bouton, carte d'aide dans la vue ; le double-clic ne replace que hors mesure.
    const walkPanel = new WalkPanel(this.viewer, (message) => this.toast(message), () => !isPointMeasure(this.tool) && this.tool !== 'section');
    const sectionToggle = button('Coupes', () => {
      const open = sectionPanel.toggle();
      sectionToggle.setAttribute('aria-pressed', String(open));
    }, { title: 'Plans de coupe', attrs: { 'aria-pressed': 'false' } });
    // Vue 2D : projection orthographique et vues standard, affichées sous la barre.
    this.viewBar = h('div', { class: 'view-bar', attrs: { hidden: '', role: 'group', 'aria-label': 'Vues 2D' } },
      ...VIEW_ORDER.map((id) => button(STANDARD_VIEWS[id].label, () => this.viewer.viewFrom(id), { title: STANDARD_VIEWS[id].title })),
    );
    this.twoDButton = button('2D', () => this.setTwoD(!this.twoD), { title: 'Vue 2D : sans perspective, déplacement et zoom seulement, vues face, arrière, gauche, droite, haut, bas', attrs: { 'aria-pressed': 'false' } });

    this.isolateButton = button('Isoler', () => this.toggleIsolate(), { attrs: { 'aria-pressed': 'false' } });
    this.maskButton = button('Masquer', () => this.toggleMask(), { attrs: { 'aria-pressed': 'false' } });
    const deselect = iconButton('deselect', 'Désélectionner', () => this.select([], 'panel'), 'Vider la sélection (Échap)');
    const syncSelection = () => { deselect.disabled = this.selection.size === 0; };
    this.on('selection', syncSelection); syncSelection();
    const undo = iconButton('undo', 'Annuler', () => this.undoProperties(), 'Annuler la dernière modification de propriétés (⌘/Ctrl Z)');
    const redo = iconButton('redo', 'Rétablir', () => this.redoProperties(), 'Rétablir la modification de propriétés (⌘/Ctrl Maj Z)');
    const revert = iconButton('reset', 'Annuler les modifications', () => this.revertEdits(), 'Revenir aux propriétés des fichiers chargés');
    const history = h('div', { class: 'bar-group', attrs: { role: 'group', 'aria-label': 'Modifications des propriétés' } }, undo, redo, revert);
    const syncHistory = () => {
      undo.disabled = !this.propertyEdits?.canUndo; redo.disabled = !this.propertyEdits?.canRedo;
      revert.hidden = !this.propertyEdits?.canUndo;
    };
    this.on('history', syncHistory); this.on('model', syncHistory); syncHistory();
    const clearMeasures = iconButton('erase', 'Effacer toutes les mesures', () => this.measure.clear());
    clearMeasures.disabled = true;
    this.measure.onChange = () => { clearMeasures.disabled = this.measure.results.length === 0; };
    // Safari exige un lien rel="ar" avec un seul enfant img pour ouvrir Quick Look.
    // Le fichier reste local : l'URL blob n'envoie jamais la maquette à un serveur.
    this.quickLookLink = h('a', {
      class: 'quick-look',
      title: 'Quick Look sur iPhone et iPad ; aperçu natif dans Safari 27 ou ultérieur sur Mac',
      attrs: { href: '#', 'aria-label': 'Voir sur Apple', ...(this.applePreview.mode === 'quick-look' ? { rel: 'ar' } : { 'aria-haspopup': 'dialog' }) },
    }, h('img', { attrs: { src: `${import.meta.env.BASE_URL}quick-look.svg`, alt: '', width: '18', height: '18' } }));
    this.quickLookLink.addEventListener('click', (event) => {
      if (this.applePreview.mode === 'unavailable') {
        event.preventDefault();
        this.applePreview.show(null, this.fileName);
        return;
      }
      if (!this.quickLookUrl || this.quickLookPreparing) {
        event.preventDefault();
        if (!this.quickLookPreparing) void this.prepareQuickLook();
      } else if (this.applePreview.mode === 'model') {
        event.preventDefault();
        this.applePreview.show(this.quickLookUrl, this.fileName);
      }
    });
    // Fichiers produits par la conversion d'un IFC : téléchargeables tant que ce modèle est affiché.
    this.downloads = h('div', { class: 'bar-group', attrs: { hidden: '' } },
      (this.modelDownload = button('GLB ↓', () => void this.download('model'), { title: 'Télécharger le fichier 3D issu de la conversion de l’IFC' })),
      (this.jsonDownload = button('JSON ↓', () => void this.download('json'), { title: 'Télécharger les métadonnées (JSON), modifications comprises' })),
      this.quickLookLink,
    );
    // Les modifications de propriétés ne vivent que dans la page : on prévient avant de la quitter.
    window.addEventListener('beforeunload', (event) => {
      if (this.propertyEdits?.changed) event.preventDefault();
    });

    // Format d'export : GLB (glTF) ou USD. Le viewer lit les deux ; un IFC est converti dans
    // le format choisi, et c'est ce fichier qui est affiché et proposé au téléchargement. Ce n'est pas le format du
    // fichier ouvert (un fichier Revit n'est converti en rien) : d'où l'étiquette « Export ».
    const formats = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-labelledby': 'export-format-label' } });
    for (const [format, label, hint] of [['glb', 'GLB', 'Exporter en glTF binaire (.glb) : compact, lu par tous les outils 3D. Un IFC est converti dans ce format.'], ['usd', 'USD', 'Exporter en OpenUSD (.usdz) : métadonnées embarquées dans chaque élément. Un IFC est converti dans ce format.']] as const) {
      const element = button(label, () => this.setFormat(format), { title: hint });
      this.formatButtons.set(format, element);
      formats.append(element);
    }
    try {
      if (localStorage.getItem('viewer-bim.format') === 'usd') this.format = 'usd';
    } catch {
      // stockage indisponible : on garde le format par défaut
    }
    this.syncFormat();

    // Boutons de repli des panneaux latéraux, aux deux extrémités de la barre. Dans une fenêtre étroite (NARROW_LAYOUT, même
    // seuil que styles.css), les panneaux s'ouvrent par-dessus la vue 3D : ils se replient quand la fenêtre le devient, ouvrir l'un
    // replie l'autre, et l'état d'avant revient quand la fenêtre s'élargit.
    const narrow = window.matchMedia(NARROW_LAYOUT);
    const setPanel = new Map<'left' | 'right', (collapsed: boolean) => void>();
    const isCollapsed = (side: 'left' | 'right') => root.classList.contains(`${side}-collapsed`);
    const panelToggle = (side: 'left' | 'right', label: string) => {
      const set = (collapsed: boolean) => {
        root.classList.toggle(`${side}-collapsed`, collapsed);
        toggle.setAttribute('aria-pressed', String(!collapsed));
        toggle.title = `${collapsed ? 'Afficher' : 'Masquer'} ${label}`;
      };
      const toggle = button('', () => {
        const collapsed = !isCollapsed(side);
        set(collapsed);
        if (!collapsed && narrow.matches) setPanel.get(side === 'left' ? 'right' : 'left')?.(true);
      }, { class: `panel-toggle ${side}`, title: `Masquer ${label}`, attrs: { 'aria-pressed': 'true', 'aria-label': `Afficher ou masquer ${label}` } });
      setPanel.set(side, set);
      return toggle;
    };
    let beforeNarrow: { left: boolean; right: boolean } | null = null;
    const fitPanelsToWidth = () => {
      if (narrow.matches && !beforeNarrow) {
        beforeNarrow = { left: isCollapsed('left'), right: isCollapsed('right') };
        for (const set of setPanel.values()) set(true);
      } else if (!narrow.matches && beforeNarrow) {
        setPanel.get('left')?.(beforeNarrow.left);
        setPanel.get('right')?.(beforeNarrow.right);
        beforeNarrow = null;
      }
    };

    this.stats = h('div', { class: 'stats' });
    const topbar = h('header', { class: 'topbar' },
      panelToggle('left', 'le panneau de gauche (arborescence, filtres)'),
      h('div', { class: 'brand', text: 'Viewer BIM' }),
      h('div', { class: 'formats', title: 'Format des téléchargements (GLB ↓ ou USD ↓) et de la conversion d’un IFC, pas celui du fichier ouvert' },
        h('span', { class: 'bar-label', text: 'Export', attrs: { id: 'export-format-label' } }),
        formats,
      ),
      h('div', { class: 'bar-group' },
        button('Ouvrir…', () => fileInput.click(), { class: 'primary', title: 'Ouvrir un .ifc, un fichier Revit (.rvt, .rfa, gabarits .rte et .rft), ou un .glb ou .gltf avec son .json de métadonnées' }),
        button('Dossier…', () => folderInput.click(), { title: 'Ouvrir un dossier contenant un .gltf, son .bin et ses textures' }),
        button('Métadonnées…', () => this.chooseMetadata(), { title: 'Ajouter ou remplacer le fichier .json de métadonnées du modèle affiché' }),
        samples, fileInput, folderInput, this.metadataInput,
      ),
      tools, clearMeasures, history,
      h('div', { class: 'bar-group' },
        this.twoDButton,
        walkPanel.button,
        mapToggle,
        viewsPanel.button,
        sectionToggle,
        button('Cadrer', () => this.fitSelection(), { title: 'Cadrer la vue sur la sélection, ou sur ce qui est affiché (F)' }),
        this.maskButton,
        this.isolateButton,
        deselect,
        button('Tout afficher', () => this.showWholeModel(), { title: 'Réafficher tous les éléments et cadrer le modèle entier (A)' }),
      ),
      this.downloads,
      h('div', { class: 'spacer' }),
      panelToggle('right', 'le panneau de droite (propriétés)'),
    );
    fitPanelsToWidth();
    narrow.addEventListener('change', fitPanelsToWidth);

    this.toastEl = h('div', { class: 'toast', attrs: { role: 'status', hidden: '' } });
    this.busyEl = h('div', { class: 'busy', attrs: { hidden: '' } });
    this.emptyEl = h('div', { class: 'empty' },
      h('div', { class: 'empty-card' },
        h('h1', { text: 'Déposez un modèle' }),
        h('p', { text: 'Un fichier .ifc (converti sur place, en GLB ou en USD selon le format d’export choisi en haut), un fichier Revit (.rvt, .rfa, gabarits .rte et .rft ; lus sur place, sans Revit), un .glb ou un .usdz avec son .json de métadonnées, ou le dossier d’un .gltf (avec son .bin et ses textures).' }),
        h('div', { class: 'empty-actions' },
          button('Choisir des fichiers…', () => fileInput.click(), { class: 'primary' }),
          button('Choisir un dossier…', () => folderInput.click()),
          button('Charger l’exemple', () => void this.loadSample('demo')),
        ),
        h('p', { class: 'empty-legal' },
          '© 2026 Zaid EL GAOUAL · view-only licence · ',
          h('a', { text: 'Licences', attrs: { href: 'licences/index.html', target: '_blank', rel: 'noopener' } }),
        ),
      ),
    );
    const globeHost = h('div', { class: 'globe-host', attrs: { hidden: '' } });
    this.viewport = h('main', { class: 'viewport' }, globeHost, canvasHost, overlayRoot, this.emptyEl, this.stats, this.toastEl, this.busyEl);
    this.mapPanel = new MapPanel(this, globeHost);
    this.mapPanel.onChange = () => {
      globeHost.hidden = !this.mapPanel.isOpen;
      // Le globe pilote une caméra en perspective : la vue 2D attend la fermeture de la carte.
      if (this.mapPanel.isOpen && this.twoD) this.setTwoD(false);
      this.twoDButton.disabled = this.mapPanel.isOpen;
      mapToggle.setAttribute('aria-pressed', String(this.mapPanel.isOpen));
    };

    // Après la conversion d'un IFC ou la lecture d'un .rvt : rappel du résultat et téléchargement des deux fichiers.
    this.conversionText = h('p', { class: 'hint' });
    this.conversionTitle = h('h2', { class: 'card-title', text: 'IFC converti' });
    this.conversionEl = h('section', { class: 'card conversion-card', attrs: { hidden: '' } },
      h('div', { class: 'card-head' },
        this.conversionTitle,
        button('×', () => (this.conversionEl.hidden = true), { class: 'measure-remove', title: 'Fermer' }),
      ),
      this.conversionText,
      h('div', { class: 'conversion-actions' },
        button('Télécharger le fichier 3D', () => void this.download('model')),
        button('Télécharger le JSON', () => void this.download('json')),
      ),
    );
    this.viewport.append(this.viewBar, this.measureHint, walkPanel.el, h('div', { class: 'cards' }, new DimensionsCard(this).el, this.mapPanel.el, viewsPanel.el, sectionPanel.el, this.conversionEl));

    // -------------------------------------------------------------- panneaux
    const tree = new TreePanel(this);
    const filters = new FilterPanel(this);
    const assistant = new AssistantPanel(this);
    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist' } });
    const panels: [string, HTMLElement][] = [['Arborescence', tree.el], ['Couleurs et filtres', filters.el], ['Assistant', assistant.el]];
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
    const left = h('aside', { class: 'sidebar left' }, tabs, tree.el, filters.el, assistant.el);
    const right = h('aside', { class: 'sidebar right' }, new PropertiesPanel(this).el);

    this.planning = new SchedulePanel(this);
    root.append(topbar, left, this.viewport, right, this.planning.el);

    this.bindPointer();
    this.bindKeyboard();
    this.bindDrop();
    this.bindTheme();
    this.setTool('select');
    this.updateStats();
    this.on('visibility', () => this.updateStats());
    this.viewer.onMotionEnd = () => this.updateStats();
    this.on('visibility', () => this.syncIsolateButton());
    this.on('selection', () => this.syncIsolateButton());
    this.on('model', () => this.syncIsolateButton());
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
    const list = [...indices].filter((i) => Number.isInteger(i) && i >= 0 && i < model.count);
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
    this.masked.clear();
    // « Tout afficher » montre aussi ce que la phase ou la vue enregistrée masquaient : leur filtre de visibilité est levé.
    this.layerHidden = null;
    for (let i = 0; i < model.count; i++) model.state.setVisible(i, true);
    this.visibilityChanged();
  }

  /**
   * Ce que fera le bouton « Masquer » : masquer la sélection tant qu'elle a des éléments visibles ;
   * sinon démasquer (la sélection si elle est masquée, à défaut tout ce que ce bouton a masqué).
   */
  get maskAction(): 'mask' | 'unmask' | 'none' {
    const state = this.model?.state;
    if (!state) return 'none';
    let hiddenInSelection = false;
    for (const index of this.selection) {
      if (state.isVisible(index)) return 'mask';
      hiddenInSelection = true;
    }
    return hiddenInSelection || this.masked.size > 0 ? 'unmask' : 'none';
  }

  /** Masque la sélection, ou fait revenir ce qui a été masqué : un seul bouton pour les deux. */
  toggleMask(): void {
    const state = this.model?.state;
    const action = this.maskAction;
    if (!state || action === 'none') return;
    if (action === 'mask') {
      const targets = [...this.selection].filter((index) => state.isVisible(index));
      for (const index of targets) this.masked.add(index);
      this.setVisible(targets, false);
    } else {
      const targets = this.selection.size > 0 ? [...this.selection] : [...this.masked];
      for (const index of targets) this.masked.delete(index);
      this.setVisible(targets, true);
    }
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
      for (let i = 0; i < model.count; i++) state.setVisible(i, i >= saved.length || saved[i] === 1);
      this.visibilityChanged();
    } else if (this.selection.size > 0) {
      this.isolate(this.selection);
    }
  }

  /** N'affiche que ces éléments ; « Ne plus isoler » rétablit l'affichage d'avant. */
  isolate(indices: Iterable<number>): void {
    const model = this.model;
    if (!model) return;
    const state = model.state;
    // Un isolement déjà en cours garde son point de départ : on ne mémorise pas une vue isolée.
    const saved = this.isolation ?? new Uint8Array(model.count);
    for (let i = 0; i < model.count; i++) {
      if (!this.isolation) saved[i] = state.isVisible(i) ? 1 : 0;
      state.setVisible(i, false);
    }
    for (const index of indices) state.setVisible(index, true);
    this.isolation = saved;
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

    const action = this.maskAction;
    this.maskButton.textContent = action === 'unmask' ? 'Démasquer' : 'Masquer';
    this.maskButton.setAttribute('aria-pressed', String(action === 'unmask'));
    this.maskButton.disabled = action === 'none';
    this.maskButton.title = action === 'unmask'
      ? 'Réafficher ce qui a été masqué (H)'
      : 'Masquer la sélection (H). Un second clic la réaffiche.';
  }

  private visibilityChanged(): void {
    // Un élément redevenu visible par un autre moyen (arbre, filtres) n'est plus « à démasquer ».
    const state = this.model?.state;
    if (state) for (const index of this.masked) if (state.isVisible(index)) this.masked.delete(index);
    this.model?.state.commit();
    this.viewer.invalidate();
    this.emit('visibility');
  }

  setAppearanceRules(rules: AppearanceRule[]): void {
    this.appearanceRules = validateAppearanceRules(rules);
    this.refreshAppearance(); this.emit('appearance');
  }
  private refreshAppearance(): void {
    const model = this.model;
    if (!model) return;
    for (let i = 0; i < model.count; i++) { model.state.clearColor(i); model.state.setOpacity(i, null); }
    // Les remplacements de la phase passent sous les règles : une règle d'apparence l'emporte, attribut par attribut.
    const rules = evaluateAppearanceRules(this.store, this.appearanceRules, { keys: model.keys, label: (index) => this.elementLabel(index) });
    for (const [i, appearance] of this.phaseEvaluation ? mergeAppearance(this.phaseEvaluation.appearance, rules) : rules) {
      if (appearance.color) model.state.setColor(i, ...hexToRgb(appearance.color));
      if (appearance.opacity !== undefined) model.state.setOpacity(i, appearance.opacity);
    }
    model.state.commit(); this.viewer.invalidate(); this.emit('colors');
  }
  groupBy(paths: string[]): void {
    if (paths.some((path) => !this.store.paths.includes(path))) throw new Error('Une propriété de regroupement est introuvable.');
    this.groupingPaths = [...new Set(paths)]; this.emit('grouping');
  }

  // ----------------------------------------------------------- phases et vues

  /** Les phases du projet, si le fichier de métadonnées en décrit. */
  get phases(): Phases | undefined {
    return this.metadata?.phases;
  }

  /** Les vues enregistrées du fichier de métadonnées. */
  get savedViews(): readonly SavedView[] {
    return this.metadata?.views ?? [];
  }

  /**
   * Choisit la phase et le filtre de phase (null : tout le modèle, sans filtre). Les éléments que le filtre masque dans
   * cette phase sont masqués, ceux qu'il « remplace » (existant, démoli…) prennent la couleur de leur état, comme dans une
   * vue de Revit ; les règles d'apparence restent prioritaires.
   */
  setPhase(selection: PhaseSelection | null): void {
    this.applyPhase(selection);
    this.refreshLayers();
    this.emit('phase');
  }

  /** Calcule l'état de chaque élément dans la phase choisie, sans rien appliquer. */
  private applyPhase(selection: PhaseSelection | null): void {
    const phases = this.phases, model = this.model;
    this.phaseSelection = phases && model && selection && phases.order.includes(selection.phase) ? selection : null;
    this.phaseEvaluation = this.phaseSelection && phases && model
      ? evaluatePhases(phases, this.phaseSelection, model.count, (index, property) => ownValue(this.store.propsOf(index), property))
      : null;
  }

  /** Remet à jour ce que la phase et la vue masquent, et les couleurs de la phase. */
  private refreshLayers(): void {
    this.syncLayerVisibility();
    this.refreshAppearance();
  }

  /**
   * Masque ce que la phase et la vue enregistrée masquent, réaffiche ce qu'elles masquaient avant. Un élément qu'elles ne
   * touchent pas garde le choix de l'utilisateur (arbre, filtres, isolement) ; l'état est celui des éléments, pas une
   * couche à part : l'arbre, le cadrage et les clics le voient.
   */
  private syncLayerVisibility(): void {
    const model = this.model;
    if (!model) return;
    const next = combineHidden(model.count, this.phaseEvaluation?.hidden, this.viewHidden);
    const { hide, show } = layerChanges(model.count, this.layerHidden, next);
    this.layerHidden = next;
    if (hide.length > 0) this.setVisible(hide, false);
    if (show.length > 0) this.setVisible(show, true);
  }

  private indexOfKey(): Map<string, number> {
    const model = this.model;
    if (!this.keyIndex || this.keyIndex.size !== (model?.keys.length ?? 0)) this.keyIndex = new Map((model?.keys ?? []).map((key, index) => [key, index]));
    return this.keyIndex;
  }

  /**
   * Ouvre une vue enregistrée : la caméra (en glissant), la boîte de coupe, les éléments et catégories masqués, la phase et
   * son filtre. `null` : la vue par défaut, c'est-à-dire l'état de l'ouverture (ce que toutes les vues 3D enregistrées
   * masquent reste masqué, le reste est affiché), sans boîte de coupe ni phase, avec la caméra d'avant la première vue
   * ouverte.
   *
   * Un plan d'étage (`kind: 'plan'`) s'ouvre en vue 2D, vu de dessus, sans rotation : la caméra est parallèle (celle du
   * fichier), puis `setProjection('orthographic', false)` retire l'orbite (déplacement et zoom seulement, comme le bouton
   * « 2D »). La boîte de coupe est celle du plan (`planSectionBox`) : son recadrage en x et z, sa profondeur de vue et sa
   * hauteur de coupe en y. La rotation revient à la sortie du plan : toute autre vue passe par `Viewer.setCameraPose` ou
   * `restorePose`, qui rétablissent l'orbite (voir `Viewer.moveTo`).
   */
  openView(view: SavedView | null): void {
    const model = this.model, { viewer } = this;
    if (!model) return;
    if (view === null) {
      viewer.sections.setBox(null);
      viewer.sectionsChanged();
      this.viewHidden = this.openingHidden;
      this.applyPhase(null);
      this.refreshLayers();
      if (this.cameraBeforeViews) viewer.restorePose(this.cameraBeforeViews);
      this.cameraBeforeViews = null;
      this.syncProjectionUi();
      this.activeView = null;
      this.emit('phase');
      this.emit('view');
      return;
    }
    if (!this.mapPanel.isOpen) this.cameraBeforeViews ??= viewer.capturePose();
    const plan = view.kind === 'plan';
    const offset = model.offset.toArray();
    // Boîte de coupe : celle de la vue, ou aucune. Un plan a la sienne (recadrage en x et z, plage de hauteur en y).
    const box = plan
      ? planSectionBox(view, offset, model.box.isEmpty() ? null : { min: model.box.min.toArray(), max: model.box.max.toArray() })
      : view.sectionBox ? sectionBoxLocal(view.sectionBox, offset) : null;
    viewer.sections.setBox(box);
    viewer.sectionsChanged();
    const hidden = hiddenByView(view, model.count, this.indexOfKey(), (index, property) => ownValue(this.store.propsOf(index), property));
    this.viewHidden = hidden.includes(1) ? hidden : null;
    this.applyPhase(view.phase ? { phase: view.phase, filter: view.phaseFilter } : null);
    this.refreshLayers();
    if (this.mapPanel.isOpen) {
      this.toast('Fermez la carte pour placer la caméra : le reste de la vue est appliqué.');
    } else {
      const sphere = model.box.getBoundingSphere(new Sphere());
      const { width, height } = viewer.size;
      const bounds = { center: sphere.center.toArray(), radius: sphere.radius };
      const aspect = width / Math.max(height, 1);
      if (plan) {
        // Un plan est toujours vu en projection parallèle : un fichier qui lui donnerait une perspective est lu comme parallèle.
        const camera = { ...view.camera, projection: 'orthographic' as const };
        // `setCameraPose` laisse l'orbite en place (une vue parallèle 3D la garde) : le plan la retire ensuite. La projection
        // est alors déjà parallèle, `setProjection` ne fait que fixer `enableRotate` à faux.
        if (viewer.setCameraPose(planCameraPose(camera, offset, bounds, aspect))) viewer.setProjection('orthographic', false);
      } else {
        viewer.setCameraPose(cameraPose(view.camera, offset, bounds, aspect));
      }
      this.syncProjectionUi();
    }
    this.activeView = view;
    this.emit('phase');
    this.emit('view');
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
    this.measure.setTool(isPointMeasure(tool) ? tool : null);
    for (const [id, element] of this.toolButtons) element.setAttribute('aria-pressed', String(id === tool));
    this.viewport.classList.toggle('measuring', isPointMeasure(tool) || tool === 'section');
    this.measureHint.hidden = tool === 'select';
    this.measureHint.textContent = tool === 'section' ? SECTION_HINT : MEASURES.find((item) => item.id === tool)?.hint ?? '';
    this.emit('tool');
  }

  get activeTool(): Tool {
    return this.tool;
  }

  get twoD(): boolean {
    return this.viewer.projection === 'orthographic';
  }

  /** Vue 2D : projection orthographique, ouverte sur la vue de face. */
  setTwoD(on: boolean): void {
    if (on === this.twoD) return;
    this.viewer.setProjection(on ? 'orthographic' : 'perspective');
    this.syncProjectionUi();
    if (this.twoD) this.viewer.viewFrom('front');
    else this.viewer.invalidate();
  }

  /** Les boutons de la vue 2D suivent la projection de la caméra (une vue enregistrée peut la changer). */
  private syncProjectionUi(): void {
    const active = this.twoD;
    this.viewBar.hidden = !active;
    this.twoDButton.setAttribute('aria-pressed', String(active));
  }

  /**
   * Pose un plan de coupe sur la surface cliquée : orienté comme elle, il retire le côté de la
   * caméra (la façade cliquée disparaît, l'intérieur apparaît). Un plan libre est pris d'abord,
   * sinon celui dont les poignées sont affichées.
   */
  private placeSection(event: PointerEvent): void {
    const hit = this.viewer.pick(event.clientX, event.clientY);
    if (!hit) return;
    const { sections, sectionHandles } = this.viewer;
    const axis = AXES.find((slot) => !sections.enabled[slot]) ?? sectionHandles.axis ?? 0;
    // La normale d'un plan de coupe désigne le côté retiré ; celle du contact pointe vers la caméra.
    sections.setTransform(axis, hit.point, hit.normal.clone());
    sections.set(axis, { enabled: true });
    this.viewer.sectionsChanged();
    sectionHandles.select(axis);
    this.setTool('select');
  }

  // ------------------------------------------------------------- chargement

  async loadFiles(inputs: InputFile[]): Promise<void> {
    // Dans un dossier, on prend le modèle et le JSON les plus proches de la racine.
    const depth = (input: InputFile) => input.path.split('/').length;
    const byDepth = (matches: InputFile[]) => matches.sort((a, b) => depth(a) - depth(b));
    const modelFiles = byDepth(inputs.filter((input) => isModelFile(input.file.name) || isUsdFile(input.file.name)));
    const modelFile = modelFiles[0] as InputFile | undefined;
    const jsonFiles = byDepth(inputs.filter((input) => /\.json$/i.test(input.file.name)));
    // Un IFC ou un fichier Revit n'est lu que si aucun modèle 3D (glb, gltf, usd) n'est fourni ; à profondeur égale, l'IFC passe d'abord.
    const sourceFile = byDepth([
      ...inputs.filter((input) => isIfcFile(input.file.name)),
      ...inputs.filter((input) => isRevitFile(input.file.name)),
    ])[0] as InputFile | undefined;
    if (!modelFile && !sourceFile && jsonFiles.length === 0) {
      this.toast('Déposez un fichier .ifc, Revit (.rvt, .rfa, gabarits .rte et .rft), .glb ou .gltf, avec éventuellement un .json de métadonnées.', true);
      return;
    }
    if ((modelFile || sourceFile) && !this.confirmReplace()) return;
    // Un JSON seul (métadonnées ou planning) pendant la lecture d'un fichier Revit ne l'interrompt pas : pas de nouveau
    // chargement (il ferait abandonner la lecture, voir `beginLoad`) ; ses métadonnées rejoignent celles de la lecture.
    const reading = !modelFile && !sourceFile ? this.revitReading : null;
    const ticket = reading ? this.loadTicket : this.beginLoad('Lecture des fichiers…');
    try {
      const metadataFiles: { name: string; text: string }[] = [];
      const schedules: { name: string; schedule: Schedule }[] = [];
      let planningError = '';
      // A planning JSON must never be interpreted as an object's metadata, even in a folder.
      for (const input of jsonFiles) {
        const text = await input.file.text();
        if (ticket !== this.loadTicket) return;
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { metadataFiles.push({ name: input.file.name, text }); continue; }
        if (isScheduleDocument(raw)) {
          try { schedules.push({ name: input.file.name, schedule: parseSchedule(raw) }); }
          catch (error) { planningError ||= error instanceof Error ? error.message : String(error); }
        } else metadataFiles.push({ name: input.file.name, text });
      }
      // Un dossier peut contenir des .json sans rapport : on lit tous ceux qui ont la forme d'un
      // fichier de métadonnées, et on retiendra celui qui correspond le mieux au modèle.
      // Un JSON illisible n'empêche pas d'afficher le modèle.
      const readCandidates = () => {
        const candidates: Metadata[] = [];
        let metadataError = '';
        for (const candidate of metadataFiles) {
          try {
            candidates.push(this.readMetadata(candidate.text, candidate.name));
          } catch (error) {
            metadataError ||= `« ${candidate.name} » : ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        return { candidates, metadataError };
      };
      if (!modelFile && sourceFile && isRevitFile(sourceFile.file.name)) {
        const { candidates, metadataError } = readCandidates();
        await this.loadRevit(ticket, sourceFile.file, candidates, metadataError);
      } else if (!modelFile && sourceFile) {
        await this.loadIfc(ticket, sourceFile.file);
        if (ticket === this.loadTicket) this.announceOpeningHidden();
      } else if (modelFile) {
        const { candidates, metadataError } = readCandidates();
        // Au-delà de cette taille, le navigateur ne peut plus lire le fichier d'un seul bloc.
        const heavy = inputs.find((input) => input.file.size > MAX_MODEL_BYTES);
        if (heavy) {
          throw new Error(
            `« ${heavy.file.name} » (${integer.format(Math.round(heavy.file.size / 1e6))} Mo) est trop volumineux pour être ouvert dans le navigateur (limite : ${integer.format(MAX_MODEL_BYTES / 1e6)} Mo). Essayez un fichier plus léger, par exemple un modèle découpé par bâtiment ou par lot.`,
          );
        }
        const siblings = inputs.filter((input) => input !== modelFile);
        let loaded: { source: GLTF | ModelSource; missingTextures: string[]; warnings: string[] };
        if (isUsdFile(modelFile.file.name)) {
          const usd = await loadUsdFile(modelFile.file).catch((error: unknown) => {
            if (isOutOfMemory(error)) throw new Error(tooHeavyMessage(modelFile.file.name));
            throw new Error(`Impossible de lire « ${modelFile.file.name} » : ${error instanceof Error ? error.message : String(error)}`);
          });
          // Les métadonnées embarquées dans l'USD servent si aucun JSON ne correspond mieux.
          if (usd.metadata) {
            usd.metadata.source = `${modelFile.file.name} (embarquées)`;
            candidates.push(usd.metadata);
          }
          loaded = { source: usd.source, missingTextures: [], warnings: usd.warnings };
        } else {
          const { gltf, missingTextures, warnings } = await loadModelFiles(modelFile, siblings).catch((error: unknown) => {
            if (error instanceof ModelFileError) throw error;
            const detail = error instanceof Error ? error.message : String(error);
            if (isOutOfMemory(error)) throw new Error(tooHeavyMessage(modelFile.file.name));
            throw new Error(`Impossible de lire « ${modelFile.file.name} » : ce n’est pas un fichier glTF valide (${detail}).`);
          });
          loaded = { source: gltf, missingTextures, warnings };
        }
        const { missingTextures, warnings } = loaded;
        // Un JSON déposé seul avant le modèle reste en attente et s'applique au premier modèle chargé.
        if (candidates.length === 0 && !this.model && this.metadata) candidates.push(this.metadata);
        const installed = await this.installModel(ticket, loaded.source, candidates, modelFile.file.name);
        if (!installed) return;
        if (/\.glb$/i.test(modelFile.file.name)) this.originalGlb = modelFile.file;
        if (/\.usdz$/i.test(modelFile.file.name)) {
          this.setQuickLook(modelFile.file.slice(0, modelFile.file.size, 'model/vnd.usdz+zip'));
        }
        const metadata = this.metadata;
        if (missingTextures.length > 0) {
          this.toast(`Modèle affiché sans ${missingTextures.length > 1 ? 'ses textures' : 'sa texture'} (« ${missingTextures.join(' », « ')} ») : déposez le dossier complet pour ${missingTextures.length > 1 ? 'les' : 'la'} charger.`, true);
        } else if (warnings.length > 0) {
          this.toast(warnings.join(' '), true);
        } else if (!metadata && metadataError) {
          this.toast(`Modèle chargé sans métadonnées. ${metadataError}`, true);
        } else if (modelFiles.length > 1) {
          this.toast(`${modelFiles.length} modèles fournis : seul « ${modelFile.file.name} » est chargé.`);
        } else {
          this.announceOpeningHidden();
        }
      } else if (metadataFiles.length && reading && this.revitReading === reading) {
        // La lecture a son propre JSON (celui du fichier) : ceux-ci sont départagés avec lui à la fin, par leurs identifiants.
        const { candidates, metadataError } = readCandidates();
        if (candidates.length === 0) {
          this.toast(metadataError, true);
        } else {
          reading.candidates.push(...candidates);
          const names = candidates.map((candidate) => `« ${candidate.source ?? 'JSON'} »`).join(', ');
          this.toast(`Métadonnées reçues (${names}) : elles seront appliquées quand la lecture du fichier Revit sera terminée.${metadataError ? ` ${metadataError}` : ''}`, metadataError !== '');
        }
      } else if (metadataFiles.length) {
        const metadata = this.readMetadata(metadataFiles[0].text, metadataFiles[0].name);
        if (ticket !== this.loadTicket) return;
        if (!this.model) {
          this.metadata = metadata;
          this.toast('Métadonnées chargées. Déposez maintenant le fichier .glb ou .gltf.');
        } else if (this.countMatches(metadata) === 0) {
          // Un JSON qui ne correspond à aucun élément ne remplace pas les métadonnées en place.
          this.toast(NO_MATCH, true);
        } else {
          this.propertyEdits?.import(metadata, this.model.keys);
          this.emit('selection');
        }
      }
      if (ticket !== this.loadTicket) return;
      if (schedules.length) {
        this.planning.loadJson(schedules[0].schedule, schedules[0].name);
        if (schedules.length > 1) this.toast(`${schedules.length} plannings fournis : seul « ${schedules[0].name} » est chargé.`);
      }
      if (planningError) this.toast(`Planning non chargé : ${planningError}`, true);
    } catch (error) {
      if (ticket === this.loadTicket) this.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (!reading) this.endLoad(ticket);
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
      if (error instanceof IfcTooLargeError) throw error;
      // Une erreur Python arrive avec toute sa trace : seule la dernière ligne parle à l'utilisateur.
      const lines = (error instanceof Error ? error.message : String(error)).trim().split('\n');
      const detail = lines[lines.length - 1];
      if (/parse|header|schema|ISO-10303|token|syntax/i.test(detail)) {
        throw new Error(`« ${file.name} » n’est pas un fichier IFC lisible : il est peut-être incomplet, ou dans une version d’IFC non prise en charge (${detail}).`);
      }
      throw new Error(`Impossible de convertir « ${file.name} » : ${detail}`);
    });
    if (ticket !== this.loadTicket) return;
    if (!result.report.elements) throw new Error(`« ${file.name} » ne contient aucun élément avec une géométrie.`);

    const metadata = this.readMetadata(result.metadata, `${base}.json`);
    let source: GLTF | ModelSource;
    let produced: { model: Blob; extension: string };
    if (this.format === 'usd') {
      // Le paquet USDZ est écrit par le convertisseur, puis relu par le viewer : ce qui est
      // affiché est exactement le fichier que l'on télécharge.
      const usdz = await packageUsd(result.glb, result.metadata, (message) => {
        if (ticket === this.loadTicket) this.busy(message);
      });
      if (ticket !== this.loadTicket) return;
      source = loadUsda(usdaFromUsdz(usdz)).source;
      produced = { model: new Blob([usdz], { type: 'model/vnd.usdz+zip' }), extension: 'usdz' };
    } else {
      const glb = new File([result.glb], `${base}.glb`, { type: 'model/gltf-binary' });
      source = (await loadModelFiles({ file: glb, path: glb.name }, [])).gltf;
      produced = { model: glb, extension: 'glb' };
    }
    if (!(await this.installModel(ticket, source, [metadata], `${base}.${produced.extension}`))) return;

    this.originalGlb = result.glb;
    this.conversion = { name: base, glb: result.glb, ...produced };
    this.modelDownload.textContent = `${produced.extension === 'usdz' ? 'USD' : 'GLB'} ↓`;
    const { elements, seconds, workers, linework, without_geometry: failedCount, failed } = result.report;
    const lines = [
      `${counted(elements, 'élément')} ${elements < 2 ? 'converti' : 'convertis'} en ${seconds.toLocaleString('fr-FR')} s${workers > 1 ? ` avec ${workers} tâches parallèles` : ''}, ${elements < 2 ? 'relié à ses propriétés par son' : 'reliés à leurs propriétés par leur'} identifiant IFC.`,
    ];
    if (linework > 0) {
      lines.push(`${integer.format(linework)} ${linework > 1 ? 'objets sans volume (axes de trame, annotations) ont été laissés' : 'objet sans volume (axe de trame, annotation) a été laissé'} de côté : rien ne manque au bâtiment.`);
    }
    if (failedCount > 0) {
      // Les vrais échecs sont nommés, pour que l'on sache ce qui manque à l'écran.
      const shown = failed.slice(0, 5).map((item) => `${item.class} « ${item.name || item.id} »`).join(', ');
      const more = failedCount > 5 ? ` et ${integer.format(failedCount - 5)} autres` : '';
      lines.push(`Attention : ${integer.format(failedCount)} ${failedCount > 1 ? 'éléments n’ont pas pu être convertis et manquent' : 'élément n’a pas pu être converti et manque'} à l’affichage (${shown}${more}).`);
    }
    this.conversionTitle.textContent = 'IFC converti';
    this.conversionText.textContent = lines.join(' ');
    this.conversionText.classList.toggle('warning', failedCount > 0);
    this.conversionEl.hidden = false;
    this.syncDownloads();
    if (produced.extension === 'usdz') this.setQuickLook(produced.model);
  }

  /**
   * Lit un fichier Revit (.rvt, .rfa, .rte, .rft) dans le navigateur (lecteur WebAssembly du dossier revit/, dans un worker), et
   * affiche le modèle à mesure que la géométrie arrive : chaque morceau de la sortie du lecteur est cuit en lots dès
   * sa réception (`ModelBuilder`), sans GLB entre les deux, et la vue grandit ; la caméra se cadre sur le premier
   * morceau, puis sur le modèle entier à la fin. L'interface (arbre, fiches, métadonnées : le JSON du contrat n'est
   * complet qu'à la fin) n'est reliée au modèle qu'une fois la lecture terminée. Le fichier n'est envoyé à aucun serveur.
   * `candidates` : JSON déposés avec le fichier, ou pendant sa lecture, essayés après les métadonnées du fichier lui-même ;
   * `metadataError` : ce qui a empêché de lire l'un d'eux (le fichier Revit s'affiche quand même, avec ses propres propriétés).
   */
  private async loadRevit(ticket: number, file: File, candidates: Metadata[], metadataError = ''): Promise<void> {
    const { base, extension } = splitRevitName(file.name);
    const reading = (this.revitReading = { controller: new AbortController(), candidates: [...candidates] });
    // Le modèle en construction, montré dans la vue dès son premier morceau ; jeté si la lecture échoue ou recommence.
    const loading: { builder: ModelBuilder | null } = { builder: null };
    let status = '';
    const discard = () => {
      const { builder } = loading;
      if (!builder) return;
      loading.builder = null;
      if (this.viewer.model === builder.model) this.viewer.setModel(null);
      builder.model.dispose();
      this.emptyEl.hidden = this.viewer.model !== null;
    };
    let result: RevitRead;
    try {
      result = await readRevit(file, (message) => {
        status = message;
        if (ticket === this.loadTicket) this.busy(message);
      }, reading.controller.signal, (raw, first) => {
        if (ticket !== this.loadTicket) return;
        // La relecture en mode prudent repart du début : ce qui en était affiché est à refaire.
        if (first) discard();
        let { builder } = loading;
        if (!builder) {
          builder = loading.builder = new ModelBuilder(this.viewer.selectColor);
          builder.append(raw);
          this.showLoadingModel(builder.model);
        } else {
          builder.append(raw);
          this.viewer.modelGrown();
        }
        const shown = builder.model.count;
        this.busy(`${status} ${counted(shown, 'élément')} ${shown < 2 ? 'affiché' : 'affichés'}.`);
      });
      if (ticket !== this.loadTicket) {
        discard();
        return;
      }
      const { report } = result;
      if (!report.elements || !report.triangles) {
        throw new Error([`« ${file.name} » ne contient aucun élément avec une géométrie à afficher.`, ...report.warnings].join(' '));
      }
      const metadata = this.readMetadata(result.metadata, `${base}.json`);
      // Le modèle construit pendant la lecture est installé tel quel, avec les libellés des fiches à la place des noms
      // provisoires de ses morceaux ; sans morceau (le lecteur a tout rendu d'un bloc), le modèle brut va tel quel à
      // buildModel. Les téléchargements réécrivent le modèle affiché (writeGlb). Un modèle seul, c'est que la lecture
      // qui a rendu le résultat (la relecture prudente, après une panique) n'a remis aucun morceau : ce qui est construit
      // vient de la lecture interrompue, et n'est pas le modèle.
      if (!Array.isArray(result.raw)) discard();
      const built = loading.builder?.model;
      if (built && result.names && result.names.length === built.names.length) {
        for (let i = 0; i < result.names.length; i++) built.names[i] = result.names[i] || built.keys[i];
      }
      const source = built ?? result.raw;
      // Le JSON du fichier d'abord, puis ceux déposés avec lui ou pendant la lecture : `installModel` lit cette liste au
      // moment d'installer, donc un JSON qui arrive encore pendant qu'il prépare le modèle compte aussi.
      reading.candidates.unshift(metadata);
      if (!(await this.installModel(ticket, source, reading.candidates, `${base}.${extension}`))) {
        discard();
        return;
      }
    } catch (error) {
      discard();
      // Construire les morceaux peut épuiser la mémoire du fil principal (RangeError) : message pour l'utilisateur, comme à l'installation.
      if (isOutOfMemory(error)) throw new Error(tooHeavyMessage(file.name));
      throw error;
    } finally {
      if (this.revitReading === reading) this.revitReading = null;
    }
    const { report } = result;
    const { text, warning } = describeRevitReport(report);
    this.conversionTitle.textContent = 'Fichier Revit lu';
    // Ce que l'ouverture a masqué est dit à la suite du compte rendu ; la phrase n'est pas un avertissement.
    this.conversionText.textContent = [text, this.openingHiddenSentence(true)].filter(Boolean).join(' ');
    this.conversionText.classList.toggle('warning', warning);
    this.conversionEl.hidden = false;
    this.syncDownloads();
    // Comme pour un glTF : un JSON illisible n'empêche pas le modèle, mais l'utilisateur doit le savoir.
    if (metadataError) this.toast(`JSON non pris en compte, seules les propriétés du fichier Revit sont affichées. ${metadataError}`, true);
  }

  /** Les métadonnées courantes (fichier JSON, `extras` du modèle et modifications réunis), au format du contrat. */
  exportMetadata(): string {
    const model = this.model;
    if (!model) return '';
    const out = this.store.export(model.keys) as Record<string, unknown>;
    if (this.georeference) out.georeference = georeferenceToJson(this.georeference);
    // Phases et vues enregistrées : le fichier d'origine les donne, le JSON exporté les garde.
    if (this.metadata?.phases) out.phases = phasesToJson(this.metadata.phases);
    if (this.metadata?.views) out.views = viewsToJson(this.metadata.views);
    return JSON.stringify(out);
  }

  setGeoreference(georeference: Georeference | null): void {
    this.georeference = georeference;
    this.emit('georeference');
  }

  /**
   * Télécharge le fichier 3D issu de la conversion, ou les métadonnées. Le JSON reflète toujours
   * les modifications faites dans le viewer ; un paquet USD est reconstruit pour les contenir.
   */
  private async download(kind: 'model' | 'json' | 'quicklook'): Promise<void> {
    const model = this.model;
    if (!model) return;
    const revision = this.quickLookRevision;
    const conversion = this.conversion;
    const name = conversion?.name ?? this.fileName.replace(/\.[^.]+$/, '');
    let blob: Blob;
    let extension: string;
    if (kind === 'json') {
      blob = new Blob([this.exportMetadata()], { type: 'application/json' });
      extension = 'json';
    } else {
      this.busy('Écriture des métadonnées du modèle…');
      try {
        await nextFrame();
        if (model !== this.model) return;
        const properties = new Map(model.keys.map((id, i) => [id, unflattenProperties(this.store.propsOf(i) ?? {})]));
        const labels = new Map(model.keys.flatMap((id, i) => { const label = this.store.labelOf(i); return label ? [[id, label] as const] : []; }));
        const metadata = this.exportMetadata();
        const source = this.originalGlb instanceof Blob ? await this.originalGlb.arrayBuffer() : this.originalGlb;
        const glb = updateGlbMetadata(source ?? writeGlb(model, 'viewer-bim', { properties }), properties, this.store.readOnly, {
          nodeKeys: source && this.originalNodeKeys.size ? this.originalNodeKeys : undefined, labels,
        });
        if (this.format === 'usd' || kind === 'quicklook') {
          const usdz = await packageUsd(glb, metadata, (message) => this.busy(message));
          blob = new Blob([usdz], { type: 'model/vnd.usdz+zip' }); extension = 'usdz';
        } else {
          blob = new Blob([glb], { type: 'model/gltf-binary' }); extension = 'glb';
        }
      } catch (error) {
        this.toast(isOutOfMemory(error) ? 'Pas assez de mémoire pour exporter ce modèle.' : `Export impossible : ${error instanceof Error ? error.message : String(error)}`, true);
        return;
      } finally { this.busy(null); }
    }
    // setQuickLook advances its revision; remember whether this export was current first.
    const currentExport = model === this.model && revision === this.quickLookRevision;
    // Une conversion en cours ne doit pas créer un lien vers une ancienne version du modèle.
    if (currentExport && extension === 'usdz') {
      this.setQuickLook(blob);
    }
    if (kind === 'quicklook') {
      if (model === this.model && this.quickLookUrl) {
        if (this.applePreview.mode === 'model') this.applePreview.show(this.quickLookUrl, this.fileName);
        else {
          // Quick Look mobile demande une vraie activation utilisateur après la conversion asynchrone.
          this.toast('Le modèle est prêt. Cliquez de nouveau sur « Voir sur Apple » pour l’ouvrir.');
        }
      }
      return;
    }
    const link = h('a', { attrs: { href: URL.createObjectURL(blob), download: `${name}.${extension}` } });
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    if (currentExport) { this.propertyEdits?.markSaved(); this.emit('history'); }
  }

  /** Le lien reste valide pendant toute la consultation native, jusqu'au prochain changement. */
  private setQuickLook(blob: Blob | null): void {
    this.applePreview.close();
    this.quickLookRevision++;
    if (this.quickLookUrl) URL.revokeObjectURL(this.quickLookUrl);
    this.quickLookUrl = blob ? URL.createObjectURL(blob) : null;
    this.quickLookLink.href = this.applePreview.mode === 'quick-look' ? (this.quickLookUrl ?? '#') : '#';
  }

  private async prepareQuickLook(): Promise<void> {
    this.quickLookPreparing = true;
    this.quickLookLink.setAttribute('aria-busy', 'true');
    try {
      await this.download('quicklook');
    } finally {
      this.quickLookPreparing = false;
      this.quickLookLink.removeAttribute('aria-busy');
    }
  }

  /** Le fichier 3D se télécharge dès qu'un modèle est affiché ; le JSON dès qu'il y a des métadonnées. */
  private syncDownloads(): void {
    const hasMetadata = this.store.matched > 0;
    this.modelDownload.hidden = this.model === null;
    this.modelDownload.textContent = `${this.format === 'usd' ? 'USD' : 'GLB'} ↓`;
    this.modelDownload.title = 'Télécharger le modèle avec ses métadonnées actuelles';
    this.jsonDownload.hidden = !hasMetadata;
    this.downloads.hidden = this.model === null;
  }

  editProperty(indices: readonly number[], path: string, value: PropValue): boolean {
    return this.propertyEdits?.set(indices, path, value) ?? false;
  }
  deleteProperty(indices: readonly number[], path: string): boolean { return this.propertyEdits?.delete(indices, path) ?? false; }
  undoProperties(): void { this.propertyEdits?.undo(); this.emit('selection'); }
  redoProperties(): void { this.propertyEdits?.redo(); this.emit('selection'); }
  revertEdits(): void { this.propertyEdits?.revert(); this.emit('selection'); }
  private afterPropertyEdit(path: string): void {
    this.edits = this.propertyEdits?.count ?? 0; this.lastEdit = { path };
    this.setQuickLook(null); this.syncDownloads(); this.updateStats();
    // Une phase de création modifiée change l'état de l'élément dans la phase choisie.
    if (this.phaseSelection) { this.applyPhase(this.phaseSelection); this.syncLayerVisibility(); this.emit('phase'); }
    this.refreshAppearance(); this.emit('metadata'); this.emit('history');
  }
  private confirmReplace(): boolean {
    return !this.propertyEdits?.changed || window.confirm('Des propriétés ont été modifiées. Les exporter avant de remplacer le modèle permet de les conserver. Remplacer le modèle ?');
  }

  async loadSample(name: string): Promise<void> {
    const raw = RAW_SAMPLES.get(name);
    if (raw) {
      // Les exemples IFC et Revit passent par le vrai convertisseur ou lecteur, comme un fichier déposé.
      let blob: Blob;
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}samples/${raw}`);
        if (!response.ok) throw new Error(`erreur ${response.status}`);
        blob = await response.blob();
      } catch (error) {
        this.toast(`Impossible de charger l’exemple : ${error instanceof Error ? error.message : String(error)}.`, true);
        return;
      }
      await this.loadFiles([{ file: new File([blob], raw), path: raw }]);
      return;
    }
    if (!this.confirmReplace()) return;
    const ticket = this.beginLoad('Chargement de l’exemple…');
    try {
      const base = `${import.meta.env.BASE_URL}samples/${name}`;
      const [gltf, text, glb] = await Promise.all([loadModelUrl(`${base}.glb`), fetch(`${base}.json`).then((r) => r.text()), fetch(`${base}.glb`).then((r) => r.blob())]);
      if (await this.installModel(ticket, gltf, [this.readMetadata(text, `${name}.json`)], `${name}.glb`)) {
        this.originalGlb = glb;
        this.announceOpeningHidden();
      }
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
    this.revitReading?.controller.abort();
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
  setFormat(format: ModelFormat): void {
    this.format = format;
    try {
      localStorage.setItem('viewer-bim.format', format);
    } catch {
      // stockage indisponible : le choix vaut pour la session
    }
    this.syncFormat();
    this.syncDownloads();
  }

  private syncFormat(): void {
    for (const [format, element] of this.formatButtons) element.setAttribute('aria-pressed', String(format === this.format));
  }

  /**
   * Remet l'application dans l'état « aucun modèle » (sélection, isolement, règles, phase, vue, métadonnées…) et rend
   * le modèle qu'elle affichait, à libérer par l'appelant. Les panneaux ne sont pas prévenus : l'appelant le fait
   * une fois le nouvel état en place.
   */
  private detachModel(): Model | null {
    const previous = this.model;
    this.measure.clear();
    this.selection.clear();
    this.isolation = null;
    this.masked.clear();
    this.conversion = null;
    this.conversionEl.hidden = true;
    this.model = null;
    this.originalGlb = null;
    this.originalNodeKeys = new Map();
    this.appearanceRules = [];
    this.groupingPaths = [];
    this.phaseSelection = null;
    this.phaseEvaluation = null;
    this.activeView = null;
    this.viewHidden = null;
    this.openingHidden = null;
    this.layerHidden = null;
    this.cameraBeforeViews = null;
    this.keyIndex = null;
    this.metadata = null;
    this.georeference = null;
    this.fileName = '';
    return previous;
  }

  /**
   * Un modèle en cours de lecture (Revit, par morceaux) prend la place du précédent dans la vue dès son premier
   * morceau. L'interface, elle, attend la fin de la lecture : d'ici là, elle est dans l'état « aucun modèle » (rien
   * à sélectionner ni à filtrer, pas de fiche ; la carte n'a pas de maquette), et la vue seule grandit.
   */
  private showLoadingModel(model: Model): void {
    const previous = this.detachModel();
    this.viewer.setModel(model);
    this.emptyEl.hidden = true;
    if (!previous) return;
    previous.dispose();
    this.store = new PropertyStore(0);
    this.propertyEdits = null;
    this.edits = 0;
    this.matched = 0;
    this.setQuickLook(null);
    this.syncDownloads();
    this.updateStats();
    this.emit('model');
    this.emit('selection');
    this.emit('visibility');
  }

  /** Installe un modèle : construit d'une scène ou d'un modèle brut, ou déjà construit (lecture Revit par morceaux). */
  private async installModel(ticket: number, gltf: GLTF | ModelSource | RawInput | Model, candidates: Metadata[], name: string): Promise<boolean> {
    if (ticket !== this.loadTicket) return false;
    const embeddedReadOnly = 'parser' in gltf ? gltf.parser.json.extras?.readOnly : undefined;
    let model: Model;
    const nodeKeys = new Map<number, string>();
    if (gltf instanceof Model) {
      model = gltf;
    } else {
      this.busy('Optimisation de la géométrie…');
      await nextFrame();
      if (ticket !== this.loadTicket) return false;
      try {
        // Un modèle brut (Revit) n'a ni nœuds glTF ni scène : il va tel quel à buildModel.
        const source: ModelSource | RawInput = 'parser' in gltf ? { ...gltfSource(gltf), onElement: (object, key) => {
          const node = gltf.parser.associations.get(object)?.nodes;
          if (node !== undefined) nodeKeys.set(node, key);
        } } : gltf;
        model = buildModel(source, this.viewer.selectColor);
      } catch (error) {
        // Un modèle très lourd peut épuiser la mémoire pendant la fusion de sa géométrie.
        if (isOutOfMemory(error)) throw new Error(tooHeavyMessage(name));
        throw error;
      }
    }

    const previous = this.detachModel();
    this.model = model;
    this.originalNodeKeys = nodeKeys;
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
    this.georeference = metadata?.georeference ?? null;
    this.fileName = name;
    // Le modèle lu par morceaux est déjà dans la vue : le remettre cadre la caméra sur le modèle entier.
    this.viewer.setModel(model);
    if (previous && previous !== model) previous.dispose();

    this.emptyEl.hidden = true;
    this.rebuildStore();
    // À l'ouverture, ce que toutes les vues enregistrées masquent l'est aussi ici (Revit ne le montre dans aucune vue 3D) :
    // la couche des vues s'en charge, l'arbre, le cadrage, les clics et la carte le voient. `'visibility'` est émis plus bas.
    this.openingHidden = hiddenInEveryView(this.savedViews, model.count, this.indexOfKey(), (index, property) => ownValue(this.store.propsOf(index), property));
    if (this.openingHidden) {
      this.viewHidden = this.openingHidden;
      this.refreshLayers();
    }
    if (Array.isArray(embeddedReadOnly)) this.store.readOnly = [...new Set([...this.store.readOnly, ...embeddedReadOnly.filter((p): p is string => typeof p === 'string')])];
    this.emit('selection');
    this.emit('visibility');
    if (metadata) this.reportMatching();
    return true;
  }

  /** Associe à chaque élément ses propriétés : les `extras` du nœud glTF, complétés par le JSON. */
  private rebuildStore(): void {
    const model = this.model;
    if (!model) return;
    this.setQuickLook(null);
    const store = new PropertyStore(model.count);
    for (let i = 0; i < model.count; i++) {
      const entry = this.metadata?.elements.get(model.keys[i]);
      const extras = model.extras[i];
      const props = entry && this.metadata?.propertiesMode === 'replace' ? entry.props : mergeProperties(extras ? flattenProperties(extras) : undefined, entry?.props);
      if (props) store.set(i, props, entry?.label);
    }
    store.finalize();
    // Le fichier dit ce qui est verrouillé ; à défaut, des métadonnées issues d'un IFC (par un
    // convertisseur plus ancien) gardent les verrous habituels.
    store.readOnly = this.metadata?.readOnly ?? (store.paths.includes('Classe IFC') ? [...IFC_READ_ONLY] : []);
    this.store = store;
    this.propertyEdits = new PropertyEdits(store, (path) => this.afterPropertyEdit(path));
    this.edits = 0;
    this.matched = store.matched;
    this.syncDownloads();
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

  /** Le nombre d'éléments que l'ouverture a masqués (voir `openingHidden`). */
  private openingHiddenCount(): number {
    let count = 0;
    for (const flag of this.openingHidden ?? []) count += flag;
    return count;
  }

  /**
   * La phrase qui dit ce que l'ouverture a masqué (vide s'il n'y a rien) : « Tout afficher » le montre. `revit` : les vues
   * sont celles du fichier Revit lui-même ; sinon, celles de son JSON.
   */
  private openingHiddenSentence(revit: boolean): string {
    const count = this.openingHiddenCount();
    if (count === 0) return '';
    const views = revit ? 'les vues 3D du fichier Revit' : 'les vues enregistrées du fichier';
    return `${counted(count, 'élément')} ${count < 2 ? 'masqué' : 'masqués'} à l’ouverture, comme dans ${views} : « Tout afficher » ${count < 2 ? 'le montre' : 'les montre'}.`;
  }

  /** Dit ce que l'ouverture a masqué dans un message, sans remplacer un message d'erreur déjà affiché (hors Revit : voir `loadRevit`). */
  private announceOpeningHidden(): void {
    const sentence = this.openingHiddenSentence(false);
    if (sentence && !(!this.toastEl.hidden && this.toastEl.classList.contains('error'))) this.toast(sentence);
  }

  private reportMatching(): void {
    const model = this.model;
    const metadata = this.metadata;
    if (!model || !metadata) return;
    const matched = this.countMatches(metadata);
    if (matched === 0) {
      this.toast(NO_MATCH, true);
    } else if (matched < model.count) {
      this.toast(`Métadonnées associées à ${counted(matched, 'élément')} sur ${integer.format(model.count)}.`);
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
      counted(model.count, 'élément'),
      counted(model.triangleCount, 'triangle'),
      counted(model.chunks.length, 'lot'),
    ];
    parts.push(
      this.metadata
        ? `métadonnées : ${this.metadata.source ?? 'JSON'} (${integer.format(this.matched)} sur ${integer.format(model.count)})`
        : 'sans fichier de métadonnées',
    );
    if (hidden > 0) parts.push(`${integer.format(hidden)} masqué${hidden > 1 ? 's' : ''}`);
    if (this.edits > 0) parts.push(`${integer.format(this.edits)} valeur${this.edits > 1 ? 's' : ''} modifiée${this.edits > 1 ? 's' : ''}`);
    // Fluidité mesurée pendant le dernier mouvement de caméra : utile pour comparer des machines.
    const { frameTime, motionScale } = this.viewer.adaptive;
    if (frameTime > 0) {
      parts.push(`${Math.round(1000 / frameTime)} img/s`);
      if (motionScale < 1) parts.push(`résolution réduite à ${Math.round(motionScale * 100)} % en mouvement`);
    }
    this.stats.textContent = parts.join(' · ');
  }

  private bindPointer(): void {
    // Les gestes sont écoutés sur la zone de vue : en mode carte, c'est le canvas du globe (dessous)
    // qui les reçoit, et ils remontent ici. Les cartes flottantes et leurs boutons sont ignorés.
    const canvas = this.viewport;
    const onCanvas = (event: Event) => event.target instanceof HTMLCanvasElement;
    let down: { x: number; y: number; button: number } | null = null;
    let hoverX = 0;
    let hoverY = 0;
    let hoverQueued = false;

    // Avec deux doigts (zoom ou déplacement tactile), aucun des deux contacts n'est un clic.
    const active = new Set<number>();
    const release = (event: PointerEvent) => active.delete(event.pointerId);
    canvas.addEventListener('pointerdown', (event) => {
      if (!onCanvas(event)) return;
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
      if (!onCanvas(event) || !isPointMeasure(this.tool) || event.buttons !== 0) return;
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
      if (!onCanvas(event) || isPointMeasure(this.tool) || this.viewer.sectionHandles.blocksPicking) return;
      const hit = this.viewer.pick(event.clientX, event.clientY);
      if (hit) this.fitTo([hit.element]);
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private handleClick(event: PointerEvent): void {
    if (!this.model || this.viewer.sectionHandles.blocksPicking) return;
    if (this.tool === 'section') {
      this.placeSection(event);
    } else if (!isPointMeasure(this.tool)) {
      // Sélection, et outil Cotes : un clic choisit l'élément, Ctrl/Cmd/Maj l'ajoute.
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
      // Native dialogs own Escape and their controls; shortcuts must not affect the model behind them.
      if (target?.closest('dialog[open]')) return;
      // Les raccourcis ne se taisent que pendant une saisie de texte ; un curseur ou une case à
      // cocher qui a gardé le focus ne doit pas les bloquer.
      const typing =
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && !/^(checkbox|radio|range|color|button|file)$/.test(target.type)) ||
        target?.isContentEditable === true;
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); if (event.shiftKey) this.redoProperties(); else this.undoProperties(); return;
      }
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
          this.toggleMask();
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
