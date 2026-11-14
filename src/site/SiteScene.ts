// La vue 3D de l'étude de site : relief (ou sol plat), voisins, volumes de la proposition, limite du terrain, Soleil avec
// ombres portées (three.js, cartes d'ombres), et les points d'une analyse colorés. Dessin à la demande, comme le viewer.
// Repère : x = est, y = haut, z = −nord (mètres, origine du site). Offre aussi ce que l'esquisse (engine/sketch.ts) lit
// d'une vue : renderer, camera, afterRender, toScreen, et pick / model sans maquette BIM.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
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
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { groundAt, neighbourBase } from './context.ts';
import { addPrism, toScene, volumeMesh } from './massing.ts';
import { safeColor, type Proposal, type Study, type XY } from './study.ts';

const NEIGHBOUR_COLOR = new Color('#d9d4cb');
const SELECTED_COLOR = new Color('#1d8bff');

export class SiteScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 1, 6000);
  readonly controls: OrbitControls;
  readonly afterRender = new Set<() => void>();
  /** Pas de maquette BIM ici : l'esquisse n'accroche qu'aux points qu'elle a posés. */
  readonly model = null;
  private readonly container: HTMLElement;
  private readonly sun = new DirectionalLight(0xffffff, 2.2);
  private readonly sky = new HemisphereLight(0xffffff, 0x8a8f98, 1.6);
  private ground: Mesh | null = null;
  private neighbours: Mesh | null = null;
  /** Premier sommet de chaque voisin dans le maillage commun (pour retrouver le voisin d'un triangle touché). */
  private neighbourStarts: number[] = [];
  private readonly volumes = new Group();
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
    this.scene.add(this.sky, this.sun, this.sun.target, this.volumes);
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
    this.ground = this.replace(this.ground, mesh);
    // La caméra d'ombre couvre tout le contexte, quelle que soit la direction du Soleil (diagonale comprise) :
    // environ 20 cm par texel sur 300 m de rayon.
    const extent = 1.45 * (grid ? Math.max(Math.abs(grid.west), Math.abs(grid.south)) : Math.max(300, study.context.radius));
    Object.assign(this.sun.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 4 * extent + 2000 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /** Les voisins, en un seul maillage ; `selected` (indice) en couleur d'accent. */
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
      const color = b === selected ? SELECTED_COLOR : NEIGHBOUR_COLOR;
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
      this.sun.intensity = 2.2;
    } else {
      this.sun.intensity = 0;
    }
    this.sun.castShadow = shadows && direction !== null;
    this.sky.intensity = direction ? 1.6 : 1.1;
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
