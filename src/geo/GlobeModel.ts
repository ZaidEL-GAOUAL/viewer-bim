// La maquette dessinée par Cesium en mode carte. Le viewer garde l'état (visibilité, couleurs,
// sélection, opacités, planning 4D, coupes) et le recopie ici : les textures d'état sont lues par
// un shader Cesium qui reproduit celui du viewer, l'affichage et l'opacité par élément passent par
// la table de features de Cesium (qui choisit les passes opaque / transparente), les plans de
// coupe deviennent des plans de découpe Cesium. Pendant ce temps, le modèle three.js est caché :
// une seule maquette à l'écran, posée sur le relief et parmi les bâtiments du globe.

import { FLAG_COLORED, FLAG_SELECTED } from '../engine/elementState.ts';
import type { Model } from '../engine/Model.ts';
import type { Viewer } from '../engine/Viewer.ts';
import { AXES } from '../engine/Sections.ts';
import { writeCesiumGlb } from './cesiumGlb.ts';

type Cesium = typeof import('cesium');
type CesiumModel = import('cesium').Model;
type FeatureTable = { setShow(featureId: number, show: boolean): void; setColor(featureId: number, color: import('cesium').Color): void };

/** Octet d'opacité signifiant « celle du matériau » ; les valeurs imposées vont de 0 à 254. */
const OPACITY_NONE = 255;

export type GlobeModelStatus = 'loading' | 'ready' | 'error';

const VERTEX = /* glsl */ `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  float index = float(vsInput.featureIds.featureId_0);
  vec2 texel = vec2(mod(index, u_bimSize.x), floor(index / u_bimSize.x));
  vec2 uv = (texel + 0.5) / u_bimSize;
  v_bimState = texture(u_bimState, uv);
  v_bimExtra = texture(u_bimExtra, uv);
}
`;

// Même logique que le shader du viewer (elementState.ts) : couleur imposée, orange des travaux en
// cours, surbrillance de sélection, opacité imposée puis fondu ; éclairage de Lambert du viewer
// (hémisphère et deux directionnelles fixes dans le repère de la maquette).
const FRAGMENT = /* glsl */ `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  int flags = int(v_bimState.a * 255.0 + 0.5);
  int schedule = int(v_bimExtra.g * 255.0 + 0.5);
  vec4 vertexColor = fsInput.attributes.color_0;
  vec3 color = czm_srgbToLinear(vertexColor.rgb);
  if ((flags & ${FLAG_COLORED}) != 0) color = czm_srgbToLinear(v_bimState.rgb);
  if (schedule == 2) color = czm_srgbToLinear(vec3(245.0, 158.0, 11.0) / 255.0);
  if ((flags & ${FLAG_SELECTED}) != 0) color = mix(color, u_bimSelect, 0.8);
  float alpha = vertexColor.a;
  float opacity = v_bimExtra.r * 255.0;
  if (opacity < 254.5) alpha = opacity / 254.0;
  alpha *= v_bimExtra.b;
  vec3 normal = normalize(fsInput.attributes.normalEC);
  if (czm_backFacing()) normal = -normal;
  vec3 up = normalize(czm_normal * vec3(0.0, 1.0, 0.0));
  vec3 key = normalize(czm_normal * vec3(0.6, 1.0, 0.8));
  vec3 fill = normalize(czm_normal * vec3(-0.8, 0.3, -0.5));
  vec3 ground = czm_srgbToLinear(vec3(138.0, 143.0, 152.0) / 255.0);
  vec3 irradiance = mix(ground, vec3(1.0), 0.5 + 0.5 * dot(normal, up)) * 1.9
    + max(dot(normal, key), 0.0) * 1.7
    + max(dot(normal, fill), 0.0) * 0.7;
  material.diffuse = color * irradiance / czm_pi;
  material.alpha = alpha;
}
`;

