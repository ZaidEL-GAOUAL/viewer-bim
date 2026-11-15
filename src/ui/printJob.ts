// L'impression d'une ou de plusieurs vues en PDF : pour chaque page, la vue est ouverte (sans glissement de caméra), sa caméra
// copiée au cadre de la feuille, dessinée par tuiles qui entrent une à une dans le PDF, puis les lignes de coupe en vecteurs,
// le cadre et le cartouche. La vue actuelle garde le cadrage de l'utilisateur ; une vue ouverte pour l'impression est centrée
// sur ce qu'elle montre (`visibleBox`), à l'échelle fixe ou à la plus grande qui tient. Les vignettes de l'aperçu passent
// par la même caméra (`previewPages`). Voir data/sheet.ts pour les calculs, engine/capture.ts pour le dessin.

import { Vector3, type OrthographicCamera, type PerspectiveCamera } from 'three';
import { loadPdf, type PdfWriter } from '../data/pdf.ts';
import { clipSegment, fitRect, northAngle, pageScale, scaleBar, sheetOf, titleBlockCells, tilePlacement, worldSize, type Paper, type Rect, type Sheet } from '../data/sheet.ts';
import type { SavedView } from '../data/savedViews.ts';
import { captureTiles, frameCamera, holdView, printCaptureOptions, tileRects } from '../engine/capture.ts';
import { cutPaths, facingPlanes } from '../engine/cutPaths.ts';
import { withoutExtension } from '../engine/fileKinds.ts';
import { planeBasis } from '../engine/sectionCut.ts';
import type { Sections } from '../engine/Sections.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { captureView } from './userViews.ts';

export interface PrintSettings {
  paper: Paper;
  landscape: boolean;
  /** « Ajuster à la page » : une vue ouverte pour l'impression prend la plus grande échelle standard qui la montre en entier. */
  fit: boolean;
  /** Dénominateur de l'échelle (100 : 1:100) pour les vues en projection parallèle (la vue actuelle, toujours ; les autres en échelle fixe). */
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
  // Vue en miroir (plan de plafond) : la droite de l'écran est la gauche de la caméra.
  if (viewer.mirrored) right.negate();
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
  // Un plan : vu de dessus, ou d'en dessous en miroir (un plan de plafond se lit comme le plan d'étage, nord compris).
  return { scaled, plan: scaled && (direction.y < -0.999 || (viewer.mirrored && direction.y > 0.999)), direction, right, up, viewHeight, extent, facing: facingPlanes(viewer.sections, direction) };
}

/** Le nord (vecteur du repère du viewer) et d'où il vient : le vrai nord du géoréférencement s'il existe, sinon +Y du modèle. */
export function northOf(app: App): { vector: [number, number, number]; note: string } {
  const georeference = app.georeference;
  // Repère source (x, y, z) → viewer (x, z, −y) : le nord (nx, ny) du plan XY est (nx, 0, −ny).
  if (georeference) return { vector: [georeference.trueNorth[0], 0, -georeference.trueNorth[1]], note: 'Nord vrai (géoréférencement)' };
  return { vector: [0, 0, -1], note: 'Nord du projet (+Y du modèle)' };
}

/** Un rectangle dans le plan de la vue, en mètres le long de la droite (`x`) et du haut (`y`) de la caméra. */
export interface ViewRect { minX: number; maxX: number; minY: number; maxY: number }

/** Ce que `visibleBox` lit du modèle (voir `Model`). */
export interface VisibleModel {
  count: number;
  /** minX, minY, minZ, maxX, maxY, maxZ par élément. */
  boxes: Float32Array;
  state: { isRendered(index: number): boolean };
}

/** Au plus tant de centres pour trouver les bornes de la maquette (`mainSpan`). */
const SPAN_SAMPLE = 65_536;

