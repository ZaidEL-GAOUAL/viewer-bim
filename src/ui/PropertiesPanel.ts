import { PATH_SEP, coerceTo, formatValue, toPropertyPath, ownValue, type PropValue } from '../data/metadata.ts';
import { formatLength } from '../engine/Measure.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { integer } from '../data/text.ts';

const MULTI_LIMIT = 5000;
const MIXED = '(valeurs multiples)';
const ADD_TITLE = 'Ajouter une propriété';
const LOCKED_HINT = 'Propriété verrouillée par le fichier : elle identifie l’élément ou découle de la structure du modèle, et ne se modifie pas ici.';
const MODIFIED_HINT = 'Modifiée : différente du fichier d’origine';

/** Une ligne de la fiche : la valeur commune aux éléments sélectionnés, ou `undefined` si elle diffère. */
interface Row {
  path: string;
  name: string;
  value: PropValue | undefined;
  kind: 'text' | 'number' | 'boolean' | 'date';
  /** La valeur qui donne son type au champ : une saisie est convertie dans ce type (`coerceTo`). */
  sample: PropValue | undefined;
  editable: boolean;
  /** Différente du fichier d'origine pour au moins un élément de la sélection. */
  modified: boolean;
}

/** Une valeur à modifier, telle qu'on la tape : virgule décimale à la française. */
const editText = (value: PropValue | undefined): string => value === undefined || value === null ? '' : typeof value === 'number' ? String(value).replace('.', ',') : String(value);

