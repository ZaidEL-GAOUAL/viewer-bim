import { DataTexture, FloatType, NearestFilter, RedFormat, RGFormat, RGBAFormat, UnsignedByteType, type Color, type IUniform, type Material } from 'three';

export const FLAG_VISIBLE = 1;
export const FLAG_COLORED = 2;
export const FLAG_SELECTED = 4;
/** Élément dont le maillage n'est pas un solide fermé : exclu du remplissage des coupes. */
export const FLAG_OPEN = 8;
/** Bits 4 à 6 : priorité d'affichage (0 à 7) quand deux éléments ont des faces confondues. */
const PRIORITY_SHIFT = 4;
const PRIORITY_MASK = 7;
const SCHEDULE_FADE_MS = 240;

export interface SchedulePresentationOptions {
  /** Fondu d'apparition uniquement pour les éléments précédemment « à venir ». */
  animate?: boolean;
  /** Horloge monotone partagée avec requestAnimationFrame ; injectable pour les tests. */
  nowMs?: number;
}

/**
 * Avance en profondeur donnée à un élément, en pas du tampon de profondeur. Deux éléments dont
 * des faces sont exactement dans le même plan (une poutre noyée dans une dalle, par exemple) se
 * disputeraient chaque pixel ; avec cette avance fixe, c'est toujours le même qui est affiché.
 * La même valeur départage les clics (voir Model.raycast).
 */
export function depthPriority(flags: number, index: number): number {
  return ((flags >> PRIORITY_SHIFT) & PRIORITY_MASK) * 3 + (index & 1) * 1.5;
}

/**
 * État d'affichage de chaque élément, stocké dans une texture lue par le vertex shader :
 * RVB = couleur imposée (sRGB), alpha = drapeaux. Masquer ou colorer un élément revient
 * à écrire un texel, quelle que soit la taille du modèle.
 */
export class ElementState {
  readonly count: number;
  data: Uint8Array;
  texture: DataTexture;
  /** Uniforme partagé par tous les matériaux du modèle. */
  readonly uniform: IUniform<DataTexture>;
  readonly opacityUniform: IUniform<DataTexture>;
  /** Présentation 4D indépendante : 0 contexte, 1 à venir, 2 en cours, 3 terminé. */
  readonly scheduleUniform: IUniform<DataTexture>;
  readonly onOpacityChange = new Set<() => void>();
  /** Prévenu après chaque lot de changements (commit, planning, opacité) : un autre moteur peut recopier l'état. */
  readonly onChange = new Set<() => void>();
  private readonly opacityData: Float32Array;
  private readonly scheduleData: Uint8Array;
  /** Rouge = état 4D ; vert = facteur de fondu. Une seule texture et un seul accès GPU. */
  private readonly scheduleTexels: Uint8Array;
  private readonly scheduleFades = new Map<number, number>();
  private translucent = 0;

  constructor(count: number) {
    this.count = count;
    this.data = new Uint8Array(0);
    this.texture = this.allocate(count);
    for (let i = 0; i < count; i++) this.data[i * 4 + 3] = FLAG_VISIBLE;
    this.uniform = { value: this.texture };
    const { width, height } = this.texture.image;
    this.opacityData = new Float32Array(width * height).fill(-1);
    const opacity = new DataTexture(this.opacityData, width, height, RedFormat, FloatType);
    opacity.minFilter = opacity.magFilter = NearestFilter;
    opacity.generateMipmaps = false;
    opacity.needsUpdate = true;
    this.opacityUniform = { value: opacity };
    this.scheduleData = new Uint8Array(width * height);
    this.scheduleTexels = new Uint8Array(width * height * 2);
    for (let i = 1; i < this.scheduleTexels.length; i += 2) this.scheduleTexels[i] = 255;
    const schedule = new DataTexture(this.scheduleTexels, width, height, RGFormat, UnsignedByteType);
    schedule.minFilter = schedule.magFilter = NearestFilter;
    schedule.generateMipmaps = false;
    schedule.needsUpdate = true;
    this.scheduleUniform = { value: schedule };
  }