/**
 * Les bornes, sur un axe, des centres qui forment la maquette : du premier au troisième quartile, on s'étend vers chaque bout
 * tant que l'écart au centre suivant ne dépasse pas deux fois l'étendue déjà gardée, ou qu'il reste au-delà plus d'une poignée
 * d'éléments (1 %). Un élément égaré loin de tout (un objet oublié à un kilomètre) reste dehors. `centres` est trié sur place.
 */
function mainSpan(centres: Float32Array): [number, number] {
  centres.sort();
  const n = centres.length, stray = Math.max(1, Math.floor(n / 100));
  let lo = Math.floor((n - 1) / 4), hi = Math.ceil((3 * (n - 1)) / 4);
  while (hi < n - 1 && (centres[hi + 1] - centres[hi] <= 2 * (centres[hi] - centres[lo]) || n - 1 - hi > stray)) hi++;
  while (lo > 0 && (centres[lo] - centres[lo - 1] <= 2 * (centres[hi] - centres[lo]) || lo > stray)) lo--;
  return [centres[lo], centres[hi]];
}

/**
 * Ce que la vue montre, dans son plan (`right`, `up` : les axes de la caméra) : le rectangle des boîtes des éléments affichés
 * (masquage, isolement, phase, 4D appliqués) que les plans de coupe, la boîte de la vue et donc l'étendue d'un plan ne retirent
 * pas entièrement, sans les éléments égarés loin du reste (`mainSpan`), coupé à la boîte de la vue. Boîtes des éléments
 * seulement, jamais les triangles : deux passages sur les éléments et deux tris d'au plus `SPAN_SAMPLE` centres. null : rien
 * n'est visible.
 */
