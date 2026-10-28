import { PHASE_STATUSES, resolveFilter, type PhaseStatus } from '../data/phases.ts';
import type { App } from './App.ts';
import { clear, h, integer } from './dom.ts';

/** Les états d'un élément dans une phase (voir data/phases.ts), au pluriel, pour le bilan sous les listes. */
const STATUS_LABELS: Record<PhaseStatus, string> = {
  past: 'démolis avant',
  existing: 'existants',
  demolished: 'démolis',
  new: 'nouveaux',
  temporary: 'temporaires',
  future: 'futurs',
};

const NONE = '';

/**
 * Phase et filtre de phase, en tête du panneau « Couleurs et filtres » : le modèle tel qu'il est dans une phase du projet,
 * comme dans une vue de Revit. Visible seulement quand les métadonnées décrivent des phases (section `phases` du contrat).
 * Le calcul est dans `data/phases.ts`, l'application dans `App.setPhase`.
 */
export class PhasePanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly phase: HTMLSelectElement;
  private readonly filter: HTMLSelectElement;
  private readonly summary: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.phase = h('select', { attrs: { id: 'phase-select', 'aria-label': 'Phase' } });
    this.filter = h('select', { attrs: { id: 'phase-filter-select', 'aria-label': 'Filtre de phase' } });
    this.summary = h('p', { class: 'hint phase-summary', attrs: { role: 'status' } });
    this.phase.addEventListener('change', () => this.choose());
    this.filter.addEventListener('change', () => this.choose());

    this.el = h('section', { class: 'phase-section', attrs: { 'aria-label': 'Phases', hidden: '' } },
      h('h3', { text: 'Phases' }),
      h('p', { class: 'hint', text: 'Le modèle tel qu’il est dans une phase du projet : le filtre décide ce que devient chaque élément (nouveau, existant, démoli…).' }),
      h('div', { class: 'phase-fields' },
        h('label', { class: 'field-label', attrs: { for: 'phase-select' }, text: 'Phase' }), this.phase,
        h('label', { class: 'field-label', attrs: { for: 'phase-filter-select' }, text: 'Filtre de phase' }), this.filter,
      ),
      this.summary,
    );

    app.on('model', () => this.rebuild());
    app.on('phase', () => this.sync());
    app.on('metadata', () => this.sync());
    this.rebuild();
  }

  /** Remplit les listes d'après les phases du fichier chargé. */
  private rebuild(): void {
    const phases = this.app.phases;
    this.el.hidden = !phases;
    clear(this.phase);
    clear(this.filter);
    if (!phases) return;
    this.phase.append(h('option', { text: 'Aucune (tout le modèle)', attrs: { value: NONE } }));
    for (const name of phases.order) this.phase.append(h('option', { text: name, attrs: { value: name } }));
    for (const filter of phases.filters) this.filter.append(h('option', { text: filter.default ? `${filter.name} (par défaut)` : filter.name, attrs: { value: filter.name } }));
    this.sync();
  }

  /** L'utilisateur a changé la phase ou le filtre. */
  private choose(): void {
    const phases = this.app.phases;
    if (!phases) return;
    if (this.phase.value === NONE) {
      this.app.setPhase(null);
      return;
    }
    // Sans filtre choisi, celui des vues neuves, comme dans Revit.
    const filter = resolveFilter(phases, this.filter.value || undefined)?.name;
    this.app.setPhase({ phase: this.phase.value, ...(filter !== undefined ? { filter } : {}) });
  }

  /** Les listes montrent la sélection de l'application (une vue enregistrée peut l'avoir changée), et le bilan. */
  private sync(): void {
    const phases = this.app.phases;
    if (!phases) return;
    const selection = this.app.phaseSelection;
    this.phase.value = selection?.phase ?? NONE;
    const filter = resolveFilter(phases, selection?.filter)?.name ?? '';
    this.filter.value = filter;
    this.filter.disabled = !selection || phases.filters.length === 0;
    const evaluation = this.app.phaseEvaluation;
    clear(this.summary);
    if (!selection || !evaluation) {
      this.summary.textContent = 'Aucune phase choisie : tout le modèle est affiché.';
      return;
    }
    const parts = PHASE_STATUSES.filter((status) => evaluation.counts[status] > 0).map((status) => `${integer.format(evaluation.counts[status])} ${STATUS_LABELS[status]}`);
    let hidden = 0;
    for (const flag of evaluation.hidden) hidden += flag;
    const lines = [`Dans « ${selection.phase} » : ${parts.length > 0 ? parts.join(', ') : 'aucun élément lié aux phases'}.`];
    if (hidden > 0) lines.push(`${integer.format(hidden)} masqué${hidden > 1 ? 's' : ''} par le filtre.`);
    if (evaluation.unphased > 0) lines.push(`${integer.format(evaluation.unphased)} sans phase, affiché${evaluation.unphased > 1 ? 's' : ''} tel quel.`);
    this.summary.textContent = lines.join(' ');
  }
}
