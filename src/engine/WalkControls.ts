import { Euler, Vector3 } from 'three';
import type { PickHit } from './Model.ts';
import type { Viewer } from './Viewer.ts';
import {
  BODY_RADIUS,
  COLLISION_HEIGHTS,
  EYE_HEIGHT,
  GROUND_DISTANCE,
  GROUND_IDLE_INTERVAL,
  GROUND_INTERVAL,
  STEP_HEIGHT,
  WALK_SPEED,
  axesOf,
  clampSpeed,
  clearance,
  currentSpeed,
  followGround,
  headingOf,
  lookStep,
  planarMove,
  probeLength,
  slide,
  walkKeyOf,
  wheelSpeed,
  type WalkKey,
} from './walkMath.ts';

const DOWN = new Vector3(0, -1, 0);
/** Distance du point de pivot devant les yeux : il sert aux plans proche et lointain (voir Viewer.updateClipRange). */
const PIVOT_DISTANCE = 3;
/** Hauteur au-dessus du pivot d'où part la recherche du sol à l'entrée dans la visite. */
const START_LIFT = 0.6;
/** Au-delà de cette durée entre deux images (onglet suspendu, par exemple), le temps est borné : pas de saut à travers un mur. */
const MAX_FRAME = 0.1;

/** Vrai pendant une saisie de texte : les touches de la visite ne doivent alors rien faire. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== 'function') return false;
  if (element.closest('dialog[open]')) return true;
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLInputElement && !/^(checkbox|radio|range|color|button|file)$/.test(element.type)) ||
    element.isContentEditable === true
  );
}

/**
 * Espace et Entrée activent la case ou le bouton qui a le focus quand celui-ci est une commande de la
 * visite (marquée `data-walk-controls`), au lieu de faire monter : sinon le clavier ne pourrait pas les actionner.
 */
function activatesControl(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (event.code === 'Space' || event.code === 'Enter') && typeof target?.closest === 'function' && target.closest('[data-walk-controls]') !== null;
}

/**
 * Mode visite : la caméra marche dans la maquette à hauteur d'yeux, comme dans la marche de Revit
 * ou de Navisworks. Elle remplace les contrôles d'orbite le temps de la visite.
 *
 * Le sol et les murs sont trouvés par le lancer de rayon du moteur (`Viewer.castRay`, donc les
 * mêmes règles que le picking : éléments masqués et parties coupées ignorés), à cadence modérée :
 * un rayon vers le bas toutes les 100 ms ou tous les 0,2 m, et deux rayons horizontaux par image
 * seulement pendant que l'on avance contre des collisions. Aucun maillage n'est créé : la caméra
 * ne fait que bouger, les lots fusionnés se dessinent comme d'habitude.
 */
export class WalkControls {
  /** Gravité : les yeux restent à 1,70 m au-dessus du sol ; sinon vol libre. */
  gravity = true;
  /** Collisions : on s'arrête à 0,3 m d'un mur, que l'on longe. */
  collisions = true;
  /** Appelé quand la visite commence, se termine, ou quand un réglage change. */
  readonly onChange = new Set<() => void>();
  /** Appelé quand la vitesse de marche change (pour l'afficher brièvement). */
  readonly onSpeed = new Set<(speed: number) => void>();
  /** Dit si un double-clic peut replacer le visiteur (faux pendant une mesure, par exemple). */
  canPlace: () => boolean = () => true;

  private readonly viewer: Viewer;
  private isActive = false;
  private baseSpeed = WALK_SPEED;
  private readonly pressed = new Set<WalkKey>();
  private yaw = 0;
  private pitch = 0;
  private x = 0;
  private z = 0;
  private feet = 0;
  private velocity = 0;
  private lastTime = 0;
  /** Dernier sol trouvé : hauteur, position et date de la recherche. */
  private ground: number | null = null;
  private groundX = 0;
  private groundZ = 0;
  private groundTime = 0;
  private groundDue = true;
  private look: { id: number; x: number; y: number } | null = null;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();

  constructor(viewer: Viewer) {
    this.viewer = viewer;
  }

  get active(): boolean {
    return this.isActive;
  }

  get speed(): number {
    return this.baseSpeed;
  }

  /** Hauteur des pieds et du sol connu sous eux : pour vérifier, et pour l'afficher. */
  get heights(): { feet: number; ground: number | null; eye: number } {
    return { feet: this.feet, ground: this.ground, eye: this.feet + EYE_HEIGHT };
  }

