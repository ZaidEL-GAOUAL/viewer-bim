// Le globe sous la maquette : CesiumJS dessine la Terre, l'imagerie et le relief dans un canvas
// placé derrière le nôtre ; notre moteur garde la maquette, les coupes, les mesures et tout le
// reste, avec une caméra copiée sur celle du globe à chaque image. Cesium n'est chargé (plusieurs
// mégaoctets) qu'à la première ouverture de la carte.

import { Box3, Sphere, Vector3 } from 'three';
import type { Viewer } from '../engine/Viewer.ts';
import { enuToLocal, enuVectorToLocal, localToEnu, type Georeference } from './georeference.ts';

type Cesium = typeof import('cesium');

export type ImageryKind = 'osm' | 'ign-ortho' | 'ign-plan';

export const IMAGERY: { id: ImageryKind; label: string; hint: string }[] = [
  { id: 'osm', label: 'Plan (OpenStreetMap)', hint: 'Monde entier, gratuit. © les contributeurs d’OpenStreetMap.' },
  { id: 'ign-ortho', label: 'Photo aérienne (IGN)', hint: 'France, gratuit. © IGN, Géoplateforme.' },
  { id: 'ign-plan', label: 'Plan IGN', hint: 'France, gratuit. © IGN, Géoplateforme.' },
];

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
    // Le canvas prend la taille de son hôte, puis une première image est demandée.
    globe.resize();
    globe.scene.requestRender();
  }

  close(): void {
    const globe = this.globe;
    if (!globe) return;
    globe.scene.postRender.removeEventListener(this.sync);
    globe.canvas.removeEventListener('click', this.onClick);
    globe.destroy();
    this.globe = null;
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
      return new cesium.ImageryLayer(new cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/', credit: '© les contributeurs d’OpenStreetMap' }));
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
