// Un mince adaptateur sur le writer PDF (jsPDF, MIT) : des pages de la taille voulue, des images, des traits et du texte,
// tout en millimètres, origine en haut à gauche. Le reste du code ne connaît pas jsPDF : le remplacer ne touche que ce
// fichier. `loadPdf` charge jsPDF à la demande (`import()` dynamique) : il n'alourdit pas le premier chargement de la page.

import { MIN_LINE_MM } from './sheet.ts';

/** Ce que l'adaptateur utilise de jsPDF (de quoi lui substituer un faux dans les tests). */
export interface JsPdfDocument {
  addPage(format: [number, number], orientation: 'portrait' | 'landscape'): unknown;
  addImage(data: Uint8Array, format: string, x: number, y: number, width: number, height: number, alias?: string, compression?: string): unknown;
  setLineWidth(width: number): unknown;
  setLineDashPattern(pattern: number[], phase: number): unknown;
  setLineCap(style: string): unknown;
  setLineJoin(style: string): unknown;
  setDrawColor(r: number, g: number, b: number): unknown;
  setFillColor(r: number, g: number, b: number): unknown;
  setTextColor(r: number, g: number, b: number): unknown;
  setFont(name: string, style: string): unknown;
  setFontSize(size: number): unknown;
  line(x0: number, y0: number, x1: number, y1: number): unknown;
  rect(x: number, y: number, width: number, height: number, style: string): unknown;
  lines(segments: number[][], x: number, y: number, scale: [number, number], style: string, closed: boolean): unknown;
  text(text: string, x: number, y: number, options?: { align?: string; angle?: number }): unknown;
  output(type: 'blob'): Blob;
}
export type JsPdfConstructor = new (options: { unit: 'mm'; format: [number, number]; orientation: 'portrait' | 'landscape'; compress: boolean }) => JsPdfDocument;

export type Rgb = readonly [number, number, number];

export interface PdfWriter {
  /** Ajoute une page de cette taille (millimètres). */
  addPage(width: number, height: number): void;
  image(data: Uint8Array, format: 'JPEG' | 'PNG', x: number, y: number, width: number, height: number): void;
  /** Épaisseur (mm, jamais sous 0,13) et tirets (longueur du trait, du blanc ; vide : plein) des traits suivants. */
  setLine(width: number, dash?: readonly number[]): void;
  /** Couleur des traits, des remplissages et du texte suivants. */
  setColor(rgb: Rgb): void;
  line(x0: number, y0: number, x1: number, y1: number): void;
  rect(x: number, y: number, width: number, height: number, fill?: boolean): void;
  polygon(points: readonly (readonly [number, number])[], fill: boolean): void;
  /** `size` en points ; l'angle est en degrés, anti-horaire. */
  text(text: string, x: number, y: number, options?: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; angle?: number }): void;
  finish(): Blob;
}

const REPLACEMENTS: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '–': '-', '—': '-', 'œ': 'oe', 'Œ': 'OE', '→': '->', ' ': ' ', ' ': ' ' };

/** Le texte que l'Helvetica intégrée sait écrire (Latin-1) : guillemets, tirets et points de suspension typographiques ramenés à l'ASCII, le reste d'inconnu devient « ? ». */
export function latin1(text: string): string {
  return Array.from(text, (char) => {
    const code = char.codePointAt(0)!;
    return REPLACEMENTS[char] ?? (code < 0x80 || (code >= 0xa0 && code <= 0xff) ? char : '?');
  }).join('');
}

/** Un writer sur la classe `jsPDF` (ou un faux). Le document se crée à la première page, à sa taille. */
export function makePdf(Constructor: JsPdfConstructor): PdfWriter {
  let doc: JsPdfDocument | null = null;
  let images = 0;
  const current = (): JsPdfDocument => {
    if (!doc) throw new Error('Aucune page : appelez addPage d’abord.');
    return doc;
  };
  return {
    addPage(width, height) {
      const orientation = width > height ? 'landscape' : 'portrait';
      if (!doc) {
        doc = new Constructor({ unit: 'mm', format: [Math.min(width, height), Math.max(width, height)], orientation, compress: true });
        doc.setLineCap('round');
        doc.setLineJoin('round');
      } else doc.addPage([Math.min(width, height), Math.max(width, height)], orientation);
    },
    // Un alias propre à chaque image évite à jsPDF de calculer une empreinte de ses octets. Un JPEG passe tel quel ; un PNG,
    // décodé par jsPDF, est recompressé (sinon ses pixels entreraient bruts dans le PDF).
    image: (data, format, x, y, width, height) => void current().addImage(data, format, x, y, width, height, `image${images++}`, format === 'PNG' ? 'FAST' : 'NONE'),
    setLine(width, dash = []) {
      current().setLineWidth(Math.max(width, MIN_LINE_MM));
      current().setLineDashPattern([...dash], 0);
    },
    setColor([r, g, b]) {
      current().setDrawColor(r, g, b);
      current().setFillColor(r, g, b);
      current().setTextColor(r, g, b);
    },
    line: (x0, y0, x1, y1) => void current().line(x0, y0, x1, y1),
    rect: (x, y, width, height, fill = false) => void current().rect(x, y, width, height, fill ? 'F' : 'S'),
    polygon(points, fill) {
      if (points.length < 2) return;
      const [[x0, y0], ...rest] = points;
      let x = x0, y = y0;
      current().lines(rest.map(([px, py]) => { const step = [px - x, py - y]; x = px; y = py; return step; }), x0, y0, [1, 1], fill ? 'F' : 'S', true);
    },
    text(text, x, y, { size = 10, bold = false, align = 'left', angle }: { size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; angle?: number } = {}) {
      current().setFont('helvetica', bold ? 'bold' : 'normal');
      current().setFontSize(size);
      current().text(latin1(text), x, y, angle === undefined ? { align } : { align, angle });
    },
    finish: () => current().output('blob'),
  };
}

/** jsPDF, chargé maintenant (premier appel) : un morceau de code à part, absent de la première page. */
export async function loadPdf(): Promise<PdfWriter> {
  const { jsPDF } = await import('jspdf');
  return makePdf(jsPDF as unknown as JsPdfConstructor);
}