  /** Pourquoi la visite ne peut pas commencer, ou null si elle le peut. */
  get unavailable(): string | null {
    if (!this.viewer.model) return 'Ouvrez d’abord une maquette.';
    if (this.viewer.hasExternalCamera) return 'La visite n’est pas disponible sur la carte : fermez la carte.';
    if (this.viewer.projection !== 'perspective') return 'La visite se fait en perspective : quittez la vue 2D.';
    return null;
  }

  setSpeed(speed: number): void {
    this.baseSpeed = clampSpeed(speed);
    for (const listener of this.onSpeed) listener(this.baseSpeed);
  }

  setGravity(on: boolean): void {
    if (this.gravity === on) return;
    this.gravity = on;
    this.velocity = 0;
    this.groundDue = true; // sans gravité on garde la hauteur ; avec, on retombe au sol sous les pieds
    this.changed();
  }

  setCollisions(on: boolean): void {
    if (this.collisions === on) return;
    this.collisions = on;
    this.changed();
  }

  /**
   * Commence la visite : les yeux à 1,70 m au-dessus du sol sous le point de pivot de l'orbite (ou
   * sous `at`), à l'horizontale dans le sens où la caméra regardait.
   */
  enter(at?: Vector3 | null): boolean {
    const viewer = this.viewer;
    if (this.isActive) return true;
    if (this.unavailable) return false;
    const camera = viewer.perspective;
    const view = camera.getWorldDirection(this.direction);
    const heading = headingOf(view.x, view.y, view.z, headingOf(camera.up.x, camera.up.y, camera.up.z).yaw);
    this.yaw = heading.yaw;
    this.pitch = 0;
    const point = at ?? viewer.controls.target;
    this.x = point.x;
    this.z = point.z;
    // Le sol sous le point, en partant un peu au-dessus de lui : le centre d'une maquette tombe souvent dans
    // l'épaisseur d'une dalle, dont le dessus est alors le sol voulu. À défaut (point hors de la maquette),
    // sous le haut de la maquette, puis le bas.
    const box = viewer.model!.box;
    const top = this.castDown(point.x, point.y + START_LIFT, point.z) ?? this.castDown(point.x, box.max.y + 1, point.z);
    this.feet = top ? top.point.y : box.isEmpty() ? point.y : box.min.y;
    this.ground = this.feet;
    this.velocity = 0;
    this.groundDue = false;
    this.groundTime = performance.now();
    this.groundX = this.x;
    this.groundZ = this.z;

    this.isActive = true;
    this.lastTime = performance.now();
    this.pressed.clear();
    viewer.controls.enabled = false;
    camera.up.set(0, 1, 0);
    // Un bouton resté actif activerait de nouveau la visite à la touche Espace ou Entrée.
    const focused = document.activeElement as HTMLElement | null;
    if (focused && (focused.tagName === 'BUTTON' || focused.tagName === 'A')) focused.blur();
    this.bind();
    this.applyPose();
    this.changed();
    return true;
  }

  /** Termine la visite : l'orbite reprend, autour d'un point devant les yeux (ce que l'on regardait). */
  exit(): void {
    if (!this.isActive) return;
    const viewer = this.viewer;
    const camera = viewer.perspective;
    this.isActive = false;
    this.unbind();
    this.pressed.clear();
    this.look = null;
    const direction = camera.getWorldDirection(this.direction);
    const hit = viewer.castRay(camera.position, direction, 200);
    const distance = hit ? Math.min(40, Math.max(1.5, hit.distance)) : 8;
    viewer.controls.target.copy(camera.position).addScaledVector(direction, distance);
    viewer.controls.enabled = true;
    viewer.controls.update();
    viewer.invalidate();
    this.changed();
  }

