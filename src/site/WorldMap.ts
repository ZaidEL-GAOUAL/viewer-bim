// La carte du monde de l'écran d'accueil et de l'étape « Lieu » : des tuiles OpenStreetMap posées en images dans la
// page (aucune bibliothèque de carte ni de globe). Glisser pour se déplacer, molette ou boutons pour zoomer, cliquer
// pour zoomer sur une région puis, de près, pour placer le projet. La carte fait le tour du monde (antiméridien) et
// s'arrête vers 85° de latitude, comme toute carte Web Mercator : la page le dit.

import { h } from '../ui/dom.ts';
import { MERCATOR_MAX_LATITUDE, imagerySource, lonLatToTile, tileToLonLat, type ImagerySource } from '../geo/imageryTiles.ts';

const TILE = 256;
/** À partir de ce zoom, un clic place le projet ; avant, il rapproche la vue. */
export const PLACE_ZOOM = 14;
const MAX_ZOOM = 19;

const wrap = (degrees: number) => ((((degrees + 180) % 360) + 360) % 360) - 180;

export class WorldMap {
  readonly el: HTMLElement;
  /** Un clic de près : le lieu choisi (degrés). */
  onPick: (latitude: number, longitude: number) => void = () => {};
  private readonly tiles = h('div', { class: 'site-world-tiles' });
  private readonly marker = h('div', { class: 'site-world-marker', attrs: { hidden: '' } });
  private readonly hint = h('div', { class: 'site-world-hint' });
  private readonly source: ImagerySource = imagerySource('osm');
  private readonly shown = new Map<string, HTMLImageElement>();
  /** Centre de la vue en coordonnées Mercator normalisées (x libre pour passer l'antiméridien, y de 0 au nord à 1). */
  private x = 0.5;
  private y = 0.42;
  private zoom = 2;
  private pin: { x: number; y: number } | null = null;
  private queued = false;

