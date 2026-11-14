import { levelPlans } from '../data/levels.ts';
import type { SavedView } from '../data/savedViews.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { captureView, newViewId } from './userViews.ts';

/**
 * Ce que la vue règle en plus de la caméra, en quelques mots pour la liste. Un plan d'étage dit son type de vue (« Floor
 * Plan »…), pas sa projection ni sa boîte de coupe : toujours parallèle, sa boîte est celle de sa hauteur de coupe.
 */
function details(view: SavedView): string {
  const plan = view.kind === 'plan';
  const parts = [plan ? view.type ?? 'plan' : view.camera.projection === 'perspective' ? 'perspective' : 'parallèle'];
  if (!plan && view.sectionBox) parts.push('boîte de coupe');
  if (view.sections?.some((plane) => plane.enabled)) parts.push('coupes');
  const hidden = (view.hiddenElements?.length ?? 0) + (view.hiddenCategories?.values.length ?? 0);
  if (hidden > 0) parts.push('masquages');
  if (view.isolated) parts.push('isolement');
  if (view.appearanceRules?.length) parts.push('couleurs');
  if (view.phase) parts.push(`phase « ${view.phase} »`);
  return parts.join(' · ');
}

/**
 * Les vues : celles de l'utilisateur (« Mes vues » : enregistrer ce qu'on voit, l'ouvrir, la mettre à jour, la renommer, la
 * dupliquer, la supprimer, la déplacer), celles du fichier (section `views` du contrat : pour Revit, ses vues 3D nommées et
 * ses plans d'étage ; en lecture seule, mais duplicables), et un plan par niveau (section `levels`) que le fichier n'a pas,
 * calculé à la demande. Un clic ouvre la vue ; « Vue par défaut » rétablit l'affichage normal. Bouton « Vues » de la barre
 * d'outils et carte dans la vue 3D.
 */
export class ViewsPanel {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly list: HTMLElement;
  private readonly save: HTMLButtonElement;
  /** Les plans par niveau du modèle ouvert : les mêmes objets d'une reconstruction à l'autre (la vue ouverte est reconnue). */
  private generated: SavedView[] = [];