export function visibleBox(model: VisibleModel, sections: Pick<Sections, 'clipPlanes' | 'planeEnabled' | 'boxEnabled' | 'boxCut'>, right: Vector3, up: Vector3): ViewRect | null {
  const planes = sections.clipPlanes.filter((_, k) => sections.planeEnabled(k));
  const { boxes, count } = model;
  const centreX = new Float32Array(count), centreY = new Float32Array(count), halfX = new Float32Array(count), halfY = new Float32Array(count);
  let n = 0;
  elements: for (let i = 0; i < count; i++) {
    const at = i * 6;
    if (!(boxes[at] <= boxes[at + 3]) || !model.state.isRendered(i)) continue; // sans géométrie, ou pas affiché
    const cx = (boxes[at] + boxes[at + 3]) / 2, cy = (boxes[at + 1] + boxes[at + 4]) / 2, cz = (boxes[at + 2] + boxes[at + 5]) / 2;
    const hx = (boxes[at + 3] - boxes[at]) / 2, hy = (boxes[at + 4] - boxes[at + 1]) / 2, hz = (boxes[at + 5] - boxes[at + 2]) / 2;
    // Toute la boîte du côté retiré d'un plan (le côté conservé est celui de la normale) : la vue n'en montre rien.
    for (const { normal: p, constant } of planes) {
      if (p.x * cx + p.y * cy + p.z * cz + constant + Math.abs(p.x) * hx + Math.abs(p.y) * hy + Math.abs(p.z) * hz < 0) continue elements;
    }
    centreX[n] = right.x * cx + right.y * cy + right.z * cz;
    halfX[n] = Math.abs(right.x) * hx + Math.abs(right.y) * hy + Math.abs(right.z) * hz;
    centreY[n] = up.x * cx + up.y * cy + up.z * cz;
    halfY[n] = Math.abs(up.x) * hx + Math.abs(up.y) * hy + Math.abs(up.z) * hz;
    n++;
  }
  if (n === 0) return null;
  // Les bornes se lisent sur au plus `SPAN_SAMPLE` centres pris à pas régulier (deux tris courts, même sur un très gros modèle) ;
  // la marge de deux fois l'étendue reprend les éléments du bord que l'échantillon a sautés, comme `mainSpan` les aurait gardés.
  const step = Math.ceil(n / SPAN_SAMPLE);
  const sample = (values: Float32Array) => Float32Array.from({ length: Math.ceil(n / step) }, (_, j) => values[j * step]);
  const [x0, x1] = mainSpan(sample(centreX)), [y0, y1] = mainSpan(sample(centreY));
  const marginX = 2 * (x1 - x0), marginY = 2 * (y1 - y0);
  const rect: ViewRect = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (let k = 0; k < n; k++) {
    if (centreX[k] < x0 - marginX || centreX[k] > x1 + marginX || centreY[k] < y0 - marginY || centreY[k] > y1 + marginY) continue;
    rect.minX = Math.min(rect.minX, centreX[k] - halfX[k]);
    rect.maxX = Math.max(rect.maxX, centreX[k] + halfX[k]);
    rect.minY = Math.min(rect.minY, centreY[k] - halfY[k]);
    rect.maxY = Math.max(rect.maxY, centreY[k] + halfY[k]);
  }
  const cut = sections.boxEnabled ? sections.boxCut : null;
  if (cut) {
    // La boîte de la vue projetée sur un axe : son centre ± la somme de ses demi-côtés le long de ses axes (tournés autour de Y).
    const angle = (cut.rotation * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
    const axes = [[c, 0, -s], [0, 1, 0], [s, 0, c]];
    const centre = [0, 1, 2].map((i) => (cut.min[i] + cut.max[i]) / 2), half = [0, 1, 2].map((i) => (cut.max[i] - cut.min[i]) / 2);
    const span = (v: Vector3): [number, number] => {
      const mid = v.x * centre[0] + v.y * centre[1] + v.z * centre[2];
      const reach = axes.reduce((sum, axis, i) => sum + Math.abs(axis[0] * v.x + axis[1] * v.y + axis[2] * v.z) * half[i], 0);
      return [mid - reach, mid + reach];
    };
    const [bx0, bx1] = span(right), [by0, by1] = span(up);
    [rect.minX, rect.maxX, rect.minY, rect.maxY] = [Math.max(rect.minX, bx0), Math.min(rect.maxX, bx1), Math.max(rect.minY, by0), Math.min(rect.maxY, by1)];
  }
  return rect.minX <= rect.maxX && rect.minY <= rect.maxY ? rect : null;
}

/** Le cadrage d'une page qui montre `box` : son centre (null : rien à centrer), l'échelle (`fixed`, ou la plus grande qui tient) et si elle tient. */
export function framing(box: ViewRect | null, sheet: Sheet, fixed: number | null): { centre: [number, number] | null; scale: number; fits: boolean } {
  const extent = box ? { width: box.maxX - box.minX, height: box.maxY - box.minY } : { width: 0, height: 0 };
  return { centre: box && [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], ...pageScale(sheet, extent, fixed) };
}

const frames = (): Promise<void> => new Promise((resolve) => {
  window.setTimeout(resolve, 100);
  requestAnimationFrame(() => resolve());
});

const interrupted = () => new DOMException('Impression interrompue.', 'AbortError');

/**
 * Attend que la vue ouverte (sans glissement de caméra, voir `App.openView`) soit dessinée deux fois et que sa coupe soit
 * calculée. L'abandon n'attend pas la fin de la coupe.
 */
async function settle(app: App, signal: AbortSignal): Promise<void> {
  await frames();
  await frames();
  if (signal.aborted) throw interrupted();
  const abort = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(interrupted()), { once: true }));
  abort.catch(() => {});
  await Promise.race([app.viewer.cut.ready(), abort]);
}

interface PageFrame {
  facts: ViewFacts;
  camera: PerspectiveCamera | OrthographicCamera;
  /** Dénominateur de l'échelle imprimée (projection parallèle). */
  scale: number;
  /** Le contenu tient dans le cadre à cette échelle (la vue actuelle : l'utilisateur voit le cadre sur la vue). */
  fits: boolean;
  /** Ce que la vue montre, en mètres ; null : rien, ou pas mesuré (vue actuelle, perspective). */
  extent: { width: number; height: number } | null;
}

