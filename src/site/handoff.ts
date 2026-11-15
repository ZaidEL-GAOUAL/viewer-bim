// Le viewer envoie la maquette ouverte à l'étude de site : sa géométrie cuite et sa géoréférence, déposées dans
// IndexedDB (voir store.ts) ; la page de l'étude les reprend (`site.html?maquette=viewer`) sans relire le fichier.

import { withoutExtension } from '../engine/fileKinds.ts';
import type { App } from '../ui/App.ts';
import { snapshotOf } from './placedModel.ts';
import { openStudyStore } from './store.ts';

export async function sendToStudy(app: App, tab: Window | null): Promise<void> {
  const model = app.model;
  if (!model) {
    tab?.close();
    return;
  }
  app.busy('Envoi de la maquette à l’étude de site…');
  try {
    const store = await openStudyStore();
    await store.putHandoff(snapshotOf(model, withoutExtension(app.sourceName), app.georeference));
    if (tab && !tab.closed) tab.location.href = new URL('site.html?maquette=viewer', document.baseURI).href;
    // Onglet bloqué : la maquette attend dans le navigateur, la page de l'étude la reprendra à son ouverture.
    else app.toast('Le navigateur a bloqué le nouvel onglet : ouvrez « Étude de site » (en haut), la maquette vous y attend.');
  } catch (error) {
    tab?.close();
    app.toast(`La maquette n’a pas pu être envoyée à l’étude de site : ${error instanceof Error ? error.message : String(error)}.`, true);
  } finally {
    app.busy(null);
  }
}
