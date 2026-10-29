import type { ToolContext } from '../assistant/tools.ts';
import type { App } from './App.ts';

/**
 * Contexte des outils de l'assistant sur l'application : lecture des propriétés, actions sur la
 * vue, écriture annulable des propriétés. Partagé par le chat IA et l'API offerte aux agents.
 */
export function toolContext(app: App): ToolContext {
  const initialModel = app.model;
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
  };
}
