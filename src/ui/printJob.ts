// L'impression d'une ou de plusieurs vues en PDF : pour chaque page, la vue est ouverte, sa caméra copiée au cadre de la feuille
// (à l'échelle choisie pour une projection parallèle), dessinée par tuiles qui entrent une à une dans le PDF, puis les lignes
// de coupe en vecteurs, le cadre et le cartouche. Voir data/sheet.ts pour les calculs, engine/capture.ts pour le dessin.

import { Vector3 } from 'three';
import { loadPdf, type PdfWriter } from '../data/pdf.ts';
import { clipSegment, fitRect, northAngle, scaleBar, sheetOf, titleBlockCells, tilePlacement, worldSize, type Paper, type Rect, type Sheet } from '../data/sheet.ts';
import type { SavedView } from '../data/savedViews.ts';
import { captureTiles, frameCamera, printCaptureOptions, tileRects } from '../engine/capture.ts';
import { cutPaths, facingPlanes } from '../engine/cutPaths.ts';
import { withoutExtension } from '../engine/fileKinds.ts';
import { planeBasis } from '../engine/sectionCut.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { captureView } from './userViews.ts';

export interface PrintSettings {
  paper: Paper;
  landscape: boolean;
  /** Dénominateur de l'échelle (100 : 1:100) pour les vues en projection parallèle. */
  scale: number;
  dpi: 150 | 300;
  project: string;
  author: string;
  margin?: number;
}

/** Une page : une vue enregistrée à ouvrir, ou `null` pour la vue telle qu'elle est. */
export interface PrintPage { label: string; view: SavedView | null }

export type PrintProgress = (text: string, fraction: number) => void;

/** Ce que la vue montre et ce que l'impression en fait. */
export interface ViewFacts {
  /** Projection parallèle : imprimée à l'échelle. */
  scaled: boolean;
  /** Vue de dessus, sans rotation : un plan (flèche du nord). */
  plan: boolean;
  direction: Vector3;
  right: Vector3;
  up: Vector3;
  /** Hauteur de ce que la vue montre, en mètres (projection parallèle). */
  viewHeight: number;
  /** Étendue du modèle dans le plan de la vue, en mètres. */
  extent: { width: number; height: number };
  /** Les plans de coupe vus de face : leurs lignes sont tracées en vecteurs. */
  facing: ReturnType<typeof facingPlanes>;
}

export function viewFacts(app: App): ViewFacts {
  const { viewer, model } = app;
  const { camera } = viewer;
  camera.updateMatrixWorld();
  const direction = camera.getWorldDirection(new Vector3());
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const scaled = viewer.projection === 'orthographic' && !viewer.walk.active;
  let viewHeight = 0;
  if (viewer.projection === 'orthographic') viewHeight = (viewer.orthographic.top - viewer.orthographic.bottom) / viewer.orthographic.zoom;
  let extent = { width: 0, height: 0 };
  if (model && !model.box.isEmpty()) {
    const { min, max } = model.box;
    let [minR, maxR, minU, maxU] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      const corner = new Vector3(x, y, z);
      minR = Math.min(minR, corner.dot(right)); maxR = Math.max(maxR, corner.dot(right));
      minU = Math.min(minU, corner.dot(up)); maxU = Math.max(maxU, corner.dot(up));
    }
    extent = { width: maxR - minR, height: maxU - minU };
  }
  return { scaled, plan: scaled && direction.y < -0.999, direction, right, up, viewHeight, extent, facing: facingPlanes(viewer.sections, direction) };
}

/** Le nord (vecteur du repère du viewer) et d'où il vient : le vrai nord du géoréférencement s'il existe, sinon +Y du modèle. */
export function northOf(app: App): { vector: [number, number, number]; note: string } {
  const georeference = app.georeference;
  // Repère source (x, y, z) → viewer (x, z, −y) : le nord (nx, ny) du plan XY est (nx, 0, −ny).
  if (georeference) return { vector: [georeference.trueNorth[0], 0, -georeference.trueNorth[1]], note: 'Nord vrai (géoréférencement)' };
  return { vector: [0, 0, -1], note: 'Nord du projet (+Y du modèle)' };
}

const frames = (): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, 100);
  requestAnimationFrame(() => resolve());
});

/** Attend que la caméra soit arrivée et que la coupe soit calculée. */
async function settle(app: App, signal: AbortSignal): Promise<void> {
  for (let i = 0; i < 100 && app.viewer.animating; i++) await frames();
  await frames();
  await frames();
  if (signal.aborted) throw new DOMException('Impression interrompue.', 'AbortError');
  await app.viewer.cut.ready();
}

