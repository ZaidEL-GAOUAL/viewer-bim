// La mise en page d'une feuille imprimée : papier, marges, échelle, cadre du dessin, cartouche, barre d'échelle. Calcul pur,
// sans PDF ni rendu. Les longueurs de la feuille sont en millimètres, origine en haut à gauche (comme jsPDF) ; celles du
// modèle sont en mètres. À l'échelle 1:S, 1 mm de papier montre S mm du modèle : `mmOf(metres, S) = metres × 1000 / S`.

export type Paper = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
/** Du plus petit au plus grand. */
export const PAPERS: readonly Paper[] = ['A4', 'A3', 'A2', 'A1', 'A0'];
/** Les échelles proposées (dénominateurs). */
export const SCALES: readonly number[] = [20, 50, 100, 200, 500];

const PORTRAIT: Record<Paper, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189] };

/** Hauteur du cartouche, en bas de la feuille. */
export const TITLE_BLOCK_MM = 28;
/** Épaisseur minimale d'un trait imprimé. */
export const MIN_LINE_MM = 0.13;

export interface Rect { x: number; y: number; width: number; height: number }

export interface Sheet {
  paper: Paper;
  landscape: boolean;
  width: number;
  height: number;
  margin: number;
  /** Le cadre du dessin : la feuille moins les marges et le cartouche. */
  frame: Rect;
  titleBlock: Rect;
}

export function paperSize(paper: Paper, landscape: boolean): { width: number; height: number } {
  const [short, long] = PORTRAIT[paper];
  return landscape ? { width: long, height: short } : { width: short, height: long };
}

export function sheetOf(paper: Paper, landscape: boolean, margin = 10): Sheet {
  const { width, height } = paperSize(paper, landscape);
  return {
    paper, landscape, width, height, margin,
    frame: { x: margin, y: margin, width: width - 2 * margin, height: height - 2 * margin - TITLE_BLOCK_MM },
    titleBlock: { x: margin, y: height - margin - TITLE_BLOCK_MM, width: width - 2 * margin, height: TITLE_BLOCK_MM },
  };
}

/** Millimètres de papier pour `metres` du modèle à l'échelle 1:`scale`. */
export const mmOf = (metres: number, scale: number): number => (metres * 1000) / scale;

/** Ce que le cadre montre du modèle, en mètres. */
export function worldSize(sheet: Sheet, scale: number): { width: number; height: number } {
  return { width: (sheet.frame.width * scale) / 1000, height: (sheet.frame.height * scale) / 1000 };
}

/** Le rectangle du modèle (mètres, repère du plan) que le cadre montre, centré en `centre`. */
export function frameRect(sheet: Sheet, scale: number, centre: readonly [number, number]): { minX: number; minY: number; maxX: number; maxY: number } {
  const { width, height } = worldSize(sheet, scale);
  return { minX: centre[0] - width / 2, maxX: centre[0] + width / 2, minY: centre[1] - height / 2, maxY: centre[1] + height / 2 };
}

/** Une étendue du modèle (mètres) tient-elle dans le cadre à cette échelle ? */
export function fits(sheet: Sheet, scale: number, extent: { width: number; height: number }): boolean {
  const world = worldSize(sheet, scale);
  return extent.width <= world.width + 1e-9 && extent.height <= world.height + 1e-9;
}

/** Le premier papier, à partir de celui de `sheet` (même orientation et marges), où l'étendue tient ; null s'il n'y en a pas. */
export function nextPaperThatFits(sheet: Sheet, scale: number, extent: { width: number; height: number }): Paper | null {
  for (const paper of PAPERS.slice(PAPERS.indexOf(sheet.paper))) {
    if (fits(sheetOf(paper, sheet.landscape, sheet.margin), scale, extent)) return paper;
  }
  return null;
}

/** La plus grande échelle standard où l'étendue tient ; null si même la plus petite est trop grande. */
export function suggestScale(sheet: Sheet, extent: { width: number; height: number }): number | null {
  return SCALES.find((scale) => fits(sheet, scale, extent)) ?? null;
}

/** « 1:75 », « 75 » ou « 1/75 » : le dénominateur, ou null. */
export function parseScale(text: string): number | null {
  const match = /^\s*(?:1\s*[:/]\s*)?(\d+)\s*$/.exec(text);
  const scale = match ? Number(match[1]) : NaN;
  return scale >= 1 ? scale : null;
}

/** Barre d'échelle : la plus grande longueur ronde (1, 2 ou 5 × 10^k mètres) qui tient dans `maxMm`. */
export function scaleBar(scale: number, maxMm: number): { metres: number; mm: number; divisions: number } {
  let metres = 0.1;
  for (let exponent = -1; exponent <= 3; exponent++) {
    for (const lead of [1, 2, 5]) {
      const candidate = lead * 10 ** exponent;
      if (mmOf(candidate, scale) <= maxMm + 1e-9) metres = candidate;
    }
  }
  const lead = Math.round(metres / 10 ** Math.floor(Math.log10(metres) + 1e-9));
  return { metres, mm: mmOf(metres, scale), divisions: lead === 2 ? 4 : 5 };
}

