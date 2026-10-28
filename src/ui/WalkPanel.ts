import type { Viewer } from '../engine/Viewer.ts';
import { isTyping } from '../engine/WalkControls.ts';
import { formatSpeed } from '../engine/walkMath.ts';
import { button, h } from './dom.ts';

const HELP_KEY = 'viewer-bim.walk-help';
/** Durée d'affichage de la vitesse après un coup de molette. */
const SPEED_SHOWN = 1400;

/** Les touches de la visite : une ligne par geste. */
const HELP: readonly [string[], string][] = [
  [['Z', 'Q', 'S', 'D'], 'se déplacer (ou W A S D, flèches)'],
  [['Maj'], 'courir (×3)'],
  [['Glisser'], 'regarder autour'],
  [['Molette'], 'vitesse de marche'],
  [['E', 'Espace'], 'monter (sans gravité)'],
  [['C'], 'descendre (sans gravité)'],
  [['Double-clic'], 'se placer à cet endroit'],
  [['Échap'], 'quitter la visite'],
];

/**
 * Bouton « Visite » de la barre d'outils et carte d'aide affichée pendant le mode visite : touches,
 * réglages Gravité et Collisions, vitesse de marche. Le moteur est dans `engine/WalkControls.ts`.
 */
export class WalkPanel {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly viewer: Viewer;
  private readonly notify: (message: string) => void;
  private readonly help: HTMLElement;
  private readonly helpButton: HTMLButtonElement;
  private readonly gravity: HTMLInputElement;
  private readonly collisions: HTMLInputElement;
  private readonly speed: HTMLElement;
  private speedTimer = 0;

  /** `notify` affiche un message à l'utilisateur ; `canPlace` dit si un double-clic peut le replacer. */
  constructor(viewer: Viewer, notify: (message: string) => void, canPlace: () => boolean) {
    this.viewer = viewer;
    this.notify = notify;
    const walk = viewer.walk;
    walk.canPlace = canPlace;

    this.button = button('Visite', () => this.toggle(), {
      title: 'Mode visite : marcher dans la maquette à hauteur d’yeux, comme dans Revit ou Navisworks (V)',
      attrs: { 'aria-pressed': 'false' },
    });

    const toggle = (label: string, hint: string, change: (on: boolean) => void) => {
      const input = h('input', { attrs: { type: 'checkbox' } });
      input.addEventListener('change', () => change(input.checked));
      // Après un clic de souris, le focus revient à la visite : Espace fait monter au lieu de recocher la case.
      input.addEventListener('click', (event) => event.detail > 0 && input.blur());
      return { input, label: h('label', { class: 'map-check', title: hint }, input, label) };
    };
    const gravity = toggle('Gravité', 'Les yeux restent à 1,70 m au-dessus du sol, on monte les marches. Décochée : vol libre (E / C pour monter et descendre).', (on) => walk.setGravity(on));
    const collisions = toggle('Collisions', 'On s’arrête devant les murs au lieu de les traverser (une porte fermée est un mur : masquez-la ou décochez).', (on) => walk.setCollisions(on));
    this.gravity = gravity.input;
    this.collisions = collisions.input;

    this.helpButton = button('?', (event) => {
      this.showHelp(this.help.hidden);
      if (event.detail > 0) this.helpButton.blur();
    }, {
      class: 'walk-help-toggle',
      title: 'Afficher ou masquer l’aide',
      attrs: { 'aria-label': 'Afficher ou masquer l’aide de la visite', 'aria-expanded': 'true' },
    });
    this.help = h('dl', { class: 'walk-keys' });
    for (const [keys, text] of HELP) {
      this.help.append(h('dt', {}, ...keys.map((key) => h('kbd', { text: key }))), h('dd', { text }));
    }

    const card = h('section', { class: 'card walk-card', attrs: { 'aria-label': 'Mode visite', 'data-walk-controls': '' } },
      h('div', { class: 'card-head' },
        h('h2', { class: 'card-title', text: 'Mode visite' }),
        h('div', { class: 'walk-head-actions' },
          this.helpButton,
          button('Quitter', () => walk.exit(), { title: 'Quitter la visite et reprendre l’orbite (Échap)' }),
        ),
      ),
      h('div', { class: 'walk-toggles' }, gravity.label, collisions.label),
      this.help,
    );
    this.speed = h('div', { class: 'walk-speed', attrs: { hidden: '', role: 'status' } });
    // Une couche transparente sur la vue : la carte en haut à droite, la vitesse en bas au centre.
    this.el = h('div', { class: 'walk-layer', attrs: { hidden: '' } }, card, this.speed);

    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HELP_KEY) === 'hidden';
    } catch {
      // stockage indisponible : l'aide reste affichée
    }
    this.showHelp(!dismissed, false);

    // V : même raccourci pour entrer et sortir, sauf pendant une saisie de texte ou dans une boîte de dialogue.
    window.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() !== 'v' || event.repeat || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      event.preventDefault();
      this.toggle();
    });

    walk.onChange.add(() => this.sync());
    walk.onSpeed.add((value) => this.showSpeed(value));
    this.sync();
  }

  /** Touche V ou bouton : commence ou termine la visite, en disant pourquoi elle est impossible. */
  toggle(): void {
    const walk = this.viewer.walk;
    if (walk.active) {
      walk.exit();
      return;
    }
    const reason = walk.unavailable;
    if (reason) this.notify(reason);
    else walk.enter();
  }

  private showHelp(shown: boolean, remember = true): void {
    this.help.hidden = !shown;
    this.helpButton.setAttribute('aria-expanded', String(shown));
    if (!remember) return;
    try {
      localStorage.setItem(HELP_KEY, shown ? 'shown' : 'hidden');
    } catch {
      // stockage indisponible : le choix vaut pour la session
    }
  }

  private sync(): void {
    const { active, gravity, collisions } = this.viewer.walk;
    this.button.setAttribute('aria-pressed', String(active));
    this.el.hidden = !active;
    this.gravity.checked = gravity;
    this.collisions.checked = collisions;
    if (!active) this.speed.hidden = true;
  }

  private showSpeed(value: number): void {
    this.speed.textContent = `Vitesse : ${formatSpeed(value)}`;
    this.speed.hidden = false;
    window.clearTimeout(this.speedTimer);
    this.speedTimer = window.setTimeout(() => (this.speed.hidden = true), SPEED_SHOWN);
  }
}
