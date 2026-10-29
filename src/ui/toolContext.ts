import { Box3 } from 'three';
import type { ToolContext } from '../assistant/tools.ts';
import type { App } from './App.ts';

/**
 * Contexte des outils de l'assistant sur l'application : lecture des propriétés, actions sur la
 * vue, écriture annulable des propriétés. Partagé par le chat IA et l'API offerte aux agents.
 */
export function toolContext(app: App): ToolContext {
  const initialModel = app.model;
  const box = new Box3();
  return {
    isCurrent: () => app.model === initialModel,
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