  constructor(app: App) {
    this.app = app;
    this.button = button('Vues', () => this.toggle(), { title: 'Vues : les vôtres, celles du fichier (vues 3D, plans d’étage) et un plan par niveau', attrs: { 'aria-pressed': 'false', hidden: '' } });
    this.list = h('div', { class: 'views-list', attrs: { role: 'group', 'aria-label': 'Vues enregistrées' } });
    this.save = button('Enregistrer cette vue', () => this.saveCurrent(), { class: 'primary', title: 'Enregistrer ce que vous voyez : caméra, coupes, boîte, masquages, isolement, phase, couleurs et regroupement' });
    this.el = h('section', { class: 'card views-card', attrs: { hidden: '', 'aria-label': 'Vues enregistrées' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Vues' }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les vues' } }),
      ),
      h('div', { class: 'section-place' }, this.save),
      this.list,
      h('p', { class: 'hint', text: 'Vos vues reprennent tout ce que vous voyez et s’enregistrent avec « JSON ↓ » ou « Modifications ↓ ». Celles du fichier reprennent caméra, boîte de coupe, masquages et phase ; un plan d’étage s’ouvre vu du dessus, en 2D, coupé à sa hauteur de coupe.' }),
    );
    app.on('model', () => {
      this.generated = levelPlans(app.levels, app.savedViews);
      this.rebuild();
    });
    app.on('userViews', () => this.rebuild());
    app.on('view', () => this.sync());
    this.rebuild();
  }

  private toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
    this.button.setAttribute('aria-pressed', String(open));
  }

  private rebuild(): void {
    const { app } = this;
    this.button.hidden = app.model === null;
    if (app.model === null) this.toggle(false);
    this.save.disabled = app.model === null;
    clear(this.list);
    const entry = (key: string, view: SavedView | null, label: string, note: string, ...actions: HTMLButtonElement[]) => {
      const item = button('', () => app.openView(view), { class: 'view-item', attrs: { 'aria-pressed': 'false' } });
      item.append(h('span', { class: 'view-name', text: label }), h('span', { class: 'view-note', text: note }));
      item.dataset.view = key;
      return actions.length === 0 ? item : h('div', { class: 'view-row' }, item, ...actions);
    };
    const group = (title: string, items: HTMLElement[]) => {
      if (items.length > 0) this.list.append(h('h3', { class: 'field-label views-group', text: title }), ...items);
    };
    const action = (label: string, title: string, run: () => void) => button(label, run, { class: 'view-action', title, attrs: { 'aria-label': title } });
    const duplicate = (view: SavedView) => action('⧉', `Dupliquer « ${view.name} » dans Mes vues`, () => this.store([...app.userViews, { ...structuredClone(view), name: `${view.name} (copie)`, id: newViewId(), origin: 'user' }]));

    this.list.append(entry('', null, 'Vue par défaut', 'affichage normal, caméra d’avant'));
    const mine = app.userViews;
    group('Mes vues', mine.map((view, index) => entry(`u:${index}`, view, view.name, details(view),
      action('↻', `Mettre à jour « ${view.name} » avec l’affichage actuel`, () => this.replace(index, captureView(app, view.name, view.id))),
      action('✎', `Renommer « ${view.name} »`, () => {
        const name = window.prompt('Nouveau nom de la vue', view.name)?.trim();
        if (name) this.replace(index, { ...view, name });
      }),
      duplicate(view),
      action('↑', 'Monter', () => this.move(index, -1)),
      action('↓', 'Descendre', () => this.move(index, 1)),
      action('×', `Supprimer « ${view.name} »`, () => {
        if (!window.confirm(`Supprimer la vue « ${view.name} » ?`)) return;
        if (app.activeView === view) app.activeView = null;
        this.store(mine.filter((_, i) => i !== index));
      }),
    )));
    const files = app.savedViews;
    // L'indice d'une vue du fichier reste celui de la liste entière (voir `sync`).
    const fileEntries = (member: (view: SavedView) => boolean) => files.flatMap((view, index) => member(view) ? [entry(`f:${index}`, view, view.name, details(view), duplicate(view))] : []);
    group('Vues 3D', fileEntries((view) => view.kind !== 'plan'));
    group('Plans d’étage', fileEntries((view) => view.kind === 'plan'));
    group('Plans par niveau', this.generated.map((view, index) => entry(`g:${index}`, view, view.name, 'calculé : coupe à 1,20 m au-dessus du niveau')));
    this.sync();
  }

  private store(views: SavedView[]): void {
    this.app.setUserViews(views);
  }

  private replace(index: number, view: SavedView): void {
    const views = [...this.app.userViews];
    if (this.app.activeView === views[index]) this.app.activeView = view;
    views[index] = view;
    this.store(views);
  }

  private move(index: number, step: number): void {
    const views = [...this.app.userViews];
    const target = index + step;
    if (target < 0 || target >= views.length) return;
    [views[index], views[target]] = [views[target], views[index]];
    this.store(views);
  }

  /** « Enregistrer cette vue » : un nom, puis ce que l'utilisateur voit devient une vue de « Mes vues », ouverte. */
  private saveCurrent(): void {
    const { app } = this;
    if (!app.model) return;
    const name = window.prompt('Nom de la vue', `Vue ${app.userViews.length + 1}`)?.trim();
    if (!name) return;
    const view = captureView(app, name);
    app.activeView = view;
    this.store([...app.userViews, view]);
    this.toggle(true);
  }

  /** La vue ouverte est mise en évidence. */
  private sync(): void {
    const { app } = this;
    const view = app.activeView;
    const index = (list: readonly SavedView[], prefix: string) => (view && list.includes(view) ? `${prefix}:${list.indexOf(view)}` : null);
    const active = view === null ? '' : index(app.userViews, 'u') ?? index(app.savedViews, 'f') ?? index(this.generated, 'g');
    for (const item of this.list.querySelectorAll<HTMLButtonElement>('.view-item')) item.setAttribute('aria-pressed', String(item.dataset.view === active));
  }
}
