import { Box3, Vector3 } from 'three';
import { PATH_SEP, formatValue, type PropValue } from '../data/metadata.ts';
import { formatLength } from '../engine/Measure.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';

const MULTI_LIMIT = 5000;
const MIXED = '(valeurs multiples)';

/** Fiche de l'élément sélectionné : ses métadonnées, regroupées par catégorie. */
export class PropertiesPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly body: HTMLElement;
  private readonly isolateButton: HTMLButtonElement;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'properties-body' });
    this.el = h('section', { class: 'panel properties-panel' }, h('h2', { class: 'panel-title', text: 'Propriétés' }), this.body);
    this.isolateButton = button('Isoler', () => app.toggleIsolate(), { attrs: { 'aria-pressed': 'false' } });
    app.on('selection', () => this.render());
    app.on('model', () => this.render());
    app.on('visibility', () => this.syncIsolate());
    this.render();
  }

  private syncIsolate(): void {
    const isolated = this.app.isolated;
    this.isolateButton.textContent = isolated ? 'Ne plus isoler' : 'Isoler';
    this.isolateButton.setAttribute('aria-pressed', String(isolated));
    this.isolateButton.title = isolated ? 'Revenir à l’affichage d’avant l’isolement (I)' : 'N’afficher que la sélection (I)';
  }

  private render(): void {
    clear(this.body);
    const { app } = this;
    const { model, store, selection } = app;
    if (!model) {
      this.body.append(h('p', { class: 'hint', text: 'Chargez un modèle pour consulter les propriétés de ses éléments.' }));
      return;
    }
    if (selection.size === 0) {
      this.body.append(h('p', { class: 'hint', text: 'Cliquez un élément dans la vue 3D ou dans l’arborescence.' }));
      return;
    }

    const indices = [...selection];
    const single = indices.length === 1;
    const title = single ? app.elementLabel(indices[0]) : `${integer.format(indices.length)} éléments sélectionnés`;
    this.body.append(h('h3', { class: 'element-title', text: title }));
    if (single) this.body.append(h('code', { class: 'element-key', text: model.keys[indices[0]], title: 'Identifiant de liaison avec les métadonnées' }));

    this.body.append(
      h('div', { class: 'element-actions' },
        button('Cadrer', () => app.fitTo(app.selection), { title: 'Cadrer la vue sur la sélection (F)' }),
        button('Masquer', () => app.setVisible(app.selection, false), { title: 'Masquer la sélection (H)' }),
        this.isolateButton,
        button('Désélectionner', () => app.select([], 'panel'), { title: 'Vider la sélection (Échap)' }),
      ),
    );
    this.syncIsolate();

    // Propriétés communes : pour plusieurs éléments, une valeur n'est affichée que si elle est identique partout.
    const values = new Map<string, string>();
    if (single) {
      const props = store.propsOf(indices[0]);
      if (props) for (const [path, value] of Object.entries(props)) values.set(path, formatValue(value as PropValue));
    } else if (indices.length <= MULTI_LIMIT) {
      for (const path of store.paths) {
        const first = store.displayValue(indices[0], path);
        let same = true;
        for (let i = 1; i < indices.length && same; i++) same = store.displayValue(indices[i], path) === first;
        values.set(path, same ? first : MIXED);
      }
    }

    if (values.size === 0) {
      const message = single
        ? 'Aucune métadonnée pour cet élément.'
        : indices.length > MULTI_LIMIT
          ? 'Sélection trop grande pour comparer les propriétés.'
          : 'Aucune métadonnée pour ces éléments.';
      this.body.append(h('p', { class: 'hint', text: message }));
    } else {
      // Le préfixe avant le dernier séparateur sert de titre de catégorie.
      const sections = new Map<string, [string, string][]>();
      for (const [path, value] of values) {
        const cut = path.lastIndexOf(PATH_SEP);
        const category = cut < 0 ? '' : path.slice(0, cut);
        const name = cut < 0 ? path : path.slice(cut + PATH_SEP.length);
        const rows = sections.get(category);
        if (rows) rows.push([name, value]);
        else sections.set(category, [[name, value]]);
      }
      for (const [category, rows] of sections) this.body.append(this.table(category || 'Général', rows));
    }

    const size = model.boxOf(indices, new Box3()).getSize(new Vector3());
    this.body.append(
      this.table('Géométrie (calculée)', [
        ['Emprise X', formatLength(size.x)],
        ['Emprise Y (hauteur)', formatLength(size.y)],
        ['Emprise Z', formatLength(size.z)],
      ]),
    );
  }

  private table(title: string, rows: [string, string][]): HTMLElement {
    const list = h('dl', { class: 'props' });
    for (const [name, value] of rows) {
      list.append(h('dt', { text: name, title: name }), h('dd', { text: value, title: value, class: value === MIXED ? 'mixed' : '' }));
    }
    return h('div', { class: 'props-section' }, h('h4', { text: title }), list);
  }
}
