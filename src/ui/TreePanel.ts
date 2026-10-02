import { buildTree, suggestGrouping, type TreeGroup } from '../data/grouping.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';

const PAGE = 200;

type EyeState = 'on' | 'off' | 'mixed';

interface LeafRow {
  row: HTMLElement;
  eye: HTMLButtonElement;
}

/**
 * Un niveau de l'arbre : soit une liste de groupes, soit une liste d'éléments. Dans les deux cas
 * seules 200 lignes existent dans la page à la fois ; regrouper 100 000 éléments sur une
 * propriété presque unique ne crée donc pas 100 000 lignes.
 */
interface ListView {
  groups: TreeGroup[] | null;
  elements: number[];
  body: HTMLElement;
  depth: number;
  page: number;
  /** Groupes et éléments de la page affichée. */
  groupViews: Map<string, GroupView>;
  leafRows: Map<number, LeafRow>;
}

interface GroupView {
  group: TreeGroup;
  row: HTMLElement;
  body: HTMLElement;
  eye: HTMLButtonElement;
  /** Contenu du groupe, construit à sa première ouverture. */
  list: ListView | null;
}

/**
 * Arborescence du modèle. Les niveaux ne viennent pas du fichier : ils sont calculés à partir
 * des propriétés choisies dans « Grouper par », dans l'ordre (groupes, puis sous-groupes…).
 */
