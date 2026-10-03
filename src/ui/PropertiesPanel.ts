import { Box3, Vector3 } from 'three';
import { PATH_SEP, formatValue, ownValue, type PropValue } from '../data/metadata.ts';
import { formatLength } from '../engine/Measure.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';

const MULTI_LIMIT = 5000;
const MIXED = '(valeurs multiples)';
const ADD_TITLE = 'Ajouter une propriété';
const MOVE_TITLE = 'Déplacer ou dupliquer';
const LOCKED_HINT = 'Propriété verrouillée par le fichier de métadonnées : elle découle de la structure du modèle (classe, type, emplacement, matériaux, quantités) et ne se modifie pas ici.';
const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

/** Une ligne de la fiche : la valeur commune aux éléments sélectionnés, ou `undefined` si elle diffère. */
interface Row {
  path: string;
  name: string;
  value: PropValue | undefined;
  kind: 'text' | 'number' | 'boolean';
  editable: boolean;
}

/** Valeur saisie dans un champ texte : un nombre si elle en a l'air, rien si le champ est vide. */
function parseInput(text: string): PropValue {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (NUMBER.test(trimmed)) return Number(trimmed.replace(',', '.'));
  return trimmed;
}

/** Fiche de l'élément sélectionné : ses métadonnées, regroupées par catégorie, modifiables sauf verrou. */
export class PropertiesPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly body: HTMLElement;
  private readonly isolateButton: HTMLButtonElement;
  private readonly maskButton: HTMLButtonElement;
  private readonly revertButton: HTMLButtonElement;
  private titleEl: HTMLElement | null = null;
  /** Catégories repliées par l'utilisateur. */
  private readonly folded = new Set<string>([ADD_TITLE, MOVE_TITLE]);

  constructor(app: App) {
    this.app = app;
    this.body = h('div', { class: 'properties-body' });
    this.el = h('section', { class: 'panel properties-panel' }, h('h2', { class: 'panel-title', text: 'Propriétés' }), this.body);
    this.isolateButton = button('Isoler', () => app.toggleIsolate(), { attrs: { 'aria-pressed': 'false' } });
    this.maskButton = button('Masquer', () => app.toggleMask(), { attrs: { 'aria-pressed': 'false' } });
    this.revertButton = button('Annuler les modifications', () => app.revertEdits(), {
      class: 'revert',
      title: 'Revenir aux métadonnées des fichiers chargés',
    });
    app.on('selection', () => this.render());
    app.on('model', () => this.render());
    app.on('visibility', () => this.syncIsolate());
    // Une modification ne redessine pas la fiche (le champ en cours garderait difficilement le
    // focus) : seuls le titre et le bouton d'annulation suivent.
    app.on('metadata', () => this.syncEdits());
    app.on('geometry', () => this.render());
    app.on('structure', () => this.render());
    this.render();
  }

  private syncIsolate(): void {
    const isolated = this.app.isolated;
    this.isolateButton.textContent = isolated ? 'Ne plus isoler' : 'Isoler';
    this.isolateButton.setAttribute('aria-pressed', String(isolated));
    this.isolateButton.title = isolated ? 'Revenir à l’affichage d’avant l’isolement (I)' : 'N’afficher que la sélection (I)';
    const unmask = this.app.maskAction === 'unmask';
    this.maskButton.textContent = unmask ? 'Démasquer' : 'Masquer';
    this.maskButton.setAttribute('aria-pressed', String(unmask));
    this.maskButton.title = unmask ? 'Réafficher la sélection (H)' : 'Masquer la sélection (H). Un second clic la réaffiche.';
  }

  private syncEdits(): void {
    const { app } = this;
    this.revertButton.hidden = app.edits === 0 && !app.geometryChanged;
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
      return;
    }
    if (selection.size === 0) {
      this.body.append(h('p', { class: 'hint', text: 'Cliquez un élément dans la vue 3D ou dans l’arborescence.' }));
      if (app.edits > 0) this.body.append(h('div', { class: 'element-actions' }, this.revertButton));
      this.syncEdits();
      return;
    }

    const indices = [...selection];
    const single = indices.length === 1;
    const title = single ? app.elementLabel(indices[0]) : `${integer.format(indices.length)} éléments sélectionnés`;
    this.titleEl = h('h3', { class: 'element-title', text: title });
    this.body.append(this.titleEl);
    if (single) this.body.append(h('code', { class: 'element-key', text: model.keys[indices[0]], title: 'Identifiant de liaison avec les métadonnées' }));

    this.body.append(
      h('div', { class: 'element-actions' },
        button('Cadrer', () => app.fitTo(app.selection), { title: 'Cadrer la vue sur la sélection (F)' }),
        this.maskButton,
        this.isolateButton,
        button('Désélectionner', () => app.select([], 'panel'), { title: 'Vider la sélection (Échap)' }),
        this.revertButton,
      ),
    );
    this.syncIsolate();
    this.syncEdits();

    const rows = this.collectRows(indices);
    if (rows.length === 0) {
      const message = single
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
    this.body.append(this.section(MOVE_TITLE, this.moveForm(indices)));

    const size = model.boxOf(indices, new Box3()).getSize(new Vector3());
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
    const { store } = this.app;
    const rows: Row[] = [];
    const push = (path: string, value: PropValue | undefined, sample: PropValue | undefined) => {
      const cut = path.lastIndexOf(PATH_SEP);
      const kind = typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'text';
      rows.push({ path, name: cut < 0 ? path : path.slice(cut + PATH_SEP.length), value, kind, editable: store.isEditable(path) });
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
      list.append(h('dt', { text: row.name, title: row.name }), h('dd', { class: 'editable' }, this.field(row, indices)));
    }
    return list;
  }

  /** Champ de saisie d'une propriété : case à cocher, nombre ou texte selon la valeur actuelle. */
  private field(row: Row, indices: number[]): HTMLElement {
    const { app } = this;
    const label = `${row.name} (modifiable)`;
    if (row.kind === 'boolean') {
      const checkbox = h('input', { attrs: { type: 'checkbox', 'aria-label': label } });
      checkbox.checked = row.value === true;
      checkbox.indeterminate = row.value === undefined;
      checkbox.addEventListener('change', () => {
        checkbox.indeterminate = false;
        app.editProperty(indices, row.path, checkbox.checked);
      });
      return h('label', { class: 'check' }, checkbox, h('span', { text: row.value === undefined ? MIXED : row.value ? 'Oui' : 'Non', class: row.value === undefined ? 'mixed' : '' }));
    }

    const input = h('input', { attrs: { type: row.kind === 'number' ? 'number' : 'text', 'aria-label': label } });
    if (row.kind === 'number') input.step = 'any';
    let shown = row.value === undefined ? '' : row.value === null ? '' : String(row.value);
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
      if (row.kind === 'number') {
        value = input.value.trim() === '' ? null : input.valueAsNumber;
        if (value !== null && !Number.isFinite(value)) {
          show();
          return;
        }
      } else {
        value = input.value.trim() === '' ? null : input.value;
      }
      if (app.editProperty(indices, row.path, value)) {
        row.value = value;
        shown = value === null ? '' : String(value);
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
    const submit = () => {
      const path = name.value.split('/').map((part) => part.trim()).filter(Boolean).join(PATH_SEP);
      if (!path) {
        name.focus();
        return;
      }
      if (!app.store.isEditable(path)) {
        app.toast(`« ${path} » est une propriété verrouillée.`, true);
        return;
      }
      if (!app.editProperty(indices, path, parseInput(value.value))) return;
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
    return h('div', { class: 'props-add' }, name, value, button('Ajouter', submit, { title: 'Ajouter cette propriété à la sélection' }));
  }

  /** Déplacement (ou copie décalée) de la sélection, en mètres dans le repère du projet. */
  private moveForm(indices: number[]): HTMLElement {
    const { app } = this;
    const fields = (['X', 'Y (vertical)', 'Z'] as const).map((axis) =>
      h('input', { attrs: { type: 'number', step: 'any', value: '0', placeholder: axis, 'aria-label': `Décalage ${axis} en mètres`, title: `Décalage ${axis} (m)` } }),
    );
    const delta = () => fields.map((field) => (field.value.trim() === '' ? 0 : field.valueAsNumber)) as [number, number, number];
    const move = button('Déplacer', () => {
      const [dx, dy, dz] = delta();
      if (![dx, dy, dz].every(Number.isFinite)) return;
      if (app.moveElements(indices, dx, dy, dz) === 0) app.toast('Indiquez un décalage non nul.');
    }, { title: 'Déplacer la sélection de ce vecteur' });
    const duplicate = button('Dupliquer', () => {
      const [dx, dy, dz] = delta();
      if (![dx, dy, dz].every(Number.isFinite)) return;
      const created = app.duplicateElements(indices, dx, dy, dz);
      if (created.length > 0) app.select(created, 'panel');
    }, { title: 'Copier la sélection, décalée de ce vecteur, avec ses propriétés' });
    return h('div', { class: 'props-move' },
      h('div', { class: 'props-move-fields' }, ...fields),
      h('div', { class: 'props-move-actions' }, move, duplicate),
      h('p', { class: 'hint', text: 'Décalage en mètres, dans le repère du projet (Y vers le haut).' }),
    );
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
