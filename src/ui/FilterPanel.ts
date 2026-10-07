import { suggestGrouping } from '../data/grouping.ts';
import { categoryColor } from '../data/palette.ts';
import { UNDEFINED_LABEL, ownValue, type PropValue } from '../data/metadata.ts';
import { validateAppearanceRules, type AppearanceRule, type RuleCondition, type RuleOp } from '../data/appearanceRules.ts';
import { ELEMENT_FIELDS, fieldLabel, isElementField } from '../data/elementFields.ts';
import type { App } from './App.ts';
import { button, clear, h, integer } from './dom.ts';
import './filter-panel.css';

const MAX_ROWS = 300;

interface ValueRow {
  elements: number[];
  checkbox: HTMLInputElement;
}

/** Une seule pile d’apparence ; les filtres de visibilité restent indépendants. */
export class FilterPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly select: HTMLSelectElement;
  private readonly ruleList: HTMLElement;
  private readonly ruleForm: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly values: HTMLElement;
  private readonly note: HTMLElement;
  private readonly palettes = new Map<string, Map<string, string>>();
  private rows: ValueRow[] = [];
  private path = '';
  private palettePath = '';
  private editingId: string | null = null;
  private ruleLimit = 50;

  constructor(app: App) {
    this.app = app;
    this.select = h('select', { attrs: { 'aria-label': 'Propriété de visibilité' } });
    this.select.addEventListener('change', () => {
      this.path = this.select.value;
      this.search.value = '';
      this.renderValues();
    });

    this.search = h('input', { attrs: { type: 'search', placeholder: 'Filtrer les valeurs…', 'aria-label': 'Filtrer les valeurs' } });
    this.search.addEventListener('input', () => this.renderValues());

    this.values = h('div', { class: 'values', attrs: { 'aria-label': 'Valeurs de visibilité' } });
    this.note = h('p', { class: 'hint' });
    this.ruleList = h('div', { class: 'appearance-rules' });
    this.ruleForm = h('div', { class: 'appearance-form', attrs: { hidden: '' } });

    this.el = h('section', { class: 'panel filter-panel' },
      h('div', { class: 'appearance-header' },
        h('h3', { text: 'Règles d’apparence' }),
        h('p', { class: 'hint', text: 'Une seule liste pour les couleurs et les opacités. En cas de conflit, la dernière règle est prioritaire.' }),
        h('div', { class: 'filter-actions' },
          button('Par valeur de propriété', () => this.editPalette()),
          button('Par condition', () => this.editRule()),
          button('Effacer les règles', () => { if (this.commit([])) this.closeForm(); }, { class: 'subtle' }),
        ),
      ),
      this.ruleList,
      this.ruleForm,
      h('div', { class: 'filter-header visibility-header' },
        h('h3', { text: 'Visibilité' }),
        h('p', { class: 'hint', text: 'Afficher ou masquer les objets selon une propriété.' }),
        this.select,
        h('div', { class: 'filter-actions' },
          button('Tout afficher', () => this.setAll(true), { title: 'Afficher les valeurs correspondant à la recherche' }),
          button('Tout masquer', () => this.setAll(false), { title: 'Masquer les valeurs correspondant à la recherche' }),
        ),
        this.search,
      ),
      this.values,
      this.note,
    );

    app.on('model', () => this.reset());
    app.on('metadata', () => this.refreshPaths());
    app.on('visibility', () => this.refreshChecks());
    app.on('appearance', () => this.renderRules());
    this.reset();
  }

  /** Après une modification de propriétés : mêmes choix, liste des propriétés et des valeurs à jour. */
  private refreshPaths(): void {
    const { store } = this.app;
    clear(this.select);
    for (const path of store.paths) this.select.append(h('option', { text: path, attrs: { value: path } }));
    if (!store.paths.includes(this.path)) this.path = suggestGrouping(store) ?? store.paths[0] ?? '';
    this.select.value = this.path;
    this.select.disabled = this.app.model === null || !this.path;
    this.renderValues();
  }

  private reset(): void {
    const { store, model } = this.app;
    this.palettes.clear();
    this.ruleForm.hidden = true;
    this.editingId = null;
    this.ruleLimit = 50;
    clear(this.select);
    for (const path of store.paths) this.select.append(h('option', { text: path, attrs: { value: path } }));
    this.path = suggestGrouping(store) ?? store.paths[0] ?? '';
    this.palettePath = this.path;
    this.select.value = this.path;
    const usable = model !== null && store.paths.length > 0;
    this.select.disabled = !usable;
    this.search.value = '';
    this.renderValues();
    this.renderRules();
  }

  /** Brouillon de palette : aucune couleur du modèle ne change avant validation. */
  private palette(path: string): Map<string, string> {
    let palette = this.palettes.get(path);
    if (!palette) {
      palette = new Map();
      this.palettes.set(path, palette);
    }
    // Les valeurs apparues depuis (propriétés modifiées) reçoivent une couleur à leur tour.
    for (const label of this.app.store.groups(path).keys()) {
      if (!palette.has(label)) palette.set(label, categoryColor(palette.size, label));
    }
    return palette;
  }

  private closeForm(): void {
    this.ruleForm.hidden = true;
    this.editingId = null;
  }

  private paletteRule(path: string, label: string, color: string): AppearanceRule {
    const first = this.app.store.groups(path).get(label)?.[0];
    const value = first === undefined ? label : ownValue(this.app.store.propsOf(first), path) ?? null;
    return {
      id: `palette:${encodeURIComponent(path)}:${encodeURIComponent(label)}`, name: `${path} : ${label}`, enabled: true, color,
      conditions: [{ property: path, op: label === UNDEFINED_LABEL ? 'missing' : 'equals', ...(label === UNDEFINED_LABEL ? {} : { value }) }],
    };
  }

  private editPalette(): void {
    if (!this.app.model) { this.app.toast('Chargez un modèle avant de définir des règles.'); return; }
    if (!this.app.store.paths.length) { this.app.toast('Chargez les métadonnées pour colorer selon une propriété.'); return; }
    this.editingId = null;
    clear(this.ruleForm); this.ruleForm.hidden = false;
    if (!this.app.store.paths.includes(this.palettePath)) this.palettePath = this.path;
    const property = h('select', { attrs: { 'aria-label': 'Propriété de coloration' } });
    for (const path of this.app.store.paths) property.append(h('option', { text: path, attrs: { value: path } }));
    property.value = this.palettePath;
    const search = h('input', { attrs: { type: 'search', placeholder: 'Rechercher une valeur…', 'aria-label': 'Rechercher une valeur à colorer' } });
    const values = h('div', { class: 'palette-values' });
    const note = h('p', { class: 'hint' });
    const save = button('Ajouter les règles', () => {
      const path = property.value;
      if (!this.app.store.paths.includes(path)) { this.app.toast('Cette propriété a été supprimée. Choisissez une autre propriété.', true); return; }
      const palette = this.palette(path);
      const additions = [...this.app.store.groups(path).keys()].map((label) => this.paletteRule(path, label, palette.get(label)!));
      const ids = new Set(additions.map((rule) => rule.id));
      if (this.commit([...this.app.appearanceRules.filter((rule) => !ids.has(rule.id)), ...additions])) this.closeForm();
    });
    const render = () => {
      clear(values);
      const path = property.value, palette = this.palette(path), groups = this.app.store.groups(path);
      const query = search.value.trim().toLocaleLowerCase('fr');
      let matching = 0, shown = 0;
      for (const [label, elements] of groups) {
        if (query && !label.toLocaleLowerCase('fr').includes(query)) continue;
        matching++;
        if (shown++ >= MAX_ROWS) continue;
        const swatch = h('input', { class: 'swatch', attrs: { type: 'color', value: palette.get(label)!, 'aria-label': `Couleur de ${label}` } });
        swatch.addEventListener('input', () => palette.set(label, swatch.value));
        values.append(h('label', { class: 'palette-value' }, swatch, h('span', { class: 'palette-value-name', text: label, title: label }), h('span', { class: 'count', text: integer.format(elements.length) })));
      }
      note.textContent = matching > MAX_ROWS ? `${integer.format(matching - MAX_ROWS)} autres valeurs : précisez la recherche.` : matching === 0 ? 'Aucune valeur ne correspond.' : '';
      search.hidden = groups.size <= 12 && !query;
      save.textContent = `Ajouter ${integer.format(groups.size)} règle${groups.size > 1 ? 's' : ''}`;
      save.disabled = groups.size === 0;
    };
    const load = () => {
      this.palettePath = property.value;
      const palette = this.palette(this.palettePath);
      const existingColors = new Map(this.app.appearanceRules.map((rule) => [rule.id, rule.color]));
      // Les couleurs déjà ajustées dans la liste de règles servent de point de départ.
      for (const label of palette.keys()) {
        const color = existingColors.get(`palette:${encodeURIComponent(this.palettePath)}:${encodeURIComponent(label)}`);
        if (color) palette.set(label, color);
      }
      search.value = ''; render();
    };
    property.addEventListener('change', load);
    search.addEventListener('input', render);
    this.ruleForm.append(
      h('h4', { text: 'Par valeur de propriété' }), property,
      h('p', { class: 'hint', text: 'Une couleur et une règle par valeur. Ajustez les couleurs, puis ajoutez-les à la liste. Les règles existantes de cette palette seront remplacées en fin de liste.' }),
      search, values, note,
      h('div', { class: 'filter-actions' }, save, button('Annuler', () => this.closeForm(), { class: 'subtle' })),
    );
    load(); property.focus();
  }

  private commit(rules: readonly AppearanceRule[]): boolean {
    try {
      this.app.setAppearanceRules(validateAppearanceRules(rules));
      return true;
    } catch (error) {
      this.app.toast(error instanceof Error ? error.message : String(error), true);
      return false;
    }
  }

  private renderRules(): void {
    clear(this.ruleList);
    const rules = this.app.appearanceRules;
    if (rules.length === 0) {
      this.ruleList.append(h('p', { class: 'hint', text: 'Aucune règle. Les matériaux du modèle sont affichés.' }));
      return;
    }
    rules.slice(0, this.ruleLimit).forEach((rule, index) => {
      const checkbox = h('input', { attrs: { type: 'checkbox', 'aria-label': `Activer ${rule.name || `règle ${index + 1}`}` } });
      checkbox.checked = rule.enabled;
      checkbox.addEventListener('change', () => this.commit(rules.map((item) => item.id === rule.id ? { ...item, enabled: checkbox.checked } : item)));
      const move = (delta: number) => {
        const next = [...this.app.appearanceRules], at = next.findIndex((item) => item.id === rule.id);
        if (at + delta < 0 || at + delta >= next.length) return;
        [next[at], next[at + delta]] = [next[at + delta], next[at]];
        this.commit(next);
      };
      const up = button('↑', () => move(-1), { title: 'Monter la règle', attrs: { 'aria-label': `Monter ${rule.name || rule.id}` } });
      const down = button('↓', () => move(1), { title: 'Descendre la règle', attrs: { 'aria-label': `Descendre ${rule.name || rule.id}` } });
      up.disabled = index === 0; down.disabled = index === rules.length - 1;
      const appearance = [rule.color, rule.opacity === undefined ? undefined : `${Math.round(rule.opacity * 100)} % d’opacité`, rule.opacityBy ? `Opacité selon ${rule.opacityBy.property}` : undefined].filter(Boolean).join(' · ');
      this.ruleList.append(h('div', { class: 'appearance-rule' },
        checkbox,
        button(rule.name || `Règle ${index + 1}`, () => this.editRule(rule), { class: 'appearance-rule-name', title: `${rule.conditions.length || 'Tous les éléments'} condition(s) · ${appearance}` }),
        h('span', { class: 'appearance-rule-swatch', attrs: { style: rule.color ? `background:${rule.color}` : '' }, title: appearance }),
        up, down,
        button('×', () => {
          if (this.editingId === rule.id) this.closeForm();
          this.commit(this.app.appearanceRules.filter((item) => item.id !== rule.id));
        }, { title: 'Retirer la règle', attrs: { 'aria-label': `Retirer ${rule.name || rule.id}` } }),
      ));
    });
    if (rules.length > this.ruleLimit) this.ruleList.append(button(`Afficher ${Math.min(50, rules.length - this.ruleLimit)} règles suivantes (${rules.length} au total)`, () => { this.ruleLimit += 50; this.renderRules(); }, { class: 'subtle' }));
  }

  private editRule(existing?: AppearanceRule): void {
    if (!this.app.model) { this.app.toast('Chargez un modèle avant de définir des règles.'); return; }
    this.editingId = existing?.id ?? null;
    clear(this.ruleForm); this.ruleForm.hidden = false;
    const name = h('input', { attrs: { type: 'text', placeholder: 'Nom de la règle', 'aria-label': 'Nom de la règle', value: existing?.name ?? '' } });
    const propertySelect = (label: string, value?: string, withElementFields = false) => {
      const select = h('select', { attrs: { 'aria-label': label } });
      // Une condition peut aussi viser un élément par son nom ou son identifiant.
      if (withElementFields) for (const field of ELEMENT_FIELDS) select.append(h('option', { text: fieldLabel(field), attrs: { value: field } }));
      for (const path of this.app.store.paths) select.append(h('option', { text: path, attrs: { value: path } }));
      if (value && !this.app.store.paths.includes(value) && !(withElementFields && isElementField(value))) select.append(h('option', { text: `${value} (absente)`, attrs: { value } }));
      select.value = value ?? this.path;
      return select;
    };
    const conditions = h('div', { class: 'appearance-conditions' });
    const readers: { row: HTMLElement; read: () => RuleCondition }[] = [];
    const labels: [RuleOp, string][] = [['equals', '='], ['not_equals', '≠'], ['contains', 'contient'], ['greater', '>'], ['greater_or_equal', '≥'], ['less', '<'], ['less_or_equal', '≤'], ['missing', 'absent'], ['present', 'renseigné']];
    const addCondition = (initial?: RuleCondition) => {
      const property = propertySelect('Propriété de la condition', initial?.property, true);
      const op = h('select', { attrs: { 'aria-label': 'Comparaison' } });
      for (const [value, label] of labels) op.append(h('option', { text: label, attrs: { value } }));
      op.value = initial?.op ?? 'equals';
      const value = h('input', { attrs: { type: 'text', value: initial?.value === undefined || initial.value === null ? '' : String(initial.value), placeholder: 'Valeur', 'aria-label': 'Valeur de la condition' } });
      const scale = h('select', { attrs: { 'aria-label': 'Échelle numérique' } },
        h('option', { text: 'Nombre', attrs: { value: 'number' } }), h('option', { text: 'Pourcentage 0–100', attrs: { value: 'percent' } }), h('option', { text: 'Fraction 0–1', attrs: { value: 'fraction' } }));
      scale.value = initial?.numericScale ?? 'number';
      const sync = () => { value.hidden = ['missing', 'present'].includes(op.value); scale.hidden = value.hidden || op.value === 'contains'; };
      op.addEventListener('change', sync); sync();
      const row = h('div', { class: 'appearance-condition' }, property, op, value, scale,
        button('×', () => { row.remove(); readers.splice(readers.findIndex((entry) => entry.row === row), 1); }, { title: 'Retirer cette condition' }));
      readers.push({ row, read: () => {
        const text = value.value.trim();
        let parsed: PropValue = text;
        if (text === 'true') parsed = true; else if (text === 'false') parsed = false;
        else if (/^[+-]?\d+(?:[.,]\d+)?$/.test(text)) parsed = Number(text.replace(',', '.'));
        return { property: property.value, op: op.value as RuleOp, ...(['missing', 'present'].includes(op.value) ? {} : { value: parsed }), numericScale: scale.value as RuleCondition['numericScale'] };
      } });
      conditions.append(row);
    };
    for (const condition of existing?.conditions ?? [{ property: this.path, op: 'equals' as const, value: '' }]) addCondition(condition);
    const colorEnabled = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Appliquer une couleur' } });
    colorEnabled.checked = existing ? existing.color !== undefined : true;
    const color = h('input', { class: 'swatch', attrs: { type: 'color', value: existing?.color ?? '#808080', 'aria-label': 'Couleur de la règle' } });
    const opacityMode = h('select', { attrs: { 'aria-label': 'Mode d’opacité' } },
      h('option', { text: 'Conserver l’opacité', attrs: { value: 'none' } }),
      h('option', { text: 'Opacité fixe', attrs: { value: 'fixed' } }),
      h('option', { text: 'Opacité selon une propriété', attrs: { value: 'property' } }));
    opacityMode.value = existing?.opacityBy ? 'property' : existing?.opacity !== undefined ? 'fixed' : 'none';
    const opacity = h('input', { attrs: { type: 'number', min: '0', max: '100', step: '1', value: String((existing?.opacity ?? 1) * 100), 'aria-label': 'Opacité en pourcentage' } });
    const opacityProperty = propertySelect('Propriété d’opacité', existing?.opacityBy?.property);
    const opacityScale = h('select', { attrs: { 'aria-label': 'Échelle de la propriété d’opacité' } },
      h('option', { text: 'Valeurs 0–100 (%)', attrs: { value: 'percent' } }), h('option', { text: 'Valeurs 0–1', attrs: { value: 'fraction' } }));
    opacityScale.value = existing?.opacityBy?.scale ?? 'percent';
    const syncOpacity = () => { opacity.hidden = opacityMode.value !== 'fixed'; opacityProperty.hidden = opacityScale.hidden = opacityMode.value !== 'property'; };
    opacityMode.addEventListener('change', syncOpacity); syncOpacity();
    this.ruleForm.append(
      h('h4', { text: existing ? 'Modifier la règle' : 'Par condition' }), name,
      h('span', { class: 'field-label', text: 'Si toutes les conditions correspondent' }), conditions,
      button('Ajouter une condition', () => addCondition(), { class: 'subtle' }),
      h('p', { class: 'hint', text: 'Sans condition, la règle concerne tous les éléments.' }),
      h('label', { class: 'appearance-color' }, colorEnabled, h('span', { text: 'Couleur' }), color),
      opacityMode, opacity, opacityProperty, opacityScale,
      h('div', { class: 'filter-actions' },
        button(existing ? 'Enregistrer la règle' : 'Ajouter la règle', () => {
          const rule: AppearanceRule = { id: existing?.id ?? crypto.randomUUID(), name: name.value.trim() || undefined, enabled: existing?.enabled ?? true, conditions: readers.map((entry) => entry.read()), ...(colorEnabled.checked ? { color: color.value } : {}), ...(opacityMode.value === 'fixed' ? { opacity: Number(opacity.value) / 100 } : {}), ...(opacityMode.value === 'property' ? { opacityBy: { property: opacityProperty.value, scale: opacityScale.value as 'percent' | 'fraction' } } : {}) };
          try {
            validateAppearanceRules([rule], this.app.store, this.app.appearanceRules);
          } catch (error) {
            this.app.toast(error instanceof Error ? error.message : String(error), true);
            return;
          }
          const rules = [...this.app.appearanceRules], index = rules.findIndex((item) => item.id === rule.id);
          if (index === -1) rules.push(rule); else rules[index] = rule;
          if (this.commit(rules)) this.closeForm();
        }),
        button('Annuler', () => this.closeForm(), { class: 'subtle' }),
      ),
    );
    name.focus();
  }

  private setAll(visible: boolean): void {
    if (!this.app.model) return;
    if (this.search.value.trim() === '') {
      if (visible) this.app.showAll();
      else this.app.setVisible(Array.from({ length: this.app.model.count }, (_, i) => i), false);
    } else {
      // Avec un filtre de recherche, l'action porte sur toutes les valeurs qui correspondent,
      // y compris celles que la liste n'affiche pas faute de place.
      const elements: number[] = [];
      for (const [label, members] of this.app.store.groups(this.path)) {
        if (this.matches(label)) for (const index of members) elements.push(index);
      }
      this.app.setVisible(elements, visible);
    }
  }

  private matches(label: string): boolean {
    const query = this.search.value.trim().toLocaleLowerCase('fr');
    return query === '' || label.toLocaleLowerCase('fr').includes(query);
  }

  private renderValues(): void {
    clear(this.values);
    this.rows = [];
    this.note.textContent = '';
    const { store, model } = this.app;
    if (!model) {
      this.note.textContent = 'Aucun modèle chargé.';
      return;
    }
    if (!this.path) {
      this.note.textContent = 'Aucune propriété disponible : chargez le fichier JSON de métadonnées.';
      return;
    }

    const groups = store.groups(this.path);
    const query = this.search.value.trim().toLocaleLowerCase('fr');
    this.search.hidden = groups.size <= 12 && query === '';
    let shown = 0;
    let matching = 0;

    for (const [label, elements] of groups) {
      if (!this.matches(label)) continue;
      matching++;
      if (shown >= MAX_ROWS) continue;
      shown++;

      const checkbox = h('input', { attrs: { type: 'checkbox', 'aria-label': `Afficher ${label}` } });
      checkbox.addEventListener('change', () => this.app.setVisible(elements, checkbox.checked));

      const name = button(label, (event) => this.app.select(elements, 'panel', event.ctrlKey || event.metaKey || event.shiftKey), {
        class: 'value-label',
        title: 'Sélectionner ces éléments',
      });
      this.values.append(h('div', { class: 'value-row' }, checkbox, name, h('span', { class: 'count', text: integer.format(elements.length) })));
      this.rows.push({ elements, checkbox });
    }

    if (matching > shown) {
      this.note.textContent = `${integer.format(matching - shown)} autres valeurs : utilisez la recherche pour les retrouver.`;
    } else if (matching === 0) {
      this.note.textContent = 'Aucune valeur ne correspond.';
    }
    this.refreshChecks();
  }

  private refreshChecks(): void {
    const state = this.app.model?.state;
    if (!state) return;
    for (const { elements, checkbox } of this.rows) {
      let visible = 0;
      for (let i = 0; i < elements.length; i++) if (state.isVisible(elements[i])) visible++;
      checkbox.checked = visible === elements.length;
      checkbox.indeterminate = visible > 0 && visible < elements.length;
    }
  }
}
