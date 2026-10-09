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
import { clipRange } from './clipRange.ts';
import { TRANSPARENT_LAYER } from './buildModel.ts';
import type { Model, PickHit, RaycastOptions } from './Model.ts';
import { AXES, Sections } from './Sections.ts';
import { SectionHandles } from './SectionHandles.ts';

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
  readonly sectionHandles: SectionHandles;
  readonly onSectionsChange = new Set<() => void>();
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
  /** Vrai si l’image demandée fait partie d’un mouvement de l’utilisateur (voir invalidateMotion). */
  private moving = false;
  private resolutionScale = 1;
  private sharpenTimer = 0;
  private externalCamera = false;
  private readonly background = new Color(0xe9ebef);
  private width = 1;
  private height = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    // alpha : en mode carte, le fond devient transparent pour laisser voir le globe dessiné dessous.
    this.renderer = new WebGLRenderer({ antialias: true, stencil: true, alpha: true, powerPreference: 'high-performance' });
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
    this.controls.addEventListener('change', this.invalidateMotion);

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
    this.sectionHandles = new SectionHandles(this);

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

  /**
   * Demande une image qui fait partie d'un mouvement mené par l'utilisateur (caméra, poignée de
   * coupe) : elle compte pour la résolution adaptative. Le reste passe par `invalidate`.
   */
  readonly invalidateMotion = (): void => {
    this.dirty = true;
    this.moving = true;
  };

  setBackground(color: string): void {
    this.background.set(color);
    this.renderer.setClearColor(this.background, this.externalCamera ? 0 : 1);
    this.invalidate();
  }

  /**
   * Caméra pilotée de l'extérieur (le globe, en mode carte) : les contrôles d'orbite se taisent,
   * le fond devient transparent, et chaque image est demandée par `applyCamera`.
   */
  setExternalCamera(active: boolean): void {
    if (this.externalCamera === active) return;
    this.externalCamera = active;
    this.controls.enabled = !active;
    this.renderer.domElement.classList.toggle('external-camera', active);
    this.renderer.setClearColor(this.background, active ? 0 : 1);
    if (!active) {
      // Retour aux contrôles d'orbite : ils repartent de la caméra laissée par le globe.
      this.camera.up.set(0, 1, 0);
      this.controls.update();
    }
    this.invalidate();
  }

  /** Place la caméra (position, direction, haut, champ vertical en degrés) et dessine tout de suite. */
  applyCamera(position: Vector3, direction: Vector3, up: Vector3, fov: number): void {
    const camera = this.camera;
    camera.position.copy(position);
    camera.up.copy(up);
    this.scratch.copy(position).add(direction);
    camera.lookAt(this.scratch);
    if (Math.abs(camera.fov - fov) > 1e-6) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    // Le point de pivot sert au plan proche (voir updateClipRange) : devant la caméra, à portée du modèle.
    this.controls.target.copy(position).addScaledVector(direction, Math.max(this.sphere.radius, 1));
    this.moving = true;
    this.dirty = true;
    this.renderNow();
  }

  /** Dessine maintenant si une image est demandée (même chemin que la boucle d'animation). */
  renderNow(): void {
    this.tick();
  }

  setCapColor(color: string): void {
    (this.cap.material as MeshBasicMaterial).color.set(color);
    this.invalidate();
  }

  setModel(model: Model | null): void {
    this.sectionHandles.select(null);
    if (this.model) this.scene.remove(this.model.group);
    this.model = model;
    if (model) {
      this.scene.add(model.group);
      (model.box.isEmpty() ? new Box3(new Vector3(-5, 0, -5), new Vector3(5, 3, 5)) : model.box).getBoundingSphere(this.sphere);
      this.sections.setBounds(model.box.isEmpty() ? new Box3(new Vector3(-5, 0, -5), new Vector3(5, 3, 5)) : model.box);
      this.sectionsChanged();
      this.fit(model.box, DEFAULT_DIRECTION);
    }
    this.invalidate();
  }

  /** Cadre la caméra sur une boîte, en conservant la direction de vue sauf indication contraire. */
  /** En mode carte, le cadrage est délégué au globe ; renvoie vrai s'il l'a pris en charge. */
  onExternalFit: ((box: Box3) => boolean) | null = null;

  fit(box: Box3, direction?: Vector3): void {
    if (box.isEmpty()) return;
    if (this.externalCamera && this.onExternalFit?.(box)) return;
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
    const { enabled } = this.sections;
    for (const axis of AXES) {
      const outline = this.outlines[axis];
      outline.visible = enabled[axis];
      if (!enabled[axis]) continue;
      const attribute = outline.geometry.getAttribute('position') as BufferAttribute;
      this.sections.outline(axis).forEach((point, i) => {
        attribute.setXYZ(i, point.x, point.y, point.z);
      });
      attribute.needsUpdate = true;
    }
    this.sectionHandles.sync();
    for (const callback of this.onSectionsChange) callback();
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
      const opacity = model.state.opacityOf(hit.element);
      if (filled && !transparent && (opacity === null || opacity === 1) && model.state.scheduleOpacityOf(hit.element) === 1 && !model.state.isOpen(hit.element) && this.moveToCap(hit, ray)) return hit;
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
    if (!this.externalCamera) this.controls.update();
    if (!this.dirty) return;
    this.dirty = false;
    const motion = this.moving;
    this.moving = false;
    // Pendant un mouvement continu, la résolution suit ce que la machine arrive à tenir ;
    // la vue repasse en pleine résolution dès que la caméra s'arrête. Les images qui ne
    // viennent pas d'un mouvement (lecture du planning, fondus…) sont toujours nettes.
    this.setResolutionScale(this.adaptive.frame(performance.now(), motion));
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

    // Plans mesurés le long de l'axe de vue (voir clipRange) : une maquette poussée dans un coin
    // de l'écran n'est plus coupée par le plan proche.
    const pivotDistance = camera.position.distanceTo(this.controls.target);
    const { near, far } = clipRange(camera.position, camera.getWorldDirection(this.scratch), center, radius, pivotDistance);
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
          sections.planes[axis].projectPoint(this.sphere.center, this.cap.position);
          this.cap.quaternion.setFromUnitVectors(UNIT[2], sections.planes[axis].normal);
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
