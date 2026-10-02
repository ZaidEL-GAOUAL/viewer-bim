import { UNDEFINED_LABEL } from './metadata.ts';

// Douze teintes bien séparées, puis des teintes générées par angle d'or au-delà.
const BASE = [
  '#3b82c4', '#e8833a', '#3fa66b', '#d1495b', '#8367c7', '#b8862f',
  '#2aa7a7', '#d264a8', '#7f9c2b', '#5d6fd1', '#c46a4a', '#4f9bd9',
];

const UNDEFINED_COLOR = '#9aa0a6';

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Couleur attribuée à la n-ième valeur distincte d'une propriété. */
export function categoryColor(index: number, label: string): string {
  if (label === UNDEFINED_LABEL) return UNDEFINED_COLOR;
  if (index < BASE.length) return BASE[index];
  const hue = (index * 137.508) % 360;
  return hslToHex(hue, 0.55, index % 2 === 0 ? 0.5 : 0.62);
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
