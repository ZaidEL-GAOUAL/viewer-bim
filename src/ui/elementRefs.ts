// Désigner un élément hors de la session (conflits, observations) : sa clé dans le fichier de sa maquette et le nom de ce
// fichier, et le retrouver ensuite, même quand plusieurs maquettes sont ouvertes (voir data/federation.ts).

import { Box3, Vector3 } from 'three';
import type { ElementRef } from '../data/clashes.ts';
import { sourceIndexOf, sourceKey } from '../data/federation.ts';
import { toModelPoint, yUpToZUp, type Vec3 } from '../data/modelFrame.ts';
import type { App } from './App.ts';

export function elementRef(app: App, element: number): ElementRef {
  const model = app.model!;
  const source = model.sources[sourceIndexOf(model, element)];
  return { key: sourceKey(model.keys[element], source), model: source?.name ?? app.sourceName };
}

/**
 * Retrouve un élément par sa maquette et sa clé. Sans maquette (lu d'un .bcf), ou d'une maquette qui n'est pas ouverte sous ce
 * nom (fichier renommé), par sa clé dans la première maquette qui l'a.
 */
export function refResolver(app: App): (ref: ElementRef) => number | undefined {
  const byRef = new Map<string, number>(), byKey = new Map<string, number>(), models = new Set<string | undefined>();
  for (let i = 0; i < (app.model?.count ?? 0); i++) {
    const ref = elementRef(app, i);
    models.add(ref.model);
    byRef.set(`${ref.model}\u0000${ref.key}`, i);
    if (!byKey.has(ref.key)) byKey.set(ref.key, i);
  }
  return (ref) => (ref.model === undefined || !models.has(ref.model) ? byKey.get(ref.key) : byRef.get(`${ref.model}\u0000${ref.key}`));
}

/** Le centre des éléments, repère du modèle, Z vers le haut (celui des observations et du BCF) ; rien sans géométrie. */
export function elementsPoint(app: App, elements: readonly number[]): Vec3 | undefined {
  const model = app.model;
  if (!model || elements.length === 0) return undefined;
  const box = model.boxOf(elements, new Box3());
  if (box.isEmpty()) return undefined;
  return yUpToZUp(toModelPoint(box.getCenter(new Vector3()).toArray(), model.offset.toArray())).map((x) => Math.round(x * 1000) / 1000 + 0) as Vec3;
}
