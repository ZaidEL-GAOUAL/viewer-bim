// Géoïde EGM96 : hauteur du niveau moyen des mers au-dessus de l'ellipsoïde WGS84 (de −107 à
// +85 m selon le lieu, +45 m environ en France). Les altitudes des maquettes (IFC) et du relief
// gratuit comptent au-dessus de la mer ; Cesium (relief et bâtiments ion, tuiles Google) compte
// au-dessus de l'ellipsoïde. Cette grille au demi-degré (EGM96 de la NGA, lue par PROJ, int16 en
// centimètres, 520 ko) fait passer de l'une à l'autre : erreur sous 0,5 m en France, 2 m ailleurs.

export const GEOID_STEP = 0.5;
export const GEOID_ROWS = 361;
export const GEOID_COLS = 721;

export class Geoid {
  private readonly centimetres: Int16Array;

  constructor(centimetres: Int16Array) {
    if (centimetres.length !== GEOID_ROWS * GEOID_COLS) throw new Error('Grille du géoïde incomplète.');
    this.centimetres = centimetres;
  }

  /** Hauteur du géoïde (m) au-dessus de l'ellipsoïde, interpolée entre les nœuds voisins. */
  height(latitude: number, longitude: number): number {
    const lat = Math.max(-90, Math.min(90, latitude));
    const lon = ((((longitude + 180) % 360) + 360) % 360) - 180;
    const fy = (lat + 90) / GEOID_STEP;
    const fx = (lon + 180) / GEOID_STEP;
    const y0 = Math.min(Math.floor(fy), GEOID_ROWS - 2);
    const x0 = Math.min(Math.floor(fx), GEOID_COLS - 2);
    const ty = fy - y0;
    const tx = fx - x0;
    const at = (row: number, col: number) => this.centimetres[row * GEOID_COLS + col];
    const south = at(y0, x0) * (1 - tx) + at(y0, x0 + 1) * tx;
    const north = at(y0 + 1, x0) * (1 - tx) + at(y0 + 1, x0 + 1) * tx;
    return (south * (1 - ty) + north * ty) / 100;
  }
}

/** Lit la grille binaire : int16 petit-boutiste, lignes de latitude −90 → 90, colonnes de longitude −180 → 180. */
export function parseGeoid(buffer: ArrayBuffer): Geoid {
  if (buffer.byteLength !== GEOID_ROWS * GEOID_COLS * 2) throw new Error(`Grille du géoïde inattendue (${buffer.byteLength} octets).`);
  const view = new DataView(buffer);
  const values = new Int16Array(GEOID_ROWS * GEOID_COLS);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);
  return new Geoid(values);
}

let loading: Promise<Geoid> | null = null;

/** Charge la grille une seule fois ; un échec laisse la possibilité de réessayer. */
export function loadGeoid(url: string): Promise<Geoid> {
  if (!loading) {
    loading = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`géoïde : ${response.status}`);
      return parseGeoid(await response.arrayBuffer());
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}