/** Le segment coupé au rectangle (Liang-Barsky), ou null s'il est entièrement dehors. */
export function clipSegment(x0: number, y0: number, x1: number, y1: number, rect: Rect): [number, number, number, number] | null {
  const dx = x1 - x0, dy = y1 - y0;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, x0 - rect.x], [dx, rect.x + rect.width - x0], [-dy, y0 - rect.y], [dy, rect.y + rect.height - y0]]) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/**
 * Où poser une tuile (pixels de l'image entière `image`) sur le cadre (millimètres). `overlap` agrandit de ce nombre de
 * millimètres, vers la droite et le bas, les tuiles qui ne sont pas au bord : les lecteurs de PDF laissent sinon un filet
 * clair entre deux images voisines.
 */
export function tilePlacement(tile: Rect, frame: Rect, image: { width: number; height: number }, overlap = 0): Rect {
  const mmPerPixelX = frame.width / image.width, mmPerPixelY = frame.height / image.height;
  return {
    x: frame.x + tile.x * mmPerPixelX,
    y: frame.y + tile.y * mmPerPixelY,
    width: tile.width * mmPerPixelX + (tile.x + tile.width < image.width ? overlap : 0),
    height: tile.height * mmPerPixelY + (tile.y + tile.height < image.height ? overlap : 0),
  };
}

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** L'angle du nord sur la feuille, en degrés dans le sens horaire depuis le haut de la page ; `right` et `up` sont ceux de la caméra. */
export function northAngle(north: readonly number[], right: readonly number[], up: readonly number[]): number {
  return (Math.atan2(dot(north, right), dot(north, up)) * 180) / Math.PI;
}

/**
 * Le cadre d'impression (mètres) dessiné sur la vue (pixels) : centré, à l'échelle de l'écran (`viewHeight` mètres sur toute
 * la hauteur). `overflow` : il dépasse la vue, une partie ne se voit pas.
 */
export function frameOnScreen(frame: { width: number; height: number }, viewHeight: number, viewport: { width: number; height: number }): Rect & { overflow: boolean } {
  const pixelsPerMetre = viewport.height / viewHeight;
  const width = frame.width * pixelsPerMetre, height = frame.height * pixelsPerMetre;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height, overflow: width > viewport.width + 0.5 || height > viewport.height + 0.5 };
}

/** Le plus grand rectangle de proportions `aspect` (largeur / hauteur) centré dans la vue, avec une marge relative. */
export function fitRect(aspect: number, viewport: { width: number; height: number }, margin = 0.06): Rect {
  const room = { width: viewport.width * (1 - margin), height: viewport.height * (1 - margin) };
  const width = Math.min(room.width, room.height * aspect), height = width / aspect;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

export interface TitleBlockCells { file: Rect; view: Rect; scale: Rect; date: Rect; author: Rect; bar: Rect; north: Rect }

/** Les cases du cartouche : texte à gauche, barre d'échelle, puis la case carrée de la flèche du nord. */
export function titleBlockCells(sheet: Sheet): TitleBlockCells {
  const { x, y, width, height } = sheet.titleBlock;
  const north = { x: x + width - height, y, width: height, height };
  const bar = { x: north.x - 0.3 * width, y, width: 0.3 * width, height };
  const room = bar.x - x, half = height / 2;
  return {
    file: { x, y, width: room / 2, height: half },
    view: { x, y: y + half, width: room / 2, height: half },
    scale: { x: x + room / 2, y, width: room / 2, height: half },
    date: { x: x + room / 2, y: y + half, width: room / 4, height: half },
    author: { x: x + (3 * room) / 4, y: y + half, width: room / 4, height: half },
    bar, north,
  };
}

// ------------------------------------------------------------------ rapports (pages qui se suivent)

/**
 * Des blocs posés les uns sous les autres dans la zone `top`..`bottom` (mm) de pages successives, séparés de `gap` : un bloc
 * qui ne tient plus passe en haut de la page suivante, et un bloc `keepWithNext` (un titre) part avec le suivant. Un bloc
 * plus haut que la zone a une page à lui.
 */
export function flowLayout(blocks: readonly { height: number; keepWithNext?: boolean }[], area: { top: number; bottom: number }, gap = 0): { page: number; y: number }[] {
  let page = 0, y = area.top;
  return blocks.map((block, i) => {
    const needed = block.height + (block.keepWithNext && blocks[i + 1] ? gap + blocks[i + 1].height : 0);
    if (y > area.top && y + needed > area.bottom) {
      page++;
      y = area.top;
    }
    const at = { page, y };
    y += block.height + gap;
    return at;
  });
}

/** Le texte coupé en lignes de `width` mm à `size` points (Helvetica : environ 0,5 em par lettre), au plus `maxLines`. */
export function wrapText(text: string, width: number, size: number, maxLines = Infinity): string[] {
  const room = Math.max(1, Math.floor(width / (size * 0.1764)));
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length <= room) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (rest.length > room) {
        lines.push(rest.slice(0, room));
        rest = rest.slice(room);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = `${last.length + 3 > room ? last.slice(0, Math.max(0, room - 3)) : last}...`;
  return kept;
}
