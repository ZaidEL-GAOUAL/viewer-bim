import { QUANTITIES, QUANTITY_LABELS, computeQuantities, quantityUpdates, type QuantityName, type QuantityPreset } from '../engine/quantities.ts';
import groupPreset from '../data/presets/quantites-groupe.json' with { type: 'json' };
import ifcPreset from '../data/presets/quantites-ifc.json' with { type: 'json' };
import { integer, plural } from '../data/text.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';

const PRESETS = [groupPreset as QuantityPreset, ifcPreset as QuantityPreset];

/**
 * Carte « Quantités manquantes » : longueur, largeur, hauteur, emprise, surfaces et volume calculés depuis la forme affichée
 * (valeurs nettes), écrits dans les propriétés choisies par un préréglage. Les valeurs déjà renseignées sont gardées, sauf
 * « Remplacer ». Une seule étape annulable ; le compte rendu dit ce qui a été écrit et ce qui ne l'a pas été.
 */
export class QuantitiesPanel {
  readonly label = 'Quantités manquantes';
  readonly summary = 'Longueur, surfaces, volume calculés et écrits dans les propriétés';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly scope = h('select', { attrs: { 'aria-label': 'Éléments concernés' } },
    h('option', { text: 'La sélection', attrs: { value: 'selection' } }), h('option', { text: 'Tout ce qui est affiché', attrs: { value: 'visible' } }));
  private readonly preset = h('select', { attrs: { 'aria-label': 'Où écrire les quantités' } }, ...PRESETS.map((preset, i) => h('option', { text: preset.name, attrs: { value: String(i) } })));
  private readonly mapping = h('div', { class: 'quantity-mapping' });
  private readonly overwrite = h('input', { attrs: { type: 'checkbox' } });
  private readonly run: HTMLButtonElement;
  private readonly stop: HTMLButtonElement;
  private readonly report = h('p', { class: 'hint', attrs: { role: 'status' } });
  private readonly targets = new Map<QuantityName, HTMLInputElement>();
  private controller: AbortController | null = null;

  constructor(app: App) {
    this.app = app;
    this.run = button('Calculer et remplir', () => void this.compute(), { class: 'primary' });
    this.stop = button('Arrêter', () => this.controller?.abort(), { attrs: { hidden: '' } });
    this.preset.addEventListener('change', () => this.renderMapping());
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les quantités' } })),
      h('p', { class: 'hint', text: 'Calculées depuis la forme affichée : valeurs nettes (ouvertures déduites), à quelques millimètres de celles du logiciel d’origine. « Fiabilité » dit « exact » pour un solide fermé, « indicatif » sinon.' }),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Éléments' }), this.scope),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Écrire dans' }), this.preset),
      this.mapping,
      h('label', { class: 'tool-check' }, this.overwrite, 'Remplacer les valeurs déjà renseignées'),
      h('div', { class: 'dimensions-actions' }, this.stop, this.run),
      this.report,
    );
    this.renderMapping();
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) this.scope.value = this.app.selection.size > 0 ? 'selection' : 'visible';
    return open;
  }

  /** Le groupe se règle quantité par quantité ; les quantités de base IFC dépendent de la classe : elles sont données telles quelles. */
  private renderMapping(): void {
    clear(this.mapping);
    this.targets.clear();
    const preset = PRESETS[Number(this.preset.value)];
    if (preset.targets) {
      for (const quantity of QUANTITIES) {
        const path = Object.entries(preset.targets).find(([, value]) => value === quantity)?.[0] ?? '';
        const input = h('input', { attrs: { type: 'text', value: path, 'aria-label': `Propriété de ${QUANTITY_LABELS[quantity]}`, placeholder: 'ne pas écrire' } });
        this.targets.set(quantity, input);
        this.mapping.append(h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: QUANTITY_LABELS[quantity] }), input));
      }
    } else {
      const classes = Object.entries(preset.classes ?? {});
      this.mapping.append(h('p', { class: 'hint', text: `Selon « ${preset.classProperty} » : ${classes.map(([name, entry]) => `${name} → ${entry.group}`).join(', ')}. Un élément d’une autre classe n’est pas concerné. Un fichier IFC verrouille souvent Qto_* : ces valeurs sont alors comptées « verrouillées ».` }));
    }
  }

  private currentPreset(): QuantityPreset {
    const preset = PRESETS[Number(this.preset.value)];
    if (!preset.targets) return preset;
    const targets: Record<string, QuantityName> = {};
    for (const [quantity, input] of this.targets) if (input.value.trim()) targets[input.value.trim()] = quantity;
    return { ...preset, targets };
  }

  private async compute(): Promise<void> {
    const { app } = this;
    const model = app.model;
    if (!model) return;
    const indices = this.scope.value === 'selection' ? [...app.selection] : Array.from({ length: model.count }, (_, i) => i).filter((i) => model.state.isRendered(i));
    if (indices.length === 0) {
      this.report.textContent = this.scope.value === 'selection' ? 'Sélectionnez d’abord des éléments.' : 'Aucun élément affiché.';
      return;
    }
    const keys = indices.map((index) => model.keys[index]);
    const controller = (this.controller = new AbortController());
    this.run.disabled = true;
    this.stop.hidden = false;
    try {
      const results = await computeQuantities(model, indices, (progress) => (this.report.textContent = `Calcul… ${Math.round(progress * 100)} %`), controller.signal);
      // Un découpage pendant le calcul renumérote les pièces : rien n'est écrit sur des numéros périmés.
      if (model !== app.model || indices.some((index, k) => model.keys[index] !== keys[k])) {
        this.report.textContent = 'Le modèle a changé pendant le calcul : relancez-le.';
        return;
      }
      const { updates, report } = quantityUpdates(app.store, results, this.currentPreset(), this.overwrite.checked);
      if (updates.length > 0) app.editProperties(updates);
      const parts = [`${plural(report.filled, 'valeur écrite', 'valeurs écrites')} sur ${plural(indices.length, 'élément')}`];
      if (report.present) parts.push(`${plural(report.present, 'déjà renseignée', 'déjà renseignées')} (gardée${report.present > 1 ? 's' : ''})`);
      if (report.notComputable) parts.push(`${plural(report.notComputable, 'élément')} sans géométrie`);
      if (report.unmatched) parts.push(`${plural(report.unmatched, 'élément')} d’une classe sans quantités de base`);
      if (report.approximate) parts.push(`${plural(report.approximate, 'élément')} à forme approchée, ${report.approximate > 1 ? 'mesurés sur leur' : 'mesuré sur sa'} boîte englobante : « indicatif »`);
      if (report.locked) parts.push(`${integer.format(report.locked)} verrouillée${report.locked > 1 ? 's' : ''} par le fichier`);
      this.report.textContent = `${parts.join(' · ')}.${updates.length > 0 ? ' « Annuler » revient en arrière en une fois.' : ''}`;
    } catch (error) {
      this.report.textContent = controller.signal.aborted ? 'Calcul arrêté : rien n’a été écrit.' : `Calcul impossible : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.controller = null;
      this.run.disabled = false;
      this.stop.hidden = true;
    }
  }
}
