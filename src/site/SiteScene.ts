// La vue 3D de l'étude de site : le sol drapé d'imagerie (tuiles d'un fond de carte posées en textures sur le relief),
// voisins, volumes de la proposition, maquettes posées sur le site, limite du terrain, Soleil avec ombres portées
// (three.js, cartes d'ombres), et les points d'une analyse colorés. Dessin à la demande, comme le viewer.
// Repère : x = est, y = haut, z = −nord (mètres, origine du site). Offre aussi ce que l'esquisse (engine/sketch.ts) lit
// d'une vue : renderer, camera, afterRender, toScreen, et pick / model sans maquette BIM.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  FrontSide,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  SRGBColorSpace,
  Scene,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Object3D,
  type Texture,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MERCATOR_MAX_LATITUDE, lonLatToTile, tileToLonLat, type ImagerySource } from '../geo/imageryTiles.ts';
import { groundAt, neighbourBase, toEnu, toGeo } from './context.ts';
import { addPrism, toScene, volumeMesh } from './massing.ts';
import type { ModelSnapshot, Placement } from './placedModel.ts';
import { safeColor, type Proposal, type Study, type XY } from './study.ts';

const NEIGHBOUR_COLOR = new Color('#d9d4cb');
/** Voisins dont la hauteur est supposée (ni mesurée ni renseignée) : teintés pour qu'on les vérifie. */
export const ASSUMED_CSS = '#eba36a';
const ASSUMED_COLOR = new Color(ASSUMED_CSS);
const SELECTED_COLOR = new Color('#1d8bff');
/** Couche des lots transparents d'une maquette (voir engine/buildModel.ts, TRANSPARENT_LAYER). */
const TRANSPARENT_LAYER = 1;
const SUN_INTENSITY = 2.6;
const SKY_INTENSITY = 1.05;
/** Tuiles d'imagerie au plus par sol (au-delà, un zoom de moins). */
const MAX_TILES = 144;
/** Sommets par côté d'une tuile drapée sur le relief. */
const TILE_GRID = 8;

/** Textures des tuiles déjà lues, gardées le temps de la session (la règle des serveurs de tuiles : pas de relecture). */
const tileTextures = new Map<string, Promise<Texture | null>>();
const tileLoader = new TextureLoader();

function tileTexture(url: string, anisotropy: number): Promise<Texture | null> {
  let texture = tileTextures.get(url);
  if (!texture) {
    texture = tileLoader.loadAsync(url).then((t) => {
      t.colorSpace = SRGBColorSpace;
      t.anisotropy = anisotropy;
      return t;
    }, () => null);
    tileTextures.set(url, texture);
  }
  return texture;
}

/** Libère les textures qui ne servent plus quand la réserve devient grande (un long voyage d'un site à l'autre). */
function trimTextures(keep: ReadonlySet<string>): void {
  if (tileTextures.size <= 400) return;
  for (const [url, texture] of tileTextures) {
    if (keep.has(url)) continue;
    tileTextures.delete(url);
    void texture.then((t) => t?.dispose());
  }
}

