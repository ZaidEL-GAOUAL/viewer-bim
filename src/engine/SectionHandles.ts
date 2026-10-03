import { Group, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Axis } from './Sections.ts';
import type { Viewer } from './Viewer.ts';

const Z = new Vector3(0, 0, 1);

/** A normal arrow and rotation rings share one stable plane pivot. Geometry is read-only. */
export class SectionHandles {
  private readonly viewer: Viewer;
  private readonly translate: TransformControls;
  private readonly rotate: TransformControls;
  private readonly proxy = new Group();
  private selected: Axis | null = null;
  private active: TransformControls | null = null;
  private pointerId: number | null = null;
  private consumed = false;
  private orbitWasEnabled = true;
  private readonly startPoint = new Vector3();
  private readonly startNormal = new Vector3();
  readonly onChange = new Set<() => void>();

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    // Route input ourselves: two DOM listeners would transform the same proxy twice.
    this.translate = new TransformControls(viewer.camera);
    this.rotate = new TransformControls(viewer.camera);
    this.translate.setMode('translate'); this.translate.setSpace('local'); this.translate.setSize(1.15);
    this.translate.showX = this.translate.showY = false;
    this.rotate.setMode('rotate'); this.rotate.setSpace('world'); this.rotate.setSize(.75);
    this.proxy.name = 'Poignées du plan de coupe';
    viewer.overlay.add(this.proxy);
    for (const control of [this.translate, this.rotate]) {
      control.enabled = false;
      control.showXY = control.showYZ = control.showXZ = control.showXYZE = control.showE = false;
      viewer.overlay.add(control.getHelper());
      control.addEventListener('change', viewer.invalidate);
      control.addEventListener('objectChange', this.preview);
    }
    const canvas = viewer.renderer.domElement;
    canvas.addEventListener('pointerdown', this.down, true);
    canvas.addEventListener('pointermove', this.move, true);
    canvas.addEventListener('pointerup', this.up, true);
    canvas.addEventListener('pointercancel', this.cancel);
    canvas.addEventListener('lostpointercapture', this.cancel);
    canvas.addEventListener('pointerleave', () => {
      if (!this.active) { this.translate.axis = null; this.rotate.axis = null; }
    });
    window.addEventListener('blur', this.cancel);
    window.addEventListener('keydown', this.keydown, true);
  }

  get axis(): Axis | null { return this.selected; }
  get blocksPicking(): boolean { return this.consumed || this.active !== null || [this.translate, this.rotate].some((c) => c.enabled && c.axis !== null); }

  select(axis: Axis | null): void {
    this.cancel(); this.selected = axis; this.sync();
    for (const callback of this.onChange) callback();
  }

  sync(): void {
    if (this.active) return;
    const axis = this.selected;
    const enabled = axis !== null && this.viewer.model !== null && this.viewer.sections.enabled[axis];
    if (enabled) {
      this.viewer.sections.origin(axis!, this.proxy.position);
      this.proxy.quaternion.setFromUnitVectors(Z, this.viewer.sections.normals[axis!]);
      this.proxy.updateMatrixWorld(true);
    }
    for (const control of [this.translate, this.rotate]) {
      control.enabled = enabled;
      if (enabled) control.attach(this.proxy); else { control.detach(); control.axis = null; }
    }
    this.viewer.invalidate();
  }

  private pointer(event: PointerEvent): PointerEvent {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    // Three expects normalized x/y, despite its typings naming DOM PointerEvent.
    return { x: (event.clientX - rect.left) / rect.width * 2 - 1, y: -(event.clientY - rect.top) / rect.height * 2 + 1, button: event.button } as PointerEvent;
  }

  private hover(event: PointerEvent): TransformControls | null {
    if (!this.translate.enabled) return null;
    const pointer = this.pointer(event);
    for (const control of [this.translate, this.rotate]) {
      control.getHelper().updateMatrixWorld(true);
      control.pointerHover(pointer);
    }
    // A ring wins where it crosses the arrow shaft, avoiding accidental translation.
    // The arrow tips extend beyond the smaller rings and stay available for translation.
    if (this.rotate.axis !== null) { this.translate.axis = null; return this.rotate; }
    return this.translate.axis !== null ? this.translate : null;
  }

  private readonly down = (event: PointerEvent): void => {
    if (this.active || event.button !== 0 || this.selected === null) return;
    const control = this.hover(event);
    if (!control) return;
    this.startPoint.copy(this.proxy.position);
    this.startNormal.copy(this.viewer.sections.normals[this.selected]);
    control.pointerDown(this.pointer(event));
    if (!control.dragging) return;
    this.active = control; this.pointerId = event.pointerId; this.consumed = true;
    this.orbitWasEnabled = this.viewer.controls.enabled; this.viewer.controls.enabled = false;
    this.viewer.renderer.domElement.setPointerCapture(event.pointerId);
    event.preventDefault(); event.stopImmediatePropagation();
  };

  private readonly move = (event: PointerEvent): void => {
    if (!this.active) { this.hover(event); return; }
    if (event.pointerId !== this.pointerId) return;
    this.active.pointerMove(this.pointer(event));
    event.preventDefault(); event.stopImmediatePropagation();
  };

  private readonly preview = (): void => {
    if (!this.active || this.selected === null) return;
    const normal = Z.clone().applyQuaternion(this.proxy.quaternion).normalize();
    const point = this.active === this.rotate ? this.startPoint : this.proxy.position;
    this.viewer.sections.setTransform(this.selected, point, normal);
    this.viewer.sectionsChanged();
  };

  private readonly up = (event: PointerEvent): void => {
    if (!this.active || event.pointerId !== this.pointerId) return;
    this.active.pointerUp(this.pointer(event));
    this.finish(); event.preventDefault(); event.stopImmediatePropagation();
  };

  private finish(): void {
    const id = this.pointerId;
    this.active = null; this.pointerId = null;
    this.viewer.controls.enabled = this.orbitWasEnabled;
    for (const control of [this.translate, this.rotate]) { control.dragging = false; control.axis = null; }
    const canvas = this.viewer.renderer.domElement;
    if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    this.sync();
    queueMicrotask(() => { this.consumed = false; });
  }

  readonly cancel = (): void => {
    if (!this.active) return;
    if (this.selected !== null) this.viewer.sections.setTransform(this.selected, this.startPoint, this.startNormal);
    this.finish(); this.viewer.sectionsChanged();
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.active) return;
    this.cancel(); event.preventDefault(); event.stopPropagation();
  };
}