  /** Une image : avance, regard déjà appliqué par la souris, sol et collisions. À appeler à chaque image tant que la visite est active. */
  update(now: number): void {
    if (!this.isActive) return;
    const dt = Math.min(MAX_FRAME, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (dt === 0) return;
    const axes = axesOf(this.pressed);
    const speed = currentSpeed(this.baseSpeed, axes.run);
    let moved = false;

    if (axes.forward !== 0 || axes.right !== 0) {
      let step = planarMove(this.yaw, axes.forward, axes.right, speed * dt);
      if (this.collisions) step = this.collide(step.x, step.z);
      if (step.x !== 0 || step.z !== 0) {
        this.x += step.x;
        this.z += step.z;
        moved = true;
      }
    }

    if (!this.gravity) {
      if (axes.up !== 0) {
        this.feet += axes.up * speed * dt;
        moved = true;
      }
    } else {
      this.searchGround(now, moved);
      const next = followGround(this.feet, this.velocity, this.ground, dt);
      if (next.feet !== this.feet) moved = true;
      this.feet = next.feet;
      this.velocity = next.velocity;
    }
    if (moved) this.applyPose();
  }

  /** Replace le visiteur sous un point touché (double-clic), debout sur le sol qui s'y trouve. */
  placeAt(point: Vector3, normal?: Vector3 | null): void {
    let x = point.x, z = point.z;
    let from = point.y;
    if (normal && Math.abs(normal.y) < 0.7) {
      // Contre un mur : un peu en avant de lui, du côté de la pièce.
      const flat = Math.hypot(normal.x, normal.z) || 1;
      x += (normal.x / flat) * (BODY_RADIUS + 0.1);
      z += (normal.z / flat) * (BODY_RADIUS + 0.1);
    } else if (normal && normal.y >= 0.7) from += STEP_HEIGHT + 0.05; // sur un sol : le sol lui-même doit être trouvé
    else if (normal) from -= 0.05; // sous un plafond : le sol de la pièce, pas la dalle du dessus
    const hit = this.castDown(x, from, z);
    this.x = x;
    this.z = z;
    this.feet = hit ? hit.point.y : point.y;
    this.ground = this.feet;
    this.velocity = 0;
    this.groundDue = false;
    this.groundTime = performance.now();
    this.groundX = x;
    this.groundZ = z;
    this.applyPose();
  }

  // ------------------------------------------------------------------ sol et murs

  private castDown(x: number, y: number, z: number): PickHit | null {
    return this.viewer.castRay(this.origin.set(x, y, z), DOWN);
  }

  /**
   * Cherche le sol sous les pieds : toutes les 100 ms ou tous les 0,2 m en marchant, toutes les 250 ms à
   * l'arrêt (un sol masqué ou coupé par un plan se remarque). Le rayon part de la hauteur d'une marche
   * au-dessus des pieds : on monte une marche, on passe sous une table ou un linteau. Sans sol trouvé
   * (au-delà de la maquette), on garde le dernier niveau connu.
   */
  private searchGround(now: number, moved: boolean): void {
    const elapsed = (now - this.groundTime) / 1000;
    const travelled = Math.hypot(this.x - this.groundX, this.z - this.groundZ);
    const busy = moved || this.velocity > 0 || (this.ground !== null && this.feet - this.ground > 1e-3);
    if (!this.groundDue && travelled < GROUND_DISTANCE && elapsed < (busy ? GROUND_INTERVAL : GROUND_IDLE_INTERVAL)) return;
    this.groundDue = false;
    this.groundTime = now;
    this.groundX = this.x;
    this.groundZ = this.z;
    const hit = this.castDown(this.x, this.feet + STEP_HEIGHT + 0.01, this.z);
    if (hit) this.ground = hit.point.y;
    else if (this.ground === null) this.ground = this.feet;
  }

  /** Le plus proche obstacle devant, à chaque hauteur de collision. */
  private obstacle(x: number, z: number, ux: number, uz: number, reach: number): PickHit | null {
    let best: PickHit | null = null;
    this.direction.set(ux, 0, uz);
    for (const height of COLLISION_HEIGHTS) {
      this.origin.set(x, this.feet + height, z);
      const hit = this.viewer.castRay(this.origin, this.direction, best ? best.distance : reach);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }

  /** Déplacement réellement possible : arrêté à 0,3 m d'un mur, puis glissé le long de lui. */
  private collide(dx: number, dz: number): { x: number; z: number } {
    let x = this.x, z = this.z;
    let done = { x: 0, z: 0 };
    for (let pass = 0; pass < 2; pass++) {
      const length = Math.hypot(dx, dz);
      if (length < 1e-9) break;
      const ux = dx / length, uz = dz / length;
      const hit = this.obstacle(x, z, ux, uz, probeLength(length));
      if (!hit) {
        done = { x: done.x + dx, z: done.z + dz };
        break;
      }
      const allowed = Math.min(length, clearance(hit.distance, hit.normal.x * ux + hit.normal.z * uz));
      done = { x: done.x + ux * allowed, z: done.z + uz * allowed };
      x += ux * allowed;
      z += uz * allowed;
      const rest = slide(ux, uz, hit.normal.x, hit.normal.z, length - allowed);
      if (!rest) break;
      dx = rest.x;
      dz = rest.z;
    }
    return done;
  }

  // ------------------------------------------------------------------ caméra

  private applyPose(): void {
    const { perspective: camera, controls } = this.viewer;
    camera.position.set(this.x, this.feet + EYE_HEIGHT, this.z);
    camera.quaternion.setFromEuler(this.euler.set(this.pitch, this.yaw, 0));
    // Point de pivot devant les yeux : il règle les plans proche et lointain pendant la visite.
    controls.target.copy(camera.position).addScaledVector(camera.getWorldDirection(this.direction), PIVOT_DISTANCE);
    this.viewer.invalidateMotion();
  }

  private changed(): void {
    for (const listener of this.onChange) listener();
  }

  // ------------------------------------------------------------------ événements

  private bind(): void {
    const canvas = this.viewer.renderer.domElement;
    // En capture : les touches de la visite passent avant les raccourcis de l'application.
    window.addEventListener('keydown', this.keydown, { capture: true });
    window.addEventListener('keyup', this.keyup, { capture: true });
    window.addEventListener('blur', this.release);
    canvas.addEventListener('pointerdown', this.pointerdown);
    canvas.addEventListener('pointermove', this.pointermove);
    canvas.addEventListener('pointerup', this.pointerup);
    canvas.addEventListener('pointercancel', this.pointerup);
    canvas.addEventListener('wheel', this.wheel, { passive: false });
    canvas.addEventListener('dblclick', this.doubleClick);
    canvas.classList.add('walking');
  }

  private unbind(): void {
    const canvas = this.viewer.renderer.domElement;
    window.removeEventListener('keydown', this.keydown, { capture: true });
    window.removeEventListener('keyup', this.keyup, { capture: true });
    window.removeEventListener('blur', this.release);
    canvas.removeEventListener('pointerdown', this.pointerdown);
    canvas.removeEventListener('pointermove', this.pointermove);
    canvas.removeEventListener('pointerup', this.pointerup);
    canvas.removeEventListener('pointercancel', this.pointerup);
    canvas.removeEventListener('wheel', this.wheel);
    canvas.removeEventListener('dblclick', this.doubleClick);
    canvas.classList.remove('walking', 'looking');
  }

  /** Perte du focus : les touches relâchées pendant l'absence ne seraient jamais vues. */
  private readonly release = (): void => {
    this.pressed.clear();
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (isTyping(event.target)) return;
    // Échap quitte la visite, sauf si la poignée d'un plan de coupe vient de l'utiliser pour annuler son geste.
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      this.exit();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || activatesControl(event)) return;
    const key = walkKeyOf(event);
    if (!key) return;
    // Maj peut avoir été relâché hors de la page : la touche elle-même fait foi.
    if (event.shiftKey) this.pressed.add('run');
    else this.pressed.delete('run');
    if (key !== 'run') this.pressed.add(key);
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly keyup = (event: KeyboardEvent): void => {
    const key = walkKeyOf(event);
    if (!key) return;
    this.pressed.delete(key);
    if (activatesControl(event)) return;
    if (!event.shiftKey) this.pressed.delete('run');
    if (!isTyping(event.target)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly pointerdown = (event: PointerEvent): void => {
    // Un seul doigt ou bouton regarde autour ; un second contact (pincement) est ignoré.
    if (this.look) return;
    this.look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    const canvas = this.viewer.renderer.domElement;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // contact déjà terminé : le regard s'arrêtera au prochain pointerup
    }
    canvas.classList.add('looking');
  };

  private readonly pointermove = (event: PointerEvent): void => {
    const look = this.look;
    if (!look || event.pointerId !== look.id) return;
    const heading = lookStep({ yaw: this.yaw, pitch: this.pitch }, event.clientX - look.x, event.clientY - look.y);
    look.x = event.clientX;
    look.y = event.clientY;
    this.yaw = heading.yaw;
    this.pitch = heading.pitch;
    this.applyPose();
  };

  private readonly pointerup = (event: PointerEvent): void => {
    if (!this.look || event.pointerId !== this.look.id) return;
    this.look = null;
    const canvas = this.viewer.renderer.domElement;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.classList.remove('looking');
  };

  private readonly wheel = (event: WheelEvent): void => {
    event.preventDefault();
    // deltaMode 1 : lignes (certaines souris sous Firefox) ; 2 : pages.
    const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 300 : 1);
    this.setSpeed(wheelSpeed(this.baseSpeed, delta));
  };

  /** Double-clic : se placer là. Il ne doit pas cadrer l'élément comme en orbite (le gestionnaire de l'application). */
  private readonly doubleClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (!this.canPlace() || this.viewer.sectionHandles.blocksPicking) return;
    const hit = this.viewer.pick(event.clientX, event.clientY);
    if (hit) this.placeAt(hit.point, hit.normal);
  };
}
