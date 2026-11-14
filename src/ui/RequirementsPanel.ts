import { coerceTo, ownValue, type PropValue } from '../data/metadata.ts';
import { checkRequirementsJob, failuresCsv, parseIds, parseRequirementList, type Failure, type IdsMapping, type RequirementRule } from '../data/requirements.ts';
import ifcPreset from '../data/presets/quantites-ifc.json' with { type: 'json' };
import { integer, plural } from '../data/text.ts';
import { addObservations, locate, observationFromFailures } from '../data/observations.ts';
import { runSliced } from '../engine/sliced.ts';
import type { App } from './App.ts';
import { button, clear, download, h } from './dom.ts';
import { elementRef, elementsPoint } from './elementRefs.ts';
import { authorName } from './ObservationsPanel.ts';

/** Lignes montrées par règle ; le CSV les contient toutes. */
const MAX_ROWS = 100;

/**
 * Carte « Propriétés requises » : une liste tapée (« éléments -> propriétés ») ou un fichier IDS 1.0, vérifiés sur les
 * métadonnées. Le résultat liste, règle par règle, chaque manquement (propriété, requis, en place) : un clic sélectionne
 * l'élément ; une valeur peut être remplie d'un coup sur les éléments en défaut (une étape annulable) ; le rapport s'exporte
 * en CSV. Ce que l'IDS demande et que le viewer ne sait pas vérifier est listé.
 */
export class RequirementsPanel {
  readonly label = 'Propriétés requises';
  readonly summary = 'Vérifier une liste ou un fichier IDS, remplir ce qui manque';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly list = h('textarea', { class: 'tool-text', attrs: { rows: '4', spellcheck: 'false', 'aria-label': 'Règles, une par ligne', placeholder: 'Catégorie = Mur -> Résistance au feu ; Niveau\n* -> Lot' } });
  private readonly classProperty = h('input', { attrs: { type: 'text', value: (ifcPreset as IdsMapping).classProperty, 'aria-label': 'Propriété qui porte la classe IFC' } });
  private readonly idsName = h('span', { class: 'hint' });
  private readonly results = h('div', { class: 'requirement-results' });
  private ids: { name: string; xml: string } | null = null;
  private rules: RequirementRule[] = [];
  private failures: Failure[] = [];
  /** `App.revision` de la vérification : les manquements désignent des éléments par leur numéro. */
  private revision = -1;
  /** La dernière vérification lancée : une plus ancienne qui finit après elle est ignorée. */
  private run = 0;

