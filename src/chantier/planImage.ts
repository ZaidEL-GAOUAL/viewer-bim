// Un plan du projet devient une image (JPEG, au plus 4 000 px de côté) : c'est elle qui est gardée, envoyée et affichée sous
// les repères. Une image est réduite ; un PDF est dessiné par le navigateur s'il sait le faire (Safari, donc l'iPhone, lit la
// première page d'un PDF comme une image), sinon la page demande une image du plan.
// shortcut: pas de lecteur PDF embarqué (pdf.js serait une dépendance de plus) ; à ajouter si les plans PDF arrivent surtout d'ordinateurs sous Chrome ou Firefox.

const MAX = 4000;
/** Côté visé pour un PDF : assez pour lire les cotes en zoomant. */
const PDF_SIDE = 3000;
export const PDF_UNREADABLE = 'Ce navigateur ne sait pas lire ce PDF comme une image : enregistrez la page du plan en PNG ou JPEG (ou ouvrez cette page dans Safari), puis ajoutez cette image.';

async function encode(width: number, height: number, draw: (context: CanvasRenderingContext2D) => void): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  draw(context);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error('Le plan n’a pas pu être enregistré en image (trop grand pour cet appareil ?).');
  return blob;
}

export async function planImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode().catch(() => { throw new Error(PDF_UNREADABLE); });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error(PDF_UNREADABLE);
      const scale = PDF_SIDE / Math.max(image.naturalWidth, image.naturalHeight);
      const width = Math.round(image.naturalWidth * scale), height = Math.round(image.naturalHeight * scale);
      return { blob: await encode(width, height, (context) => context.drawImage(image, 0, 0, width, height)), width, height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Image illisible : choisissez un fichier PNG, JPEG ou PDF.'); });
  try {
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    return { blob: await encode(width, height, (context) => context.drawImage(bitmap, 0, 0, width, height)), width, height };
  } finally {
    bitmap.close();
  }
}