export class GlobeModel {
  status: GlobeModelStatus = 'loading';
  error = '';
  onStatus: (status: GlobeModelStatus) => void = () => {};
  private readonly cesium: Cesium;
  private readonly scene: import('cesium').Scene;
  private readonly viewer: Viewer;
  private readonly model: Model;
  private readonly shader: import('cesium').CustomShader;
  private readonly clipping: import('cesium').ClippingPlaneCollection;
  private readonly width: number;
  private readonly height: number;
  /** Dernières valeurs envoyées à Cesium : seules les différences sont retransmises. */
  private readonly stateSent: Uint8Array;
  private readonly extra: Uint8Array;
  private readonly alphaSent: Uint8Array;
  private readonly selectSent = new Float32Array(3);
  private readonly scratchColor: import('cesium').Color;
  private cesiumModel: CesiumModel | null = null;
  private url: string | null = null;
  private disposed = false;

  constructor(cesium: Cesium, scene: import('cesium').Scene, viewer: Viewer, model: Model, modelMatrix: import('cesium').Matrix4) {
    this.cesium = cesium;
    this.scene = scene;
    this.viewer = viewer;
    this.model = model;
    const { width, height } = model.state.texture.image;
    this.width = width;
    this.height = height;
    this.stateSent = new Uint8Array(width * height * 4);
    this.extra = new Uint8Array(width * height * 4);
    this.alphaSent = new Uint8Array(model.count).fill(255);
    for (let i = 0; i < this.extra.length; i += 4) {
      this.extra[i] = OPACITY_NONE;
      this.extra[i + 2] = 255;
      this.extra[i + 3] = 255;
    }
    this.scratchColor = cesium.Color.WHITE.clone();
    const select = viewer.selectColor.value;
    this.selectSent.set([select.r, select.g, select.b]);
    this.stateSent.set(model.state.data);
    this.shader = new cesium.CustomShader({
      mode: cesium.CustomShaderMode.MODIFY_MATERIAL,
      lightingModel: cesium.LightingModel.UNLIT,
      translucencyMode: cesium.CustomShaderTranslucencyMode.INHERIT,
      uniforms: {
        u_bimState: { type: cesium.UniformType.SAMPLER_2D, value: this.textureUniform(this.stateSent) },
        u_bimExtra: { type: cesium.UniformType.SAMPLER_2D, value: this.textureUniform(this.extra) },
        u_bimSize: { type: cesium.UniformType.VEC2, value: new cesium.Cartesian2(width, height) },
        u_bimSelect: { type: cesium.UniformType.VEC3, value: new cesium.Cartesian3(select.r, select.g, select.b) },
      },
      varyings: { v_bimState: cesium.VaryingType.VEC4, v_bimExtra: cesium.VaryingType.VEC4 },
      vertexShaderText: VERTEX,
      fragmentShaderText: FRAGMENT,
    });
    // Comme dans le viewer, un point est coupé dès qu'il est du mauvais côté d'un plan actif.
    this.clipping = new cesium.ClippingPlaneCollection({ unionClippingRegions: true, edgeWidth: 0 });
    void this.load(modelMatrix);
  }

  get ready(): boolean {
    return this.cesiumModel?.ready === true;
  }

  private textureUniform(data: Uint8Array): import('cesium').TextureUniform {
    const cesium = this.cesium;
    return new cesium.TextureUniform({
      typedArray: data.slice(),
      width: this.width,
      height: this.height,
      minificationFilter: cesium.TextureMinificationFilter.NEAREST,
      magnificationFilter: cesium.TextureMagnificationFilter.NEAREST,
    });
  }

  private async load(modelMatrix: import('cesium').Matrix4): Promise<void> {
    const cesium = this.cesium;
    try {
      const glb = writeCesiumGlb(this.model);
      this.url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
      const cesiumModel = await cesium.Model.fromGltfAsync({
        url: this.url,
        modelMatrix,
        // Les sommets sont déjà dans le repère du viewer : aucune correction d'axes de Cesium.
        upAxis: cesium.Axis.Z,
        forwardAxis: cesium.Axis.X,
        allowPicking: false,
        customShader: this.shader,
        clippingPlanes: this.clipping,
      });
      if (this.disposed) {
        cesiumModel.destroy();
        return;
      }
      this.cesiumModel = cesiumModel;
      cesiumModel.readyEvent.addEventListener(() => this.onReady());
      this.scene.primitives.add(cesiumModel);
      this.scene.requestRender();
    } catch (error) {
      if (this.disposed) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.setStatus('error');
    }
  }

