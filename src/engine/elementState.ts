import { DataTexture, NearestFilter, RGBAFormat, UnsignedByteType, type Color, type IUniform, type Material } from 'three';

export const FLAG_VISIBLE = 1;
export const FLAG_COLORED = 2;
export const FLAG_SELECTED = 4;
/** Élément dont le maillage n'est pas un solide fermé : exclu du remplissage des coupes. */
export const FLAG_OPEN = 8;

/**
 * État d'affichage de chaque élément, stocké dans une texture lue par le vertex shader :
 * RVB = couleur imposée (sRGB), alpha = drapeaux. Masquer ou colorer un élément revient
 * à écrire un texel, quelle que soit la taille du modèle.
 */
export class ElementState {
  readonly count: number;
  readonly data: Uint8Array;
  readonly texture: DataTexture;

  constructor(count: number) {
    this.count = count;
    const width = Math.max(1, Math.min(count, 1024));
    const height = Math.max(1, Math.ceil(count / width));
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < count; i++) this.data[i * 4 + 3] = FLAG_VISIBLE;
    this.texture = new DataTexture(this.data, width, height, RGBAFormat, UnsignedByteType);
    this.texture.minFilter = NearestFilter;
    this.texture.magFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  private setFlag(index: number, flag: number, on: boolean): void {
    const at = index * 4 + 3;
    this.data[at] = on ? this.data[at] | flag : this.data[at] & ~flag;
  }

  isVisible(index: number): boolean {
    return (this.data[index * 4 + 3] & FLAG_VISIBLE) !== 0;
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

  /** Envoie les modifications au GPU (une seule fois après un lot de changements). */
  commit(): void {
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

const PARS = /* glsl */ `
attribute float aElement;
uniform highp sampler2D uElementState;
uniform vec3 uSelectColor;
varying float vBimFlat;
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
int bimFlags = int( bimState.a * 255.0 + 0.5 );
vBimFlat = 0.0;
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
	if ( ( bimFlags & ${FLAG_COLORED} ) != 0 ) {
		vColor.rgb = bimState.rgb;
		vBimFlat = 1.0;
	}
	vColor.rgb = bimSRGBToLinear( vColor.rgb );
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
`;

const FRAGMENT_MAP = /* glsl */ `
#ifdef USE_MAP
	diffuseColor.rgb = mix( diffuseColor.rgb, diffuse, vBimFlat );
#endif
`;

// Un élément masqué a tous ses sommets rejetés hors du volume de vue : ses triangles
// sont éliminés avant la rastérisation, sans toucher à la géométrie.
const HIDE = /* glsl */ `
bool bimHidden = ( bimFlags & ${FLAG_VISIBLE} ) == 0;
#ifdef BIM_SOLID_ONLY
	bimHidden = bimHidden || ( bimFlags & ${FLAG_OPEN} ) != 0;
#endif
if ( bimHidden ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`;

/** Branche un matériau three.js sur la texture d'état des éléments. */
export function applyElementState(material: Material, state: ElementState, selectColor: IUniform<Color>): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uElementState = { value: state.texture };
    shader.uniforms.uSelectColor = selectColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${COLOR}`)
      .replace(/\}\s*$/, `${HIDE}\n}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAGMENT_MAP}`);
  };
  material.customProgramCacheKey = () => 'bim-element-state';
}
