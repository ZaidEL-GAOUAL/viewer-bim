// Parties pures du mode visite : touches, vitesse, regard, gravité et marches.
// Sans three.js ni DOM, pour être testées seules (voir WalkControls pour le branchement).
// Repère du viewer : Y vers le haut ; un cap (yaw) nul regarde vers −Z, un cap positif tourne à gauche.

/** Hauteur des yeux au-dessus du sol, en mètres. */
export const EYE_HEIGHT = 1.7;
/** Vitesse de marche, en m/s ; Maj la multiplie par RUN_FACTOR. */
export const WALK_SPEED = 1.4;
export const RUN_FACTOR = 3;
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 50;
/** Hauteur d'une marche que l'on enjambe sans s'arrêter. */
export const STEP_HEIGHT = 0.4;
/** Rayon du corps : distance gardée devant un mur. */
export const BODY_RADIUS = 0.3;
/** Hauteurs, au-dessus des pieds, des rayons de collision : juste au-dessus d'une marche, puis la poitrine. */
export const COLLISION_HEIGHTS: readonly number[] = [STEP_HEIGHT + 0.1, 1.2];

/** Sensibilité du regard, en radians par pixel glissé. */
export const LOOK_SENSITIVITY = 0.0022;
export const MAX_PITCH = (85 * Math.PI) / 180;

export const GRAVITY = 9.81;
export const MAX_FALL_SPEED = 30;
/** Raideur du lissage (par seconde) quand on monte une marche ou qu'on descend de moins d'une marche. */
export const CLIMB_RATE = 14;
export const DROP_RATE = 12;

/** Un sol est cherché au plus toutes les 100 ms en marchant (et tous les 0,2 m), toutes les 250 ms à l'arrêt. */
export const GROUND_INTERVAL = 0.1;
export const GROUND_IDLE_INTERVAL = 0.25;
export const GROUND_DISTANCE = 0.2;

export type WalkKey = 'forward' | 'back' | 'left' | 'right' | 'up' | 'down' | 'run';

/**
 * Touches par position physique (`event.code`) : W A S D d'un clavier QWERTY sont aussi Z Q S D d'un
 * clavier AZERTY, qui sont au même endroit. C'est ce qui rend le déplacement identique sur les deux.
 */
const BY_CODE: Readonly<Record<string, WalkKey>> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  KeyE: 'up', Space: 'up', PageUp: 'up',
  KeyC: 'down', PageDown: 'down',
  ShiftLeft: 'run', ShiftRight: 'run',
};

/** Repli quand le navigateur ne fournit pas de position physique (clavier virtuel, saisie assistée). */
const BY_KEY: Readonly<Record<string, WalkKey>> = {
  w: 'forward', z: 'forward', arrowup: 'forward',
  s: 'back', arrowdown: 'back',
  a: 'left', q: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
  e: 'up', ' ': 'up', pageup: 'up',
  c: 'down', pagedown: 'down',
  shift: 'run',
};

/** Action de visite d'une touche, ou null. Le code physique prime : sur AZERTY, la touche « A » (KeyQ) ne fait rien. */
export function walkKeyOf(event: { code: string; key: string }): WalkKey | null {
  if (event.code && event.code !== 'Unidentified') return BY_CODE[event.code] ?? null;
  return BY_KEY[event.key.toLowerCase()] ?? null;
}

export interface Axes {
  /** −1, 0 ou 1 : arrière, rien, avant. */
  forward: number;
  /** −1, 0 ou 1 : gauche, rien, droite. */
  right: number;
  /** −1, 0 ou 1 : descendre, rien, monter. */
  up: number;
  run: boolean;
}

/** Résume les touches tenues. Deux touches opposées s'annulent. */
export function axesOf(pressed: ReadonlySet<WalkKey>): Axes {
  const sign = (positive: WalkKey, negative: WalkKey) => (pressed.has(positive) ? 1 : 0) - (pressed.has(negative) ? 1 : 0);
  return { forward: sign('forward', 'back'), right: sign('right', 'left'), up: sign('up', 'down'), run: pressed.has('run') };
}

/** Vitesse courante : celle de marche, multipliée en courant. */
export function currentSpeed(base: number, run: boolean): number {
  return base * (run ? RUN_FACTOR : 1);
}

export function clampSpeed(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number.isFinite(speed) ? speed : WALK_SPEED));
}

/** Molette vers l'avant (deltaY négatif) : plus vite. Une encoche (100) change la vitesse d'un quart. */
export function wheelSpeed(speed: number, deltaY: number): number {
  return clampSpeed(speed * Math.exp(-Math.max(-600, Math.min(600, deltaY)) * 0.0022));
}