export class SiteScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 1, 6000);
  readonly controls: OrbitControls;
  readonly afterRender = new Set<() => void>();
  /** Pas de maquette BIM ici : l'esquisse n'accroche qu'aux points qu'elle a posés. */
  readonly model = null;
  private readonly container: HTMLElement;
  // Soleil fort, ciel modéré : les ombres se lisent sur l'imagerie (le ciel seul éclaire une ombre).
  private readonly sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
  private readonly sky = new HemisphereLight(0xffffff, 0x8a8f98, SKY_INTENSITY);
  private ground: Mesh | null = null;
  private neighbours: Mesh | null = null;
  /** Premier sommet de chaque voisin dans le maillage commun (pour retrouver le voisin d'un triangle touché). */
  private neighbourStarts: number[] = [];
  private readonly volumes = new Group();
  private readonly imagery = new Group();
  private readonly models = new Group();
  private readonly modelGroups = new Map<string, Group>();
  private limit: LineLoop | null = null;
  private analysis: Points | null = null;
  private readonly raycaster = new Raycaster();
  private readonly scratch = new Vector3();
  private dirty = true;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    container.append(this.renderer.domElement);
    this.scene.background = new Color(window.matchMedia('(prefers-color-scheme: dark)').matches ? 0x23282e : 0xe7eaee);
    this.camera.position.set(-160, 200, 260);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.addEventListener('change', this.invalidate);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.15;
    this.camera.layers.enable(TRANSPARENT_LAYER);
    this.scene.add(this.sky, this.sun, this.sun.target, this.volumes, this.imagery, this.models);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(this.tick);
  }

  readonly invalidate = (): void => {
    this.dirty = true;
  };

  /** Pas de maquette : rien à toucher pour l'esquisse. */
  pick(): null {
    return null;
  }

  toScreen(point: Vector3, out: { x: number; y: number }): boolean {
    const v = this.scratch.copy(point).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > -this.camera.near) return false;
    v.applyMatrix4(this.camera.projectionMatrix);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (0.5 - v.y * 0.5) * this.height;
    return true;
  }

  private resize(): void {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    this.tick();
  }

  private readonly tick = (): void => {
    this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    for (const callback of this.afterRender) callback();
  };

  /** Cadre la vue sur un disque de `radius` m autour de l'origine. */
  frame(radius: number): void {
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(-0.6 * radius, 0.8 * radius, 1.0 * radius);
    this.controls.update();
    this.invalidate();
  }

  /** Vue du dessus, nord en haut, sur un disque de `radius` m autour de `center` (est, nord). */
  topView(radius: number, center: XY = [0, 0]): void {
    const [x, , z] = toScene(center[0], center[1], 0);
    this.controls.target.set(x, 0, z);
    this.camera.position.set(x, radius / Math.tan((this.camera.fov * Math.PI) / 360), z + 0.01);
    this.controls.update();
    this.invalidate();
  }

  private replace<T extends Object3D>(old: T | null, next: T | null): T | null {
    if (old) {
      this.scene.remove(old);
      old.traverse((object) => {
        const { geometry, material } = object as Mesh;
        geometry?.dispose();
        (Array.isArray(material) ? material : material ? [material] : []).forEach((m) => m.dispose());
      });
    }
    if (next) this.scene.add(next);
    this.invalidate();
    return next;
  }

  /** Relief de l'étude (ou sol plat de la taille du contexte), qui reçoit les ombres. */
  setGround(study: Study): void {
    const grid = study.context.terrain;
    const geometry = new BufferGeometry();
    if (grid) {
      const positions: number[] = [], index: number[] = [];
      for (let row = 0; row < grid.rows; row++) {
        for (let col = 0; col < grid.columns; col++) {
          const e = grid.west + col * grid.step, n = grid.south + row * grid.step;
          positions.push(...toScene(e, n, grid.heights[row * grid.columns + col] - study.site.origin.altitude));
        }
      }
      for (let row = 0; row + 1 < grid.rows; row++) {
        for (let col = 0; col + 1 < grid.columns; col++) {
          const a = row * grid.columns + col, b = a + 1, c = a + grid.columns, d = c + 1;
          index.push(a, b, d, a, d, c);
        }
      }
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
      geometry.setIndex(index);
    } else {
      const r = Math.max(300, study.context.radius);
      geometry.setAttribute('position', new BufferAttribute(new Float32Array([...toScene(-r, -r, 0), ...toScene(r, -r, 0), ...toScene(r, r, 0), ...toScene(-r, r, 0)]), 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
    }
    geometry.computeVertexNormals();
    const mesh = new Mesh(geometry, new MeshLambertMaterial({ color: 0xc9cfc2, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    mesh.receiveShadow = true;
    // Sous l'imagerie, le sol uni descend d'un demi-mètre : il ne la traverse pas là où les deux maillages diffèrent.
    mesh.position.y = this.imagery.children.length > 0 ? -0.5 : 0;
    this.ground = this.replace(this.ground, mesh);
    // La caméra d'ombre couvre tout le contexte, quelle que soit la direction du Soleil (diagonale comprise) :
    // environ 20 cm par texel sur 300 m de rayon.
    const extent = 1.45 * (grid ? Math.max(Math.abs(grid.west), Math.abs(grid.south)) : Math.max(300, study.context.radius));
    Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 4 * extent + 2000 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /**
   * Le sol drapé du fond de carte `source` (null : aucun) autour de l'origine, sur le relief de l'étude. Chaque tuile
   * Web Mercator devient un petit maillage dont les sommets sont placés par leur longitude et latitude ; les tuiles déjà
   * lues pendant la session ne sont pas redemandées. Rien au-delà de 85° de latitude (pas de tuiles).
   */
  setImagery(study: Study, source: ImagerySource | null): void {
    for (const child of [...this.imagery.children]) {
      this.imagery.remove(child);
      (child as Mesh).geometry.dispose();
      ((child as Mesh).material as MeshLambertMaterial).dispose();
    }
    const origin = study.site.origin;
    const shown = source !== null && Math.abs(origin.latitude) < MERCATOR_MAX_LATITUDE - 0.05;
    if (this.ground) this.ground.position.y = shown ? -0.5 : 0;
    this.invalidate();
    if (!shown || !source) return;
    const half = Math.max(350, (study.context.radius || 300) + 50);
    const unwrap = ([lon, lat]: [number, number]): [number, number] => [origin.longitude + ((((lon - origin.longitude + 180) % 360) + 360) % 360) - 180, lat];
    const [west, north] = unwrap(toGeo(origin, -half, half)), [east, south] = unwrap(toGeo(origin, half, -half));
    let z = Math.min(source.maxZoom, half <= 450 ? 18 : 17);
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z > 1; z--) {
      [x0, y0] = lonLatToTile(west, north, z).map(Math.floor);
      [x1, y1] = lonLatToTile(east, south, z).map(Math.floor);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_TILES) break;
    }
    const count = 2 ** z, anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const used = new Set<string>();
    for (let ty = Math.max(0, y0); ty <= Math.min(count - 1, y1); ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const positions: number[] = [], uvs: number[] = [], index: number[] = [];
        for (let j = 0; j <= TILE_GRID; j++) {
          for (let i = 0; i <= TILE_GRID; i++) {
            const [lon, lat] = tileToLonLat(tx + i / TILE_GRID, ty + j / TILE_GRID, z);
            const [e, n] = toEnu(origin, lon, lat);
            positions.push(...toScene(e, n, groundAt(study, e, n) + 0.05));
            uvs.push(i / TILE_GRID, 1 - j / TILE_GRID);
          }
        }
        for (let j = 0; j < TILE_GRID; j++) {
          for (let i = 0; i < TILE_GRID; i++) {
            const a = j * (TILE_GRID + 1) + i, b = a + 1, c = a + TILE_GRID + 1, d = c + 1;
            index.push(a, c, b, b, c, d);
          }
        }
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
        geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
        geometry.setIndex(index);
        geometry.computeVertexNormals();
        const material = new MeshLambertMaterial({ color: 0xc9cfc2 });
        const mesh = new Mesh(geometry, material);
        mesh.receiveShadow = true;
        this.imagery.add(mesh);
        const url = source.url(z, ((tx % count) + count) % count, ty);
        used.add(url);
        void tileTexture(url, anisotropy).then((texture) => {
          if (!texture || mesh.parent !== this.imagery) return;
          material.map = texture;
          material.color.set(0xffffff);
          material.needsUpdate = true;
          this.invalidate();
        });
      }
    }
    trimTextures(used);
  }

  /** Les voisins, en un seul maillage ; `selected` (indice) en couleur d'accent, les hauteurs supposées teintées. */
  setNeighbours(study: Study, selected: number | null): void {
    const positions: number[] = [], normals: number[] = [];
    this.neighbourStarts = study.context.buildings.map((b) => {
      const start = positions.length / 3;
      const base = neighbourBase(study, b.footprint);
      addPrism(b.footprint, base, base + b.height, positions, normals);
      return start;
    });
    if (positions.length === 0) {
      this.neighbours = this.replace(this.neighbours, null);
      return;
    }
    const colors = new Float32Array(positions.length);
    const count = positions.length / 3;
    for (let b = 0; b < this.neighbourStarts.length; b++) {
      const building = study.context.buildings[b];
      const color = b === selected ? SELECTED_COLOR : building.heightSource === 'assumed' && !building.edited ? ASSUMED_COLOR : NEIGHBOUR_COLOR;
      const end = b + 1 < this.neighbourStarts.length ? this.neighbourStarts[b + 1] : count;
      for (let v = this.neighbourStarts[b]; v < end; v++) color.toArray(colors, v * 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true }));
    mesh.castShadow = mesh.receiveShadow = true;
    this.neighbours = this.replace(this.neighbours, mesh);
  }

  /** Les volumes d'une proposition, couleur de leur usage par niveau ; le volume `selected` souligné. */
  setVolumes(study: Study, proposal: Proposal, selected: string | null): void {
    for (const child of [...this.volumes.children]) {
      this.volumes.remove(child);
      child.traverse((object) => {
        (object as Mesh).geometry?.dispose();
        ((object as Mesh).material as MeshLambertMaterial | undefined)?.dispose();
      });
    }
    const colorOf = new Map(study.settings.uses.map((use) => [use.id, new Color(safeColor(use.color, '#9b7fd1'))]));
    for (const volume of proposal.volumes) {
      const { positions, normals, segments } = volumeMesh(volume);
      const colors = new Float32Array(positions.length);
      for (const segment of segments) {
        const color = colorOf.get(segment.use) ?? NEIGHBOUR_COLOR;
        for (let v = segment.start; v < segment.start + segment.count; v++) color.toArray(colors, v * 3);
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(normals, 3));
      geometry.setAttribute('color', new BufferAttribute(colors, 3));
      const isSelected = volume.id === selected;
      const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, emissive: isSelected ? 0x1d5fd0 : 0x000000, emissiveIntensity: 0.45 }));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.volume = volume.id;
      const edges = new LineSegments(new EdgesGeometry(geometry, 20), new LineBasicMaterial({ color: isSelected ? 0x1d8bff : 0x39424f }));
      mesh.add(edges);
      this.volumes.add(mesh);
    }
    this.invalidate();
  }

  /** Ajoute la géométrie d'une maquette (une fois) ; elle n'est visible qu'une fois placée (`placeModels`). */
  addModel(snapshot: ModelSnapshot): void {
    if (this.modelGroups.has(snapshot.id)) return;
    const group = new Group();
    group.userData.model = snapshot.id;
    group.visible = false;
    for (const part of snapshot.parts) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(part.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(part.normals, 3, !(part.normals instanceof Float32Array)));
      if (part.colors) geometry.setAttribute('color', new BufferAttribute(part.colors, 4, !(part.colors instanceof Float32Array)));
      geometry.setIndex(new BufferAttribute(part.index, 1));
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, new MeshLambertMaterial({
        vertexColors: part.colors !== null, transparent: part.transparent, depthWrite: !part.transparent, side: part.doubleSided ? DoubleSide : FrontSide,
      }));
      mesh.castShadow = !part.transparent;
      mesh.receiveShadow = true;
      if (part.transparent) mesh.layers.set(TRANSPARENT_LAYER);
      group.add(mesh);
    }
    this.modelGroups.set(snapshot.id, group);
    this.models.add(group);
    this.invalidate();
  }

  removeModel(id: string): void {
    const group = this.modelGroups.get(id);
    if (!group) return;
    this.modelGroups.delete(id);
    this.models.remove(group);
    group.traverse((object) => {
      (object as Mesh).geometry?.dispose();
      ((object as Mesh).material as MeshLambertMaterial | undefined)?.dispose();
    });
    this.invalidate();
  }

  /** Place les maquettes : position, rotation, visibilité, et celle qui est sélectionnée soulignée. */
  placeModels(entries: readonly { id: string; placement: Placement; visible: boolean }[], selected: string | null): void {
    for (const { id, placement, visible } of entries) {
      const group = this.modelGroups.get(id);
      if (!group) continue;
      group.position.set(...toScene(placement.east, placement.north, placement.up));
      group.rotation.set(0, (placement.rotation * Math.PI) / 180, 0);
      group.visible = visible;
      group.updateMatrixWorld(true);
      for (const child of group.children) {
        const material = (child as Mesh).material as MeshLambertMaterial;
        material.emissive.set(id === selected ? 0x1d5fd0 : 0x000000);
        material.emissiveIntensity = 0.35;
      }
    }
    this.invalidate();
  }

  /** Les triangles des maquettes visibles, à plat dans le repère de la scène (pour le lancer de rayons des analyses). */
  modelTriangles(): Float32Array[] {
    const out: Float32Array[] = [];
    const v = new Vector3();
    for (const group of this.modelGroups.values()) {
      if (!group.visible) continue;
      group.updateMatrixWorld(true);
      for (const child of group.children) {
        const mesh = child as Mesh;
        if (!mesh.castShadow) continue;
        const positions = mesh.geometry.getAttribute('position').array as Float32Array;
        const index = mesh.geometry.getIndex()!.array;
        const flat = new Float32Array(index.length * 3);
        for (let i = 0; i < index.length; i++) {
          const k = index[i] * 3;
          v.set(positions[k], positions[k + 1], positions[k + 2]).applyMatrix4(group.matrixWorld);
          flat[i * 3] = v.x;
          flat[i * 3 + 1] = v.y;
          flat[i * 3 + 2] = v.z;
        }
        out.push(flat);
      }
    }
    return out;
  }

  /** La limite du terrain, toujours visible, posée sur le sol. */
  setLimit(study: Study): void {
    const limit = study.site.limit;
    if (limit.length < 3) {
      this.limit = this.replace(this.limit, null);
      return;
    }
    const positions = limit.flatMap(([e, n]) => toScene(e, n, groundAt(study, e, n) + 0.2));
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    const line = new LineLoop(geometry, new LineBasicMaterial({ color: 0xf08c00, depthTest: false }));
    line.renderOrder = 10;
    this.limit = this.replace(this.limit, line);
  }

  /** Soleil vers `direction` (repère de la scène) ; null : sous l'horizon. `shadows` : ombres portées. */
  setSun(direction: [number, number, number] | null, shadows: boolean): void {
    if (direction) {
      this.sun.position.set(direction[0] * 1500, direction[1] * 1500, direction[2] * 1500);
      this.sun.intensity = SUN_INTENSITY;
    } else {
      this.sun.intensity = 0;
    }
    this.sun.castShadow = shadows && direction !== null;
    this.sky.intensity = direction ? SKY_INTENSITY : 1.1;
    this.invalidate();
  }

  /** Points d'une analyse colorés (null : aucune) ; `size` : côté d'un point en mètres. */
  setAnalysis(positions: Float32Array | null, colors: Float32Array | null, size: number): void {
    if (!positions || !colors) {
      this.analysis = this.replace(this.analysis, null);
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    const points = new Points(geometry, new PointsMaterial({ size, sizeAttenuation: true, vertexColors: true }));
    points.renderOrder = 5;
    this.analysis = this.replace(this.analysis, points);
  }

  private rayFrom(clientX: number, clientY: number): Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    return this.raycaster;
  }

  /** Le volume sous le pointeur (identifiant et point touché), ou null. */
  pickVolume(clientX: number, clientY: number): { id: string; point: Vector3 } | null {
    const hit = this.rayFrom(clientX, clientY).intersectObjects(this.volumes.children, false)[0];
    return hit ? { id: hit.object.userData.volume as string, point: hit.point } : null;
  }

  /** La maquette posée sous le pointeur (identifiant et point touché), ou null. */
  pickModel(clientX: number, clientY: number): { id: string; point: Vector3; distance: number } | null {
    const visible = [...this.modelGroups.values()].filter((group) => group.visible);
    const hit = this.rayFrom(clientX, clientY).intersectObjects(visible, true)[0];
    if (!hit) return null;
    let object: Object3D | null = hit.object;
    while (object && object.userData.model === undefined) object = object.parent;
    return object ? { id: object.userData.model as string, point: hit.point, distance: hit.distance } : null;
  }

  /** Ce qui est sous le pointeur, le plus proche d'abord : un volume, une maquette posée ou un voisin ; ou null. */
  pickAt(clientX: number, clientY: number): { kind: 'volume' | 'model'; id: string; point: Vector3 } | { kind: 'neighbour'; index: number } | null {
    const raycaster = this.rayFrom(clientX, clientY);
    const volume = raycaster.intersectObjects(this.volumes.children, false)[0];
    const model = this.pickModel(clientX, clientY);
    const neighbour = this.neighbours ? raycaster.intersectObject(this.neighbours, false)[0] : undefined;
    const best = Math.min(volume?.distance ?? Infinity, model?.distance ?? Infinity, neighbour?.distance ?? Infinity);
    if (best === Infinity) return null;
    if (volume && volume.distance === best) return { kind: 'volume', id: volume.object.userData.volume as string, point: volume.point };
    if (model && model.distance === best) return { kind: 'model', id: model.id, point: model.point };
    const index = this.pickNeighbour(clientX, clientY);
    return index === null ? null : { kind: 'neighbour', index };
  }

  /** Le voisin sous le pointeur (indice), s'il est plus près que tout volume ; ou null. */
  pickNeighbour(clientX: number, clientY: number): number | null {
    if (!this.neighbours) return null;
    const raycaster = this.rayFrom(clientX, clientY);
    const hit: Intersection | undefined = raycaster.intersectObject(this.neighbours, false)[0];
    if (!hit || hit.faceIndex == null) return null;
    const vertex = hit.faceIndex * 3;
    let low = 0, high = this.neighbourStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.neighbourStarts[middle] <= vertex) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  /** Le point analysé sous le pointeur (indice), ou null. */
  pickAnalysis(clientX: number, clientY: number, size: number): number | null {
    if (!this.analysis) return null;
    const raycaster = this.rayFrom(clientX, clientY);
    raycaster.params.Points = { threshold: size / 2 };
    const hit = raycaster.intersectObject(this.analysis, false)[0];
    return hit?.index ?? null;
  }

  /** Le point du plan horizontal y = `height` sous le pointeur (est, nord), ou null. */
  planePoint(clientX: number, clientY: number, height: number): XY | null {
    const { origin, direction } = this.rayFrom(clientX, clientY).ray;
    if (Math.abs(direction.y) < 1e-9) return null;
    const t = (height - origin.y) / direction.y;
    if (t <= 0) return null;
    return [origin.x + t * direction.x, -(origin.z + t * direction.z)];
  }

  /** Les triangles des voisins (repère de la scène), pour le lancer de rayons des analyses. */
  neighbourTriangles(): Float32Array | null {
    return this.neighbours ? (this.neighbours.geometry.getAttribute('position').array as Float32Array) : null;
  }
}