/** Fiche de l'élément sélectionné : ses métadonnées, regroupées par catégorie, modifiables sauf verrou. */
export class PropertiesPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly body: HTMLElement;
  private titleEl: HTMLElement | null = null;
  /** Catégories repliées par l'utilisateur. */
  private readonly folded = new Set<string>([ADD_TITLE]);
  /** « Modifiées seulement » : la fiche ne montre que ce qui diffère du fichier. */
  private modifiedOnly = false;

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'properties-body' });
    this.el = h('section', { class: 'panel properties-panel' }, h('h2', { class: 'panel-title', text: 'Propriétés' }), this.body);
    app.on('selection', () => this.render());
    app.on('model', () => this.render());
    // Une modification ne redessine pas la fiche (le champ en cours garderait difficilement le
    // focus) : seul le titre suit.
    app.on('metadata', () => this.syncEdits());
    app.on('history', () => this.syncEdits());
    this.render();
  }

  private syncEdits(): void {
    const { app } = this;
    const indices = [...app.selection];
    if (this.titleEl && indices.length === 1) this.titleEl.textContent = app.elementLabel(indices[0]);
  }

  private render(): void {
    clear(this.body);
    this.titleEl = null;
    const { app } = this;
    const { model, selection } = app;
    if (!model) {
      this.body.append(h('p', { class: 'hint', text: 'Chargez un modèle pour consulter les propriétés de ses éléments.' }));
      this.syncEdits();
      return;
    }
    if (selection.size === 0) {
      this.body.append(h('p', { class: 'hint', text: 'Cliquez un élément dans la vue 3D ou dans l’arborescence.' }));
      this.syncEdits();
      return;
    }

    const indices = [...selection];
    const single = indices.length === 1;
    const title = single ? app.elementLabel(indices[0]) : `${integer.format(indices.length)} éléments sélectionnés`;
    this.titleEl = h('h3', { class: 'element-title', text: title });
    this.body.append(this.titleEl);
    if (single) this.body.append(h('code', { class: 'element-key', text: model.keys[indices[0]], title: 'Identifiant de liaison avec les métadonnées' }));

    this.syncEdits();

    const all = this.collectRows(indices);
    const rows = this.modifiedOnly ? all.filter((row) => row.modified) : all;
    if (all.length > 0) {
      const only = h('input', { attrs: { type: 'checkbox' } });
      only.checked = this.modifiedOnly;
      only.addEventListener('change', () => { this.modifiedOnly = only.checked; this.render(); });
      this.body.append(h('label', { class: 'check modified-only', title: 'Ne montrer que les propriétés différentes du fichier d’origine' }, only, 'Modifiées seulement'));
    }
    if (rows.length === 0) {
      const message = all.length > 0
        ? 'Aucune propriété modifiée.'
        : single
          ? 'Aucune métadonnée pour cet élément.'
          : indices.length > MULTI_LIMIT
            ? 'Sélection trop grande pour comparer les propriétés.'
            : 'Aucune métadonnée pour ces éléments.';
      this.body.append(h('p', { class: 'hint', text: message }));
    } else {
      // Le préfixe avant le dernier séparateur sert de titre de catégorie.
      const sections = new Map<string, Row[]>();
      for (const row of rows) {
        const cut = row.path.lastIndexOf(PATH_SEP);
        const category = cut < 0 ? '' : row.path.slice(0, cut);
        const list = sections.get(category);
        if (list) list.push(row);
        else sections.set(category, [row]);
      }
      for (const [category, list] of sections) this.body.append(this.section(category || 'Général', this.propertyList(list, indices)));
    }

    this.body.append(this.section(ADD_TITLE, this.addForm(indices)));

    // Emprise selon les axes ; les cotes détaillées (longueur, largeur, surface, volume) sont
    // dans le menu Mesures → Cotes.
    const size = model.sizeOf(indices);
    const geometry = h('dl', { class: 'props' });
    for (const [name, value] of [
      ['Emprise X', formatLength(size.x)],
      ['Emprise Y (hauteur)', formatLength(size.y)],
      ['Emprise Z', formatLength(size.z)],
    ]) {
      geometry.append(h('dt', { text: name, title: name }), h('dd', { text: value, title: value }));
    }
    this.body.append(this.section('Géométrie (calculée)', geometry));
  }

  /** Propriétés de la sélection : pour plusieurs éléments, une valeur n'est retenue que si elle est identique partout. */
  private collectRows(indices: number[]): Row[] {
    const { store, propertyEdits: edits } = this.app;
    const rows: Row[] = [];
    const anyModified = (edits?.modifiedCount ?? 0) > 0;
    const push = (path: string, value: PropValue | undefined, sample: PropValue | undefined) => {
      const cut = path.lastIndexOf(PATH_SEP);
      const kind = typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sample) ? 'date' : 'text';
      const modified = anyModified && indices.some((index) => edits!.isModified(index, path));
      rows.push({ path, name: cut < 0 ? path : path.slice(cut + PATH_SEP.length), value, kind, sample, editable: store.isEditable(path), modified });
    };
    if (indices.length === 1) {
      const props = store.propsOf(indices[0]);
      if (props) for (const [path, value] of Object.entries(props)) push(path, value as PropValue, value as PropValue);
    } else if (indices.length <= MULTI_LIMIT) {
      for (const path of store.paths) {
        // Une propriété qu'aucun élément de la sélection ne possède n'est pas proposée.
        let sample: PropValue | undefined;
        let owned = false;
        for (const index of indices) {
          const value = ownValue(store.propsOf(index), path);
          if (value === undefined) continue;
          owned = true;
          // Le type du champ suit la première valeur renseignée.
          if (value !== null) {
            sample = value;
            break;
          }
        }
        if (!owned) continue;
        const first = store.displayValue(indices[0], path);
        let same = true;
        for (let i = 1; i < indices.length && same; i++) same = store.displayValue(indices[i], path) === first;
        push(path, same ? (ownValue(store.propsOf(indices[0]), path) ?? null) : undefined, sample);
      }
    }
    return rows;
  }

  private propertyList(rows: Row[], indices: number[]): HTMLElement {
    const { app } = this;
    const list = h('dl', { class: 'props' });
    for (const row of rows) {
      const display = row.value === undefined ? MIXED : formatValue(row.value);
      if (!row.editable) {
        list.append(
          h('dt', { text: row.name, title: `${row.name} — ${LOCKED_HINT}`, class: 'locked' }),
          h('dd', { text: display, title: display, class: row.value === undefined ? 'mixed locked' : 'locked' }),
        );
        continue;
      }
      const name = h('dt', { text: row.name });
      const revert = button('↺', () => { if (app.revertProperty(indices, row.path)) this.render(); }, { class: 'property-revert', title: 'Revenir à la valeur du fichier d’origine', attrs: { 'aria-label': `Revenir à la valeur du fichier pour ${row.path}` } });
      // Une saisie ne redessine pas la fiche : la marque « modifiée » suit ici.
      const mark = () => {
        name.classList.toggle('modified', row.modified);
        name.title = row.modified ? `${row.name} — ${MODIFIED_HINT}` : row.name;
        revert.hidden = !row.modified;
      };
      const changed = () => { row.modified = indices.some((index) => app.propertyEdits?.isModified(index, row.path)); mark(); };
      mark();
      list.append(name, h('dd', { class: 'editable property-edit-cell' }, this.field(row, indices, changed), revert, button('×', () => { if (app.deleteProperty(indices, row.path)) this.render(); }, { class: 'property-delete', title: `Supprimer la propriété ${row.path} de la sélection`, attrs: { 'aria-label': `Supprimer la propriété ${row.path}` } })));
    }
    return list;
  }

  /**
   * Champ de saisie d'une propriété : case à cocher, date ou texte selon la valeur actuelle. Une saisie garde le type de la
   * propriété (un nombre reste un nombre, « 12,5 » compris) ; une valeur qui ne s'y convertit pas est refusée avec un message.
   */
  private field(row: Row, indices: number[], changed: () => void): HTMLElement {
    const { app } = this;
    const label = `${row.name} (modifiable)`;
    if (row.kind === 'boolean') {
      const checkbox = h('input', { attrs: { type: 'checkbox', 'aria-label': label } });
      const valueLabel = h('span');
      const show = () => {
        checkbox.checked = row.value === true;
        checkbox.indeterminate = row.value === undefined;
        valueLabel.textContent = row.value === undefined ? MIXED : row.value ? 'Oui' : 'Non';
        valueLabel.classList.toggle('mixed', row.value === undefined);
      };
      show();
      checkbox.addEventListener('change', () => {
        if (app.editProperty(indices, row.path, checkbox.checked)) { row.value = checkbox.checked; changed(); }
        show();
      });
      return h('label', { class: 'check' }, checkbox, valueLabel);
    }

    const input = h('input', { attrs: { type: row.kind === 'date' ? 'date' : 'text', 'aria-label': label } });
    if (row.kind === 'number') input.inputMode = 'decimal';
    let shown = editText(row.value);
    const show = () => {
      input.value = shown;
      input.placeholder = row.value === undefined ? MIXED : row.value === null ? formatValue(null) : '';
      input.classList.toggle('mixed', row.value === undefined);
    };
    show();
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
      if (event.key === 'Escape') {
        show();
        input.blur();
      }
    });
    input.addEventListener('change', () => {
      let value: PropValue;
      try {
        value = coerceTo(row.sample, input.value);
      } catch (error) {
        app.toast(`${error instanceof Error ? error.message : String(error)} Valeur refusée pour « ${row.name} ».`, true);
        show();
        return;
      }
      if (app.editProperty(indices, row.path, value)) {
        row.value = value;
        shown = editText(value);
        changed();
      }
      show();
    });
    return input;
  }

  /** Formulaire d'ajout : un nom (avec « / » pour une catégorie) et une valeur, appliqués à toute la sélection. */
  private addForm(indices: number[]): HTMLElement {
    const { app } = this;
    const name = h('input', { attrs: { type: 'text', placeholder: 'Nom, ou Catégorie / Nom', 'aria-label': 'Nom de la nouvelle propriété' } });
    const value = h('input', { attrs: { type: 'text', placeholder: 'Valeur', 'aria-label': 'Valeur de la nouvelle propriété' } });
    const valueType = h('select', { attrs: { 'aria-label': 'Type de la nouvelle propriété' } }, h('option', { text: 'Valeur', attrs: { value: 'text' } }), h('option', { text: 'Date', attrs: { value: 'date' } }));
    valueType.addEventListener('change', () => { value.type = valueType.value; value.value = ''; });
    const submit = () => {
      const path = toPropertyPath(name.value);
      if (!path) {
        name.focus();
        return;
      }
      if (!app.store.isEditable(path)) {
        app.toast(`« ${path} » est une propriété verrouillée.`, true);
        return;
      }
      let typed: PropValue;
      try {
        typed = coerceTo(indices.map((index) => ownValue(app.store.propsOf(index), path)).find((existing) => existing !== undefined && existing !== null), value.value);
      } catch (error) {
        app.toast(`${error instanceof Error ? error.message : String(error)} Valeur refusée pour « ${path} ».`, true);
        return;
      }
      if (!app.editProperty(indices, path, typed)) return;
      this.render();
      // La fiche a été redessinée : on rouvre le formulaire pour enchaîner les ajouts.
      const next = this.body.querySelector<HTMLInputElement>('.props-add input');
      next?.focus();
    };
    for (const input of [name, value]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
    }
    return h('div', { class: 'props-add' }, name, valueType, value, button('Ajouter', submit, { title: 'Ajouter cette propriété à la sélection' }));
  }

  /** Catégorie pliable ; son état est conservé d'un élément à l'autre. */
  private section(title: string, content: HTMLElement): HTMLElement {
    const section = h('details', { class: 'props-section' }, h('summary', { text: title }), content);
    section.open = !this.folded.has(title);
    section.addEventListener('toggle', () => {
      if (section.open) this.folded.delete(title);
      else this.folded.add(title);
    });
    return section;
  }
}