  constructor() {
    const zoomButton = (label: string, delta: number, title: string) => {
      const b = h('button', { text: label, title, attrs: { type: 'button' } });
      b.addEventListener('click', (event) => { event.stopPropagation(); this.zoomAt(delta, null); });
      b.addEventListener('pointerdown', (event) => event.stopPropagation());
      return b;
    };
    const credit = h('a', { class: 'site-world-credit', text: this.source.credit, attrs: { href: this.source.creditUrl, target: '_blank', rel: 'noopener' } });
    credit.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.el = h('div', { class: 'site-world', attrs: { role: 'application', 'aria-label': 'Carte du monde : cliquez pour zoomer, puis pour placer le projet' } },
      this.tiles, this.marker, this.hint,
      h('div', { class: 'site-world-zoom' }, zoomButton('+', 1, 'Zoomer'), zoomButton('−', -1, 'Dézoomer')),
      h('p', { class: 'site-world-note', text: `Carte Web Mercator : elle s’arrête vers ${Math.floor(MERCATOR_MAX_LATITUDE)}° de latitude ; au-delà, entrez les coordonnées (étape « Lieu »).` }),
      credit);
    this.bind();
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  /** Centre la carte sur un point, à ce zoom ; le point est marqué s'il est le lieu du projet. */
  show(latitude: number, longitude: number, zoom: number, marked: boolean): void {
    [this.x, this.y] = lonLatToTile(longitude, latitude, 0);
    this.zoom = Math.max(1, Math.min(MAX_ZOOM, zoom));
    this.pin = marked ? { x: this.x, y: this.y } : null;
    this.render();
  }

  private get worldSize(): number {
    return TILE * 2 ** this.zoom;
  }

  /** Point de l'écran (px dans la carte) → Mercator normalisé. */
  private toWorld(px: number, py: number): { x: number; y: number } {
    const size = this.worldSize;
    return { x: this.x + (px - this.el.clientWidth / 2) / size, y: this.y + (py - this.el.clientHeight / 2) / size };
  }

  private clampY(): void {
    const half = this.el.clientHeight / 2 / this.worldSize;
    this.y = half >= 0.5 ? 0.5 : Math.min(1 - half, Math.max(half, this.y));
  }

  private zoomAt(delta: number, at: { px: number; py: number } | null): void {
    const next = Math.max(1, Math.min(MAX_ZOOM, this.zoom + delta));
    if (next === this.zoom) return;
    const px = at?.px ?? this.el.clientWidth / 2, py = at?.py ?? this.el.clientHeight / 2;
    const anchor = this.toWorld(px, py);
    this.zoom = next;
    // Le point sous le curseur reste sous le curseur.
    const size = this.worldSize;
    this.x = anchor.x - (px - this.el.clientWidth / 2) / size;
    this.y = anchor.y - (py - this.el.clientHeight / 2) / size;
    this.render();
  }

  private bind(): void {
    let drag: { px: number; py: number; x: number; y: number; moved: boolean } | null = null;
    this.el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { px: event.clientX, py: event.clientY, x: this.x, y: this.y, moved: false };
      this.el.setPointerCapture(event.pointerId);
    });
    this.el.addEventListener('pointermove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.px, dy = event.clientY - drag.py;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.el.classList.add('dragging');
      this.x = drag.x - dx / this.worldSize;
      this.y = drag.y - dy / this.worldSize;
      this.schedule();
    });
    this.el.addEventListener('pointerup', (event) => {
      const start = drag;
      drag = null;
      this.el.classList.remove('dragging');
      if (!start || start.moved) return;
      const rect = this.el.getBoundingClientRect();
      const px = event.clientX - rect.left, py = event.clientY - rect.top;
      if (this.zoom < PLACE_ZOOM) {
        this.zoomAt(Math.min(3, PLACE_ZOOM - this.zoom), { px, py });
        return;
      }
      const point = this.toWorld(px, py);
      const [longitude, latitude] = tileToLonLat(point.x, point.y, 0);
      this.pin = point;
      this.render();
      this.onPick(latitude, wrap(longitude));
    });
    this.el.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = this.el.getBoundingClientRect();
      this.zoomAt(event.deltaY < 0 ? 0.5 : -0.5, { px: event.clientX - rect.left, py: event.clientY - rect.top });
    }, { passive: false });
  }

  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    });
  }

  private render(): void {
    const width = this.el.clientWidth, height = this.el.clientHeight;
    if (width === 0 || height === 0) return;
    this.clampY();
    const z = Math.max(0, Math.min(this.source.maxZoom, Math.round(this.zoom)));
    const count = 2 ** z;
    const tile = TILE * 2 ** (this.zoom - z);
    const left = this.x * TILE * 2 ** this.zoom - width / 2, top = this.y * TILE * 2 ** this.zoom - height / 2;
    const wanted = new Set<string>();
    for (let ty = Math.max(0, Math.floor(top / tile)); ty <= Math.min(count - 1, Math.floor((top + height) / tile)); ty++) {
      for (let tx = Math.floor(left / tile); tx <= Math.floor((left + width) / tile); tx++) {
        const key = `${z}/${tx}/${ty}`;
        wanted.add(key);
        let img = this.shown.get(key);
        if (!img) {
          img = h('img', { attrs: { alt: '', draggable: 'false', src: this.source.url(z, ((tx % count) + count) % count, ty) } });
          this.shown.set(key, img);
          this.tiles.append(img);
        }
        Object.assign(img.style, { left: `${tx * tile - left}px`, top: `${ty * tile - top}px`, width: `${tile + 0.5}px`, height: `${tile + 0.5}px` });
      }
    }
    for (const [key, img] of this.shown) {
      if (wanted.has(key)) continue;
      img.remove();
      this.shown.delete(key);
    }
    if (this.pin) {
      // La copie du repère la plus proche du centre (la carte se répète d'est en ouest).
      const dx = this.pin.x - this.x - Math.round(this.pin.x - this.x);
      this.marker.style.left = `${width / 2 + dx * TILE * 2 ** this.zoom}px`;
      this.marker.style.top = `${height / 2 + (this.pin.y - this.y) * TILE * 2 ** this.zoom}px`;
    }
    this.marker.hidden = !this.pin;
    this.hint.textContent = this.zoom < PLACE_ZOOM
      ? 'Cliquez sur la carte pour zoomer sur une région (ou cherchez une adresse à gauche).'
      : 'Cliquez sur votre terrain pour y placer le projet.';
  }
}