export class TreePanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private paths: string[] = [];
  private root: ListView | null = null;

  constructor(app: App) {
    this.app = app;
    this.header = h('div', { class: 'tree-header' });
    this.list = h('div', { class: 'tree-list', attrs: { role: 'tree' } });
    this.el = h('section', { class: 'panel tree-panel' }, this.header, this.list);

    app.on('model', () => {
      const suggestion = suggestGrouping(app.store);
      this.paths = suggestion ? [suggestion] : [];
      this.rebuild();
    });
    app.on('visibility', () => this.refresh());
    app.on('selection', () => {
      this.refresh();
      // Seul un élément que l'on vient de désigner dans la vue 3D fait défiler l'arbre.
      const picked = app.lastPicked;
      if (app.selectionSource === 'view' && picked !== null && app.selection.has(picked)) this.reveal(picked);
    });
    this.rebuild();
  }

  // ----------------------------------------------------------- regroupement

  private renderHeader(): void {
    clear(this.header);
    const { store, model } = this.app;
    if (!model) return;

    const chips = h('div', { class: 'chips' });
    this.paths.forEach((path, index) => {
      chips.append(
        h('span', { class: 'chip' },
          h('span', { class: 'chip-level', text: String(index + 1) }),
          h('span', { class: 'chip-text', text: path, title: path }),
          button('×', () => {
            this.paths.splice(index, 1);
            this.rebuild();
          }, { class: 'chip-remove', title: 'Retirer ce niveau' }),
        ),
      );
    });

    const available = store.paths.filter((path) => !this.paths.includes(path));
    const add = h('select', { class: 'add-level', attrs: { 'aria-label': 'Ajouter un niveau de regroupement' } },
      h('option', { text: this.paths.length === 0 ? 'Choisir une propriété…' : '+ Ajouter un sous-niveau', attrs: { value: '' } }),
      ...available.map((path) => h('option', { text: path, attrs: { value: path } })),
    );
    add.disabled = available.length === 0;
    add.addEventListener('change', () => {
      if (!add.value) return;
      this.paths.push(add.value);
      this.rebuild();
    });

    this.header.append(h('div', { class: 'field-label', text: 'Grouper par' }), chips, add);
    if (store.paths.length === 0) {
      this.header.append(h('p', { class: 'hint', text: 'Aucune propriété disponible : chargez le fichier JSON de métadonnées pour regrouper les éléments.' }));
    }
  }

  private rebuild(): void {
    const { model, store } = this.app;
    // Les propriétés de regroupement qui n'existent plus (nouvelles métadonnées) sont retirées
    // avant d'afficher l'en-tête, pour que les pastilles correspondent à l'arbre.
    this.paths = this.paths.filter((path) => store.paths.includes(path));
    this.renderHeader();
    clear(this.list);
    this.root = null;
    if (!model) {
      this.list.append(h('p', { class: 'hint', text: 'Aucun modèle chargé.' }));
      return;
    }

    const all = Array.from({ length: model.count }, (_, i) => i);
    const groups = this.paths.length > 0 ? buildTree(store, this.paths, all) : null;
    this.root = this.createList(this.list, 0, groups, all);
    this.renderList(this.root);
    this.refresh();
  }

  // ------------------------------------------------------------------ lignes

  private createList(body: HTMLElement, depth: number, groups: TreeGroup[] | null, elements: number[]): ListView {
    return { groups, elements, body, depth, page: 0, groupViews: new Map(), leafRows: new Map() };
  }

  /** Affiche la page courante d'un niveau, encadrée de liens vers les pages voisines. */
  private renderList(list: ListView): void {
    clear(list.body);
    list.groupViews.clear();
    list.leafRows.clear();

    const total = list.groups ? list.groups.length : list.elements.length;
    const pages = Math.ceil(total / PAGE);
    list.page = Math.max(0, Math.min(list.page, pages - 1));
    const start = list.page * PAGE;
    const end = Math.min(total, start + PAGE);
    const noun = list.groups ? 'Groupes' : 'Éléments';
    const pager = (label: string, page: number) =>
      h('div', { class: 'row pager', attrs: { style: `--depth:${list.depth}` } },
        button(label, () => {
          list.page = page;
          this.renderList(list);
          this.refresh();
        }),
      );

    if (list.page > 0) {
      list.body.append(pager(`↑ ${noun} ${integer.format(start - PAGE + 1)} à ${integer.format(start)}`, list.page - 1));
    }
    for (let i = start; i < end; i++) {
      if (list.groups) {
        const view = this.createGroup(list.groups[i], list.depth);
        list.groupViews.set(view.group.label, view);
        list.body.append(view.row, view.body);
      } else {
        const index = list.elements[i];
        const leaf = this.createLeaf(index, list.depth);
        list.leafRows.set(index, leaf);
        list.body.append(leaf.row);
      }
    }
    if (list.page < pages - 1) {
      const last = Math.min(total, end + PAGE);
      list.body.append(pager(`↓ ${noun} ${integer.format(end + 1)} à ${integer.format(last)} sur ${integer.format(total)}`, list.page + 1));
    }
  }

  private createGroup(group: TreeGroup, depth: number): GroupView {
    const caret = button('', () => this.toggle(view), { class: 'caret', attrs: { 'aria-label': 'Déplier' } });
    const eye = this.createEye(() => {
      const hide = eye.dataset.state !== 'off';
      this.app.setVisible(group.elements, !hide);
    });
    const label = h('span', { class: 'row-label', text: group.label, title: `${group.path} : ${group.label}` });
    const row = h('div', { class: 'row group', attrs: { role: 'treeitem', 'aria-expanded': 'false', style: `--depth:${depth}` } },
      caret, eye, label, h('span', { class: 'count', text: integer.format(group.elements.length) }),
    );
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      this.app.select(group.elements, 'panel', event.ctrlKey || event.metaKey || event.shiftKey);
    });
    row.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      this.app.fitTo(group.elements);
    });
    const body = h('div', { class: 'children', attrs: { role: 'group', hidden: '' } });
    const view: GroupView = { group, row, body, eye, list: null };
    return view;
  }

  private createLeaf(index: number, depth: number): LeafRow {
    const { app } = this;
    const eye = this.createEye(() => app.setVisible([index], eye.dataset.state === 'off'));
    const row = h('div', { class: 'row leaf', attrs: { role: 'treeitem', style: `--depth:${depth}` } },
      eye, h('span', { class: 'row-label', text: app.elementLabel(index) }),
    );
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      app.select([index], 'panel', event.ctrlKey || event.metaKey || event.shiftKey);
    });
    row.addEventListener('dblclick', (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      app.fitTo([index]);
    });
    return { row, eye };
  }

  private createEye(onClick: () => void): HTMLButtonElement {
    return button('', onClick, { class: 'eye', attrs: { 'data-state': 'on', 'aria-label': 'Afficher ou masquer' } });
  }

  private toggle(view: GroupView, open = view.body.hidden, depth = Number(view.row.style.getPropertyValue('--depth'))): void {
    if (open && !view.list) {
      // Le contenu d'un groupe n'est construit qu'à sa première ouverture.
      const { children, elements } = view.group;
      view.list = this.createList(view.body, depth + 1, children.length > 0 ? children : null, elements);
      this.renderList(view.list);
      this.refreshList(view.list);
    }
    view.body.hidden = !open;
    view.row.setAttribute('aria-expanded', String(open));
  }

  // ------------------------------------------------------- synchronisation

  /** Remet à jour les yeux et la surbrillance de toutes les lignes affichées. */
  private refresh(): void {
    if (this.root) this.refreshList(this.root);
  }

  private refreshList(list: ListView): void {
    const state = this.app.model?.state;
    if (!state) return;
    const selection = this.app.selection;
    for (const [index, { row, eye }] of list.leafRows) {
      eye.dataset.state = state.isVisible(index) ? 'on' : 'off';
      row.classList.toggle('selected', selection.has(index));
    }
    for (const view of list.groupViews.values()) {
      let visible = 0;
      const elements = view.group.elements;
      for (let i = 0; i < elements.length; i++) if (state.isVisible(elements[i])) visible++;
      const value: EyeState = visible === 0 ? 'off' : visible === elements.length ? 'on' : 'mixed';
      view.eye.dataset.state = value;
      if (view.list) this.refreshList(view.list);
    }
  }

  /** Déplie l'arbre jusqu'à un élément choisi dans la vue 3D et le fait défiler à l'écran. */
  private reveal(index: number): void {
    const { store } = this.app;
    let list = this.root;
    for (const path of this.paths) {
      if (!list?.groups) return;
      const label = store.displayValue(index, path);
      const position = list.groups.findIndex((group) => group.label === label);
      if (position < 0) return;
      this.showPage(list, Math.floor(position / PAGE));
      const view = list.groupViews.get(label);
      if (!view) return;
      this.toggle(view, true, list.depth);
      list = view.list;
    }
    if (!list || list.groups) return;
    const position = list.elements.indexOf(index);
    if (position < 0) return;
    this.showPage(list, Math.floor(position / PAGE));
    list.leafRows.get(index)?.row.scrollIntoView({ block: 'nearest' });
  }

  private showPage(list: ListView, page: number): void {
    if (page === list.page) return;
    list.page = page;
    this.renderList(list);
    this.refreshList(list);
  }
}
