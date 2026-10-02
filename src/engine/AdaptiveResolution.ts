const MOTION_GAP = 100; // au-delà de cet écart entre deux images, ce n'est plus un mouvement continu
const SLOW = 32; // ms par image : en dessous d'environ 30 images par seconde, on allège
const FAST = 18; // ms par image : la machine suit sans effort
const STEP = 0.8;
const MIN_SCALE = 0.5;
const SETTLE = 8; // images laissées pour que la mesure se stabilise après un changement

/**
 * Résolution adaptative. Sur une machine dont la carte graphique ne suit pas, la vue 3D est
 * calculée avec moins de pixels pendant que la caméra bouge, puis en pleine résolution dès
 * qu'elle s'arrête. Une machine rapide n'est jamais concernée.
 *
 * La classe ne fait que décider du facteur d'échelle à partir des dates des images rendues ;
 * elle ne touche pas au rendu.
 */
export class AdaptiveResolution {
  /** Facteur de résolution utilisé pendant un mouvement (1 = pleine résolution). */
  motionScale = 1;
  /** Durée moyenne d'une image pendant le dernier mouvement, en millisecondes (0 si inconnue). */
  frameTime = 0;

  private last = -Infinity;
  private average = 0;
  private settle = 0;
  private fastFrames = 0;
  private raiseAfter = 90;
  private justRaised = false;

  /**
   * À appeler juste avant de rendre une image. Renvoie le facteur de résolution à utiliser pour
   * cette image : `motionScale` au milieu d'un mouvement, 1 pour une image isolée.
   */
  frame(now: number): number {
    const elapsed = now - this.last;
    this.last = now;
    if (elapsed > MOTION_GAP) {
      // Première image d'un mouvement, ou image isolée : rien à mesurer encore.
      this.average = 0;
      this.settle = 0;
      this.fastFrames = 0;
      return 1;
    }

    this.average = this.average === 0 ? elapsed : this.average * 0.8 + elapsed * 0.2;
    this.frameTime = this.average;
    if (this.settle > 0) {
      this.settle--;
    } else if (this.average > SLOW && this.motionScale > MIN_SCALE) {
      this.motionScale = Math.max(MIN_SCALE, this.motionScale * STEP);
      // Une remontée aussitôt suivie d'une rechute : on attendra plus longtemps avant de réessayer,
      // pour ne pas osciller entre deux résolutions.
      if (this.justRaised) this.raiseAfter = Math.min(1200, this.raiseAfter * 2);
      this.justRaised = false;
      this.restart();
    } else if (this.average < FAST && this.motionScale < 1) {
      if (++this.fastFrames >= this.raiseAfter) {
        this.motionScale = Math.min(1, this.motionScale / STEP);
        this.justRaised = true;
        this.restart();
      }
    } else {
      this.fastFrames = 0;
    }
    return this.motionScale;
  }

  private restart(): void {
    this.average = 0;
    this.settle = SETTLE;
    this.fastFrames = 0;
  }
}
