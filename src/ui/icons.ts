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
  // Groupes du rail.
  tree: 'M5 4v15h5 M5 9h5 M5 14h5 M13 6.5h6 M13 11.5h6 M13 16.5h6 M13 19h6',
  palette: 'M12 3a9 9 0 100 18c1.400 0 2-.9 2-2 0-1.200-.6-2 1-2h2a4 4 0 004-4c0-4.500-4-8-9-8z M7.500 12v.01 M9.500 8v.01 M14 7.500v.01',
  eye: 'M2.500 12s3.500-6.500 9.500-6.500 9.500 6.500 9.500 6.500-3.500 6.500-9.500 6.500S2.500 12 2.500 12z M12 9a3 3 0 100 6 3 3 0 000-6z',
  check: 'M4 6h9 M4 11h9 M4 16h5 M13 16l3 3 5-6',
  calendar: 'M4 6h16v14H4z M4 10.500h16 M8 3.500v4 M16 3.500v4',
  pin: 'M12 21s6.500-5.800 6.500-11a6.500 6.500 0 00-13 0c0 5.200 6.500 11 6.500 11z M12 7.500a2.500 2.500 0 100 5 2.500 2.500 0 000-5z',
  export: 'M12 15V4 M7.500 8.500L12 4l4.500 4.500 M4 14.500V20h16v-5.500',
  chat: 'M4 5h16v11h-9l-5 4v-4H4z',
  back: 'M14 6l-6 6 6 6',
  more: 'M5 12v.01 M12 12v.01 M19 12v.01',
  theme: 'M12 3.500a8.500 8.500 0 100 17 6.500 6.500 0 010-17z',
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
