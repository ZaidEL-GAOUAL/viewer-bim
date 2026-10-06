import { button } from './dom.ts';

const paths = {
  select: 'M5 3l14 9-7 1-3 7-4-17z',
  distance: 'M4 16L16 4l5 5L9 21z M8 12l2 2 M11 9l2 2 M14 6l2 2',
  area: 'M5 5h14v14H5z M5 10h4 M10 5v4 M14 19v-4 M19 14h-4',
  volume: 'M12 3l9 5v9l-9 5-9-5V8z M3 8l9 5 9-5 M12 13v9',
  undo: 'M8 4L3 9l5 5 M3 9h11a6 6 0 010 12h-3',
  redo: 'M16 4l5 5-5 5 M21 9H10a6 6 0 000 12h3',
  reset: 'M3 4v6h6 M4 10a8 8 0 118 10 M12 7v6l3 2',
  deselect: 'M4 4h5 M4 4v5 M20 4h-5 M20 4v5 M4 20h5 M4 20v-5 M20 20h-5 M20 20v-5 M9 9l6 6 M15 9l-6 6',
  erase: 'M3 15L14 4l7 7-9 9H8z M7 11l7 7 M12 20h9',
  dimensions: 'M5 11h14v9H5z M5 6h14 M5 4v4 M19 4v4 M8 6l-1.5-1.2 M8 6l-1.5 1.2 M16 6l1.5-1.2 M16 6l1.5 1.2',
  chevron: 'M7 10l5 5 5-5',
} as const;

/** Icône seule (décorative) à placer dans un bouton qui porte déjà son texte. */
export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[name]); svg.append(path);
  return svg;
}

export type IconName = keyof typeof paths;

/** Small local SVGs, with accessible names and tooltips on every icon-only button. */
export function iconButton(icon: keyof typeof paths, label: string, onClick: () => void, title = label): HTMLButtonElement {
  const element = button('', onClick, { class: 'icon-button', title, attrs: { 'aria-label': label } });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(name, value);
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', paths[icon]); svg.append(path); element.append(svg);
  return element;
}