/** Le texte raccourci pour tenir dans `width` mm à `size` points (Helvetica : environ 0,5 em par lettre). */
function fitText(text: string, width: number, size: number): string {
  const room = Math.max(1, Math.floor(width / (size * 0.1764)));
  return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 3))}...`;
}

function drawTitleBlock(pdf: PdfWriter, sheet: Sheet, info: { file: string; view: string; scale: string; author: string; scaled: boolean; scaleValue: number; north: { angle: number; note: string } | null }): void {
  const cells = titleBlockCells(sheet);
  pdf.setColor([0, 0, 0]);
  pdf.setLine(0.35);
  pdf.rect(sheet.titleBlock.x, sheet.titleBlock.y, sheet.titleBlock.width, sheet.titleBlock.height);
  pdf.setLine(0.18);
  const labelled = (rect: Rect, label: string, value: string) => {
    pdf.rect(rect.x, rect.y, rect.width, rect.height);
    pdf.setColor([110, 110, 110]);
    pdf.text(label, rect.x + 1.5, rect.y + 3.2, { size: 6 });
    pdf.setColor([0, 0, 0]);
    pdf.text(fitText(value, rect.width - 3, 9), rect.x + 1.5, rect.y + rect.height - 2.6, { size: 9, bold: true });
  };
  labelled(cells.file, 'Fichier', info.file);
  labelled(cells.view, 'Vue', info.view);
  labelled(cells.scale, 'Échelle', info.scale);
  labelled(cells.date, 'Date', new Date().toLocaleDateString('fr-FR'));
  labelled(cells.author, 'Auteur', info.author);

  const bar = cells.bar;
  pdf.rect(bar.x, bar.y, bar.width, bar.height);
  if (info.scaled) {
    const { metres, mm, divisions } = scaleBar(info.scaleValue, bar.width - 8);
    const x0 = bar.x + 4, y0 = bar.y + 9;
    pdf.setLine(0.18);
    for (let i = 0; i < divisions; i++) pdf.rect(x0 + (i * mm) / divisions, y0, mm / divisions, 2, i % 2 === 0);
    pdf.text('0', x0, y0 - 1.2, { size: 6, align: 'center' });
    pdf.text(`${metres} m`, x0 + mm, y0 - 1.2, { size: 6, align: 'center' });
    // Un trait de contrôle : s'il ne mesure pas 50 mm sur le papier, l'impression a été mise à l'échelle.
    pdf.setLine(0.35);
    pdf.line(bar.x + 4, bar.y + 20, bar.x + 54, bar.y + 20);
    pdf.line(bar.x + 4, bar.y + 18.5, bar.x + 4, bar.y + 21.5);
    pdf.line(bar.x + 54, bar.y + 18.5, bar.x + 54, bar.y + 21.5);
    pdf.text('Imprimer à 100 % : ce trait mesure 50 mm', bar.x + 4, bar.y + 25, { size: 5 });
  } else {
    pdf.text('Non à l’échelle', bar.x + bar.width / 2, bar.y + bar.height / 2 + 1.5, { size: 11, bold: true, align: 'center' });
  }

  const north = cells.north;
  pdf.setLine(0.18);
  pdf.rect(north.x, north.y, north.width, north.height);
  if (info.north) {
    const radians = (info.north.angle * Math.PI) / 180;
    const d = [Math.sin(radians), -Math.cos(radians)], perpendicular = [-d[1], d[0]];
    const centre = [north.x + north.width / 2, north.y + north.height / 2 - 1.5], half = 8;
    const tip = [centre[0] + d[0] * half, centre[1] + d[1] * half], tail = [centre[0] - d[0] * half, centre[1] - d[1] * half];
    const base = [tip[0] - d[0] * 5, tip[1] - d[1] * 5];
    pdf.setLine(0.35);
    pdf.line(tail[0], tail[1], base[0], base[1]);
    pdf.polygon([[tip[0], tip[1]], [base[0] + perpendicular[0] * 2, base[1] + perpendicular[1] * 2], [base[0] - perpendicular[0] * 2, base[1] - perpendicular[1] * 2]], true);
    pdf.text('N', tip[0] + d[0] * 2.8, tip[1] + d[1] * 2.8 + 1.2, { size: 8, bold: true, align: 'center' });
    pdf.text(fitText(info.north.note, north.width - 2, 4.5), north.x + 1, north.y + north.height - 1.4, { size: 4.5 });
  }
}

/** Les lignes de coupe des plans vus de face, en traits vectoriels (millimètres) coupés au cadre. */
async function drawCut(app: App, pdf: PdfWriter, camera: ReturnType<typeof frameCamera>, frame: Rect, facing: ViewFacts['facing'], signal: AbortSignal): Promise<void> {
  const { model } = app;
  if (!model) return;
  const point = new Vector3();
  for (const plane of facing) {
    const paths = await runSliced(cutPaths(model, plane), undefined, signal);
    const { origin, u, v } = planeBasis(plane);
    // Le point du plan, projeté par la caméra de la capture : exactement là où la trame le montre.
    const toPage = (x: number, y: number): [number, number] => {
      point.copy(origin).addScaledVector(u, x).addScaledVector(v, y).project(camera);
      return [frame.x + (point.x * 0.5 + 0.5) * frame.width, frame.y + (0.5 - point.y * 0.5) * frame.height];
    };
    pdf.setColor([0, 0, 0]);
    for (const solid of [false, true]) {
      // Tirets pour un maillage ouvert ou une ligne qui ne se ferme pas, trait plein épais pour un solide fermé.
      pdf.setLine(solid ? 0.35 : 0.18, solid ? [] : [1.2, 0.8]);
      for (const path of paths) {
        if (path.solid !== solid) continue;
        const n = path.points.length / 2;
        for (let i = 0; i < (path.closed ? n : n - 1); i++) {
          const j = (i + 1) % n;
          const [x0, y0] = toPage(path.points[2 * i], path.points[2 * i + 1]), [x1, y1] = toPage(path.points[2 * j], path.points[2 * j + 1]);
          const clipped = clipSegment(x0, y0, x1, y1, frame);
          if (clipped) pdf.line(...clipped);
        }
      }
    }
    pdf.setLine(0.35);
  }
}

async function addPage(app: App, pdf: PdfWriter, settings: PrintSettings, page: PrintPage, progress: (fraction: number, text: string) => void, signal: AbortSignal): Promise<void> {
  const { viewer } = app;
  const sheet = sheetOf(settings.paper, settings.landscape, settings.margin ?? 10);
  const facts = viewFacts(app);
  const aspect = sheet.frame.width / sheet.frame.height;
  const camera = facts.scaled
    ? frameCamera(viewer, aspect, { world: worldSize(sheet, settings.scale) })
    : frameCamera(viewer, aspect, { crop: fitRect(aspect, viewer.size).height / viewer.size.height });
  const pixelsPerMm = settings.dpi / 25.4;
  const image = { width: Math.round(sheet.frame.width * pixelsPerMm), height: Math.round(sheet.frame.height * pixelsPerMm) };
  const vector = facts.scaled && facts.facing.length > 0;
  const tiles = tileRects(image.width, image.height, 2048).length;

  pdf.addPage(sheet.width, sheet.height);
  let done = 0;
  for await (const tile of captureTiles(viewer, printCaptureOptions({ widthPx: image.width, heightPx: image.height, camera, cutLines: !vector, lineScale: pixelsPerMm / 3.78, signal }))) {
    const at = tilePlacement(tile, sheet.frame, image, 0.05);
    pdf.image(new Uint8Array(await tile.blob.arrayBuffer()), 'JPEG', at.x, at.y, at.width, at.height);
    progress(++done / tiles, `${page.label} : tuile ${done} sur ${tiles}`);
  }
  if (vector) await drawCut(app, pdf, camera, sheet.frame, facts.facing, signal);
  pdf.setColor([0, 0, 0]);
  pdf.setLine(0.35);
  pdf.rect(sheet.frame.x, sheet.frame.y, sheet.frame.width, sheet.frame.height);
  const north = facts.plan ? northOf(app) : null;
  drawTitleBlock(pdf, sheet, {
    file: [settings.project, withoutExtension(app.fileName || 'Maquette')].filter(Boolean).join(' · '),
    view: app.reading ? `${page.label} (modèle partiel)` : page.label,
    scale: facts.scaled ? `1:${settings.scale}` : 'Non à l’échelle',
    author: settings.author,
    scaled: facts.scaled,
    scaleValue: settings.scale,
    north: north ? { angle: northAngle(north.vector, facts.right.toArray(), facts.up.toArray()), note: north.note } : null,
  });
}

/** Le nom du fichier PDF : le fichier ouvert et la vue (ou « plans » pour plusieurs pages). */
export function pdfName(app: App, pages: readonly PrintPage[]): string {
  const base = withoutExtension(app.fileName || 'maquette');
  return `${base} - ${pages.length === 1 ? pages[0].label : 'plans'}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Imprime les pages en un PDF. Les vues enregistrées sont ouvertes l'une après l'autre ; ce que l'utilisateur voyait avant est
 * rétabli à la fin (comme une vue enregistrée), même si l'impression échoue ou est interrompue (`signal`).
 */
export async function printToPdf(app: App, settings: PrintSettings, pages: readonly PrintPage[], onProgress: PrintProgress, signal: AbortSignal): Promise<Blob> {
  if (!app.model) throw new Error('Aucun modèle ouvert.');
  const pdf = await loadPdf();
  const snapshot = pages.some((page) => page.view) ? captureView(app, 'avant impression') : null;
  try {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (page.view) app.openView(page.view);
      await settle(app, signal);
      await addPage(app, pdf, settings, page, (fraction, text) => onProgress(text, (i + fraction) / pages.length), signal);
    }
    return pdf.finish();
  } finally {
    if (snapshot) app.openView(snapshot);
  }
}

