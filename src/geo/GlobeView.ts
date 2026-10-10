// Le globe sous la maquette : CesiumJS dessine la Terre, l'imagerie, le relief et — dès qu'elle
// est posée — la maquette elle-même (voir GlobeModel), dans un canvas placé derrière le nôtre ;
// notre moteur garde les coupes, les mesures, les poignées et l'état des éléments, avec une
// caméra copiée sur celle du globe à chaque image. Cesium n'est chargé (plusieurs mégaoctets)
// qu'à la première ouverture de la carte.

import { Box3, Sphere, Vector3 } from 'three';
import type { Model } from '../engine/Model.ts';
import type { Viewer } from '../engine/Viewer.ts';
import { enuToLocal, enuVectorToLocal, localToEnu, type Georeference } from './georeference.ts';
import { GlobeModel, type GlobeModelStatus } from './GlobeModel.ts';
import { fetchOsmBuildings, outlineCentre, type OsmBuilding } from './osmBuildings.ts';
import { createTerrariumTerrainProvider } from './terrain.ts';

type Cesium = typeof import('cesium');

export type ImageryKind = 'osm' | 'ign-ortho' | 'ign-plan';

export const IMAGERY: { id: ImageryKind; label: string; hint: string }[] = [
  { id: 'osm', label: 'Plan (OpenStreetMap)', hint: 'Monde entier, gratuit. © les contributeurs d’OpenStreetMap.' },
  { id: 'ign-ortho', label: 'Photo aérienne (IGN)', hint: 'France, gratuit. © IGN, Géoplateforme.' },
  { id: 'ign-plan', label: 'Plan IGN', hint: 'France, gratuit. © IGN, Géoplateforme.' },
];

export type TerrainKind = 'flat' | 'terrarium' | 'ion';

export const TERRAINS: { id: TerrainKind; label: string; hint: string; needsIon?: boolean }[] = [
  { id: 'flat', label: 'Aucun (Terre lisse)', hint: 'Le globe sans relief.' },
  { id: 'terrarium', label: 'Relief mondial (Terrain Tiles)', hint: 'Gratuit, sans clé. AWS Open Data / Mapzen : SRTM, ASTER, EU-DEM… ~30 m.' },
  { id: 'ion', label: 'Cesium World Terrain (clé ion)', hint: 'Relief détaillé de Cesium ion ; demande un jeton ion (compte gratuit).', needsIon: true },
];

export type OsmStatus = 'off' | 'loading' | 'on' | 'error';

/** Niveau de tuile lu pour la hauteur du sol sur le relief gratuit (son plus fin). */
const TERRARIUM_SAMPLE_LEVEL = 15;
/** Rayon, en mètres, du quartier dont on lit les bâtiments autour de la maquette. */
const OSM_RADIUS = 400;
const BUILDING_CSS_COLOR = '#e6e1d8';

const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={layer}&STYLE={style}&TILEMATRIXSET=PM&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}&FORMAT={format}';

let cesiumPromise: Promise<Cesium> | null = null;

