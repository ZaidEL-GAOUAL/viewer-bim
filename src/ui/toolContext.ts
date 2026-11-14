import { Box3 } from 'three';
import type { ToolContext } from '../assistant/tools.ts';
import type { App } from './App.ts';

/**
 * Contexte des outils de l'assistant sur l'application : lecture des propriétés, actions sur la
 * vue, écriture annulable des propriétés. Partagé par le chat IA et l'API offerte aux agents.
 */
export function toolContext(app: App): ToolContext {
  const initialModel = app.model, initialRevision = app.revision;
  const box = new Box3();
  return {
    // Une maquette ajoutée ou retirée, des pièces refaites : les numéros d'éléments ont changé, le tour de l'assistant aussi.
    isCurrent: () => app.model === initialModel && app.revision === initialRevision,
    get store() { return app.store; },
    get count() { return app.model?.count ?? 0; },
    get keys() { return app.model?.keys ?? []; },
    labelOf: (index) => app.elementLabel(index),
    get selection() { return app.selection; },
    select: (indices, isolate) => {
      app.select(indices, 'panel');
      if (isolate) app.isolate(indices);
      if (indices.length > 0) app.fitTo(indices);
    },
    setVisible: (indices, visible) => app.setVisible(indices, visible),
    showAll: () => app.showAll(),
    get appearanceRules() { return app.appearanceRules; },
    setAppearanceRules: (rules) => app.setAppearanceRules(rules),
    get grouping() { return app.grouping; },
    groupBy: (paths) => app.groupBy(paths),
    writeProperties: (updates) => app.editProperties(updates),
    openPlanning: (startProperty, endProperty) => app.openPlanning(startProperty, endProperty),
    // La maquette est en Y vers le haut : le bas d'un élément est le minimum de sa boîte en Y.
    heightOf: (index) => {
      if (!app.model?.elementBox(index, box) || box.isEmpty()) return undefined;
      return box.min.y;
    },
  };
}

/**
 * État de la vue avant une action de l'assistant (sélection, visibilité, isolement, règles,
 * regroupement) : la fonction rendue le rétablit, c'est l'action inverse du bouton « Annuler ».
 */
export function snapshotView(app: App): () => void {
  const model = app.model;
  if (!model) return () => {};
  const selection = [...app.selection];
  const visible = Array.from({ length: model.count }, (_, i) => model.state.isVisible(i));
  const isolated = app.isolated;
  const rules = app.appearanceRules.map((rule) => structuredClone(rule));
  const grouping = [...app.grouping];
  return () => {
    if (app.model !== model) return;
    // Un isolement posé par l'action se quitte d'abord : l'affichage d'avant revient, puis chaque élément est remis tel quel.
    if (app.isolated && !isolated) app.toggleIsolate();
    const show: number[] = [], hide: number[] = [];
    visible.forEach((was, i) => { if (model.state.isVisible(i) !== was) (was ? show : hide).push(i); });
    if (show.length > 0) app.setVisible(show, true);
    if (hide.length > 0) app.setVisible(hide, false);
    app.select(selection, 'panel');
    app.setAppearanceRules(rules);
    if (grouping.join('\u0000') !== app.grouping.join('\u0000')) app.groupBy(grouping.filter((path) => app.store.paths.includes(path)));
  };
}
