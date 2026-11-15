import type { MeasureTool } from './App.ts';

export const MEASURES: { id: MeasureTool; label: string; summary: string; hint: string }[] = [
  { id: 'distance', label: 'Distance', summary: 'Entre deux points', hint: 'Cliquez deux points. Accroche aux sommets proches ; Échap annule le point en cours.' },
  { id: 'area', label: 'Surface', summary: 'D’une face plane', hint: 'Cliquez une face plane pour mesurer sa surface.' },
  { id: 'volume', label: 'Volume', summary: 'D’un élément', hint: 'Cliquez un élément pour mesurer son volume.' },
  { id: 'dimensions', label: 'Cotes', summary: 'Longueur, largeur, hauteur, surface, volume de la sélection', hint: 'Clic : choisir un élément · Ctrl, Cmd ou Maj + clic : en ajouter.' },
];