  private onReady(): void {
    if (this.disposed) return;
    this.syncSections();
    this.syncState();
    this.model.state.onChange.add(this.onState);
    this.viewer.onSectionsChanged.add(this.syncSections);
    // Le globe dessine désormais la maquette ; le viewer ne garde que ses repères (mesures, coupes…).
    this.model.group.visible = false;
    this.viewer.invalidate();
    this.setStatus('ready');
  }

  private setStatus(status: GlobeModelStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  /** Nouvelle position sur Terre : la maquette suit sans être rechargée. */
  setModelMatrix(modelMatrix: import('cesium').Matrix4): void {
    if (!this.cesiumModel) return;
    this.cesium.Matrix4.clone(modelMatrix, this.cesiumModel.modelMatrix);
    this.scene.requestRender();
  }

  private readonly onState = (): void => {
    this.syncState();
  };

  /** Recopie vers Cesium ce qui a changé dans l'état des éléments (texture d'état, opacités, sélection). */
  private syncState(): void {
    const cesiumModel = this.cesiumModel;
    if (!cesiumModel || this.disposed) return;
    const { state, count } = this.model;
    const data = state.data;
    let stateDirty = false;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== this.stateSent[i]) {
        stateDirty = true;
        break;
      }
    }
    if (stateDirty) {
      this.stateSent.set(data);
      this.shader.setUniform('u_bimState', this.textureUniform(this.stateSent));
    }

    const tables = (cesiumModel as unknown as { featureTables?: FeatureTable[]; featureTableId?: number });
    const table = tables.featureTables?.[tables.featureTableId ?? 0];
    let extraDirty = false;
    let featuresDirty = false;
    const color = this.scratchColor;
    for (let i = 0; i < count; i++) {
      const opacity = state.opacityOf(i);
      const fade = state.scheduleOpacityOf(i);
      const alpha = state.isRendered(i) ? Math.round((opacity ?? 1) * fade * 255) : 0;
      if (table && alpha !== this.alphaSent[i]) {
        this.alphaSent[i] = alpha;
        table.setShow(i, alpha !== 0);
        color.alpha = alpha / 255;
        table.setColor(i, color);
        featuresDirty = true;
      }
      const at = i * 4;
      const opacityByte = opacity === null ? OPACITY_NONE : Math.round(opacity * 254);
      const schedule = state.scheduleStateOf(i);
      const fadeByte = Math.round(fade * 255);
      if (this.extra[at] !== opacityByte || this.extra[at + 1] !== schedule || this.extra[at + 2] !== fadeByte) {
        this.extra[at] = opacityByte;
        this.extra[at + 1] = schedule;
        this.extra[at + 2] = fadeByte;
        extraDirty = true;
      }
    }
    if (extraDirty) this.shader.setUniform('u_bimExtra', this.textureUniform(this.extra));

    const select = this.viewer.selectColor.value;
    if (select.r !== this.selectSent[0] || select.g !== this.selectSent[1] || select.b !== this.selectSent[2]) {
      this.selectSent.set([select.r, select.g, select.b]);
      this.shader.setUniform('u_bimSelect', new this.cesium.Cartesian3(select.r, select.g, select.b));
      stateDirty = true;
    }
    if (stateDirty || extraDirty || featuresDirty) this.scene.requestRender();
  }

  /** Les plans de coupe actifs du viewer, dans le repère de la maquette (celui de modelMatrix). */
  private readonly syncSections = (): void => {
    if (!this.cesiumModel || this.disposed) return;
    const cesium = this.cesium;
    const { planes, enabled } = this.viewer.sections;
    this.clipping.removeAll();
    for (const axis of AXES) {
      if (!enabled[axis]) continue;
      const { normal, constant } = planes[axis];
      this.clipping.add(new cesium.ClippingPlane(new cesium.Cartesian3(normal.x, normal.y, normal.z), constant));
    }
    this.scene.requestRender();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.model.state.onChange.delete(this.onState);
    this.viewer.onSectionsChanged.delete(this.syncSections);
    if (this.cesiumModel) {
      this.scene.primitives.remove(this.cesiumModel);
      this.cesiumModel = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.model.group.visible = true;
    this.viewer.invalidate();
    this.scene.requestRender();
  }
}
