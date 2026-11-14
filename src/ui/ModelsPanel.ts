import { sourceIndexOf, type ModelSourceInfo } from '../data/federation.ts';
import { integer, plural } from '../data/text.ts';
import { filesFromList } from '../engine/loadModel.ts';
import { addModelFiles, federationBlocked, removeLastModel } from './addModel.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

/** Fichiers qu'« Ajouter… » accepte : un modèle 3D ou un IFC, et ses JSON, .bin et textures. */
export const MODEL_ACCEPT = '.ifc,.glb,.gltf,.usdz,.usda,.usd,.json,.bin,.png,.jpg,.jpeg,.webp';

/**
 * Carte « Maquettes » : les maquettes réunies dans la scène (voir data/federation.ts), leurs nombres d'éléments et de
 * triangles, les afficher ou les masquer, retirer la dernière ajoutée. `addButton` (barre d'outils, à côté d'« Ouvrir… »)
 * en ajoute une. Désactivée en mode carte : le globe dessine sa propre copie de la maquette.
 */
export class ModelsPanel {
  readonly label = 'Maquettes';
  readonly summary = 'Plusieurs maquettes ensemble : ajouter, afficher, retirer';
  readonly el: HTMLElement;
  readonly addButton: HTMLButtonElement;
  private readonly app: App;
  private readonly input = h('input', { attrs: { type: 'file', multiple: '', accept: MODEL_ACCEPT, hidden: '' } });
  private readonly list = h('div', { class: 'views-list' });
  private readonly status = h('p', { class: 'hint', attrs: { role: 'status' } });

  constructor(app: App) {
    this.app = app;
    this.input.addEventListener('change', () => {
      const files = this.input.files?.length ? filesFromList(this.input.files) : [];
      this.input.value = '';
      if (files.length) void addModelFiles(app, files).then(() => this.render());
    });
    const choose = () => {
      const blocked = federationBlocked(app);
      if (blocked) app.toast(blocked, true);
      else this.input.click();
    };
    this.addButton = button('Ajouter…', choose, { title: 'Ajouter une maquette à celle qui est ouverte (.ifc, .glb, .gltf, .usdz, avec son .json), placée par ses coordonnées d’origine' });
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les maquettes' } })),
      this.status, this.list,
      h('div', { class: 'dimensions-actions' }, button('Ajouter une maquette…', choose, { class: 'primary' }), this.input),
      h('p', { class: 'hint', text: 'Chaque élément reçoit la propriété « Modèle » (le nom de son fichier) : l’arbre, les filtres, les couleurs et le planning portent sur toutes les maquettes. « JSON ↓ » et « Modifications ↓ » écrivent un fichier par maquette, avec ses propres identifiants ; « GLB ↓ » les réunit. Seule la dernière maquette ajoutée se retire.' }),
    );
    for (const event of ['model', 'metadata', 'visibility'] as const) app.on(event, () => this.render());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) this.render();
    return open;
  }

  /** Les éléments d'une maquette, pièces de ses originaux comprises. */
  private elementsOf(index: number): number[] {
    const model = this.app.model!;
    const out: number[] = [];
    for (let i = 0; i < model.count; i++) if (sourceIndexOf(model, i) === index) out.push(i);
    return out;
  }

  private render(): void {
    if (this.el.hidden) return;
    const { app } = this;
    const model = app.model;
    clear(this.list);
    const blocked = federationBlocked(app);
    this.status.textContent = blocked || (model && model.sources.length > 1 ? `${plural(model.sources.length, 'maquette')} dans la scène, un seul repère : celui de la première.` : 'Une seule maquette ouverte.');
    if (!model) return;
    const sources: ModelSourceInfo[] = model.sources.length > 0 ? model.sources
      : [{ id: 'm1', name: app.sourceName, kind: 'glb', role: 'model', start: 0, count: model.count, chunkStart: 0, chunkCount: model.chunks.length, triangles: model.triangleCount, offset: [0, 0, 0] }];
    sources.forEach((source, index) => {
      const elements = model.sources.length > 0 ? this.elementsOf(index) : Array.from({ length: model.count }, (_, i) => i);
      const visible = elements.some((i) => model.state.isVisible(i));
      const item = button('', () => { app.select(elements, 'panel'); app.fitTo(elements); }, { class: 'view-item', title: 'Sélectionner et cadrer cette maquette' });
      item.append(h('span', { class: 'view-name', text: `${source.name}${source.role === 'reference' ? ' (référence)' : ''}` }),
        h('span', { class: 'view-note', text: `${plural(source.count, 'élément')} · ${integer.format(source.triangles)} triangles` }));
      const eye = button(visible ? 'Masquer' : 'Afficher', () => app.setVisible(elements, !visible), { class: 'view-action model-eye', title: visible ? 'Masquer cette maquette' : 'Afficher cette maquette', attrs: { 'aria-pressed': String(visible) } });
      const last = model.sources.length > 1 && index === model.sources.length - 1;
      const remove = button('×', () => this.remove(source), {
        class: 'view-action',
        title: last ? 'Retirer cette maquette' : index === 0 ? 'La première maquette ne se retire pas : ouvrez-en une autre à la place' : 'Retirez d’abord les maquettes ajoutées après celle-ci',
        attrs: { 'aria-label': `Retirer ${source.name}` },
      });
      remove.disabled = !last || blocked !== '';
      this.list.append(h('div', { class: 'view-row' }, item, eye, remove));
    });
  }

  private remove(source: ModelSourceInfo): void {
    const { app } = this;
    const model = app.model, edits = app.propertyEdits;
    if (!model || !edits) return;
    const keys = new Set(model.keys.slice(source.start, source.start + source.count));
    const modified = Object.keys(edits.diff(model.keys).elements).filter((key) => keys.has(key)).length;
    if (modified > 0 && !window.confirm(`${plural(modified, 'élément modifié')} dans « ${source.name} » : ces modifications seront perdues (« Modifications ↓ » les enregistre d’abord). Retirer la maquette ?`)) return;
    removeLastModel(app);
    this.render();
  }
}
