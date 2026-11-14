// Un écrivain DXF ASCII (AutoCAD R2000, « AC1015 », lu par AutoCAD, BricsCAD et Revit) : en-tête en mètres, table des
// calques, polylignes légères (`LWPOLYLINE`) pour les boucles fermées, `LINE` pour les segments ouverts, `TEXT` pour les
// notes. Aucune dépendance. Les accents s'écrivent `\U+XXXX` : le fichier reste de l'ASCII pur, quel que soit le lecteur.

export interface DxfLayer { name: string; /** Couleur AutoCAD (ACI), 1 à 255. */ color: number }
export interface DxfPolyline { layer: string; points: readonly (readonly [number, number])[]; closed: boolean; /** Altitude (Z) de la polyligne. */ elevation?: number }
export interface DxfLine { layer: string; from: readonly [number, number]; to: readonly [number, number]; elevation?: number }
export interface DxfTextItem { layer: string; x: number; y: number; height: number; text: string; elevation?: number }
export interface DxfDrawing {
  layers: readonly DxfLayer[];
  polylines: readonly DxfPolyline[];
  lines?: readonly DxfLine[];
  texts?: readonly DxfTextItem[];
}

/** Nom du calque d'un élément sans valeur pour la propriété choisie. */
export const NO_VALUE_LAYER = 'Sans valeur';

