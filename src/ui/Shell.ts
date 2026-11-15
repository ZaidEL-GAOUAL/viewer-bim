// L'ossature de l'interface : un rail de groupes à gauche et, à côté, un panneau où s'ouvre un groupe à la fois. Un groupe
// montre soit son contenu (arborescence, assistant…), soit la liste de ses outils ; un outil s'ouvre à la place de la liste,
// avec un retour. Les cartes d'outils (`section.card`, que leur propre `toggle` affiche ou masque) sont logées ici : plus rien
// ne flotte sur la maquette. Une carte qui s'ouvre d'ailleurs (raccourci, bouton de la vue) amène son groupe devant.

import { button, h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export interface ShellTool {
  label: string;
  summary: string;
  /** La carte de l'outil, s'il en a une : la liste du groupe s'efface quand elle s'ouvre. */
  el?: HTMLElement;
  /** Ouvre l'outil, ou lance l'action. */
  open(): void;
  /** Ferme la carte ; absent : la carte est simplement masquée. */
  close?(): void;
  /** Outil sans carte actuellement en service (une mesure en cours) : sa ligne est marquée. */
  active?(): boolean;
}

/** Une carte d'outil que le rail ouvre et ferme (la plupart des panneaux du viewer). */
export interface MenuCard {
  label: string;
  summary: string;
  el: HTMLElement;
  toggle(open?: boolean): boolean;
}

export interface ShellGroup {
  id: string;
  /** Nom court, sous l'icône du rail. */
  label: string;
  /** Titre du panneau, s'il est plus long que le nom du rail. */
  title?: string;
  icon: IconName;
  /** Une phrase sous le titre : ce qu'on fait ici. */
  intro?: string;
  /** Contenu toujours présent dans le groupe (arborescence, assistant, liste d'exports). */
  content?: HTMLElement[];
  tools?: ShellTool[];
  /** Sections sous la liste et sous l'outil ouvert, qui restent quand un outil s'ouvre (les réglages du mode carte). */
  footer?: HTMLElement[];
}

interface Page { group: ShellGroup; el: HTMLElement; list: HTMLElement | null; rows: HTMLButtonElement[]; railButton: HTMLButtonElement }

export class Shell {
  readonly rail: HTMLElement;
  readonly dock: HTMLElement;
  /** Le rail demande d'afficher (`true`) ou de replier le panneau. */
  onDockVisible: (visible: boolean) => void = () => {};
  private readonly title = h('h2', { class: 'dock-title' });
  private readonly back: HTMLButtonElement;
  private readonly pages = new Map<string, Page>();
  private current = '';
  private visible = true;

  constructor(groups: readonly ShellGroup[]) {
    this.back = button('', () => this.closeTool(), { class: 'dock-back', title: 'Revenir à la liste des outils', attrs: { 'aria-label': 'Revenir à la liste des outils', hidden: '' } });
    this.back.append(icon('back'));
    const body = h('div', { class: 'dock-body' });
    this.rail = h('nav', { class: 'rail', attrs: { 'aria-label': 'Outils' } });
    for (const group of groups) {
      const railButton = h('button', { class: 'rail-button', title: group.intro ?? group.title ?? group.label, attrs: { type: 'button', 'aria-pressed': 'false' } }, icon(group.icon), h('span', { text: group.label }));
      railButton.addEventListener('click', () => {
        if (this.current === group.id && this.visible) this.setVisible(false);
        else this.open(group.id);
      });
      this.rail.append(railButton);

      const el = h('section', { class: 'dock-page', attrs: { 'aria-label': group.title ?? group.label, hidden: '' } });
      if (group.intro) el.append(h('p', { class: 'dock-intro', text: group.intro }));
      for (const content of group.content ?? []) el.append(content);
      const rows: HTMLButtonElement[] = [];
      let list: HTMLElement | null = null;
      if (group.tools?.length) {
        list = h('div', { class: 'dock-list' });
        for (const tool of group.tools) {
          const row = h('button', { class: 'dock-row', attrs: { type: 'button' } }, h('span', { class: 'dock-row-name', text: tool.label }), h('span', { class: 'dock-row-summary', text: tool.summary }));
          row.addEventListener('click', () => {
            tool.open();
            this.refresh();
            // La carte ouverte remplace la liste : le clavier passe à son retour.
            if (tool.el && !tool.el.hidden) {
              this.syncPage();
              this.back.focus();
            }
          });
          rows.push(row);
          list.append(row);
        }
        el.append(list);
        for (const tool of group.tools) {
          if (!tool.el) continue;
          el.append(tool.el);
          // La carte s'ouvre ou se ferme d'elle-même (sa croix, un raccourci, un autre bouton) : le panneau suit.
          new MutationObserver(() => this.onCard(group, tool)).observe(tool.el, { attributes: true, attributeFilter: ['hidden'] });
        }
      }
      for (const section of group.footer ?? []) el.append(section);
      body.append(el);
      this.pages.set(group.id, { group, el, list, rows, railButton });
    }
    this.dock = h('aside', { class: 'sidebar left dock' }, h('header', { class: 'dock-head' }, this.back, this.title), body);
    if (groups.length > 0) this.show(groups[0].id);
  }

  /** Amène ce groupe devant et affiche le panneau. */
  open(id: string): void {
    this.show(id);
    this.setVisible(true);
  }

  /** L'état du panneau, quand il change par ailleurs (bouton de repli, fenêtre étroite). */
  setVisible(visible: boolean, notify = true): void {
    this.visible = visible;
    this.syncRail();
    if (notify) this.onDockVisible(visible);
  }

  /** Remet à jour les marques des outils sans carte (mesure en cours). */
  refresh(): void {
    for (const page of this.pages.values()) page.group.tools?.forEach((tool, i) => page.rows[i].setAttribute('aria-pressed', String(tool.active?.() ?? false)));
  }

  private show(id: string): void {
    this.current = id;
    for (const [key, page] of this.pages) page.el.hidden = key !== id;
    this.syncPage();
    this.syncRail();
  }

  private syncRail(): void {
    for (const [key, page] of this.pages) page.railButton.setAttribute('aria-pressed', String(this.visible && key === this.current));
  }

  private openTool(page: Page): ShellTool | undefined {
    return page.group.tools?.find((tool) => tool.el && !tool.el.hidden);
  }

  /** Le titre, le retour et la liste du groupe affiché, selon qu'un de ses outils est ouvert. */
  private syncPage(): void {
    const page = this.pages.get(this.current);
    if (!page) return;
    const tool = this.openTool(page);
    if (page.list) page.list.hidden = tool !== undefined;
    this.back.hidden = tool === undefined;
    this.title.textContent = tool ? tool.label : page.group.title ?? page.group.label;
    page.el.classList.toggle('in-tool', tool !== undefined);
  }

  private onCard(group: ShellGroup, tool: ShellTool): void {
    if (tool.el && !tool.el.hidden) {
      // Un outil à la fois : les autres cartes ouvertes se referment.
      for (const page of this.pages.values()) for (const other of page.group.tools ?? []) if (other !== tool && other.el && !other.el.hidden) this.close(other);
      this.open(group.id);
    }
    this.syncPage();
    // Refermée de l'intérieur (son bouton, Échap) alors que le clavier y était : il revient à la ligne de l'outil.
    const active = document.activeElement;
    if (tool.el?.hidden && (!active || active === document.body || tool.el.contains(active))) this.focusRow(group.id, tool);
  }

  private close(tool: ShellTool): void {
    if (tool.close) tool.close();
    else if (tool.el) tool.el.hidden = true;
  }

  private closeTool(): void {
    const page = this.pages.get(this.current);
    const tool = page && this.openTool(page);
    if (tool) this.close(tool);
    this.syncPage();
    if (tool) this.focusRow(this.current, tool);
  }

  /** Le clavier sur la ligne de cet outil, si sa liste est affichée. */
  private focusRow(id: string, tool: ShellTool): void {
    const page = this.pages.get(id);
    if (!page || id !== this.current || page.list?.hidden) return;
    page.rows[page.group.tools?.indexOf(tool) ?? -1]?.focus();
  }
}

export interface MenuItem { label: string; summary?: string; run(): void }

/** Un bouton qui ouvre une courte liste d'actions ; Échap ou un clic ailleurs la referme. */
export function menuButton(label: string, title: string, items: readonly MenuItem[]): HTMLElement {
  const trigger = h('button', { class: 'menu-trigger', title, attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } }, h('span', { text: label }), icon('chevron'));
  const menu = h('div', { class: 'menu-list', attrs: { role: 'menu', 'aria-label': label, hidden: '' } });
  const close = () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };
  for (const item of items) {
    const row = h('button', { class: 'dock-row', attrs: { type: 'button', role: 'menuitem' } }, h('span', { class: 'dock-row-name', text: item.label }), item.summary ? h('span', { class: 'dock-row-summary', text: item.summary }) : null);
    row.addEventListener('click', () => {
      close();
      item.run();
    });
    menu.append(row);
  }
  const wrap = h('div', { class: 'menu-wrap' }, trigger, menu);
  trigger.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    trigger.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) (menu.firstElementChild as HTMLElement | null)?.focus();
  });
  wrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.hidden) return;
    event.stopPropagation();
    close();
    trigger.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !wrap.contains(event.target as Node)) close();
  });
  return wrap;
}