  constructor(app: App) {
    this.app = app;
    const file = h('input', { attrs: { type: 'file', accept: '.ids,.xml', hidden: '' } });
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (chosen) void chosen.text().then((xml) => { this.ids = { name: chosen.name, xml }; void this.check(); });
    });
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer les propriétés requises' } })),
      h('p', { class: 'hint', text: 'Une règle par ligne : « éléments -> propriétés ». Les éléments : « * » ou « Propriété = valeur » ; les propriétés séparées par « ; », chacune seule (doit être renseignée) ou « Propriété = valeur ».' }),
      this.list,
      h('div', { class: 'tool-row' }, button('Ouvrir un IDS…', () => file.click(), { title: 'Fichier IDS 1.0 (buildingSMART) : entité, attribut, propriété' }), this.idsName, file),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Classe IFC (IDS)' }), this.classProperty),
      h('div', { class: 'dimensions-actions' }, button('Vérifier', () => void this.check(), { class: 'primary' })),
      this.results,
    );
    app.on('model', () => { this.failures = []; clear(this.results); });
    // Pièces refaites, maquette ajoutée ou retirée : les numéros ont changé, « Remplir », les observations et le CSV viseraient d'autres éléments.
    app.on('metadata', () => {
      if (this.failures.length === 0 || this.revision === app.revision) return;
      this.failures = [];
      clear(this.results);
      this.results.append(h('p', { class: 'hint', text: 'La maquette a changé : relancez la vérification.' }));
    });
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    return open;
  }

  private async check(): Promise<void> {
    const { app } = this;
    const model = app.model;
    const run = ++this.run;
    clear(this.results);
    if (!model) return;
    let unsupported: string[] = [];
    try {
      this.rules = parseRequirementList(this.list.value);
      if (this.ids) {
        const parsed = parseIds(this.ids.xml, { ...(ifcPreset as IdsMapping), classProperty: this.classProperty.value.trim() || (ifcPreset as IdsMapping).classProperty });
        this.rules.push(...parsed.rules);
        unsupported = parsed.unsupported;
        this.idsName.textContent = `${parsed.title || this.ids.name} : ${plural(parsed.rules.length, 'règle')}`;
      }
    } catch (error) {
      this.results.append(h('p', { class: 'hint warning', text: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (this.rules.length === 0) {
      this.results.append(h('p', { class: 'hint', text: 'Écrivez une règle ou ouvrez un fichier IDS.' }));
      return;
    }
    // Les originaux remplacés par leurs pièces ne comptent pas : leurs pièces sont vérifiées à leur place.
    const elements = Array.from({ length: model.count }, (_, i) => i).filter((i) => !model.state.isReplaced(i));
    const revision = app.revision;
    const status = h('p', { class: 'hint', text: 'Vérification…' });
    this.results.append(status);
    // Par tranches : un grand modèle et beaucoup de règles ne figent pas l'onglet.
    const failures = await runSliced(checkRequirementsJob(app.store, this.rules, { keys: model.keys, label: (i) => app.elementLabel(i) }, elements),
      (progress) => (status.textContent = `Vérification… ${Math.round(progress * 100)} %`));
    if (run !== this.run || model !== app.model || revision !== app.revision) return;
    status.remove();
    this.revision = revision;
    this.failures = failures;
    const failing = new Set(this.failures.map((failure) => failure.element));
    this.results.append(h('p', { class: 'dimensions-title', text: this.failures.length === 0 ? 'Tout est conforme.' : `${plural(this.failures.length, 'manquement')} sur ${plural(failing.size, 'élément')}` }));
    if (unsupported.length > 0) {
      this.results.append(h('details', { class: 'hint' }, h('summary', { text: `${plural(unsupported.length, 'point')} de l’IDS non vérifié${unsupported.length > 1 ? 's' : ''}` }),
        h('ul', {}, ...unsupported.map((text) => h('li', { text })))));
    }
    this.rules.forEach((rule, r) => {
      const failures = this.failures.filter((failure) => failure.rule === r);
      if (failures.length === 0) return;
      const elements = [...new Set(failures.map((failure) => failure.element))];
      const rows = h('ol', { class: 'dimensions-list' });
      for (const failure of failures.slice(0, MAX_ROWS)) {
        const row = h('button', { class: 'dimensions-row', attrs: { type: 'button' } },
          h('span', { class: 'dimensions-name', text: app.elementLabel(failure.element) }),
          h('span', { class: 'dimensions-values', text: `${failure.property} · requis : ${failure.required} · en place : ${failure.actual}` }));
        row.addEventListener('click', () => { app.select([failure.element], 'panel'); app.fitTo([failure.element]); });
        rows.append(h('li', {}, row));
      }
      this.results.append(h('div', { class: 'requirement-rule' },
        h('p', { class: 'field-label', text: `${rule.name} (${integer.format(failures.length)})` }),
        rows,
        failures.length > MAX_ROWS ? h('p', { class: 'hint', text: `… et ${integer.format(failures.length - MAX_ROWS)} autres, dans le CSV.` }) : null,
        h('div', { class: 'tool-row' }, button(`Sélectionner (${integer.format(elements.length)})`, () => app.select(elements, 'panel'))),
        ...this.fillers(failures),
      ));
    });
    if (this.failures.length > 0) {
      this.results.append(h('div', { class: 'dimensions-actions' },
        button(`Créer des observations (${integer.format(failing.size)})`, () => this.observations(), { title: 'Une observation par élément en défaut, avec la liste de ce qui manque (suivi de chantier)' }),
        button('Exporter en CSV', () => {
          const csv = failuresCsv(this.failures, this.rules, model.keys, (i) => app.elementLabel(i));
          download(new Blob(['﻿', csv], { type: 'text/csv' }), 'proprietes-requises.csv');
        })));
    }
  }

  /** Une observation par élément en défaut (une seule fois par élément), avec ses manquements en description. */
  private observations(): void {
    const { app } = this;
    const byElement = new Map<number, string[]>();
    for (const failure of this.failures) {
      const lines = byElement.get(failure.element) ?? [];
      lines.push(`${failure.property} : requis ${failure.required}, en place ${failure.actual}`);
      byElement.set(failure.element, lines);
    }
    if (byElement.size > 200 && !window.confirm(`Créer ${integer.format(byElement.size)} observations ?`)) return;
    const author = authorName() || 'Viewer BIM', now = new Date();
    const { lists, settings } = app.observations;
    const list = [...byElement].map(([element, lines]) => ({
      ...observationFromFailures(elementRef(app, element), app.elementLabel(element) || app.model!.keys[element], lines, elementsPoint(app, [element]), author, now, lists),
      location: locate(app.store.propsOf(element), settings),
    }));
    const { book, added } = addObservations(app.observations, list);
    app.setObservations(book);
    app.toast(added > 0 ? `${plural(added, 'observation créée', 'observations créées')} : menu « Chantier », carte « Observations ».` : 'Ces éléments ont déjà leurs observations.');
  }

  /** Un champ par propriété requise : la valeur saisie est écrite sur les éléments en défaut, en une étape annulable. */
  private fillers(failures: readonly Failure[]): HTMLElement[] {
    const { app } = this;
    const byProperty = new Map<string, number[]>();
    for (const failure of failures) {
      if (failure.cardinality !== 'required' || failure.property.startsWith('#') || !app.store.isEditable(failure.property)) continue;
      const list = byProperty.get(failure.property);
      if (list) list.push(failure.element);
      else byProperty.set(failure.property, [failure.element]);
    }
    return [...byProperty].map(([property, elements]) => {
      const input = h('input', { attrs: { type: 'text', 'aria-label': `Valeur de ${property}`, placeholder: `Valeur de ${property}` } });
      const fill = button('Remplir', () => {
        const value = input.value.trim();
        if (!value) return;
        try {
          const updates = elements.map((element): [number, string, PropValue] => [element, property, coerceTo(ownValue(app.store.propsOf(element), property), value)]);
          if (app.editProperties(updates)) void this.check();
        } catch (error) {
          app.toast(error instanceof Error ? error.message : String(error), true);
        }
      }, { title: `Écrire cette valeur sur les ${integer.format(elements.length)} éléments en défaut (annulable)` });
      return h('div', { class: 'tool-row' }, input, fill);
    });
  }
}