  private allocate(count: number): DataTexture {
    const width = Math.max(1, Math.min(count, 1024));
    const height = Math.max(1, Math.ceil(count / width));
    const data = new Uint8Array(width * height * 4);
    data.set(this.data.subarray(0, Math.min(this.data.length, data.length)));
    this.data = data;
    const texture = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
    texture.minFilter = NearestFilter;
    texture.magFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  private setFlag(index: number, flag: number, on: boolean): void {
    const at = index * 4 + 3;
    this.data[at] = on ? this.data[at] | flag : this.data[at] & ~flag;
  }

  isVisible(index: number): boolean {
    return (this.data[index * 4 + 3] & FLAG_VISIBLE) !== 0;
  }

  /** La 4D et l'opacité restent indépendantes du masque sauvegardé par l'isolation. */
  isRendered(index: number): boolean {
    return this.isVisible(index) && this.opacityData[index] !== 0 && this.scheduleData[index] !== 1 && this.scheduleOpacityOf(index) > 0;
  }

  /**
   * Change uniquement la présentation 4D. La validation précède toute écriture, puis les valeurs
   * sont copiées : un tampon réutilisé par le lecteur ne change pas une frame déjà affichée.
   * null retire la simulation et révèle immédiatement les filtres et couleurs courants.
   */
  setSchedule(states: Uint8Array | null, options: SchedulePresentationOptions = {}): void {
    if (states !== null) {
      if (!(states instanceof Uint8Array) || states.length !== this.count) {
        throw new Error('Le planning doit fournir un état par élément du modèle.');
      }
      for (const status of states) {
        if (status > 3) throw new Error('Un état du planning doit être compris entre 0 et 3.');
      }
    }
    const animate = states !== null && options.animate === true;
    const now = animate ? options.nowMs ?? performance.now() : 0;
    if (!Number.isFinite(now)) throw new Error('Horloge du planning invalide.');
    const wasTranslucent = this.hasTranslucency;
    for (let index = 0; index < this.count; index++) {
      const previous = this.scheduleData[index];
      const next = states?.[index] ?? 0;
      if (!animate || next === 1) {
        this.scheduleFades.delete(index);
        this.scheduleTexels[index * 2 + 1] = 255;
      } else if (previous === 1 && this.isVisible(index) && this.opacityData[index] !== 0) {
        this.scheduleFades.set(index, now);
        this.scheduleTexels[index * 2 + 1] = 0;
      }
      this.scheduleData[index] = next;
      this.scheduleTexels[index * 2] = next;
    }
    this.scheduleUniform.value.needsUpdate = true;
    if (this.hasTranslucency !== wasTranslucent) for (const notify of this.onOpacityChange) notify();
    this.notifyChange();
  }

  /** État 4D d'un élément : 0 contexte, 1 à venir, 2 en cours, 3 terminé. */
  scheduleStateOf(index: number): number { return this.scheduleData[index]; }

  private notifyChange(): void {
    for (const notify of this.onChange) notify();
  }

  get hasScheduleFade(): boolean { return this.scheduleFades.size > 0; }

  /** Facteur de présentation ; ne change jamais l'opacité choisie par l'utilisateur. */
  scheduleOpacityOf(index: number): number { return this.scheduleTexels[index * 2 + 1] / 255; }

  /** Ne parcourt que les apparitions en cours. Retourne vrai tant qu'une frame est nécessaire. */
  advanceScheduleFade(nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) throw new Error('Horloge du planning invalide.');
    if (!this.hasScheduleFade) return false;
    const wasTranslucent = this.hasTranslucency;
    let changed = false;
    for (const [index, started] of this.scheduleFades) {
      const elapsed = Math.max(0, Math.min(1, (nowMs - started) / SCHEDULE_FADE_MS));
      const value = Math.round(elapsed * elapsed * (3 - 2 * elapsed) * 255);
      if (this.scheduleTexels[index * 2 + 1] !== value) {
        this.scheduleTexels[index * 2 + 1] = value;
        changed = true;
      }
      if (elapsed === 1) this.scheduleFades.delete(index);
    }
    if (changed) {
      this.scheduleUniform.value.needsUpdate = true;
      this.notifyChange();
    }
    if (this.hasTranslucency !== wasTranslucent) for (const notify of this.onOpacityChange) notify();
    return this.hasScheduleFade;
  }

