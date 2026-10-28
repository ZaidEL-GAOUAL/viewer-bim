import type { SavedView } from '../data/savedViews.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

/**
 * Ce que la vue règle en plus de la caméra, en quelques mots pour la liste. Un plan d'étage dit son type de vue (« Floor
 * Plan »…), pas sa projection ni sa boîte de coupe : toujours parallèle, sa boîte est celle de sa hauteur de coupe.
 */
function details(view: SavedView): string {
  const plan = view.kind === 'plan';
  const parts = [plan ? view.type ?? 'plan' : view.camera.projection === 'perspective' ? 'perspective' : 'parallèle'];
  if (!plan && view.sectionBox) parts.push('boîte de coupe');
  const hidden = (view.hiddenElements?.length ?? 0) + (view.hiddenCategories?.values.length ?? 0);
  if (hidden > 0) parts.push('masquages');
  if (view.phase) parts.push(`phase « ${view.phase} »`);
  return parts.join(' · ');
}

/**
 * Les vues enregistrées du fichier (section `views` du contrat : pour Revit, ses vues 3D nommées et ses plans d'étage) : un
 * clic place la caméra, la boîte de coupe, les masquages et la phase de la vue ; « Vue par défaut » rétablit l'affichage
 * normal. Les vues 3D et les plans d'étage forment deux groupes, chacun sous son titre s'il a des vues. Bouton « Vues » de
 * la barre d'outils (visible seulement s'il y a des vues) et carte dans la vue 3D.
 */
export class ViewsPanel {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly list: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.button = button('Vues', () => this.toggle(), { title: 'Vues enregistrées du fichier : vues 3D et plans d’étage (caméra, coupe, masquages et phase)', attrs: { 'aria-pressed': 'false', hidden: '' } });
    this.list = h('div', { class: 'views-list', attrs: { role: 'group', 'aria-label': 'Vues enregistrées' } });
    this.el = h('section', { class: 'card views-card', attrs: { hidden: '', 'aria-label': 'Vues enregistrées' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Vues' }),
        button('×', () => this.toggle(false), { class: 'measure-remove', title: 'Fermer', attrs: { 'aria-label': 'Fermer les vues' } }),
      ),
      this.list,
      h('p', { class: 'hint', text: 'Reprises : caméra (perspective, parallèle, champ), boîte de coupe, éléments et catégories masqués, phase et filtre de phase. Un plan d’étage s’ouvre vu du dessus, en 2D, coupé à la hauteur de coupe du plan. Les remplacements graphiques par catégorie, le niveau de détail et le style visuel ne le sont pas.' }),
    );
    app.on('model', () => this.rebuild());
    app.on('view', () => this.sync());
    this.rebuild();
  }

  private toggle(open = this.el.hidden): void {
    this.el.hidden = !open;
    this.button.setAttribute('aria-pressed', String(open));
  }

  private rebuild(): void {
    const views = this.app.savedViews;
    this.button.hidden = views.length === 0;
    if (views.length === 0) this.toggle(false);
    clear(this.list);
    const entry = (index: string, label: string, note: string, view: SavedView | null) => {
      const item = button('', () => this.app.openView(view), { class: 'view-item', attrs: { 'aria-pressed': 'false' } });
      item.append(h('span', { class: 'view-name', text: label }), h('span', { class: 'view-note', text: note }));
      item.dataset.view = index;
      return item;
    };
    this.list.append(entry('', 'Vue par défaut', 'affichage normal, caméra d’avant', null));
    // Deux groupes, chacun sous son titre s'il a des vues ; l'indice d'une vue reste celui de la liste entière (voir `sync`).
    const groups: [string, (view: SavedView) => boolean][] = [['Vues 3D', (view) => view.kind !== 'plan'], ['Plans d’étage', (view) => view.kind === 'plan']];
    for (const [title, member] of groups) {
      const items = views.map((view, index) => ({ view, index })).filter(({ view }) => member(view));
      if (items.length === 0) continue;
      this.list.append(h('h3', { class: 'field-label views-group', text: title }));
      for (const { view, index } of items) this.list.append(entry(String(index), view.name, details(view), view));
    }
    this.sync();
  }

  /** La vue ouverte est mise en évidence. */
  private sync(): void {
    const views = this.app.savedViews;
    const active = this.app.activeView === null ? '' : String(views.indexOf(this.app.activeView));
    for (const item of this.list.querySelectorAll<HTMLButtonElement>('.view-item')) item.setAttribute('aria-pressed', String(item.dataset.view === active));
  }
}
