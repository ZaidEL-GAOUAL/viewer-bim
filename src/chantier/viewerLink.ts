// Dans le viewer, menu « Chantier » : « Projet du suivi de chantier ». Lier la maquette ouverte à un projet du suivi de chantier
// (chantier.html) : ses observations deviennent celles du projet, gardées sur l'appareil et envoyées avec lui. Sans lien, rien
// ne change (observations en fichiers seulement). Tout le reste (magasin, serveur) est chargé à la demande, par link.ts : le
// bundle du viewer ne porte que ce petit module.

import type { App } from '../ui/App.ts';
import { h, stored } from '../ui/dom.ts';
import type { MenuCard } from '../ui/PanelMenu.ts';

/** Le projet lié à une maquette (par le nom de son fichier), gardé dans ce navigateur. */
export const linkKey = (fileName: string): string => `viewer-bim.chantier.projet.${fileName}`;

export function projectCard(app: App, openObservations: () => void): MenuCard {
  const el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': 'Projet du suivi de chantier' } });
  const load = () => import('./link.ts');
  const refresh = () => {
    if (!el.hidden) void load().then((module) => module.render(app, el, openObservations));
  };
  // Une maquette liée auparavant : ses observations reviennent avec celles du projet.
  app.on('model', () => {
    if (app.model && stored.get(linkKey(app.fileName))) void load().then((module) => module.attach(app)).then(refresh);
    else refresh();
  });
  return {
    label: 'Projet du suivi de chantier',
    summary: 'Lier la maquette à un projet : ses observations deviennent celles du projet',
    el,
    toggle(open = el.hidden) {
      el.hidden = !open;
      refresh();
      return open;
    },
  };
}