/** « 1,4 m/s », avec une décimale sous 10 m/s, sans au-delà. */
export function formatSpeed(speed: number): string {
  const text = speed < 10 ? speed.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : Math.round(speed).toLocaleString('fr-FR');
  return `${text} m/s`;
}

export interface Heading {
  yaw: number;
  pitch: number;
}

/** Cap et inclinaison d'une direction de vue. Regardant à la verticale, le cap est inchangé (`fallback`). */
export function headingOf(x: number, y: number, z: number, fallback = 0): Heading {
  const length = Math.hypot(x, y, z);
  if (length < 1e-9) return { yaw: fallback, pitch: 0 };
  const flat = Math.hypot(x, z);
  return { yaw: flat < 1e-6 * length ? fallback : Math.atan2(-x, -z), pitch: Math.asin(Math.max(-1, Math.min(1, y / length))) };
}

/**
 * Regard par glissement, comme on « attrape » la scène : glisser vers la droite fait tourner la
 * vue vers la gauche, glisser vers le bas la fait monter. L'inclinaison est bornée.
 */
export function lookStep(heading: Heading, dx: number, dy: number, sensitivity = LOOK_SENSITIVITY): Heading {
  return { yaw: heading.yaw + dx * sensitivity, pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, heading.pitch + dy * sensitivity)) };
}

/** Déplacement horizontal (x, z) pour une avance et un pas de côté, de longueur totale `distance` (normé en diagonale). */
export function planarMove(yaw: number, forward: number, right: number, distance: number): { x: number; z: number } {
  const length = Math.hypot(forward, right);
  if (length === 0) return { x: 0, z: 0 };
  const f = (forward / length) * distance;
  const r = (right / length) * distance;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  return { x: -sin * f + cos * r, z: -cos * f - sin * r };
}

export interface Vertical {
  /** Hauteur des pieds. */
  feet: number;
  /** Vitesse de chute, positive vers le bas. */
  velocity: number;
}

/**
 * Suit le sol d'une image à l'autre. Monter une marche et descendre de moins d'une marche sont
 * lissés (approche exponentielle, donc identique quelle que soit la cadence) ; plus haut, on
 * tombe : la vitesse croît avec la gravité, jusqu'à une vitesse limite, sans jamais passer sous le sol.
 * Sans sol connu (`null`), on reste à la hauteur où l'on est.
 */
export function followGround(feet: number, velocity: number, ground: number | null, dt: number): Vertical {
  if (ground === null || dt <= 0) return { feet, velocity: ground === null ? 0 : velocity };
  const gap = ground - feet;
  if (Math.abs(gap) < 1e-4) return { feet: ground, velocity: 0 };
  if (gap > 0) return { feet: feet + gap * (1 - Math.exp(-CLIMB_RATE * dt)), velocity: 0 };
  // Une chute commencée va jusqu'au sol ; seule une marche descendue de pied ferme est lissée.
  if (-gap <= STEP_HEIGHT && velocity === 0) return { feet: feet + gap * (1 - Math.exp(-DROP_RATE * dt)), velocity: 0 };
  const next = Math.min(MAX_FALL_SPEED, velocity + GRAVITY * dt);
  // Vitesse moyenne de l'image : le résultat ne dépend presque pas du pas de temps.
  const fallen = ((velocity + next) / 2) * dt;
  return fallen >= -gap ? { feet: ground, velocity: 0 } : { feet: feet - fallen, velocity: next };
}

/**
 * Distance que l'on peut parcourir avant un obstacle touché à la distance `hit` (le long du
 * déplacement), en gardant `radius` entre le corps et le mur. `facing` est le cosinus entre le
 * déplacement et la normale du mur : sous incidence rasante, la distance au mur est bien plus
 * courte que `hit`. Borné, pour qu'un déplacement presque parallèle au mur le longe sans s'arrêter.
 */
export function clearance(hit: number, facing: number, radius = BODY_RADIUS): number {
  return Math.max(0, hit - radius / Math.max(0.3, Math.abs(facing)));
}

/** Longueur du rayon à lancer pour un déplacement de `length` : assez pour voir un mur rasant (voir `clearance`). */
export function probeLength(length: number, radius = BODY_RADIUS): number {
  return length + radius / 0.3;
}

/**
 * Glissement le long d'un mur : le déplacement restant `remaining`, dirigé selon (ux, uz), privé de sa
 * composante vers le mur de normale horizontale (nx, nz). Renvoie null si la normale n'est pas
 * horizontale (sol, plafond) : on s'arrête alors.
 */
export function slide(ux: number, uz: number, nx: number, nz: number, remaining: number): { x: number; z: number } | null {
  const length = Math.hypot(nx, nz);
  if (length < 0.3) return null;
  const px = nx / length, pz = nz / length;
  const into = ux * px + uz * pz;
  return { x: (ux - px * into) * remaining, z: (uz - pz * into) * remaining };
}