/** Un nom de calque valide : sans les caractères interdits (< > / \ " : ; ? * | = , `), de 255 caractères au plus ; vide : « Sans valeur ». */
export function layerName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const name = (raw === undefined || raw === null ? '' : String(raw)).replace(/[<>/\\":;?*|=,`]/g, '_').replace(/[\u0000-\u001f]/g, '').trim();
  return name === '' ? NO_VALUE_LAYER : name.slice(0, 255);
}

/** Un texte en ASCII : chaque unité UTF-16 au-delà de 0x7F devient `\U+XXXX`. */
export function dxfText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 10 || code === 13) out += ' ';
    else out += code < 0x80 ? text[i] : `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

let palette: [number, number, number][] | null = null;

/** Les 255 couleurs AutoCAD : 1 à 9 fixes, 10 à 249 (24 teintes en 10 nuances), 250 à 255 des gris. */
function aciPalette(): [number, number, number][] {
  if (palette) return palette;
  const table: [number, number, number][] = [[0, 0, 0], [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 255, 255], [128, 128, 128], [192, 192, 192]];
  const shades: [number, number][] = [[1, 1], [0.5, 1], [1, 0.65], [0.5, 0.65], [1, 0.5], [0.5, 0.5], [1, 0.3], [0.5, 0.3], [1, 0.15], [0.5, 0.15]];
  for (let n = 0; n < 240; n++) {
    const hue = (Math.floor(n / 10) * 15) / 60, [saturation, value] = shades[n % 10];
    const channel = (offset: number) => {
      const k = (offset + hue) % 6;
      return Math.round(255 * value * (1 - saturation * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    table.push([channel(5), channel(3), channel(1)]);
  }
  for (const grey of [51, 91, 132, 173, 214, 255]) table.push([grey, grey, grey]);
  return (palette = table);
}

/** La couleur AutoCAD (ACI) la plus proche d'une couleur CSS « #rrggbb » ; 7 (blanc/noir) si elle est illisible. */
export function nearestAci(color: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return 7;
  const value = parseInt(match[1], 16), rgb = [value >> 16, (value >> 8) & 255, value & 255];
  let best = 7, bestDistance = Infinity;
  aciPalette().forEach(([r, g, b], index) => {
    if (index === 0) return;
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [index, distance];
  });
  return best;
}

/** Un nombre sans bruit de virgule flottante (microns) ni « -0 ». */
const num = (value: number): string => String(Number(value.toFixed(6)));

/** Le dessin au format DXF (texte ASCII, lignes séparées par « \n »). */
export function writeDxf(drawing: DxfDrawing): string {
  const out: string[] = [];
  const put = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? num(value) : value);
  let handle = 0x20;
  const next = () => (handle++).toString(16).toUpperCase();
  const layers = drawing.layers.some((layer) => layer.name === '0') ? drawing.layers : [{ name: '0', color: 7 }, ...drawing.layers];

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const extend = (x: number, y: number, z: number) => [x, y, z].forEach((value, i) => { min[i] = Math.min(min[i], value); max[i] = Math.max(max[i], value); });
  for (const polyline of drawing.polylines) for (const [x, y] of polyline.points) extend(x, y, polyline.elevation ?? 0);
  for (const line of drawing.lines ?? []) { extend(line.from[0], line.from[1], line.elevation ?? 0); extend(line.to[0], line.to[1], line.elevation ?? 0); }
  for (const text of drawing.texts ?? []) extend(text.x, text.y, text.elevation ?? 0);
  if (min[0] === Infinity) [min[0], min[1], min[2], max[0], max[1], max[2]] = [0, 0, 0, 0, 0, 0];

  const entity = (type: string, layer: string, marker: string) => {
    put(0, type);
    put(5, next());
    put(100, 'AcDbEntity');
    put(8, dxfText(layer));
    put(100, marker);
  };

  // Entités d'abord (leurs poignées viennent après celles des tables), l'en-tête ensuite : il porte la dernière poignée.
  const section = (name: string) => { put(0, 'SECTION'); put(2, name); };
  const table = (name: string, count: number) => { put(0, 'TABLE'); put(2, name); put(5, next()); put(100, 'AcDbSymbolTable'); put(70, count); };

  section('TABLES');
  table('APPID', 1);
  put(0, 'APPID'); put(5, next()); put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbRegAppTableRecord'); put(2, 'ACAD'); put(70, 0);
  put(0, 'ENDTAB');
  table('LTYPE', 1);
  put(0, 'LTYPE'); put(5, next()); put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbLinetypeTableRecord'); put(2, 'CONTINUOUS'); put(70, 0); put(3, 'Solid line'); put(72, 65); put(73, 0); put(40, 0);
  put(0, 'ENDTAB');
  table('LAYER', layers.length);
  for (const layer of layers) {
    put(0, 'LAYER'); put(5, next()); put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbLayerTableRecord');
    put(2, dxfText(layer.name)); put(70, 0); put(62, layer.color); put(6, 'CONTINUOUS');
  }
  put(0, 'ENDTAB');
  table('STYLE', 1);
  put(0, 'STYLE'); put(5, next()); put(100, 'AcDbSymbolTableRecord'); put(100, 'AcDbTextStyleTableRecord'); put(2, 'STANDARD'); put(70, 0); put(40, 0); put(41, 1); put(50, 0); put(71, 0); put(42, 0.2); put(3, 'txt'); put(4, '');
  put(0, 'ENDTAB');
  put(0, 'ENDSEC');

  section('ENTITIES');
  for (const polyline of drawing.polylines) {
    if (polyline.points.length < 2) continue;
    entity('LWPOLYLINE', polyline.layer, 'AcDbPolyline');
    put(90, polyline.points.length);
    put(70, polyline.closed ? 1 : 0);
    put(43, 0);
    if (polyline.elevation !== undefined) put(38, polyline.elevation);
    for (const [x, y] of polyline.points) { put(10, x); put(20, y); }
  }
  for (const line of drawing.lines ?? []) {
    entity('LINE', line.layer, 'AcDbLine');
    put(10, line.from[0]); put(20, line.from[1]); put(30, line.elevation ?? 0);
    put(11, line.to[0]); put(21, line.to[1]); put(31, line.elevation ?? 0);
  }
  for (const text of drawing.texts ?? []) {
    entity('TEXT', text.layer, 'AcDbText');
    put(10, text.x); put(20, text.y); put(30, text.elevation ?? 0);
    put(40, text.height);
    put(1, dxfText(text.text));
    put(7, 'STANDARD');
    put(100, 'AcDbText');
  }
  put(0, 'ENDSEC');
  put(0, 'EOF');

  const head: string[] = [];
  const header = (code: number, value: string | number) => head.push(String(code), typeof value === 'number' ? num(value) : value);
  header(0, 'SECTION'); header(2, 'HEADER');
  header(9, '$ACADVER'); header(1, 'AC1015');
  header(9, '$HANDSEED'); header(5, handle.toString(16).toUpperCase());
  header(9, '$INSBASE'); header(10, 0); header(20, 0); header(30, 0);
  header(9, '$EXTMIN'); header(10, min[0]); header(20, min[1]); header(30, min[2]);
  header(9, '$EXTMAX'); header(10, max[0]); header(20, max[1]); header(30, max[2]);
  header(9, '$MEASUREMENT'); header(70, 1);
  header(9, '$INSUNITS'); header(70, 6);
  header(0, 'ENDSEC');
  return [...head, ...out].join('\n') + '\n';
}