  isSelected(index: number): boolean {
    return (this.data[index * 4 + 3] & FLAG_SELECTED) !== 0;
  }

  /** Vrai si le maillage de l'élément n'est pas un solide fermé. */
  isOpen(index: number): boolean {
    return (this.data[index * 4 + 3] & FLAG_OPEN) !== 0;
  }

  setVisible(index: number, visible: boolean): void {
    this.setFlag(index, FLAG_VISIBLE, visible);
  }

  setSelected(index: number, selected: boolean): void {
    this.setFlag(index, FLAG_SELECTED, selected);
  }

  setOpen(index: number, open: boolean): void {
    this.setFlag(index, FLAG_OPEN, open);
  }

  /** Priorité d'affichage, de 0 (grand élément) à 7 (petit élément) : le plus petit l'emporte. */
  setPriority(index: number, level: number): void {
    const at = index * 4 + 3;
    const clamped = Math.max(0, Math.min(PRIORITY_MASK, Math.floor(level)));
    this.data[at] = (this.data[at] & ~(PRIORITY_MASK << PRIORITY_SHIFT)) | (clamped << PRIORITY_SHIFT);
  }

  /** Couleur imposée, en octets sRGB. */
  setColor(index: number, r: number, g: number, b: number): void {
    const at = index * 4;
    this.data[at] = r;
    this.data[at + 1] = g;
    this.data[at + 2] = b;
    this.data[at + 3] |= FLAG_COLORED;
  }

  clearColor(index: number): void {
    this.setFlag(index, FLAG_COLORED, false);
  }

  get hasTranslucency(): boolean { return this.translucent > 0 || this.hasScheduleFade; }

  /** null conserve l'alpha du matériau chargé ; une valeur impose l'opacité de l'élément. */
  opacityOf(index: number): number | null {
    const value = this.opacityData[index];
    return value >= 0 ? value : null;
  }

  setOpacity(index: number, opacity: number | null): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return;
    if (opacity !== null && !Number.isFinite(opacity)) throw new Error('Opacité invalide.');
    const value = opacity === null ? -1 : Math.max(0, Math.min(1, opacity));
    const previous = this.opacityData[index];
    if (previous === value) return;
    if (previous > 0 && previous < 1) this.translucent--;
    this.opacityData[index] = value;
    if (value > 0 && value < 1) this.translucent++;
    for (const notify of this.onOpacityChange) notify();
  }

  clearOpacity(index: number): void { this.setOpacity(index, null); }

  /** Envoie les modifications au GPU (une seule fois après un lot de changements). */
  commit(): void {
    this.texture.needsUpdate = true;
    this.opacityUniform.value.needsUpdate = true;
    this.notifyChange();
  }

  dispose(): void {
    this.texture.dispose();
    this.opacityUniform.value.dispose();
    this.scheduleUniform.value.dispose();
    this.scheduleFades.clear();
    this.onOpacityChange.clear();
  }
}

const PARS = /* glsl */ `
attribute float aElement;
uniform highp sampler2D uElementState;
uniform highp sampler2D uElementOpacity;
uniform highp sampler2D uElementSchedule;
uniform vec3 uSelectColor;
varying float vBimFlat;
varying float vBimOpacity;
varying float vBimFade;
vec3 bimSRGBToLinear( vec3 c ) {
	return mix( pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), c / 12.92, vec3( lessThanEqual( c, vec3( 0.04045 ) ) ) );
}
`;