export type PageId = 'maquette' | 'etude' | 'chantier';

/** Les trois pages du produit, dans l'en-tête de chacune : celle où l'on est, et les deux autres en liens. */
export function pageTabs(current: PageId): HTMLElement {
  const pages: [PageId, string, string, string][] = [
    ['maquette', 'Maquette', 'index.html', 'Ouvrir et exploiter une maquette'],
    ['etude', 'Étude de site', 'site.html', 'Avant le projet : lieu, terrain, voisins, volumes, soleil'],
    ['chantier', 'Chantier', 'chantier.html', 'Suivi de chantier : observations, photos, rapports'],
  ];
  return h('nav', { class: 'page-tabs', attrs: { 'aria-label': 'Pages' } },
    ...pages.map(([id, label, href, title]) => (id === current
      ? h('span', { class: 'page-tab current', text: label, attrs: { 'aria-current': 'page' } })
      : h('a', { class: 'page-tab', text: label, title, attrs: { href } }))));
}

const THEME_KEY = 'viewer-bim.theme';
const THEMES = ['auto', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const THEME_LABEL: Record<Theme, string> = { auto: 'Thème : comme le système', light: 'Thème : clair', dark: 'Thème : sombre' };

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Applique le thème retenu (à appeler avant le premier affichage) ; `auto` suit le système. */
export function applyTheme(theme: Theme = storedTheme()): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Bouton de l'en-tête : système, clair, sombre, à tour de rôle. `onChange` après chaque changement (couleurs de la vue 3D). */
export function themeButton(onChange: () => void = () => {}): HTMLButtonElement {
  let theme = storedTheme();
  const element = button('', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try {
      if (theme === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // stockage indisponible : le choix vaut pour la session
    }
    applyTheme(theme);
    sync();
    onChange();
  }, { class: 'icon-button theme-button' });
  element.append(icon('theme'));
  const sync = () => {
    element.title = `${THEME_LABEL[theme]} (cliquer pour changer)`;
    element.setAttribute('aria-label', THEME_LABEL[theme]);
  };
  sync();
  return element;
}