/** Charge Cesium une seule fois ; ses fichiers d'exécution sont servis sous `cesium/` (voir vite.config.ts). */
export function loadCesium(): Promise<Cesium> {
  if (!cesiumPromise) {
    (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = new URL(`${import.meta.env.BASE_URL}cesium/`, document.baseURI).href;
    cesiumPromise = Promise.all([import('cesium'), import('cesium/Build/Cesium/Widgets/widgets.css')]).then(([module]) => module);
  }
  return cesiumPromise;
}

export class GlobeView {
  private readonly host: HTMLElement;
  private readonly viewer: Viewer;
  private cesium: Cesium | null = null;
  private globe: import('cesium').Viewer | null = null;
  private imagery: ImageryKind = 'osm';
  private georeference: Georeference | null = null;
  private offset = new Vector3();
  private enuToEcef: import('cesium').Matrix4 | null = null;
  private ecefToEnu: import('cesium').Matrix4 | null = null;
  private pickHandler: ((position: { latitude: number; longitude: number }) => void) | null = null;
  private model: Model | null = null;
  private globeModel: GlobeModel | null = null;
  private terrain: TerrainKind = 'flat';
  private ionToken = '';
  private googleKey = '';
  private osmSource: import('cesium').CustomDataSource | null = null;
  private osmWanted = false;
  private osmLoaded = '';
  private osmAbort: AbortController | null = null;
  private osmCount = 0;
  private osmCredited = false;
  private ionBuildings: import('cesium').Cesium3DTileset | null = null;
  private googleTiles: import('cesium').Cesium3DTileset | null = null;
  private ionBuildingsWanted = false;
  private googleWanted = false;
  osmStatus: OsmStatus = 'off';
  /** Prévenu quand quelque chose change côté globe (maquette envoyée, relief, bâtiments) : l'interface se redessine. */
  onStatus: () => void = () => {};
  /** Message pour l'utilisateur (échec d'un service, clé manquante). */
  onNotice: (message: string, warning?: boolean) => void = () => {};
  private syncing = false;
  /** Dernière caméra copiée : une image du globe sans mouvement ne redessine pas la maquette. */
  private lastCamera = new Float64Array(9);
  private cameraKnown = false;

  constructor(host: HTMLElement, viewer: Viewer) {
    this.host = host;
    this.viewer = viewer;
  }

  get active(): boolean {
    return this.globe !== null;
  }

  get imageryKind(): ImageryKind {
    return this.imagery;
  }

  /** État de la maquette côté globe ; null tant qu'elle n'est pas posée (pas de position). */
  get modelStatus(): GlobeModelStatus | null {
    return this.globeModel?.status ?? null;
  }

  get modelError(): string {
    return this.globeModel?.error ?? '';
  }

  get terrainKind(): TerrainKind {
    return this.terrain;
  }

  get keys(): { ion: string; google: string } {
    return { ion: this.ionToken, google: this.googleKey };
  }

  get osmBuildingsShown(): boolean {
    return this.osmWanted;
  }

  get osmBuildingsCount(): number {
    return this.osmCount;
  }

  get ionBuildingsShown(): boolean {
    return this.ionBuildingsWanted;
  }

  get googleTilesShown(): boolean {
    return this.googleWanted;
  }

  async open(): Promise<void> {
    if (this.globe) return;
    const cesium = await loadCesium();
    if (this.globe) return;
    this.cesium = cesium;
    const { Viewer: CesiumViewer } = cesium;
    const globe = new CesiumViewer(this.host, {
      baseLayer: this.layerFor(this.imagery),
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      msaaSamples: 4,
    });
    globe.scene.globe.depthTestAgainstTerrain = false;
    globe.scene.postRender.addEventListener(this.sync);
    globe.scene.screenSpaceCameraController.enableCollisionDetection = true;
    globe.scene.screenSpaceCameraController.minimumZoomDistance = 2;
    globe.canvas.addEventListener('click', this.onClick);
    this.globe = globe;
    this.viewer.setExternalCamera(true);
    this.viewer.onExternalFit = (box) => this.flyTo(box, 0.8);
    this.updateFrame();
    this.applyKeys();
    this.applyTerrain();
    // Les couches demandées avant une fermeture de la carte sont recréées.
    if (this.ionBuildingsWanted) void this.setIonBuildings(true);
    if (this.googleWanted) void this.setGoogleTiles(true);
    // Le canvas prend la taille de son hôte, puis une première image est demandée.
    globe.resize();
    globe.scene.requestRender();
  }

  close(): void {
    const globe = this.globe;
    if (!globe) return;
    this.globeModel?.dispose();
    this.globeModel = null;
    this.osmAbort?.abort();
    this.osmAbort = null;
    globe.scene.postRender.removeEventListener(this.sync);
    globe.canvas.removeEventListener('click', this.onClick);
    // Détruit aussi la source des bâtiments et les tuiles 3D ajoutées à la scène.
    globe.destroy();
    this.globe = null;
    this.osmSource = null;
    this.osmLoaded = '';
    this.osmCount = 0;
    this.osmCredited = false;
    this.osmStatus = this.osmWanted ? 'off' : this.osmStatus;
    this.ionBuildings = null;
    this.googleTiles = null;
    this.enuToEcef = this.ecefToEnu = null;
    this.viewer.onExternalFit = null;
    this.viewer.setExternalCamera(false);
  }

  setImagery(kind: ImageryKind): void {
    this.imagery = kind;
    const globe = this.globe;
    if (!globe) return;
    globe.imageryLayers.removeAll();
    globe.imageryLayers.add(this.layerFor(kind));
    globe.scene.requestRender();
  }

  /** Nouvelle position de la maquette (ou nouveau modèle) : la caméra reste où elle est. */
  setPlacement(georeference: Georeference | null, offset: Vector3): void {
    this.georeference = georeference;
    this.offset.copy(offset);
    this.updateFrame();
    this.cameraKnown = false;
    this.sync();
    this.refreshModel();
    if (this.osmWanted) void this.loadOsmBuildings();
  }

  /** Relief du globe : aucun, les tuiles gratuites, ou Cesium World Terrain (clé ion). */
  setTerrain(kind: TerrainKind): void {
    this.terrain = kind;
    this.applyTerrain();
    this.onStatus();
  }

  /** Jetons facultatifs (Cesium ion, Google) : gardés en mémoire ici, jamais dans les fichiers. */
  setKeys(ion: string, google: string): void {
    this.ionToken = ion.trim();
    this.googleKey = google.trim();
    this.applyKeys();
    if (this.terrain === 'ion' && !this.ionToken) this.terrain = 'flat';
    this.applyTerrain();
    this.onStatus();
  }

  private applyKeys(): void {
    const cesium = this.cesium;
    if (!cesium) return;
    if (this.ionToken) cesium.Ion.defaultAccessToken = this.ionToken;
    if (this.googleKey) cesium.GoogleMaps.defaultApiKey = this.googleKey;
  }

  private applyTerrain(): void {
    const cesium = this.cesium, globe = this.globe;
    if (!cesium || !globe) return;
    const { scene } = globe;
    if (this.terrain === 'ion') {
      if (!this.ionToken) {
        this.onNotice('Cesium World Terrain demande un jeton Cesium ion (voir « Clés »).', true);
        this.terrain = 'flat';
      } else {
        const terrain = cesium.Terrain.fromWorldTerrain();
        terrain.errorEvent.addEventListener((error) => {
          this.onNotice(`Relief Cesium ion indisponible : ${error instanceof Error ? error.message : String(error)}`, true);
          this.terrain = 'flat';
          this.applyTerrain();
          this.onStatus();
        });
        scene.setTerrain(terrain);
        scene.requestRender();
        return;
      }
    }
    scene.terrainProvider = this.terrain === 'terrarium' ? createTerrariumTerrainProvider(cesium) : new cesium.EllipsoidTerrainProvider();
    scene.requestRender();
  }

  /** Hauteur du sol (relief ou tuiles 3D) à la position de la maquette ; 0 sans relief, null si inconnue. */
  async groundHeight(): Promise<number | null> {
    const cesium = this.cesium, globe = this.globe, g = this.georeference;
    if (!cesium || !globe || !g) return null;
    const position = cesium.Cartographic.fromDegrees(g.longitude, g.latitude);
    try {
      if (this.googleTiles?.show) {
        const [hit] = await globe.scene.sampleHeightMostDetailed([position]);
        return hit ? hit.height : null;
      }
      if (this.terrain === 'flat') return 0;
      const provider = globe.scene.terrainProvider;
      // Le relief gratuit n'annonce pas la disponibilité de ses tuiles : on lit son niveau le plus fin.
      const [sampled] = provider.availability
        ? await cesium.sampleTerrainMostDetailed(provider, [position])
        : await cesium.sampleTerrain(provider, TERRARIUM_SAMPLE_LEVEL, [position]);
      return Number.isFinite(sampled?.height) ? sampled.height : null;
    } catch (error) {
      this.onNotice(`Hauteur du sol inconnue : ${error instanceof Error ? error.message : String(error)}`, true);
      return null;
    }
  }

  /** Bâtiments du quartier lus dans OpenStreetMap (Overpass), extrudés sur le relief. */
  setOsmBuildings(shown: boolean): void {
    this.osmWanted = shown;
    if (!shown) {
      this.osmAbort?.abort();
      this.osmAbort = null;
      if (this.osmSource) this.osmSource.show = false;
      this.osmStatus = 'off';
      this.globe?.scene.requestRender();
      this.onStatus();
      return;
    }
    if (this.osmSource) this.osmSource.show = true;
    void this.loadOsmBuildings();
  }

  private osmBbox(): { south: number; west: number; north: number; east: number } | null {
    const g = this.georeference;
    if (!g) return null;
    const dLat = OSM_RADIUS / 111320;
    const dLon = OSM_RADIUS / (111320 * Math.max(0.05, Math.cos((g.latitude * Math.PI) / 180)));
    return { south: g.latitude - dLat, west: g.longitude - dLon, north: g.latitude + dLat, east: g.longitude + dLon };
  }

  private async loadOsmBuildings(): Promise<void> {
    const cesium = this.cesium, globe = this.globe, bbox = this.osmBbox();
    if (!cesium || !globe || !bbox) return;
    const key = [bbox.south, bbox.west].map((v) => v.toFixed(3)).join(',');
    if (key === this.osmLoaded && this.osmStatus === 'on') {
      this.onStatus();
      return;
    }
    this.osmAbort?.abort();
    const controller = new AbortController();
    this.osmAbort = controller;
    this.osmStatus = 'loading';
    this.onStatus();
    let buildings: OsmBuilding[];
    try {
      buildings = await fetchOsmBuildings(bbox, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.osmStatus = 'error';
      this.onNotice(`Bâtiments OpenStreetMap indisponibles : ${error instanceof Error ? error.message : String(error)}`, true);
      this.onStatus();
      return;
    }
    if (controller.signal.aborted || !this.globe) return;
    if (!this.osmSource) {
      this.osmSource = new cesium.CustomDataSource('Bâtiments OpenStreetMap');
      await globe.dataSources.add(this.osmSource);
    }
    const { entities } = this.osmSource;
    entities.suspendEvents();
    entities.removeAll();
    const footprint = this.footprintEnu();
    const material = cesium.Color.fromCssColorString(BUILDING_CSS_COLOR);
    let count = 0;
    for (const building of buildings) {
      if (footprint && this.inFootprint(outlineCentre(building.outline), footprint)) continue;
      entities.add({
        polygon: {
          hierarchy: new cesium.PolygonHierarchy(cesium.Cartesian3.fromDegreesArray(building.outline.flat())),
          extrudedHeight: building.height,
          heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
          extrudedHeightReference: cesium.HeightReference.RELATIVE_TO_GROUND,
          material,
          outline: false,
        },
      });
      count++;
    }
    entities.resumeEvents();
    this.osmSource.show = this.osmWanted;
    if (!this.osmCredited) {
      globe.creditDisplay.addStaticCredit(new cesium.Credit('Bâtiments : © les contributeurs d’OpenStreetMap (Overpass)'));
      this.osmCredited = true;
    }
    this.osmLoaded = key;
    this.osmCount = count;
    this.osmStatus = 'on';
    globe.scene.requestRender();
    this.onStatus();
  }

  /** Emprise de la maquette en est-nord (m), élargie d'un mètre : les bâtiments OSM qui y tombent sont ceux qu'elle remplace. */
  private footprintEnu(): { minE: number; maxE: number; minN: number; maxN: number } | null {
    const g = this.georeference, model = this.model;
    if (!g || !model || model.box.isEmpty()) return null;
    const offset = this.offset.toArray();
    const { min, max } = model.box;
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const [e, n] = localToEnu([x, y, z], offset, g);
      minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    return { minE: minE - 1, maxE: maxE + 1, minN: minN - 1, maxN: maxN + 1 };
  }

  private inFootprint([longitude, latitude]: [number, number], footprint: { minE: number; maxE: number; minN: number; maxN: number }): boolean {
    const cesium = this.cesium, m = this.ecefToEnu;
    if (!cesium || !m) return false;
    const enu = cesium.Matrix4.multiplyByPoint(m, cesium.Cartesian3.fromDegrees(longitude, latitude), new cesium.Cartesian3());
    return enu.x >= footprint.minE && enu.x <= footprint.maxE && enu.y >= footprint.minN && enu.y <= footprint.maxN;
  }

  /** Cesium OSM Buildings (tuiles 3D de Cesium ion, clé nécessaire). */
  async setIonBuildings(shown: boolean): Promise<void> {
    this.ionBuildingsWanted = shown;
    const cesium = this.cesium, globe = this.globe;
    if (!cesium || !globe) return;
    if (this.ionBuildings) {
      this.ionBuildings.show = shown;
      globe.scene.requestRender();
      this.onStatus();
      return;
    }
    if (!shown) return;
    if (!this.ionToken) {
      this.ionBuildingsWanted = false;
      this.onNotice('Cesium OSM Buildings demande un jeton Cesium ion (voir « Clés »).', true);
      this.onStatus();
      return;
    }
    try {
      const tileset = await cesium.createOsmBuildingsAsync();
      if (!this.globe) { tileset.destroy(); return; }
      this.ionBuildings = tileset;
      tileset.show = this.ionBuildingsWanted;
      globe.scene.primitives.add(tileset);
      globe.scene.requestRender();
    } catch (error) {
      this.ionBuildingsWanted = false;
      this.onNotice(`Cesium OSM Buildings indisponible : ${error instanceof Error ? error.message : String(error)}`, true);
    }
    this.onStatus();
  }

  /** Tuiles 3D photoréalistes de Google (clé Google Maps Platform nécessaire) ; le globe se cache dessous. */
  async setGoogleTiles(shown: boolean): Promise<void> {
    this.googleWanted = shown;
    const cesium = this.cesium, globe = this.globe;
    if (!cesium || !globe) return;
    if (this.googleTiles) {
      this.googleTiles.show = shown;
      globe.scene.globe.show = !shown;
      globe.scene.requestRender();
      this.onStatus();
      return;
    }
    if (!shown) return;
    if (!this.googleKey) {
      this.googleWanted = false;
      this.onNotice('Les tuiles 3D de Google demandent une clé Google Maps Platform (voir « Clés »).', true);
      this.onStatus();
      return;
    }
    try {
      const tileset = await cesium.createGooglePhotorealistic3DTileset({ key: this.googleKey });
      if (!this.globe) { tileset.destroy(); return; }
      this.googleTiles = tileset;
      tileset.show = this.googleWanted;
      globe.scene.primitives.add(tileset);
      globe.scene.globe.show = !this.googleWanted;
      globe.scene.requestRender();
    } catch (error) {
      this.googleWanted = false;
      this.onNotice(`Tuiles Google indisponibles : ${error instanceof Error ? error.message : String(error)}`, true);
    }
    this.onStatus();
  }

  /** La maquette que le globe doit dessiner (null : aucune). Elle est envoyée dès qu'elle a une position. */
  setModel(model: Model | null): void {
    if (this.model === model) return;
    this.model = model;
    this.globeModel?.dispose();
    this.globeModel = null;
    this.refreshModel();
  }

  private refreshModel(): void {
    const matrix = this.modelMatrix();
    if (!matrix || !this.model || !this.globe || !this.cesium) {
      if (this.globeModel) {
        this.globeModel.dispose();
        this.globeModel = null;
        this.onStatus();
      }
      return;
    }
    if (this.globeModel) {
      this.globeModel.setModelMatrix(matrix);
      return;
    }
    this.globeModel = new GlobeModel(this.cesium, this.globe.scene, this.viewer, this.model, matrix);
    this.globeModel.onStatus = () => this.onStatus();
    this.onStatus();
  }

  /** Repère du viewer → repère terrestre : la matrice que Cesium applique à la maquette. */
  private modelMatrix(): import('cesium').Matrix4 | null {
    const cesium = this.cesium, g = this.georeference, enuToEcef = this.enuToEcef;
    if (!cesium || !g || !enuToEcef) return null;
    const offset = this.offset.toArray();
    const origin = localToEnu([0, 0, 0], offset, g);
    const [x, y, z] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((axis) => localToEnu(axis, offset, g).map((value, i) => value - origin[i]));
    const localToEnuMatrix = new cesium.Matrix4(
      x[0], y[0], z[0], origin[0],
      x[1], y[1], z[1], origin[1],
      x[2], y[2], z[2], origin[2],
      0, 0, 0, 1,
    );
    return cesium.Matrix4.multiply(enuToEcef, localToEnuMatrix, new cesium.Matrix4());
  }

  /** Au prochain clic sur le globe, la position cliquée est transmise (placement à la souris). */
  pickOnce(handler: ((position: { latitude: number; longitude: number }) => void) | null): void {
    this.pickHandler = handler;
    this.host.classList.toggle('picking', handler !== null);
  }

  /** Vole vers une boîte du repère du viewer ; faux si le globe n'est pas prêt. */
  flyTo(box: Box3 | null, duration = 1.2): boolean {
    const cesium = this.cesium, globe = this.globe;
    if (!cesium || !globe || !this.enuToEcef || !this.georeference || !box || box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new Sphere());
    const [e, n, u] = localToEnu(sphere.center.toArray(), this.offset.toArray(), this.georeference);
    const center = cesium.Matrix4.multiplyByPoint(this.enuToEcef, new cesium.Cartesian3(e, n, u), new cesium.Cartesian3());
    const radius = Math.max(sphere.radius, 1);
    globe.camera.flyToBoundingSphere(new cesium.BoundingSphere(center, radius), {
      duration,
      offset: new cesium.HeadingPitchRange(cesium.Math.toRadians(35), cesium.Math.toRadians(-28), radius * 3.2),
    });
    return true;
  }

  private layerFor(kind: ImageryKind): import('cesium').ImageryLayer {
    const cesium = this.cesium!;
    if (kind === 'osm') {
      // Les tuiles OSM s'arrêtent au niveau 19 : au-delà, le serveur répond une erreur.
      return new cesium.ImageryLayer(new cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', maximumLevel: 19, credit: '© les contributeurs d’OpenStreetMap' }));
    }
    const ortho = kind === 'ign-ortho';
    return new cesium.ImageryLayer(new cesium.WebMapTileServiceImageryProvider({
      url: IGN_WMTS.replace('{layer}', ortho ? 'ORTHOIMAGERY.ORTHOPHOTOS' : 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2').replace('{style}', 'normal').replace('{format}', ortho ? 'image/jpeg' : 'image/png'),
      layer: ortho ? 'ORTHOIMAGERY.ORTHOPHOTOS' : 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',
      style: 'normal',
      format: ortho ? 'image/jpeg' : 'image/png',
      tileMatrixSetID: 'PM',
      maximumLevel: ortho ? 20 : 19,
      credit: '© IGN – Géoplateforme',
    }));
  }

  /** Matrices entre le repère est-nord-haut de l'origine du site et le repère terrestre de Cesium. */
  private updateFrame(): void {
    const cesium = this.cesium;
    const g = this.georeference;
    if (!cesium || !g) {
      this.enuToEcef = this.ecefToEnu = null;
      return;
    }
    const origin = cesium.Cartesian3.fromDegrees(g.longitude, g.latitude, g.elevation);
    this.enuToEcef = cesium.Transforms.eastNorthUpToFixedFrame(origin);
    this.ecefToEnu = cesium.Matrix4.inverseTransformation(this.enuToEcef, new cesium.Matrix4());
  }

  /** Après chaque image du globe : la caméra de notre moteur prend la même place, la maquette se redessine. */
  private readonly sync = (): void => {
    const cesium = this.cesium, globe = this.globe, g = this.georeference, m = this.ecefToEnu;
    if (!cesium || !globe || !g || !m || this.syncing) return;
    this.syncing = true;
    try {
      const camera = globe.camera;
      const p = camera.positionWC, d = camera.directionWC, u = camera.upWC;
      const current = [p.x, p.y, p.z, d.x, d.y, d.z, u.x, u.y, u.z];
      if (this.cameraKnown && current.every((value, i) => value === this.lastCamera[i])) return;
      this.lastCamera.set(current);
      this.cameraKnown = true;
      const position = cesium.Matrix4.multiplyByPoint(m, camera.positionWC, new cesium.Cartesian3());
      const direction = cesium.Matrix4.multiplyByPointAsVector(m, camera.directionWC, new cesium.Cartesian3());
      const up = cesium.Matrix4.multiplyByPointAsVector(m, camera.upWC, new cesium.Cartesian3());
      const offset = this.offset.toArray();
      const local = enuToLocal([position.x, position.y, position.z], offset, g);
      const dir = enuVectorToLocal([direction.x, direction.y, direction.z], g);
      const upLocal = enuVectorToLocal([up.x, up.y, up.z], g);
      const frustum = camera.frustum as import('cesium').PerspectiveFrustum;
      const fov = frustum.fovy !== undefined ? cesium.Math.toDegrees(frustum.fovy) : 45;
      this.viewer.applyCamera(new Vector3(...local), new Vector3(...dir), new Vector3(...upLocal), fov);
    } finally {
      this.syncing = false;
    }
  };

  private readonly onClick = (event: MouseEvent): void => {
    const cesium = this.cesium, globe = this.globe, handler = this.pickHandler;
    if (!cesium || !globe || !handler) return;
    const rect = globe.canvas.getBoundingClientRect();
    const point = new cesium.Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
    const hit = globe.camera.pickEllipsoid(point, globe.scene.globe.ellipsoid);
    if (!hit) return;
    const carto = cesium.Cartographic.fromCartesian(hit);
    this.pickOnce(null);
    handler({ latitude: cesium.Math.toDegrees(carto.latitude), longitude: cesium.Math.toDegrees(carto.longitude) });
  };
}
