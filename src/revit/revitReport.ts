import type { RevitReport } from './readRevit.ts';

const integer = new Intl.NumberFormat('fr-FR');
const oneDecimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

/** « 1 forme Revit », « 958 formes Revit » : un seul au singulier, zéro compris, comme partout dans l'interface. */
const count = (n: number, one: string, many: string) => `${integer.format(n)} ${n > 1 ? many : one}`;

/** Le retour de la lecture d'un .rvt ou d'un .rfa, en phrases pour la carte de conversion ; `warning` colore la carte. */
export function describeRevitReport(report: RevitReport): { text: string; warning: boolean } {
  const { release, experimental, elements, seconds, sources, withoutGeometry, warnings } = report;
  const lines: string[] = [];

  const parts: string[] = [];
  if (sources.revit > 0) parts.push(count(sources.revit, 'forme Revit', 'formes Revit'));
  if (sources.partial > 0) parts.push(count(sources.partial, 'partielle', 'partielles'));
  if (sources.rebuilt > 0) parts.push(count(sources.rebuilt, 'reconstruite', 'reconstruites'));
  if (sources.unknown > 0) parts.push(`${count(sources.unknown, 'inconnue', 'inconnues')} (boîte englobante)`);
  const version = release === null ? 'version de Revit inconnue' : `Revit ${release}`;
  lines.push(`${count(elements, 'élément lu', 'éléments lus')} en ${oneDecimal.format(seconds)} s (${version})${parts.length > 0 ? ` : ${parts.join(', ')}` : ''}.`);

  // Les formes qui ne sont pas celles que Revit a enregistrées se retrouvent par leur propriété.
  const approximate = sources.partial + sources.rebuilt + sources.unknown;
  if (approximate > 0) lines.push('Regroupez par « Source de la géométrie » pour les retrouver.');
  if (withoutGeometry > 0) {
    lines.push(`${count(withoutGeometry, 'élément sans géométrie n’est pas dessiné', 'éléments sans géométrie ne sont pas dessinés')}.`);
  }
  lines.push(...warnings);
  // « Expérimental » : la lecture native n'a pas suffi (version de Revit inconnue ou non lue, formes reconstruites à la place).
  if (experimental) lines.push('Lecture expérimentale : des éléments peuvent manquer ou être approximatifs.');

  return { text: lines.join(' '), warning: approximate > 0 || experimental || warnings.length > 0 };
}
