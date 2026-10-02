import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

const HINTS = {
  select: '',
  distance: 'Cliquez deux points. Le curseur s’accroche aux sommets proches. Échap annule le point en cours.',
  area: 'Cliquez une face : la surface de toute la face plane est mesurée.',
  volume: 'Cliquez un élément : son volume est calculé à partir de son maillage.',
};

const KINDS = { distance: 'Distance', area: 'Surface', volume: 'Volume' };

/** Liste des mesures prises, affichée dès qu'un outil de mesure est actif ou qu'une mesure existe. */
export class MeasurePanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly hint: HTMLElement;
  private readonly list: HTMLElement;
  private readonly clearButton: HTMLButtonElement;

  constructor(app: App) {
    this.app = app;
    this.hint = h('p', { class: 'hint' });
    this.list = h('ul', { class: 'measure-list' });
    this.clearButton = button('Tout effacer', () => app.measure.clear());
    this.el = h('section', { class: 'card measure-card', attrs: { hidden: '' } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Mesures' }), this.clearButton),
      this.hint,
      this.list,
    );
    app.measure.onChange = () => this.render();
    app.on('tool', () => this.render());
    this.render();
  }

  private render(): void {
    const { measure, tool } = this.app;
    const results = measure.results;
    this.el.hidden = tool === 'select' && results.length === 0;
    this.hint.textContent = HINTS[tool];
    this.hint.hidden = tool === 'select';
    this.clearButton.hidden = results.length === 0;
    clear(this.list);
    for (const result of results) {
      this.list.append(
        h('li', { class: 'measure-item' },
          h('div', { class: 'measure-main' },
            h('span', { class: 'measure-kind', text: KINDS[result.kind] }),
            h('span', { class: 'measure-value', text: (result.approximate ? '≈ ' : '') + result.text }),
            button('×', () => measure.remove(result.id), { class: 'measure-remove', title: 'Supprimer cette mesure' }),
          ),
          h('div', { class: 'measure-note', text: result.note }),
        ),
      );
    }
  }
}
