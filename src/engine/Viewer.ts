import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  NotEqualStencilFunc,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  type IUniform,
  type Plane,
  type Ray,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AdaptiveResolution } from './AdaptiveResolution.ts';
import { TRANSPARENT_LAYER } from './buildModel.ts';
import type { Model, PickHit, RaycastOptions } from './Model.ts';
import { AXES, Sections, type Axis } from './Sections.ts';

const NO_PLANES: Plane[] = [];
const UNIT = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
const DEFAULT_DIRECTION = new Vector3(1, 0.7, 1).normalize();

export interface FrameStats {
  calls: number;
  triangles: number;
}

/** Délai sans mouvement après lequel la vue est recalculée en pleine résolution. */
const SHARPEN_DELAY = 160;

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Objets dessinés par-dessus le modèle, sans plans de coupe (surfaces mesurées, contours). */
  readonly overlay = new Scene();
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 1000);
  readonly controls: OrbitControls;
  readonly sections = new Sections();
  readonly selectColor: IUniform<Color> = { value: new Color(0x1d8bff) };
  /** Appelé après chaque image : sert à replacer les étiquettes HTML sur la vue 3D. */
  readonly afterRender = new Set<() => void>();
  readonly stats: FrameStats = { calls: 0, triangles: 0 };
  /** Mesure de fluidité et résolution réduite en mouvement sur les machines lentes. */
  readonly adaptive = new AdaptiveResolution();
  /** Appelé à la fin d'un mouvement de caméra, pour afficher la fluidité mesurée. */
  onMotionEnd: () => void = () => {};
  model: Model | null = null;

  private readonly container: HTMLElement;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly sphere = new Sphere(new Vector3(), 10);
  private readonly capScene = new Scene();
  private readonly cap: Mesh;
  private readonly outlines: LineLoop[] = [];
  private readonly onePlane: Plane[] = [];
  private readonly otherPlanes: Plane[] = [];
  private readonly scratch = new Vector3();
  private readonly scratchBox = new Box3();
  private dirty = true;
  private resolutionScale = 1;
  private sharpenTimer = 0;
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera.position.copy(DEFAULT_DIRECTION).multiplyScalar(30);
    this.camera.layers.enable(TRANSPARENT_LAYER);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.zoomSpeed = 1.3;
    this.controls.addEventListener('change', this.invalidate);

    // Éclairage fixe et peu coûteux : une lumière d'ambiance et deux directions opposées,
    // pour qu'aucune face ne soit complètement noire.
    const lights = [new HemisphereLight(0xffffff, 0x8a8f98, 1.9), new DirectionalLight(0xffffff, 1.7), new DirectionalLight(0xffffff, 0.7)];
    lights[1].position.set(0.6, 1, 0.8);
    lights[2].position.set(-0.8, 0.3, -0.5);
    for (const light of lights) {
      light.layers.enable(TRANSPARENT_LAYER);
      this.scene.add(light);
    }

    // Quadrilatère de remplissage des coupes : dessiné là où le pochoir signale l'intérieur d'un solide.
    this.cap = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({
        color: 0x39424f,
        side: DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: NotEqualStencilFunc,
      }),
    );
    this.capScene.add(this.cap);

    for (const axis of AXES) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
      const outline = new LineLoop(geometry, new LineBasicMaterial({ color: 0x1d8bff }));
      outline.visible = false;
      outline.frustumCulled = false;
      this.outlines[axis] = outline;
      this.overlay.add(outline);
    }

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    // Fenêtre déplacée vers un écran d'une autre densité, ou contexte graphique rétabli par le
    // navigateur : dans les deux cas l'image doit être recalculée.
    window.addEventListener('resize', () => this.resize());
    this.renderer.domElement.addEventListener('webglcontextrestored', this.invalidate);
    this.renderer.setAnimationLoop(this.tick);
  }

  readonly invalidate = (): void => {
    this.dirty = true;
  };

  setBackground(color: string): void {
    this.renderer.setClearColor(new Color(color), 1);
    this.invalidate();
  }

  setCapColor(color: string): void {
    (this.cap.material as MeshBasicMaterial).color.set(color);
    this.invalidate();
  }

  setModel(model: Model | null): void {
    if (this.model) this.scene.remove(this.model.group);
    this.model = model;
    if (model) {
      this.scene.add(model.group);
      model.box.getBoundingSphere(this.sphere);
      this.sections.setBounds(model.box);
      this.sectionsChanged();
      this.fit(model.box, DEFAULT_DIRECTION);
    }
    this.invalidate();
  }

  /** Cadre la caméra sur une boîte, en conservant la direction de vue sauf indication contraire. */
  fit(box: Box3, direction?: Vector3): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 1e-4);
    const halfV = (this.camera.fov * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(halfV, halfH))) * 1.05;
    const dir = direction ? this.scratch.copy(direction) : this.scratch.copy(this.camera.position).sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.copy(DEFAULT_DIRECTION);
    dir.normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, distance);
    this.controls.update();
    this.invalidate();
  }

  /** À appeler après toute modification des plans de coupe. */
  sectionsChanged(): void {
    const { min, max, position, enabled } = this.sections;
    for (const axis of AXES) {
      const outline = this.outlines[axis];
      outline.visible = enabled[axis];
      if (!enabled[axis]) continue;
      const b = ((axis + 1) % 3) as Axis;
      const c = ((axis + 2) % 3) as Axis;
      const attribute = outline.geometry.getAttribute('position') as BufferAttribute;
      const corners = [[min[b], min[c]], [max[b], min[c]], [max[b], max[c]], [min[b], max[c]]];
      corners.forEach(([vb, vc], i) => {
        const point = [0, 0, 0];
        point[axis] = position[axis];
        point[b] = vb;
        point[c] = vc;
        attribute.setXYZ(i, point[0], point[1], point[2]);
      });
      attribute.needsUpdate = true;
    }
    this.invalidate();
  }

  /** Élément et point 3D sous le pointeur, en tenant compte des éléments masqués et des coupes. */
  pick(clientX: number, clientY: number): PickHit | null {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const ray = this.raycaster.ray;
    const model = this.model;
    const cutting = this.sections.active;
    const filled = cutting && this.sections.fill;
    const options: RaycastOptions = { clipped: cutting ? this.sections.isClipped : undefined, capBackfaces: filled, minDistance: 0 };

    // Le lancer ne renvoie l'envers d'une face que dans deux cas : matériau à double face (l'envers
    // est affiché), ou solide fermé vu à travers une section remplie. Dans le second cas, ce que
    // l'on voit est la section : on y ramène le point. Si aucune section n'explique ce contact
    // (caméra à l'intérieur du solide), rien n'est affiché à cet endroit et le rayon continue.
    for (let attempt = 0; attempt < 16; attempt++) {
      const hit = model.raycast(ray, options);
      if (!hit || !hit.backface) return hit;
      const { doubleSided, transparent } = model.chunks[hit.chunk];
      if (filled && !transparent && !model.state.isOpen(hit.element) && this.moveToCap(hit, ray)) return hit;
      if (doubleSided) return hit;
      options.minDistance = hit.distance;
    }
    return null;
  }

  /**
   * Un rayon qui touche l'envers d'une face d'un solide fermé y est entré par une section coupée :
   * le point visible à l'écran est sur le plan de coupe, pas sur la face intérieure. On ramène donc
   * le point touché sur ce plan, pour que les mesures prises sur une section soient exactes.
   */
  private moveToCap(hit: PickHit, ray: Ray): boolean {
    const { planes, enabled } = this.sections;
    const box = this.model!.elementBox(hit.element, this.scratchBox);
    const margin = Math.max(1e-6, this.sphere.radius * 1e-5);
    let best = -1;
    let bestT = 0;
    for (const axis of AXES) {
      if (!enabled[axis]) continue;
      const plane = planes[axis];
      const toward = plane.normal.dot(ray.direction);
      if (toward <= 1e-12) continue; // le rayon doit passer du côté retiré au côté conservé
      const t = -(plane.normal.dot(ray.origin) + plane.constant) / toward;
      if (t <= 0 || t >= hit.distance || t <= bestT) continue;
      const point = this.scratch.copy(ray.direction).multiplyScalar(t).add(ray.origin);
      if (box.distanceToPoint(point) > margin) continue;
      let kept = true;
      for (const other of AXES) {
        if (other !== axis && enabled[other] && planes[other].distanceToPoint(point) < 0) kept = false;
      }
      if (!kept) continue;
      best = axis;
      bestT = t;
    }
    if (best < 0) return false;
    hit.point.copy(ray.direction).multiplyScalar(bestT).add(ray.origin);
    hit.normal.copy(planes[best].normal).negate();
    hit.distance = bestT;
    hit.cap = true;
    return true;
  }

  /** Projette un point 3D en pixels dans la vue. Renvoie faux s'il est derrière la caméra. */
  toScreen(point: Vector3, out: { x: number; y: number }): boolean {
    const v = this.scratch.copy(point).applyMatrix4(this.camera.matrixWorldInverse);
    if (v.z > -this.camera.near) return false;
    v.applyMatrix4(this.camera.projectionMatrix);
    out.x = (v.x * 0.5 + 0.5) * this.width;
    out.y = (0.5 - v.y * 0.5) * this.height;
    return true;
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.width = width;
    this.height = height;
    this.resolutionScale = 1;
    this.renderer.setPixelRatio(this.basePixelRatio());
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Rendu immédiat : évite une image vide ou étirée pendant le redimensionnement.
    this.draw();
  }

  private basePixelRatio(): number {
    return Math.min(window.devicePixelRatio, 2);
  }

  /** Change la résolution de rendu (1 = celle de l'écran) sans changer la taille affichée. */
  private setResolutionScale(scale: number): void {
    if (scale === this.resolutionScale) return;
    this.resolutionScale = scale;
    this.renderer.setPixelRatio(this.basePixelRatio() * scale);
  }

  private readonly tick = (): void => {
    this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    // Pendant un mouvement continu, la résolution suit ce que la machine arrive à tenir ;
    // la vue repasse en pleine résolution dès que la caméra s'arrête.
    this.setResolutionScale(this.adaptive.frame(performance.now()));
    this.draw();
    window.clearTimeout(this.sharpenTimer);
    this.sharpenTimer = window.setTimeout(this.sharpen, SHARPEN_DELAY);
  };

  private readonly sharpen = (): void => {
    if (this.resolutionScale !== 1) {
      this.setResolutionScale(1);
      this.draw();
    }
    this.onMotionEnd();
  };

  /** Ajuste les plans proche et lointain au modèle pour garder un maximum de précision en profondeur. */
  private updateClipRange(): void {
    const camera = this.camera;
    const { center, radius } = this.sphere;
    const distance = camera.position.distanceTo(center);

    // Si la caméra rattrape son point de pivot, le zoom se bloquerait : on repousse le pivot
    // le long de l'axe de vue, ce qui ne change pas l'image et permet d'avancer dans le modèle.
    const minDistance = radius * 0.02;
    const toTarget = this.scratch.copy(this.controls.target).sub(camera.position);
    const targetDistance = toTarget.length();
    if (targetDistance < minDistance) {
      if (targetDistance < 1e-9) camera.getWorldDirection(toTarget);
      else toTarget.divideScalar(targetDistance);
      this.controls.target.copy(camera.position).addScaledVector(toTarget, minDistance);
    }

    // Plan proche : aussi loin que possible pour la précision en profondeur, mais jamais au point
    // de couper ce que l'on regarde. En s'approchant d'un petit objet dans un grand modèle, il
    // se resserre avec la distance au point de pivot.
    const far = (distance + radius) * 1.02;
    const pivotDistance = camera.position.distanceTo(this.controls.target);
    const inside = Math.max(far * 1e-6, Math.min(far * 1e-4, pivotDistance * 0.05));
    const near = Math.max(inside, (distance - radius) * 0.98);
    if (Math.abs(camera.near - near) > near * 1e-3 || Math.abs(camera.far - far) > far * 1e-3) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  private draw(): void {
    const { renderer, scene, camera, sections } = this;
    this.updateClipRange();
    renderer.info.reset();
    renderer.clear(true, true, true);

    if (!this.model || !sections.active) {
      renderer.clippingPlanes = NO_PLANES;
      renderer.render(scene, camera);
    } else {
      // 1. Géométrie opaque, coupée par les trois plans.
      renderer.clippingPlanes = sections.planes;
      camera.layers.set(0);
      renderer.render(scene, camera);

      // 2. Remplissage : pour chaque plan actif, le pochoir compte les faces arrière et avant
      //    des solides fermés ; là où le compte n'est pas nul, le plan traverse de la matière.
      if (sections.fill) {
        for (const axis of AXES) {
          if (!sections.enabled[axis]) continue;
          renderer.clearStencil();
          this.onePlane[0] = sections.planes[axis];
          renderer.clippingPlanes = this.onePlane;
          scene.overrideMaterial = this.model.stencilBack;
          renderer.render(scene, camera);
          scene.overrideMaterial = this.model.stencilFront;
          renderer.render(scene, camera);
          scene.overrideMaterial = null;

          this.otherPlanes[0] = sections.planes[(axis + 1) % 3];
          this.otherPlanes[1] = sections.planes[(axis + 2) % 3];
          renderer.clippingPlanes = this.otherPlanes;
          this.cap.position.copy(this.sphere.center).setComponent(axis, sections.position[axis]);
          this.cap.quaternion.setFromUnitVectors(UNIT[2], UNIT[axis]);
          this.cap.scale.setScalar(this.sphere.radius * 4);
          renderer.render(this.capScene, camera);
        }
      }

      // 3. Géométrie transparente, par-dessus les remplissages.
      renderer.clippingPlanes = sections.planes;
      camera.layers.set(TRANSPARENT_LAYER);
      renderer.render(scene, camera);
      camera.layers.set(0);
      camera.layers.enable(TRANSPARENT_LAYER);
    }

    renderer.clippingPlanes = NO_PLANES;
    renderer.render(this.overlay, camera);
    this.stats.calls = renderer.info.render.calls;
    this.stats.triangles = renderer.info.render.triangles;
    for (const callback of this.afterRender) callback();
  }
}
