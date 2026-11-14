import { h } from './dom.ts';
import { icon } from './icons.ts';

/** Une carte que le menu ouvre et ferme. */
export interface MenuCard {
  label: string;
  summary: string;
  el: HTMLElement;
  toggle(open?: boolean): boolean;
}

/**
 * Menu de la barre d'outils qui ouvre des cartes (même présentation que « Mesures ») : un bouton, une liste ; choisir une
 * carte ouverte la referme. Échap ou un clic ailleurs ferme la liste.
 */
export class PanelMenu {
  readonly el: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly menu: HTMLElement;

  constructor(label: string, title: string, cards: readonly MenuCard[]) {
    this.trigger = h('button', { class: 'measure-menu-trigger', title, attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } },
      h('span', { text: label }), h('span', { class: 'measure-menu-chevron' }, icon('chevron')));
    this.menu = h('div', { class: 'measure-menu', attrs: { role: 'menu', 'aria-label': label, hidden: '' } });
    for (const card of cards) {
      const item = h('button', { class: 'measure-menu-item', attrs: { type: 'button', role: 'menuitemcheckbox', 'aria-checked': 'false' } },
        h('span', { class: 'measure-menu-text' }, h('span', { class: 'measure-menu-name', text: card.label }), h('span', { class: 'measure-menu-summary', text: card.summary })));
      item.addEventListener('click', () => {
        this.close();
        item.setAttribute('aria-checked', String(card.toggle()));
      });
      // La carte peut se fermer d'elle-même (sa croix) : la case suit.
      new MutationObserver(() => item.setAttribute('aria-checked', String(!card.el.hidden))).observe(card.el, { attributes: true, attributeFilter: ['hidden'] });
      this.menu.append(item);
    }
    this.el = h('div', { class: 'measure-menu-wrap' }, this.trigger, this.menu);
    this.trigger.addEventListener('click', () => {
      this.menu.hidden = !this.menu.hidden;
      this.trigger.setAttribute('aria-expanded', String(!this.menu.hidden));
    });
    this.menu.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.close();
      this.trigger.focus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.menu.hidden && !this.el.contains(event.target as Node)) this.close();
    });
  }

  private close(): void {
    this.menu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
  }
}
