import { Box3, Vector3 } from 'three';
import { PLAN_CUT_HEIGHT } from '../data/levels.ts';
import { decimal } from '../data/text.ts';
import type { CutColorMode } from '../engine/CutDisplay.ts';
import { formatLength } from '../engine/Measure.ts';
import { AXES, PLANE_NAMES, boxAround, type Axis } from '../engine/Sections.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

interface AxisRow {
  enable: HTMLInputElement;
  name: HTMLElement;
  slider: HTMLInputElement;
  flip: HTMLButtonElement;
  readout: HTMLElement;
}

const MAP_NOTE = 'Carte ouverte : la coupe retire la matière, sans remplissage, contour ni poignées de boîte.';

/**
 * Les coupes : trois plans libres (activation, position, sens, nom, poignées dans la vue), la pose par clic, au niveau ou à
 * travers la sélection, la boîte de coupe (autour de la sélection ou de ce qui est visible, poignées pour la modifier), et
 * le dessin de la coupe (remplissage à la couleur des éléments ou d'une seule couleur, contour). Les hauteurs et positions
 * saisies sont dans le repère du modèle (voir data/modelFrame.ts).
 */
export class SectionPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly rows: AxisRow[] = [];
  private readonly fill: HTMLInputElement;
  private readonly fillColor: HTMLSelectElement;
  private readonly activePlane: HTMLSelectElement;
  private readonly planeName: HTMLInputElement;
  private readonly planePosition: HTMLInputElement;
  private readonly reset: HTMLButtonElement;
  private readonly place: HTMLButtonElement;
  private readonly throughSelection: HTMLButtonElement;
  private readonly level: HTMLSelectElement;
  private readonly height: HTMLInputElement;
  private readonly cutHere: HTMLButtonElement;
  private readonly boxToggle: HTMLInputElement;
  private readonly boxSelection: HTMLButtonElement;
  private readonly boxVisible: HTMLButtonElement;
  private readonly status: HTMLElement;
  private progress: number | null = null;

  constructor(app: App) {
    this.app = app;
    const { viewer } = app;
    const sections = viewer.sections;
    const body = h('div', { class: 'section-rows' });

    for (const axis of AXES) {
      const enable = h('input', { attrs: { type: 'checkbox', id: `section-${axis}` } });
      const slider = h('input', { attrs: { type: 'range', min: '0', max: '1000', step: '1', 'aria-label': `Position de la coupe ${PLANE_NAMES[axis]}` } });
      const flip = button('⇄', () => this.change(axis, { flipped: !sections.flipped[axis] }), { class: 'flip', title: 'Inverser le côté conservé' });
      const readout = h('span', { class: 'readout' });
      const name = h('span', { class: 'section-label' });
      enable.addEventListener('change', () => {
        this.change(axis, { enabled: enable.checked });
        viewer.sectionHandles.select(enable.checked ? axis : AXES.find((slot) => sections.enabled[slot]) ?? null);
      });
      // « input » suit le curseur en continu : déplacer un plan ne modifie que des uniformes GPU.
      slider.addEventListener('input', () => {
        const t = Number(slider.value) / 1000;
        this.change(axis, { position: sections.min[axis] + t * (sections.max[axis] - sections.min[axis]) });
      });
      this.rows[axis] = { enable, name, slider, flip, readout };
      body.append(h('div', { class: 'section-row' }, h('label', { class: 'section-name', attrs: { for: `section-${axis}` } }, enable, name), slider, readout, flip));
    }

    this.fill = h('input', { attrs: { type: 'checkbox', id: 'section-fill' } });
    this.fill.checked = sections.fill;
    this.fill.addEventListener('change', () => {
      sections.fill = this.fill.checked;
      viewer.sectionsChanged();
    });
    this.fillColor = h('select', { attrs: { 'aria-label': 'Couleur du remplissage' } },
      h('option', { text: 'couleur de l’élément', attrs: { value: 'element' } }),
      h('option', { text: 'une seule couleur', attrs: { value: 'single' } }),
    );
    this.fillColor.addEventListener('change', () => {
      viewer.cut.setColorMode(this.fillColor.value as CutColorMode);
      viewer.invalidate();
    });

    // Le plan à manipuler : poignées dans la vue, nom et position saisis.
    this.activePlane = h('select', { attrs: { 'aria-label': 'Plan à manipuler' } },
      h('option', { text: 'Sans poignées', attrs: { value: '' } }),
      ...AXES.map((axis) => h('option', { attrs: { value: String(axis) } })),
    );
    this.activePlane.addEventListener('change', () => viewer.sectionHandles.select(this.activePlane.value === '' ? null : Number(this.activePlane.value) as Axis));
    this.planeName = h('input', { class: 'section-field', attrs: { type: 'text', 'aria-label': 'Nom du plan', placeholder: 'Nom' } });
    this.planeName.addEventListener('change', () => {
      const axis = viewer.sectionHandles.axis;
      if (axis === null) return;
      sections.names[axis] = this.planeName.value.trim() || PLANE_NAMES[axis];
      this.sync();
    });
    this.planePosition = h('input', { class: 'section-field', attrs: { type: 'number', step: '0.01', 'aria-label': 'Position du plan, en mètres, dans le repère du modèle', title: 'Position le long de la normale du plan, en mètres, dans les coordonnées du modèle' } });
    this.planePosition.addEventListener('change', () => {
      const axis = viewer.sectionHandles.axis;
      const value = Number(this.planePosition.value);
      if (axis === null || !app.model || this.planePosition.value === '' || !Number.isFinite(value)) return;
      this.change(axis, { position: value - sections.normals[axis].dot(app.model.offset) });
    });
    this.reset = button('Réaligner', () => {
      const axis = viewer.sectionHandles.axis;
      if (axis === null) return;
      sections.resetOrientation(axis); viewer.sectionsChanged();
    }, { title: 'Remettre la coupe sur son axe X, Y ou Z' });
    const handles = h('div', { class: 'section-handles' }, this.activePlane, this.planeName, this.planePosition, this.reset);

    // Poser une coupe : par clic, à travers la sélection, à une hauteur (celle d'un niveau, ou saisie).
    this.place = button('Placer par clic', () => app.setTool(app.activeTool === 'section' ? 'select' : 'section'), {
      class: 'primary',
      title: 'Puis cliquez une surface de la maquette : le plan de coupe s’y pose, orienté comme elle, et retire ce qui est devant',
      attrs: { 'aria-pressed': 'false' },
    });
    this.throughSelection = button('À travers la sélection', () => this.cutThroughSelection(), { title: 'Un plan par le centre de la sélection, face à vous : ce qui est devant est retiré' });
    this.level = h('select', { attrs: { 'aria-label': 'Niveau' } });
    this.level.addEventListener('change', () => {
      const elevation = Number(this.level.value);
      if (this.level.value !== '') this.height.value = (elevation + PLAN_CUT_HEIGHT).toFixed(2);
    });
    this.height = h('input', { class: 'section-field', attrs: { type: 'number', step: '0.1', placeholder: 'Hauteur (m)', 'aria-label': 'Hauteur de coupe, en mètres, dans le repère du modèle' } });
    this.cutHere = button('Couper', () => this.cutAtHeight(), { title: 'Un plan horizontal à cette hauteur : ce qui est au-dessus est retiré' });

    this.boxToggle = h('input', { attrs: { type: 'checkbox', id: 'section-box' } });
    this.boxToggle.addEventListener('change', () => {
      if (this.boxToggle.checked && !sections.boxCut) this.boxAround('visible');
      else {
        sections.setBoxEnabled(this.boxToggle.checked);
        viewer.sectionsChanged();
      }
    });
    this.boxSelection = button('Autour de la sélection', () => this.boxAround('selection'), { title: 'Une boîte de coupe autour des éléments sélectionnés' });
    this.boxVisible = button('Autour de ce qui est visible', () => this.boxAround('visible'), { title: 'Une boîte de coupe autour des éléments affichés' });
    this.status = h('p', { class: 'hint section-status', attrs: { role: 'status' } });

    this.el = h('section', { class: 'card section-card', attrs: { hidden: '' } },
      h('h2', { class: 'card-title', text: 'Coupes' }),
      h('div', { class: 'section-place' }, this.place, this.throughSelection),
      h('div', { class: 'section-handles' }, this.level, this.height, this.cutHere),
      body,
      handles,
      h('p', { class: 'hint', text: 'Dans la vue : flèche bleue pour déplacer le plan, flèches rouge et verte pour déplacer ses poignées, cercles pour l’incliner. Boîte : carrés orange pour pousser ou tirer une face, rond bleu pour la tourner. Échap annule le geste.' }),
      h('div', { class: 'section-handles' }, h('label', { class: 'section-name', attrs: { for: 'section-box' } }, this.boxToggle, 'Boîte de coupe'), this.boxSelection, this.boxVisible),
      h('div', { class: 'section-handles' }, h('label', { class: 'section-name', attrs: { for: 'section-fill' } }, this.fill, 'Remplir les coupes'), this.fillColor),
      this.status,
    );

    app.on('tool', () => this.place.setAttribute('aria-pressed', String(app.activeTool === 'section')));
    app.on('model', () => this.syncLevels());
    app.on('selection', () => this.sync());
    viewer.onSectionsChange.add(() => this.sync());
    viewer.sectionHandles.onChange.add(() => this.sync());
    viewer.onExternalCameraChange.add(() => this.sync());
    viewer.cut.onProgress.add((progress) => {
      this.progress = progress;
      this.syncStatus();
    });
    this.syncLevels();
  }

  toggle(): boolean {
    this.el.hidden = !this.el.hidden;
    const { viewer } = this.app;
    viewer.sectionHandles.select(this.el.hidden ? null : AXES.find((axis) => viewer.sections.enabled[axis]) ?? null);
    viewer.boxHandles.setShown(!this.el.hidden);
    return !this.el.hidden;
  }

  private change(axis: Axis, change: { enabled?: boolean; position?: number; flipped?: boolean }): void {
    this.app.viewer.sections.set(axis, change);
    this.app.viewer.sectionsChanged();
    this.sync();
  }

  /** Pose un plan, nommé, et en montre les poignées. Le côté retiré est celui de `normal`. */
  private pose(axis: Axis, point: Vector3, normal: Vector3, name: string): void {
    const { viewer } = this.app;
    viewer.sections.setTransform(axis, point, normal);
    viewer.sections.set(axis, { enabled: true, flipped: false });
    viewer.sections.names[axis] = name;
    viewer.sectionsChanged();
    viewer.sectionHandles.select(axis);
  }

  /** Un plan horizontal à la hauteur saisie (repère du modèle) : le plan Y, qui retire le dessus. */
  private cutAtHeight(): void {
    const model = this.app.model;
    const height = Number(this.height.value);
    if (!model || this.height.value === '' || !Number.isFinite(height)) return;
    const centre = model.box.getCenter(new Vector3());
    const level = this.level.selectedOptions[0];
    const name = level && level.value !== '' && Math.abs(Number(level.value) + PLAN_CUT_HEIGHT - height) < 0.006 ? `Niveau ${level.dataset.name}` : `Hauteur ${decimal.format(height)} m`;
    this.pose(1, new Vector3(centre.x, height - model.offset.y, centre.z), new Vector3(0, 1, 0), name);
  }

  /** Un plan par le centre de la sélection, face à la caméra : il retire ce qui est entre elle et ce centre. */
  private cutThroughSelection(): void {
    const { app } = this;
    const { model, viewer } = app;
    if (!model || app.selection.size === 0) return;
    const box = model.boxOf(app.selection, new Box3());
    if (box.isEmpty()) return;
    const toward = viewer.camera.getWorldDirection(new Vector3()).negate();
    const axis = AXES.find((slot) => !viewer.sections.enabled[slot]) ?? viewer.sectionHandles.axis ?? 0;
    this.pose(axis, box.getCenter(new Vector3()), toward, 'Sélection');
  }

  private boxAround(what: 'selection' | 'visible'): void {
    const { app } = this;
    const model = app.model;
    if (!model) return;
    const indices = what === 'selection' ? [...app.selection] : Array.from({ length: model.count }, (_, i) => i).filter((i) => model.state.isVisible(i));
    const box = model.boxOf(indices, new Box3());
    if (box.isEmpty()) {
      app.toast(what === 'selection' ? 'La sélection n’a pas de géométrie.' : 'Aucun élément affiché.');
      this.sync();
      return;
    }
    app.viewer.sections.setBox(boxAround(box));
    app.viewer.sectionsChanged();
  }

  private syncLevels(): void {
    const levels = this.app.levels;
    clear(this.level);
    this.level.hidden = levels.length === 0;
    this.level.append(h('option', { text: 'Niveau…', attrs: { value: '' } }), ...levels.map((level) => {
      const option = h('option', { text: `${level.name} (${decimal.format(level.elevation)} m)`, attrs: { value: String(level.elevation) } });
      option.dataset.name = level.name;
      return option;
    }));
    this.sync();
  }

  private syncStatus(): void {
    const map = this.app.viewer.hasExternalCamera;
    this.status.textContent = map ? MAP_NOTE : this.progress !== null ? `Calcul de la coupe… ${Math.round(this.progress * 100)} %` : '';
    this.status.hidden = this.status.textContent === '';
  }

  private sync(): void {
    const { app } = this;
    const { viewer, model } = app;
    const sections = viewer.sections;
    const hasModel = model !== null;
    const handles = viewer.sectionHandles;
    this.boxToggle.checked = sections.boxEnabled;
    this.boxToggle.disabled = this.boxVisible.disabled = !hasModel;
    this.boxSelection.disabled = this.throughSelection.disabled = !hasModel || app.selection.size === 0;
    this.place.disabled = this.cutHere.disabled = this.level.disabled = this.height.disabled = !hasModel;
    this.activePlane.disabled = !hasModel;
    for (const axis of AXES) {
      const option = this.activePlane.options[axis + 1];
      option.textContent = `Plan ${sections.names[axis]}`;
      option.disabled = !sections.enabled[axis];
    }
    this.activePlane.value = handles.axis === null ? '' : String(handles.axis);
    const axis = handles.axis;
    const canManipulate = hasModel && axis !== null && sections.enabled[axis];
    this.reset.disabled = this.planeName.disabled = this.planePosition.disabled = !canManipulate;
    if (document.activeElement !== this.planeName) this.planeName.value = canManipulate ? sections.names[axis] : '';
    if (document.activeElement !== this.planePosition) this.planePosition.value = canManipulate && model ? (sections.position[axis] + sections.normals[axis].dot(model.offset)).toFixed(2) : '';
    for (const slot of AXES) {
      const row = this.rows[slot];
      const span = sections.max[slot] - sections.min[slot];
      row.name.textContent = sections.names[slot];
      row.enable.checked = sections.enabled[slot];
      row.enable.disabled = !hasModel;
      row.slider.disabled = !hasModel || !sections.enabled[slot];
      row.flip.disabled = row.slider.disabled;
      row.flip.setAttribute('aria-pressed', String(sections.flipped[slot]));
      const t = span > 0 ? (sections.position[slot] - sections.min[slot]) / span : 0.5;
      // Ne pas réécrire la valeur pendant que l'utilisateur fait glisser le curseur.
      if (document.activeElement !== row.slider) row.slider.value = String(Math.round(t * 1000));
      // Position affichée depuis le bas du modèle, plus parlante que la coordonnée recentrée.
      row.readout.textContent = sections.enabled[slot] ? formatLength(sections.position[slot] - sections.min[slot]) : '—';
    }
    this.syncStatus();
  }
}