/**
 * La caméra d'une page, pour la vue telle qu'elle est ouverte. Perspective : la vue rognée aux proportions de la feuille. Vue
 * actuelle en projection parallèle : le cadrage de l'utilisateur à l'échelle du dialogue. Autre vue parallèle : centrée sur ce
 * qu'elle montre, à l'échelle fixe ou (« Ajuster à la page ») à la plus grande qui tient.
 */
function pageFrame(app: App, settings: PrintSettings, page: PrintPage, sheet: Sheet): PageFrame {
  const { viewer, model } = app;
  const facts = viewFacts(app);
  const aspect = sheet.frame.width / sheet.frame.height;
  if (!facts.scaled) return { facts, camera: frameCamera(viewer, aspect, { crop: fitRect(aspect, viewer.size).height / viewer.size.height }), scale: settings.scale, fits: true, extent: null };
  if (!page.view || !model) return { facts, camera: frameCamera(viewer, aspect, { world: worldSize(sheet, settings.scale) }), scale: settings.scale, fits: true, extent: null };
  const box = visibleBox(model, viewer.sections, facts.right, facts.up);
  const { centre, scale, fits } = framing(box, sheet, settings.fit ? null : settings.scale);
  const camera = frameCamera(viewer, aspect, { world: worldSize(sheet, scale) });
  if (centre) {
    // Glisser la caméra dans le plan de la vue : la profondeur, donc les plans proche et lointain, ne change pas.
    camera.position.addScaledVector(facts.right, centre[0] - camera.position.dot(facts.right)).addScaledVector(facts.up, centre[1] - camera.position.dot(facts.up));
    camera.updateMatrixWorld(true);
  }
  return { facts, camera, scale, fits, extent: box && { width: box.maxX - box.minX, height: box.maxY - box.minY } };
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

/** Ajoute la page de la vue ouverte ; vrai si son image n'a que le fond (rien de visible). */
async function addPage(app: App, pdf: PdfWriter, settings: PrintSettings, page: PrintPage, progress: (fraction: number, text: string) => void, signal: AbortSignal): Promise<boolean> {
  const { viewer } = app;
  const sheet = sheetOf(settings.paper, settings.landscape, settings.margin ?? 10);
  const { facts, camera, scale } = pageFrame(app, settings, page, sheet);
  const pixelsPerMm = settings.dpi / 25.4;
  const image = { width: Math.round(sheet.frame.width * pixelsPerMm), height: Math.round(sheet.frame.height * pixelsPerMm) };
  const vector = facts.scaled && facts.facing.length > 0;
  const tiles = tileRects(image.width, image.height, 2048).length;

  pdf.addPage(sheet.width, sheet.height);
  let done = 0, blank = true;
  for await (const tile of captureTiles(viewer, printCaptureOptions({ widthPx: image.width, heightPx: image.height, camera, cutLines: !vector, lineScale: pixelsPerMm / 3.78, signal }))) {
    blank &&= tile.blank;
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
    scale: facts.scaled ? `1:${scale}` : 'Non à l’échelle',
    author: settings.author,
    scaled: facts.scaled,
    scaleValue: scale,
    north: north ? { angle: northAngle(north.vector, facts.right.toArray(), facts.up.toArray()), note: north.note } : null,
  });
  return blank;
}