// Les couleurs de sommet et les couleurs imposées sont stockées en sRGB sur 8 bits
// (meilleure précision dans les teintes sombres) puis converties ici en linéaire.
const COLOR = /* glsl */ `
int bimIndex = int( aElement + 0.5 );
int bimWidth = textureSize( uElementState, 0 ).x;
vec4 bimState = texelFetch( uElementState, ivec2( bimIndex % bimWidth, bimIndex / bimWidth ), 0 );
vBimOpacity = texelFetch( uElementOpacity, ivec2( bimIndex % bimWidth, bimIndex / bimWidth ), 0 ).r;
vec2 bimPresentation = texelFetch( uElementSchedule, ivec2( bimIndex % bimWidth, bimIndex / bimWidth ), 0 ).rg;
int bimSchedule = int( bimPresentation.r * 255.0 + 0.5 );
vBimFade = bimPresentation.g;
int bimFlags = int( bimState.a * 255.0 + 0.5 );
vBimFlat = 0.0;
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	if ( ( bimFlags & ${FLAG_COLORED} ) != 0 ) {
		vColor.rgb = bimState.rgb;
		vBimFlat = 1.0;
	}
	vColor.rgb = bimSRGBToLinear( vColor.rgb );
	if ( bimSchedule == 2 ) {
		vColor.rgb = bimSRGBToLinear( vec3( 245.0, 158.0, 11.0 ) / 255.0 );
		vBimFlat = 1.0;
	}
	if ( ( bimFlags & ${FLAG_SELECTED} ) != 0 ) {
		vColor.rgb = mix( vColor.rgb, uSelectColor, 0.8 );
		vBimFlat = max( vBimFlat, 0.8 );
	}
#endif
`;

// Sur un matériau texturé, la texture multiplie la couleur : une couleur imposée ou la surbrillance
// de sélection seraient dénaturées. `vBimFlat` efface donc la texture à proportion.
const FRAGMENT_PARS = /* glsl */ `
varying float vBimFlat;
varying float vBimOpacity;
varying float vBimFade;
uniform int uBimOpacityPass;
`;

const FRAGMENT_MAP = /* glsl */ `
#ifdef USE_MAP
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuse, vBimFlat );
#endif
`;

// Un élément masqué a tous ses sommets rejetés hors du volume de vue : ses triangles
// sont éliminés avant la rastérisation, sans toucher à la géométrie.
const HIDE = /* glsl */ `
// Avance en profondeur propre à l'élément : départage les faces confondues sans scintillement.
// Un pas vaut la plus petite différence que distingue un tampon de profondeur de 24 bits.
gl_Position.z -= ( float( ( bimFlags >> ${PRIORITY_SHIFT} ) & ${PRIORITY_MASK} ) * 3.0 + float( bimIndex & 1 ) * 1.5 ) * 1.1920929e-7 * gl_Position.w;
bool bimHidden = ( bimFlags & ${FLAG_VISIBLE} ) == 0 || vBimOpacity == 0.0 || bimSchedule == 1 || vBimFade == 0.0;
#ifdef BIM_SOLID_ONLY
	bimHidden = bimHidden || ( bimFlags & ${FLAG_OPEN} ) != 0 || ( vBimOpacity >= 0.0 && vBimOpacity < 1.0 ) || vBimFade < 1.0;
#endif
if ( bimHidden ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`;

/** Branche un matériau three.js sur la texture d'état des éléments. */
export function applyElementState(material: Material, state: ElementState, selectColor: IUniform<Color>, opacityPass?: 'translucent'): void {
  // Opaques et transparences imposées sont dessinés séparément, sans modifier leurs maillages.
  const pass = opacityPass === 'translucent' ? 1 : material.transparent || !material.colorWrite ? 2 : 0;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uElementState = state.uniform;
    shader.uniforms.uElementOpacity = state.opacityUniform;
    shader.uniforms.uElementSchedule = state.scheduleUniform;
    shader.uniforms.uBimOpacityPass = { value: pass };
    shader.uniforms.uSelectColor = selectColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${COLOR}`)
      .replace(/\}\s*$/, `${HIDE}\n}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_MAP}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n
        bool bimTranslucent = (vBimOpacity >= 0.0 && vBimOpacity < 1.0) || vBimFade < 1.0;
        if (uBimOpacityPass == 0 && bimTranslucent) discard;
        if (uBimOpacityPass == 1 && !bimTranslucent) discard;
        if (vBimOpacity >= 0.0) diffuseColor.a = vBimOpacity;
      `)
      // Le fondu ne doit pas déplacer le seuil des textures découpées (alphaMode MASK).
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>\n diffuseColor.a *= vBimFade;`);
  };
  material.customProgramCacheKey = () => `bim-element-state-${pass}`;
}
