// La carte pour choisir le lieu du projet (écran d'accueil, étape « Lieu ») : une carte web ordinaire, Leaflet (BSD-2),
// chargée sur cette page seulement. Glisser pour se déplacer (avec inertie), molette, pincement ou double-clic pour
// zoomer autour du curseur, boutons + et −, échelle. Une seule façon de placer le projet : un clic (ou un résultat de
// recherche) pose un repère, que l'on peut glisser, avec « Placer le projet ici » / « Annuler ». Fond : le plan
// OpenStreetMap, et la photo mondiale de l'utilisateur s'il en a branché une.

import 'leaflet/dist/leaflet.css';
import * as L from 'leaflet';
import { OSM, type ImagerySource } from '../geo/imageryTiles.ts';
import { h } from '../ui/dom.ts';

/** Sous ce zoom, on voit une région, pas un terrain : le repère se règle avant de confirmer. */
const PRECISE_ZOOM = 15;
/** Un clic attend ce délai (ms) : un double-clic zoome sans poser de repère. */
const CLICK_DELAY = 260;

const credit = (source: ImagerySource) => `<a href="${source.creditUrl}" target="_blank" rel="noopener">${source.credit.replace(/</g, '&lt;')}</a>`;
const layer = (source: ImagerySource) => L.tileLayer(source.template, { maxZoom: 19, maxNativeZoom: source.maxZoom, attribution: credit(source) });
const pin = (className: string) => L.divIcon({ className, iconSize: [18, 18], iconAnchor: [9, 9] });

export class WorldMap {
  readonly el = h('div', { class: 'site-world', attrs: { role: 'application', 'aria-label': 'Carte : cliquez votre terrain pour y placer le projet' } });
  /** Le lieu confirmé ; `label` : le nom du résultat de recherche s'il vient de là (et que le repère n'a pas bougé). */
  onPick: (latitude: number, longitude: number, label: string | null) => void = () => {};
  private readonly map: L.Map;
  private readonly plan = layer(OSM);
  private photo: L.TileLayer | null = null;
  private layers: L.Control.Layers | null = null;
  private project: L.Marker | null = null;
  private proposal: L.Marker | null = null;
  private clickTimer = 0;

  constructor() {
    this.map = L.map(this.el, { center: [20, 10], zoom: 2, minZoom: 1, worldCopyJump: true, zoomControl: false, attributionControl: false });
    // Créée hors de la page, la carte se met en « position: relative » : la feuille de style la place (plein cadre).
    this.el.style.position = '';
    L.control.zoom({ position: 'topright', zoomInTitle: 'Zoomer', zoomOutTitle: 'Dézoomer' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(this.map);
    L.control.attribution({ prefix: '<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>' }).addTo(this.map);
    this.plan.addTo(this.map);
    this.map.on('click', (event: L.LeafletMouseEvent) => {
      window.clearTimeout(this.clickTimer);
      this.clickTimer = window.setTimeout(() => this.propose(event.latlng.lat, event.latlng.wrap().lng, null), CLICK_DELAY);
    });
    this.map.on('dblclick', () => window.clearTimeout(this.clickTimer));
    // Montrée après avoir été cachée, ou la fenêtre change : la carte relit sa taille.
    new ResizeObserver(() => this.map.invalidateSize()).observe(this.el);
  }

  /** Le fond « Photo satellite » proposé en plus du plan (null : aucun). */
  setPhoto(source: ImagerySource | null): void {
    if (this.photo) this.map.removeLayer(this.photo);
    this.layers?.remove();
    this.photo = source ? layer(source) : null;
    this.layers = this.photo ? L.control.layers({ Plan: this.plan, 'Photo satellite': this.photo }, undefined, { position: 'topright' }).addTo(this.map) : null;
    if (!this.map.hasLayer(this.plan)) this.plan.addTo(this.map);
  }

  /** Centre la carte sur un point, à ce zoom ; `marked` : c'est le lieu actuel du projet (repère fixe). */
  show(latitude: number, longitude: number, zoom: number, marked: boolean): void {
    this.clearProposal();
    this.project?.remove();
    this.project = marked ? L.marker([latitude, longitude], { icon: pin('site-world-project'), interactive: false, keyboard: false }).addTo(this.map) : null;
    this.map.setView([latitude, longitude], zoom, { animate: false });
  }

  /** Pose le repère à confirmer (un clic sur la carte, ou un résultat de recherche, alors nommé par `label`). */
  propose(latitude: number, longitude: number, label: string | null): void {
    this.clearProposal();
    const marker = L.marker([latitude, longitude], { icon: pin('site-world-marker'), draggable: true, autoPan: true, keyboard: true, title: 'Glissez pour ajuster' }).addTo(this.map);
    this.proposal = marker;
    let named = label;
    const confirm = h('button', { class: 'primary', text: 'Placer le projet ici', attrs: { type: 'button' } });
    const cancel = h('button', { text: 'Annuler', attrs: { type: 'button' } });
    const text = h('p', { class: 'site-world-popup-text' });
    const describe = () => {
      const near = this.map.getZoom() >= PRECISE_ZOOM;
      text.textContent = `${named ?? 'Point choisi'}${near ? '.' : ' : rapprochez-vous (molette) et glissez le repère sur votre terrain, ou confirmez tel quel.'}`;
    };
    confirm.addEventListener('click', () => {
      const at = marker.getLatLng().wrap();
      this.clearProposal();
      this.onPick(at.lat, at.lng, named);
    });
    cancel.addEventListener('click', () => this.clearProposal());
    describe();
    marker.bindPopup(h('div', { class: 'site-world-popup' }, text, h('div', { class: 'tool-row' }, confirm, cancel)), { closeButton: false, autoClose: false, closeOnClick: false, minWidth: 230, offset: [0, -6] });
    marker.on('dragend', () => {
      // Déplacé : ce n'est plus exactement le lieu trouvé par la recherche, son nom sera relu.
      named = null;
      describe();
      marker.openPopup();
    });
    this.map.on('zoomend', describe);
    marker.on('remove', () => this.map.off('zoomend', describe));
    marker.openPopup();
  }

  /** Va sur un lieu trouvé par la recherche et y pose le repère à confirmer. */
  goTo(latitude: number, longitude: number, label: string): void {
    this.map.setView([latitude, longitude], Math.max(this.map.getZoom(), 16), { animate: false });
    this.propose(latitude, longitude, label);
  }

  private clearProposal(): void {
    window.clearTimeout(this.clickTimer);
    this.proposal?.remove();
    this.proposal = null;
  }
}
