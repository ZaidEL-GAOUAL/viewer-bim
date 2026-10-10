// Relief gratuit et sans clé : les « Terrain Tiles » du programme AWS Open Data (Mapzen), tuiles
// PNG « terrarium » en grille Web Mercator (zoom 0 à 15) où la hauteur d'un pixel vaut
// R·256 + G + B/256 − 32768 mètres. Elles sont décodées ici en champs de hauteurs pour Cesium.
// Les fonds marins (hauteurs négatives) sont ramenés au niveau de la mer : le globe reste lisse
// sur les côtes, là où l'on pose des maquettes.

type Cesium = typeof import('cesium');

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE_PIXELS = 256;
/** Sommets par côté de tuile envoyés au globe : un sur quatre pixels, comme les tuiles Cesium. */
export const GRID = 65;
const MAX_LEVEL = 15;
export const TERRAIN_CREDIT = 'Relief : Terrain Tiles (AWS Open Data, Mapzen) — SRTM, ASTER GDEM, EU-DEM, ETOPO1…';

/** Hauteurs (m) d'une grille GRID × GRID échantillonnée dans les pixels RVBA d'une tuile terrarium. */
export function decodeTerrarium(pixels: ArrayLike<number>, size = TILE_PIXELS): Float32Array {
  const heights = new Float32Array(GRID * GRID);
  for (let row = 0; row < GRID; row++) {
    const y = Math.round((row * (size - 1)) / (GRID - 1));
    for (let col = 0; col < GRID; col++) {
      const x = Math.round((col * (size - 1)) / (GRID - 1));
      const at = (y * size + x) * 4;
      heights[row * GRID + col] = Math.max(0, pixels[at] * 256 + pixels[at + 1] + pixels[at + 2] / 256 - 32768);
    }
  }
  return heights;
}

/** Fournisseur de relief Cesium lisant les tuiles terrarium ; à passer à `scene.terrainProvider`. */
export function createTerrariumTerrainProvider(cesium: Cesium): import('cesium').TerrainProvider {
  const tilingScheme = new cesium.WebMercatorTilingScheme();
  const levelZeroError = cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(tilingScheme.ellipsoid, GRID, tilingScheme.getNumberOfXTilesAtLevel(0));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE_PIXELS;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D indisponible : impossible de décoder le relief.');

  const provider = {
    errorEvent: new cesium.Event(),
    credit: new cesium.Credit(TERRAIN_CREDIT),
    tilingScheme,
    hasWaterMask: false,
    hasVertexNormals: false,
    availability: undefined,
    requestTileGeometry(x: number, y: number, level: number, request?: import('cesium').Request) {
      const resource = new cesium.Resource({ url: TILE_URL, templateValues: { z: level, x, y }, request });
      const promise = resource.fetchImage({ preferImageBitmap: true, flipY: false, skipColorSpaceConversion: true });
      if (!promise) return undefined;
      return promise.then((image) => {
        context.drawImage(image, 0, 0, TILE_PIXELS, TILE_PIXELS);
        const { data } = context.getImageData(0, 0, TILE_PIXELS, TILE_PIXELS);
        return new cesium.HeightmapTerrainData({ buffer: decodeTerrarium(data), width: GRID, height: GRID, childTileMask: level < MAX_LEVEL ? 15 : 0 });
      });
    },
    getLevelMaximumGeometricError(level: number) {
      return levelZeroError / (1 << level);
    },
    getTileDataAvailable(_x: number, _y: number, level: number) {
      return level <= MAX_LEVEL;
    },
    loadTileDataAvailability() {
      return undefined;
    },
  };
  return provider as unknown as import('cesium').TerrainProvider;
}
