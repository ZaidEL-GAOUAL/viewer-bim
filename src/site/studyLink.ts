// Dans le viewer, menu « Chantier » : « Étudier le site de cette maquette ». Ouvre l'étude de site dans un nouvel onglet,
// sur la géoréférence de la maquette, avec sa géométrie déjà cuite (passée par IndexedDB, pas relue). L'onglet est
// ouvert tout de suite, au clic (sinon le navigateur le bloquerait) ; l'envoi, chargé à la demande, le dirige ensuite.

import type { App } from '../ui/App.ts';
import { h } from '../ui/dom.ts';
import type { MenuCard } from '../ui/Shell.ts';

export function studyCard(app: App): MenuCard {
  return {
    label: 'Étudier le site de cette maquette',
    summary: 'Étude de site sur sa position : voisins, soleil et ombres, avec la maquette posée',
    el: h('div', { attrs: { hidden: '' } }),
    toggle: () => {
      if (!app.model) {
        app.toast('Ouvrez d’abord une maquette.', true);
        return false;
      }
      const tab = window.open('', '_blank');
      void import('./handoff.ts').then((module) => module.sendToStudy(app, tab));
      return false;
    },
  };
}
