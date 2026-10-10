import { Box3 } from 'three';
import { azimuthOf, trueNorthFromAzimuth } from '../geo/georeference.ts';
import { GlobeView, IMAGERY, type ImageryKind } from '../geo/GlobeView.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6, useGrouping: false });

/**
 * Carte « Carte » : le globe sous la maquette (CesiumJS, chargé à la demande), le choix du fond,
 * et la position de la maquette sur Terre — lue dans le fichier, saisie, ou prise d'un clic.
 */
export class MapPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly globe: GlobeView;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly fields = { latitude: h('input'), longitude: h('input'), elevation: h('input'), rotation: h('input') };
  private open = false;
  private loading = false;
  /** Appelé quand le globe s'ouvre ou se ferme (l'application montre ou cache son hôte). */
  onChange: () => void = () => {};

  constructor(app: App, host: HTMLElement) {
    this.app = app;
    this.globe = new GlobeView(host, app.viewer);
    this.status = h('p', { class: 'hint map-status' });
    this.body = h('div', { class: 'map-body' });
    this.el = h('section', { class: 'card map-card', attrs: { hidden: '' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Carte' }),
        button('×', () => void this.toggle(), { class: 'measure-remove', title: 'Fermer la carte', attrs: { 'aria-label': 'Fermer la carte' } }),
      ),
      this.status,
      this.body,
    );
    for (const [key, input] of Object.entries(this.fields)) {
      input.type = 'number';
      input.step = 'any';
      input.setAttribute('aria-label', { latitude: 'Latitude', longitude: 'Longitude', elevation: 'Altitude (m)', rotation: 'Rotation du nord (°)' }[key] ?? key);
      input.addEventListener('change', () => this.applyFields());
    }
    this.globe.onModelStatus = () => this.render();
    app.on('model', () => this.onModel());
    app.on('georeference', () => {
      // Position saisie, cliquée ou reprise du fichier : le globe déplace la maquette.
      if (this.globe.active) this.pushPlacement();
      this.render();
    });
    this.render();
  }

  get active(): boolean {
    return this.globe.active;
  }

  /** Vrai dès que la carte est demandée : son hôte doit être visible avant que le globe ne se crée. */
  get isOpen(): boolean {
    return this.open;
  }

  /** Ouvre ou ferme la carte ; renvoie l'état obtenu. */
  async toggle(): Promise<boolean> {
    if (this.open) {
      this.open = false;
      this.el.hidden = true;
      this.globe.close();
      this.onChange();
      return false;
    }
    this.open = true;
    this.el.hidden = false;
    // L'hôte du globe est affiché avant la création : un canvas créé caché (0 × 0) ne dessine pas.
    this.onChange();
    this.render();
    await this.load();
    return this.open;
  }

  private async load(): Promise<void> {
    if (this.globe.active || this.loading) return;
    this.loading = true;
    this.status.textContent = 'Chargement de la carte (CesiumJS, quelques mégaoctets, une seule fois)…';
    try {
      await this.globe.open();
      if (!this.open) {
        this.globe.close();
        return;
      }
      this.pushPlacement();
      this.globe.setModel(this.app.model);
      // Premier affichage : la caméra du globe part de l'espace ; on l'amène sur la maquette d'un coup.
      this.globe.flyTo(this.app.model?.box ?? null, 0);
      this.onChange();
    } catch (error) {
      this.status.textContent = `La carte n’a pas pu se charger : ${error instanceof Error ? error.message : String(error)}`;
      this.status.classList.add('warning');
      return;
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private onModel(): void {
    this.render();
    if (this.globe.active) {
      this.pushPlacement();
      this.globe.setModel(this.app.model);
      this.globe.flyTo(this.app.model?.box ?? null, 0.6);
    }
  }

  private pushPlacement(): void {
    const model = this.app.model;
    this.globe.setPlacement(model ? this.app.georeference : null, model?.offset ?? new Box3().min);
  }

  private applyFields(): void {
    const read = (input: HTMLInputElement) => (input.value.trim() === '' ? NaN : input.valueAsNumber);
    const latitude = read(this.fields.latitude), longitude = read(this.fields.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      this.app.toast('Latitude (−90 à 90) et longitude (−180 à 180) sont nécessaires.', true);
      return;
    }
    const current = this.app.georeference;
    const elevation = read(this.fields.elevation), rotation = read(this.fields.rotation);
    this.app.setGeoreference({
      latitude,
      longitude,
      elevation: Number.isFinite(elevation) ? elevation : current?.elevation ?? 0,
      origin: current?.origin ?? [0, 0, 0],
      trueNorth: Number.isFinite(rotation) ? trueNorthFromAzimuth(rotation) : current?.trueNorth ?? [0, 1],
      source: 'manuel',
    });
  }

  private render(): void {
    clear(this.body);
    const { app } = this;
    const model = app.model;
    if (!this.open) return;
    if (!model) {
      this.status.textContent = 'Chargez une maquette pour la poser sur la carte.';
      this.status.classList.remove('warning');
      return;
    }
    const georeference = app.georeference;
    if (this.globe.active) {
      this.status.classList.remove('warning');
      const modelStatus = this.globe.modelStatus;
      const sent = modelStatus === 'loading' ? ' Envoi de la maquette au globe…'
        : modelStatus === 'error' ? ` Le globe n’a pas pu dessiner la maquette (${this.globe.modelError}) ; le viewer la garde.`
        : '';
      this.status.textContent = georeference
        ? `Maquette posée à ${number.format(georeference.latitude)}, ${number.format(georeference.longitude)}${georeference.source ? ` (${georeference.source === 'manuel' ? 'position saisie' : `d’après ${georeference.source}`})` : ''}.${sent}`
        : 'Le fichier ne donne pas la position de la maquette : saisissez-la ci-dessous, ou cliquez sur la carte.';
      if (modelStatus === 'error') this.status.classList.add('warning');
    }

    const imagery = h('select', { attrs: { 'aria-label': 'Fond de carte' } });
    for (const item of IMAGERY) imagery.append(h('option', { text: item.label, attrs: { value: item.id, title: item.hint } }));
    imagery.value = this.globe.imageryKind;
    imagery.addEventListener('change', () => this.globe.setImagery(imagery.value as ImageryKind));

    const fill = () => {
      this.fields.latitude.value = georeference ? String(georeference.latitude) : '';
      this.fields.longitude.value = georeference ? String(georeference.longitude) : '';
      this.fields.elevation.value = georeference ? String(georeference.elevation) : '';
      this.fields.rotation.value = georeference ? String(azimuthOf(georeference.trueNorth)) : '';
    };
    fill();
    const field = (label: string, input: HTMLInputElement) => h('label', { class: 'map-field' }, h('span', { text: label }), input);
    const pick = button('Placer au clic', () => {
      if (!this.globe.active) return;
      pick.setAttribute('aria-pressed', 'true');
      this.status.textContent = 'Cliquez l’endroit de la carte où poser la maquette (Échap pour annuler).';
      this.globe.pickOnce(({ latitude, longitude }) => {
        pick.setAttribute('aria-pressed', 'false');
        const current = app.georeference;
        app.setGeoreference({ latitude, longitude, elevation: current?.elevation ?? 0, origin: current?.origin ?? [0, 0, 0], trueNorth: current?.trueNorth ?? [0, 1], source: 'manuel' });
        app.fitTo([...Array(model.count).keys()]);
      });
    }, { title: 'Le prochain clic sur le globe donne la position de la maquette', attrs: { 'aria-pressed': 'false' } });
    const fromFile = app.metadata?.georeference;
    this.body.append(
      h('div', { class: 'map-row' }, h('span', { class: 'field-label', text: 'Fond' }), imagery),
      h('div', { class: 'map-fields' },
        field('Latitude', this.fields.latitude), field('Longitude', this.fields.longitude),
        field('Altitude (m)', this.fields.elevation), field('Nord (°)', this.fields.rotation),
      ),
      h('div', { class: 'map-actions' },
        pick,
        button('Cadrer', () => this.globe.flyTo(model.box, 1), { title: 'Voler jusqu’à la maquette' }),
        fromFile ? button('Position du fichier', () => app.setGeoreference(fromFile), { title: 'Revenir à la position lue dans le fichier' }) : null,
      ),
      h('p', { class: 'hint', text: 'Nord (°) : angle du nord vrai par rapport à l’axe Y du projet, sens horaire. La position est enregistrée dans « JSON ↓ ». Cartes : OpenStreetMap et IGN, gratuites, sans clé.' }),
    );
  }
}
