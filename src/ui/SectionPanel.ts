import { formatLength } from '../engine/Measure.ts';
import { AXES, type Axis } from '../engine/Sections.ts';
import type { App } from './App.ts';
import { button, h } from './dom.ts';

const LABELS = ['X', 'Y (hauteur)', 'Z'];

interface AxisRow {
  enable: HTMLInputElement;
  slider: HTMLInputElement;
  flip: HTMLButtonElement;
  readout: HTMLElement;
}

/** Réglage des trois plans de coupe : activation, position, sens. */
export class SectionPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly rows: AxisRow[] = [];
  private readonly fill: HTMLInputElement;

  constructor(app: App) {
    this.app = app;
    const sections = app.viewer.sections;
    const body = h('div', { class: 'section-rows' });

    for (const axis of AXES) {
      const enable = h('input', { attrs: { type: 'checkbox', id: `section-${axis}` } });
      const slider = h('input', { attrs: { type: 'range', min: '0', max: '1000', step: '1', 'aria-label': `Position de la coupe ${LABELS[axis]}` } });
      const flip = button('⇄', () => this.change(axis, { flipped: !sections.flipped[axis] }), { class: 'flip', title: 'Inverser le côté conservé' });
      const readout = h('span', { class: 'readout' });
      enable.addEventListener('change', () => this.change(axis, { enabled: enable.checked }));
      // « input » suit le curseur en continu : déplacer un plan ne modifie que des uniformes GPU.
      slider.addEventListener('input', () => {
        const t = Number(slider.value) / 1000;
        this.change(axis, { position: sections.min[axis] + t * (sections.max[axis] - sections.min[axis]) });
      });
      this.rows[axis] = { enable, slider, flip, readout };
      body.append(
        h('div', { class: 'section-row' },
          h('label', { class: 'section-name', attrs: { for: `section-${axis}` } }, enable, LABELS[axis]),
          slider, readout, flip,
        ),
      );
    }

    this.fill = h('input', { attrs: { type: 'checkbox', id: 'section-fill' } });
    this.fill.checked = sections.fill;
    this.fill.addEventListener('change', () => {
      sections.fill = this.fill.checked;
      app.viewer.invalidate();
    });

    this.el = h('section', { class: 'card section-card', attrs: { hidden: '' } },
      h('h2', { class: 'card-title', text: 'Coupes' }),
      body,
      h('label', { class: 'section-fill', attrs: { for: 'section-fill' } }, this.fill, 'Remplir les sections coupées'),
    );

    app.on('model', () => this.sync());
    this.sync();
  }

  toggle(): boolean {
    this.el.hidden = !this.el.hidden;
    return !this.el.hidden;
  }

  private change(axis: Axis, change: { enabled?: boolean; position?: number; flipped?: boolean }): void {
    this.app.viewer.sections.set(axis, change);
    this.app.viewer.sectionsChanged();
    this.sync();
  }

  private sync(): void {
    const sections = this.app.viewer.sections;
    const hasModel = this.app.model !== null;
    for (const axis of AXES) {
      const row = this.rows[axis];
      const span = sections.max[axis] - sections.min[axis];
      row.enable.checked = sections.enabled[axis];
      row.enable.disabled = !hasModel;
      row.slider.disabled = !hasModel || !sections.enabled[axis];
      row.flip.disabled = row.slider.disabled;
      row.flip.setAttribute('aria-pressed', String(sections.flipped[axis]));
      const t = span > 0 ? (sections.position[axis] - sections.min[axis]) / span : 0.5;
      // Ne pas réécrire la valeur pendant que l'utilisateur fait glisser le curseur.
      if (document.activeElement !== row.slider) row.slider.value = String(Math.round(t * 1000));
      // Position affichée depuis le bas du modèle, plus parlante que la coordonnée recentrée.
      row.readout.textContent = sections.enabled[axis] ? formatLength(sections.position[axis] - sections.min[axis]) : '—';
    }
  }
}
