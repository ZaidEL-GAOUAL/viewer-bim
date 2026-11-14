// Images des observations : photos réduites à 1 500 px de côté avant d'être gardées, repère dessiné sur l'image d'un point de
// vue. Le décodage passe par `createImageBitmap` (hors du fil principal) et le dessin par un `OffscreenCanvas` quand le
// navigateur en a un. Une seule photo pleine taille en mémoire à la fois : l'appelant les traite l'une après l'autre.

import { SNAPSHOT_MAX } from '../data/bcf.ts';

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

async function encode(width: number, height: number, draw: (context: Context2D) => void, type: 'image/jpeg' | 'image/png'): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context) {
      draw(context);
      return canvas.convertToBlob({ type, quality: 0.85 });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('L’image n’a pas pu être encodée.');
  return blob;
}

/** La photo en JPEG d'au plus `max` px de côté, tournée comme l'appareil l'indique. */
export async function reducePhoto(file: Blob, max = SNAPSHOT_MAX): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    return await encode(width, height, (context) => context.drawImage(bitmap, 0, 0, width, height), 'image/jpeg');
  } finally {
    bitmap.close();
  }
}

/** L'image avec un repère rond en (`x`, `y`), fractions de sa largeur et de sa hauteur. */
export async function withPin(image: Blob, x: number, y: number, color: string): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const { width, height } = bitmap;
    return await encode(width, height, (context) => {
      context.drawImage(bitmap, 0, 0);
      const radius = Math.max(7, Math.round(Math.max(width, height) / 110));
      context.beginPath();
      context.arc(x * width, y * height, radius, 0, Math.PI * 2);
      context.fillStyle = color;
      context.fill();
      context.lineWidth = Math.max(2, radius / 3);
      context.strokeStyle = '#ffffff';
      context.stroke();
    }, 'image/png');
  } finally {
    bitmap.close();
  }
}