/** Le nom du fichier PDF : le fichier ouvert et la vue (ou « plans » pour plusieurs pages). */
export function pdfName(app: App, pages: readonly PrintPage[]): string {
  const base = withoutExtension(app.fileName || 'maquette');
  return `${base} - ${pages.length === 1 ? pages[0].label : 'plans'}.pdf`.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * Imprime les pages en un PDF. Les vues enregistrées sont ouvertes l'une après l'autre ; ce que l'utilisateur voyait avant est
 * rétabli à la fin (comme une vue enregistrée, sous le nom de la vue qu'il avait ouverte), même si l'impression échoue ou est
 * interrompue (`signal`). `empty` : les pages dont l'image n'a que le fond.
 */
export async function printToPdf(app: App, settings: PrintSettings, pages: readonly PrintPage[], onProgress: PrintProgress, signal: AbortSignal): Promise<{ blob: Blob; empty: string[] }> {
  if (!app.model) throw new Error('Aucun modèle ouvert.');
  const pdf = await loadPdf();
  // L'impression passe devant l'aperçu : il rend la vue, puis elle la tient jusqu'à la fin.
  previewing?.abort();
  return holdView(async () => {
    const snapshot = pages.some((page) => page.view) ? captureView(app, 'avant impression') : null, active = app.activeView;
    const empty: string[] = [];
    try {
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (page.view) app.openView(page.view, { animate: false });
        await settle(app, signal);
        if (await addPage(app, pdf, settings, page, (fraction, text) => onProgress(text, (i + fraction) / pages.length), signal)) empty.push(page.label);
      }
      return { blob: pdf.finish(), empty };
    } finally {
      if (snapshot) app.openView(snapshot, { activeView: active });
    }
  });
}

/** L'aperçu en cours ou en attente : une impression l'interrompt. */
let previewing: AbortController | null = null;

/** Largeur d'une vignette de l'aperçu, en pixels. */
const PREVIEW_WIDTH = 320;

export interface PagePreview {
  /** La vignette PNG (adresse d'objet : à libérer). */
  url: string;
  /** L'échelle de la page ; null : non à l'échelle (perspective). */
  scale: number | null;
  /** Le contenu dépasse la feuille à cette échelle. */
  overflow: boolean;
  /** Ce que la vue montre, en mètres (de quoi proposer un papier qui suffit). */
  extent: { width: number; height: number } | null;
  /** L'image n'a que le fond : rien de visible. */
  empty: boolean;
}

/**
 * Les vignettes des pages, une capture à la fois : chaque vue est ouverte sans glissement, cadrée comme à l'impression et
 * dessinée en petit sur fond blanc. Ce que l'utilisateur voyait est rétabli à la fin, sans glissement, même si l'aperçu est
 * interrompu (`signal`, ou une impression qui passe devant : `AbortError` aussi).
 */
export async function previewPages(app: App, settings: PrintSettings, pages: readonly PrintPage[], onPreview: (page: PrintPage, preview: PagePreview) => void, signal: AbortSignal): Promise<void> {
  if (!app.model || pages.length === 0) return;
  const sheet = sheetOf(settings.paper, settings.landscape, settings.margin ?? 10);
  const width = PREVIEW_WIDTH, height = Math.max(1, Math.round((PREVIEW_WIDTH * sheet.frame.height) / sheet.frame.width));
  const own = previewing = new AbortController();
  const stop = AbortSignal.any([signal, own.signal]);
  try {
    await holdView(async () => {
      if (stop.aborted) throw interrupted();
      const snapshot = captureView(app, 'avant aperçu'), active = app.activeView;
      try {
        for (const page of pages) {
          if (page.view) app.openView(page.view, { animate: false });
          await settle(app, stop);
          const frame = pageFrame(app, settings, page, sheet);
          for await (const tile of captureTiles(app.viewer, { widthPx: width, heightPx: height, tile: Math.max(width, height), format: 'png', camera: frame.camera, background: '#ffffff', signal: stop })) {
            onPreview(page, { url: URL.createObjectURL(tile.blob), scale: frame.facts.scaled ? frame.scale : null, overflow: !frame.fits, extent: frame.extent, empty: tile.blank });
          }
        }
      } finally {
        app.openView(snapshot, { animate: false, activeView: active });
      }
    });
  } finally {
    if (previewing === own) previewing = null;
  }
}

