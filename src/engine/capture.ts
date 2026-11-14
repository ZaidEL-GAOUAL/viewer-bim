// L'image de la vue courante, hors de la boucle d'affichage : dessinée par tuiles dans une cible de rendu (jamais plus grande
// qu'une tuile), avec `setViewOffset` de la caméra, puis encodée en JPEG ou PNG une tuile à la fois. Ni poignées, ni curseur,
// ni contour de sélection ; la coupe remplie, les règles de couleur, les éléments masqués et l'état 4D sont ceux de l'écran.
// Rien de ce qui est à l'écran ne change : la caméra de la vue n'est pas touchée (on dessine avec une copie), et le moteur
// de rendu reprend sa cible, sa couleur de fond et ses matériaux dès que chaque tuile est lue (`Viewer.renderToPixels`).

import { OrthographicCamera, PerspectiveCamera, SRGBColorSpace, WebGLRenderTarget } from 'three';
import type { Viewer } from './Viewer.ts';

export interface TileRect { x: number; y: number; width: number; height: number }

/** Côté d'une tuile par défaut, en pixels : 16 Mo de pixels, sans excès de mémoire de la carte graphique. */
export const DEFAULT_TILE = 2048;

/** Les tuiles qui couvrent l'image une fois, ligne par ligne, de gauche à droite (celles du bord sont plus petites). */
export function tileRects(width: number, height: number, tile: number): TileRect[] {
  if (!(tile >= 1)) throw new Error('La tuile doit faire au moins 1 pixel.');
  const rects: TileRect[] = [];
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) rects.push({ x, y, width: Math.min(tile, width - x), height: Math.min(tile, height - y) });
  }
  return rects;
}

/** Ce que la caméra d'une capture montre : des mètres du modèle (projection parallèle, à l'échelle), ou une fraction de la hauteur de la vue. */
export type FrameSpec = { world: { width: number; height: number } } | { crop?: number };

/**
 * Une copie de la caméra de la vue pour une capture de proportions `aspect` (largeur / hauteur), à la même place et dans la
 * même direction. Projection parallèle avec `world` : la fenêtre est exactement ces mètres (c'est ce qui fixe l'échelle d'un
 * plan imprimé). Sinon `crop` (1 par défaut) est la fraction de la hauteur de la vue qu'elle garde.
 */
export function frameCamera(viewer: Viewer, aspect: number, spec: FrameSpec = {}): PerspectiveCamera | OrthographicCamera {
  const source = viewer.camera;
  source.updateMatrixWorld();
  const crop = 'crop' in spec && spec.crop !== undefined ? spec.crop : 1;
  let camera: PerspectiveCamera | OrthographicCamera;
  if (source instanceof OrthographicCamera) {
    const halfHeight = 'world' in spec ? spec.world.height / 2 : ((source.top - source.bottom) / 2 / source.zoom) * crop;
    const halfWidth = 'world' in spec ? spec.world.width / 2 : halfHeight * aspect;
    camera = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, source.near, source.far);
  } else {
    const fov = (2 * Math.atan(Math.tan((source.fov * Math.PI) / 360) * crop) * 180) / Math.PI;
    camera = new PerspectiveCamera(fov, aspect, source.near, source.far);
  }
  camera.position.copy(source.position);
  camera.quaternion.copy(source.quaternion);
  camera.up.copy(source.up);
  camera.layers.mask = source.layers.mask;
  camera.updateMatrixWorld(true);
  return camera;
}

export interface CaptureOptions {
  /** Taille de l'image entière, en pixels. */
  widthPx: number;
  heightPx: number;
  /** Côté d'une tuile (2048 par défaut, borné par la carte graphique). */
  tile?: number;
  format?: 'jpeg' | 'png';
  /** Qualité JPEG, de 0 à 1 (0,9). */
  quality?: number;
  /** La caméra à copier ; par défaut celle de la vue, aux proportions de l'image. */
  camera?: PerspectiveCamera | OrthographicCamera;
  /** Dessiner les traits de coupe (vrai par défaut) ; faux : seulement le remplissage (l'impression les trace en vecteurs). */
  cutLines?: boolean;
  /** Épaisseur des traits de coupe, en fois celle de l'écran (1 par défaut). */
  lineScale?: number;
  /** Couleur de fond opaque (« #ffffff » pour le papier) ; absent : celle de l'écran (thème). Le blanc vient du fond, pas d'une transparence. */
  background?: string;
  /** L'abandon rejette avec une `AbortError` ; la cible de rendu est libérée. */
  signal?: AbortSignal;
}

