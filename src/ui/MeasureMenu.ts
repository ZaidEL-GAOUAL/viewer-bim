import type { App, MeasureTool } from './App.ts';
import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export const MEASURES: { id: MeasureTool; label: string; summary: string; hint: string }[] = [
  { id: 'distance', label: 'Distance', summary: 'Entre deux points', hint: 'Cliquez deux points. Accroche aux sommets proches ; Échap annule le point en cours.' },
  { id: 'area', label: 'Surface', summary: 'D’une face plane', hint: 'Cliquez une face plane pour mesurer sa surface.' },
  { id: 'volume', label: 'Volume', summary: 'D’un élément', hint: 'Cliquez un élément pour mesurer son volume.' },
  { id: 'dimensions', label: 'Cotes', summary: 'Longueur, largeur, hauteur, surface, volume de la sélection', hint: 'Clic : choisir un élément · Ctrl, Cmd ou Maj + clic : en ajouter.' },
];

/**
 * Menu « Mesures » de la barre d'outils : les outils de mesure réunis derrière un seul bouton,
 * qui affiche l'outil actif. Clavier : flèches, Début/Fin, Entrée, Échap.
 */
export class MeasureMenu {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly trigger: HTMLButtonElement;
  private readonly triggerIcon: HTMLElement;
  private readonly triggerLabel: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly items = new Map<MeasureTool, HTMLButtonElement>();

  constructor(app: App) {
    this.app = app;
    this.triggerIcon = h('span', { class: 'measure-menu-icon' }, icon('distance'));
    this.triggerLabel = h('span', { text: 'Mesures' });
    this.trigger = h('button', {
      class: 'measure-menu-trigger',
      title: 'Mesures : distance, surface, volume, cotes de la sélection',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'measure-menu', 'aria-pressed': 'false' },
    }, this.triggerIcon, this.triggerLabel, h('span', { class: 'measure-menu-chevron' }, icon('chevron')));
    this.menu = h('div', { class: 'measure-menu', attrs: { id: 'measure-menu', role: 'menu', 'aria-label': 'Mesures', hidden: '' } });
    for (const measure of MEASURES) {
      const item = h('button', { class: 'measure-menu-item', attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1' } },
        icon(measure.id as IconName),
        h('span', { class: 'measure-menu-text' }, h('span', { class: 'measure-menu-name', text: measure.label }), h('span', { class: 'measure-menu-summary', text: measure.summary })),
      );
      item.addEventListener('click', () => {
        this.close(true);
        // Choisir l'outil déjà actif le referme : retour à la sélection.
        app.setTool(app.tool === measure.id ? 'select' : measure.id);
      });
      this.items.set(measure.id, item);
      this.menu.append(item);
    }
    this.el = h('div', { class: 'measure-menu-wrap' }, this.trigger, this.menu);

    this.trigger.addEventListener('click', () => (this.menu.hidden ? this.open() : this.close(false)));
    this.trigger.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.open(event.key === 'ArrowUp' ? 'last' : 'first');
      }
    });
    this.menu.addEventListener('keydown', (event) => this.onKey(event));
    document.addEventListener('pointerdown', (event) => {
      if (!this.menu.hidden && !this.el.contains(event.target as Node)) this.close(false);
    });
    app.on('tool', () => this.sync());
    this.sync();
  }

  private sync(): void {
    const active = MEASURES.find((measure) => measure.id === this.app.tool);
    this.triggerIcon.replaceChildren(icon((active?.id ?? 'distance') as IconName));
    this.triggerLabel.textContent = active ? active.label : 'Mesures';
    this.trigger.setAttribute('aria-pressed', String(Boolean(active)));
    for (const [id, item] of this.items) item.setAttribute('aria-checked', String(id === this.app.tool));
  }

  private open(focus: 'first' | 'last' | 'checked' = 'checked'): void {
    this.menu.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    const items = [...this.items.values()];
    const checked = items.find((item) => item.getAttribute('aria-checked') === 'true');
    (focus === 'last' ? items[items.length - 1] : focus === 'first' ? items[0] : checked ?? items[0]).focus();
  }

  private close(restoreFocus: boolean): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.trigger.focus();
  }

  private onKey(event: KeyboardEvent): void {
    const items = [...this.items.values()];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
      // Le raccourci Échap de la vue (désélectionner) ne doit pas partir en même temps.
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'Tab') this.close(false);
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  }
}
