import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineLoop, Points, PointsMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { boxFaces, moveBoxFace, type BoxCut } from './Sections.ts';
import type { Viewer } from './Viewer.ts';

/** Distance au pointeur, en pixels, en deçà de laquelle une poignée est saisie. */
const GRIP_RADIUS = 12;
const RING_SEGMENTS = 64;
const FACE_COLOR = [0.94, 0.55, 0];
const TURN_COLOR = [0.11, 0.55, 1];

/**
 * Les poignées de la boîte de coupe : un carré au centre de chaque face, à pousser ou tirer le long de sa normale, et un
 * rond sur un cercle autour de la boîte, qui la fait tourner autour de la verticale. Les poignées gardent leur taille à
 * l'écran ; une face vue de face (sa normale vers l'œil) ne se saisit pas, elle ne pourrait pas avancer.
 */
export class BoxHandles {
  private readonly viewer: Viewer;
  /** Six faces (−x, +x, −y, +y, −z, +z de la boîte), puis la poignée de rotation. */
  private readonly grips: Points;
  private readonly ring: LineLoop;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly screen = { x: 0, y: 0 };
  private shown = false;
  private drag: { grip: number; pointerId: number; start: BoxCut; from: number; orbit: boolean } | null = null;
  private consumed = false;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    const gripGeometry = new BufferGeometry();
    gripGeometry.setAttribute('position', new BufferAttribute(new Float32Array(7 * 3), 3));
    gripGeometry.setAttribute('color', new BufferAttribute(new Float32Array([...Array(6).fill(FACE_COLOR).flat(), ...TURN_COLOR]), 3));
    this.grips = new Points(gripGeometry, new PointsMaterial({ size: 11, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    const ringGeometry = new BufferGeometry();
    ringGeometry.setAttribute('position', new BufferAttribute(new Float32Array(RING_SEGMENTS * 3), 3));
    this.ring = new LineLoop(ringGeometry, new LineBasicMaterial({ color: 0x1d8bff, depthTest: false, transparent: true, opacity: 0.7 }));
    for (const object of [this.grips, this.ring]) {
      object.frustumCulled = false;
      object.renderOrder = 2;
      object.visible = false;
      viewer.overlay.add(object);
    }
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointerdown', this.down, true);
    canvas.addEventListener('pointermove', this.move, true);
    canvas.addEventListener('pointerup', this.up, true);
    canvas.addEventListener('pointercancel', this.cancel);
    window.addEventListener('blur', this.cancel);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.drag) return;
      this.cancel();
      event.preventDefault();
      event.stopPropagation();
    }, true);
  }

  get blocksPicking(): boolean { return this.consumed || this.drag !== null; }

  /** Les poignées se montrent quand la carte « Coupes » est ouverte et qu'une boîte coupe. */
  setShown(shown: boolean): void {
    this.shown = shown;
    this.sync();
  }

  private get visible(): boolean {
    const sections = this.viewer.sections;
    return this.shown && sections.boxEnabled && sections.boxCut !== null && !this.viewer.hasExternalCamera;
  }

  /** Replace les poignées sur la boîte actuelle. */
  sync(): void {
    const box = this.viewer.sections.boxCut;
    const visible = this.visible && box !== null;
    this.grips.visible = this.ring.visible = visible;
    if (!visible || !box) return;
    const grips = this.grips.geometry.getAttribute('position') as BufferAttribute;
    boxFaces(box).forEach((face, i) => grips.setXYZ(i, ...face.centre));
    const { centre, radius } = this.ringOf(box);
    const angle = (box.rotation * Math.PI) / 180;
    grips.setXYZ(6, centre.x + Math.cos(angle) * radius, centre.y, centre.z - Math.sin(angle) * radius);
    grips.needsUpdate = true;
    const ring = this.ring.geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      ring.setXYZ(i, centre.x + Math.cos(a) * radius, centre.y, centre.z - Math.sin(a) * radius);
    }
    ring.needsUpdate = true;
    this.viewer.invalidate();
  }

  /** Le cercle de rotation : au bas de la boîte, un peu plus large qu'elle. */
  private ringOf(box: BoxCut): { centre: Vector3; radius: number } {
    const centre = new Vector3((box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2);
    return { centre, radius: Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]) * 0.55 };
  }

  /** La poignée sous le pointeur, ou -1. */
  private gripAt(event: PointerEvent): number {
    const box = this.viewer.sections.boxCut;
    if (!this.visible || !box) return -1;
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const view = this.viewer.camera.getWorldDirection(new Vector3());
    const grips = this.grips.geometry.getAttribute('position') as BufferAttribute;
    const faces = boxFaces(box);
    let best = -1, bestDistance = GRIP_RADIUS;
    for (let i = 0; i < 7; i++) {
      if (i < 6 && Math.abs(view.dot(new Vector3(...faces[i].normal))) > 0.97) continue;
      if (!this.viewer.toScreen(new Vector3().fromBufferAttribute(grips, i), this.screen)) continue;
      const distance = Math.hypot(this.screen.x - x, this.screen.y - y);
      if (distance < bestDistance) [best, bestDistance] = [i, distance];
    }
    return best;
  }

  private ray(event: PointerEvent) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.viewer.camera);
    return this.raycaster.ray;
  }

  /**
   * Où en est le pointeur pour cette poignée : pour une face, la position le long de sa normale (le point de la droite de
   * la normale le plus proche du rayon) ; pour la rotation, l'angle autour du centre, dans le plan horizontal du cercle.
   */
  private measure(grip: number, box: BoxCut, event: PointerEvent): number | null {
    const { origin, direction } = this.ray(event);
    if (grip === 6) {
      const { centre } = this.ringOf(box);
      if (Math.abs(direction.y) < 1e-6) return null;
      const t = (centre.y - origin.y) / direction.y;
      const x = origin.x + direction.x * t - centre.x, z = origin.z + direction.z * t - centre.z;
      return Math.atan2(-z, x);
    }
    const face = boxFaces(box)[grip];
    const d = new Vector3(...face.normal);
    const w0 = new Vector3(...face.centre).sub(origin);
    const b = d.dot(direction);
    const denominator = 1 - b * b;
    if (denominator < 1e-6) return null;
    return (b * direction.dot(w0) - d.dot(w0)) / denominator;
  }

  private readonly down = (event: PointerEvent): void => {
    if (this.drag || event.button !== 0) return;
    const grip = this.gripAt(event);
    const box = this.viewer.sections.boxCut;
    if (grip < 0 || !box) return;
    const from = this.measure(grip, box, event);
    if (from === null) return;
    this.drag = { grip, pointerId: event.pointerId, start: { min: [...box.min], max: [...box.max], rotation: box.rotation }, from, orbit: this.viewer.controls.enabled };
    this.consumed = true;
    this.viewer.controls.enabled = false;
    this.viewer.renderer.domElement.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly move = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) {
      if (this.visible) this.viewer.renderer.domElement.style.cursor = this.gripAt(event) >= 0 ? 'grab' : '';
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const now = this.measure(drag.grip, drag.start, event);
    if (now === null) return;
    const { start } = drag;
    const box = drag.grip === 6
      ? { ...start, rotation: start.rotation + ((now - drag.from) * 180) / Math.PI }
      : moveBoxFace(start, drag.grip, now - drag.from);
    this.viewer.sections.setBox(box);
    this.viewer.sectionsChanged();
    this.viewer.invalidateMotion();
  };

  private readonly up = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finish();
  };

  private finish(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.viewer.controls.enabled = drag.orbit;
    const canvas = this.viewer.renderer.domElement;
    if (canvas.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    queueMicrotask(() => { this.consumed = false; });
  }

  /** Échap, ou le geste interrompu : la boîte revient où elle était. */
  private readonly cancel = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.viewer.sections.setBox(drag.start);
    this.finish();
    this.viewer.sectionsChanged();
  };
}