export interface CaptureTile extends TileRect { blob: Blob }

const aborted = () => new DOMException('Capture interrompue.', 'AbortError');

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('L’image n’a pas pu être encodée.'))), type, quality));
}

/**
 * La vue courante par tuiles, une à la fois (jamais plus d'une en mémoire côté appelant si elle libère chaque `blob`).
 * Interrompre la boucle (`break`, erreur, `signal`) libère la cible de rendu et laisse le moteur dans son état.
 */
export async function* captureTiles(viewer: Viewer, options: CaptureOptions): AsyncGenerator<CaptureTile, void, undefined> {
  const { widthPx, heightPx } = options;
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1) throw new Error('Taille d’image invalide.');
  const { renderer } = viewer;
  const size = Math.max(1, Math.min(options.tile ?? DEFAULT_TILE, renderer.capabilities.maxTextureSize));
  const base = options.camera ?? frameCamera(viewer, widthPx / heightPx);
  const type = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const target = new WebGLRenderTarget(size, size, { depthBuffer: true, stencilBuffer: true, samples: Math.min(4, renderer.capabilities.maxSamples) });
  // Une cible sRGB : le matériel encode ce que les shaders écrivent en linéaire, sans perdre de précision dans les ombres.
  target.texture.colorSpace = SRGBColorSpace;
  const pixels = new Uint8Array(size * size * 4);
  const canvas = document.createElement('canvas');
  try {
    for (const rect of tileRects(widthPx, heightPx, size)) {
      if (options.signal?.aborted) throw aborted();
      const camera = base.clone();
      camera.setViewOffset(widthPx, heightPx, rect.x, rect.y, rect.width, rect.height);
      camera.updateMatrixWorld(true);
      viewer.renderToPixels(camera, target, rect, { cutLines: options.cutLines ?? true, lineScale: options.lineScale ?? 1, background: options.background }, pixels);
      // La lecture part du bas : les lignes sont remises à l'endroit en les recopiant.
      const image = new ImageData(rect.width, rect.height);
      const stride = rect.width * 4;
      for (let row = 0; row < rect.height; row++) image.data.set(pixels.subarray((rect.height - 1 - row) * stride, (rect.height - row) * stride), row * stride);
      canvas.width = rect.width;
      canvas.height = rect.height;
      canvas.getContext('2d')!.putImageData(image, 0, 0);
      const blob = await encode(canvas, type, options.quality ?? 0.9);
      if (options.signal?.aborted) throw aborted();
      yield { ...rect, blob };
    }
  } finally {
    target.dispose();
    canvas.width = canvas.height = 0;
    viewer.invalidate();
  }
}

/**
 * La vue courante en une seule image PNG, au plus de `widthPx` × `heightPx` (réduite aux mêmes proportions si la carte
 * graphique ne fait pas de texture aussi grande). Pour les petites tailles (copie dans le presse-papiers, vignette).
 */
export async function capturePng(viewer: Viewer, widthPx: number, heightPx: number, options: Partial<CaptureOptions> = {}): Promise<Blob> {
  const limit = viewer.renderer.capabilities.maxTextureSize;
  const shrink = Math.min(1, limit / Math.max(widthPx, heightPx));
  const width = Math.max(1, Math.round(widthPx * shrink)), height = Math.max(1, Math.round(heightPx * shrink));
  for await (const tile of captureTiles(viewer, { ...options, widthPx: width, heightPx: height, tile: Math.max(width, height), format: 'png' })) return tile.blob;
  throw new Error('Aucune image.');
}

/** Les options d'une page imprimée : tuiles JPEG sur fond blanc, quel que soit le thème de l'interface. */
export function printCaptureOptions(options: Omit<CaptureOptions, 'format' | 'quality' | 'background'>): CaptureOptions {
  return { ...options, format: 'jpeg', quality: 0.9, background: '#ffffff' };
}
