// Repères des observations dans la vue : un seul objet `Points` (un appel de dessin, quel que soit leur nombre), à taille
// fixe à l'écran, dessinés par-dessus la maquette (sans test de profondeur) dans la scène des superpositions : ni coupés
// par les plans de coupe, ni présents dans les captures. Positions dans le repère du viewer.

import { BufferAttribute, BufferGeometry, CanvasTexture, Color, Points, PointsMaterial, SRGBColorSpace, Vector3, type Scene } from 'three';
import type { Viewer } from './Viewer.ts';

/** Un disque blanc cerclé de sombre : la couleur du repère le teinte, le cercle reste lisible sur tout fond. */
function pinTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.beginPath();
  context.arc(32, 32, 27, 0, Math.PI * 2);
  context.fillStyle = '#ffffff';
  context.fill();
  context.lineWidth = 7;
  context.strokeStyle = '#1f2937';
  context.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export class Pins {
  readonly object: Points;
  private positions = new Float32Array(0);
  private readonly scratch = new Vector3();
  private readonly screen = { x: 0, y: 0 };

  constructor(scene: Scene) {
    const material = new PointsMaterial({ size: 18, sizeAttenuation: false, vertexColors: true, map: pinTexture(), transparent: true, alphaTest: 0.4, depthTest: false, depthWrite: false });
    this.object = new Points(new BufferGeometry(), material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
    scene.add(this.object);
  }

  /** Remplace tous les repères : position (repère du viewer) et couleur (« #rrggbb »). */
  set(pins: readonly { position: readonly number[]; color: string }[]): void {
    const positions = new Float32Array(pins.length * 3), colors = new Float32Array(pins.length * 3);
    const color = new Color();
    pins.forEach((pin, i) => {
      positions.set(pin.position.slice(0, 3), i * 3);
      color.set(pin.color);
      colors.set([color.r, color.g, color.b], i * 3);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    this.object.geometry.dispose();
    this.object.geometry = geometry;
    this.positions = positions;
  }

  /** Le repère le plus proche du pointeur, à moins de `tolerance` pixels ; −1 s'il n'y en a pas. */
  nearest(viewer: Pick<Viewer, 'toScreen' | 'renderer'>, clientX: number, clientY: number, tolerance = 12): number {
    if (!this.object.visible) return -1;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let best = -1, bestDistance = tolerance;
    for (let i = 0; i < this.positions.length / 3; i++) {
      if (!viewer.toScreen(this.scratch.fromArray(this.positions, i * 3), this.screen)) continue;
      const distance = Math.hypot(this.screen.x - x, this.screen.y - y);
      if (distance <= bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    return best;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    const material = this.object.material as PointsMaterial;
    material.map?.dispose();
    material.dispose();
  }
}
