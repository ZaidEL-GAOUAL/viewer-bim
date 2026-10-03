import { suggestGrouping } from '../data/grouping.ts';
import { categoryColor } from '../data/palette.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';

const MAX_ROWS = 300;

interface ValueRow {
  elements: number[];
  checkbox: HTMLInputElement;
}

/**
 * Colorer et masquer selon une propriété : on choisit une propriété, le panneau liste ses valeurs
 * distinctes ; chaque valeur a une case (visibilité) et une couleur.
 */
export class FilterPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly select: HTMLSelectElement;
  private readonly colorToggle: HTMLButtonElement;
  private readonly search: HTMLInputElement;
  private readonly values: HTMLElement;
  private readonly note: HTMLElement;
  private readonly palettes = new Map<string, Map<string, string>>();
  private rows: ValueRow[] = [];
  private path = '';
  private coloring = false;

  constructor(app: App) {
    this.app = app;
    this.select = h('select', { attrs: { 'aria-label': 'Propriété' } });
    this.select.addEventListener('change', () => {
      this.path = this.select.value;
      this.search.value = '';
      this.renderValues();
      if (this.coloring) this.applyColors();
    });

    this.colorToggle = button('Colorer par valeur', () => {
      this.coloring = !this.coloring;
      if (this.coloring) this.applyColors();
      else app.clearColors();
      this.syncToggle();
    }, { class: 'toggle', attrs: { 'aria-pressed': 'false' } });

    this.search = h('input', { attrs: { type: 'search', placeholder: 'Filtrer les valeurs…', 'aria-label': 'Filtrer les valeurs' } });
    this.search.addEventListener('input', () => this.renderValues());

    this.values = h('div', { class: 'values' });
    this.note = h('p', { class: 'hint' });

    this.el = h('section', { class: 'panel filter-panel' },
      h('div', { class: 'filter-header' },
        h('div', { class: 'field-label', text: 'Propriété' }),
        this.select,
        h('div', { class: 'filter-actions' },
          this.colorToggle,
          button('Tout cocher', () => this.setAll(true)),
          button('Tout décocher', () => this.setAll(false)),
        ),
        this.search,
      ),
      this.values,
      this.note,
    );

    app.on('model', () => this.reset());
    app.on('metadata', () => this.refreshPaths());
    app.on('structure', () => this.refreshPaths());
    app.on('visibility', () => this.refreshChecks());
    this.reset();
  }

  /** Après une modification de propriétés : mêmes choix, liste des propriétés et des valeurs à jour. */
  private refreshPaths(): void {
    const { store } = this.app;
    clear(this.select);
    for (const path of store.paths) this.select.append(h('option', { text: path, attrs: { value: path } }));
    if (!store.paths.includes(this.path)) this.path = suggestGrouping(store) ?? store.paths[0] ?? '';
    this.select.value = this.path;
    this.renderValues();
    if (this.coloring) this.applyColors();
  }

  private reset(): void {
    const { store, model } = this.app;
    this.palettes.clear();
    this.coloring = false;
    this.syncToggle();
    clear(this.select);
    for (const path of store.paths) this.select.append(h('option', { text: path, attrs: { value: path } }));
    this.path = suggestGrouping(store) ?? store.paths[0] ?? '';
    this.select.value = this.path;
    const usable = model !== null && store.paths.length > 0;
    this.select.disabled = !usable;
    this.colorToggle.disabled = !usable;
    this.search.value = '';
    this.renderValues();
  }

  private syncToggle(): void {
    this.colorToggle.setAttribute('aria-pressed', String(this.coloring));
    this.colorToggle.textContent = this.coloring ? 'Retirer les couleurs' : 'Colorer par valeur';
  }

  /** Couleurs des valeurs de la propriété courante, mémorisées pour rester stables. */
  private palette(): Map<string, string> {
    let palette = this.palettes.get(this.path);
    if (!palette) {
      palette = new Map();
      this.palettes.set(this.path, palette);
    }
    // Les valeurs apparues depuis (propriétés modifiées) reçoivent une couleur à leur tour.
    for (const label of this.app.store.groups(this.path).keys()) {
      if (!palette.has(label)) palette.set(label, categoryColor(palette.size, label));
    }
    return palette;
  }

  private applyColors(): void {
    if (!this.path) return;
    const palette = this.palette();
    const groups: [number[], string][] = [];
    for (const [label, elements] of this.app.store.groups(this.path)) groups.push([elements, palette.get(label)!]);
    this.app.applyColors(groups);
  }

  private setAll(visible: boolean): void {
    if (!this.app.model) return;
    if (this.search.value.trim() === '') {
      if (visible) this.app.showAll();
      else this.app.setVisible(Array.from({ length: this.app.model.count }, (_, i) => i), false);
    } else {
      // Avec un filtre de recherche, l'action porte sur toutes les valeurs qui correspondent,
      // y compris celles que la liste n'affiche pas faute de place.
      const elements: number[] = [];
      for (const [label, members] of this.app.store.groups(this.path)) {
        if (this.matches(label)) for (const index of members) elements.push(index);
      }
      this.app.setVisible(elements, visible);
    }
  }

  private matches(label: string): boolean {
    const query = this.search.value.trim().toLocaleLowerCase('fr');
    return query === '' || label.toLocaleLowerCase('fr').includes(query);
  }

  private renderValues(): void {
    clear(this.values);
    this.rows = [];
    this.note.textContent = '';
    const { store, model } = this.app;
    if (!model) {
      this.note.textContent = 'Aucun modèle chargé.';
      return;
    }
    if (!this.path) {
      this.note.textContent = 'Aucune propriété disponible : chargez le fichier JSON de métadonnées.';
      return;
    }

    const groups = store.groups(this.path);
    const palette = this.palette();
    const query = this.search.value.trim().toLocaleLowerCase('fr');
    this.search.hidden = groups.size <= 12 && query === '';
    let shown = 0;
    let matching = 0;

    for (const [label, elements] of groups) {
      if (!this.matches(label)) continue;
      matching++;
      if (shown >= MAX_ROWS) continue;
      shown++;

      const checkbox = h('input', { attrs: { type: 'checkbox', 'aria-label': `Afficher ${label}` } });
      checkbox.addEventListener('change', () => this.app.setVisible(elements, checkbox.checked));

      const swatch = h('input', { class: 'swatch', attrs: { type: 'color', value: palette.get(label)!, 'aria-label': `Couleur de ${label}` } });
      swatch.addEventListener('input', () => {
        palette.set(label, swatch.value);
        if (this.coloring) this.app.applyColors([[elements, swatch.value]]);
      });

      const name = button(label, (event) => this.app.select(elements, 'panel', event.ctrlKey || event.metaKey || event.shiftKey), {
        class: 'value-label',
        title: 'Sélectionner ces éléments',
      });
      this.values.append(h('div', { class: 'value-row' }, checkbox, swatch, name, h('span', { class: 'count', text: integer.format(elements.length) })));
      this.rows.push({ elements, checkbox });
    }

    if (matching > shown) {
      this.note.textContent = `${integer.format(matching - shown)} autres valeurs : utilisez la recherche pour les retrouver.`;
    } else if (matching === 0) {
      this.note.textContent = 'Aucune valeur ne correspond.';
    }
    this.refreshChecks();
  }

  private refreshChecks(): void {
    const state = this.app.model?.state;
    if (!state) return;
    for (const { elements, checkbox } of this.rows) {
      let visible = 0;
      for (let i = 0; i < elements.length; i++) if (state.isVisible(elements[i])) visible++;
      checkbox.checked = visible === elements.length;
      checkbox.indeterminate = visible > 0 && visible < elements.length;
    }
  }
}
