import { compileSchedule, evaluateSchedule, formatScheduleDate, parseSchedule, parseScheduleDate, scheduleFromMetadata, type CompiledSchedule, type Schedule, type ScheduleFrame } from '../data/schedule.ts';
import type { App } from './App.ts';
import type { Model } from '../engine/Model.ts';
import { button, h, integer } from './dom.ts';
import './schedule-panel.css';
import { buildScheduleTree, collectTaskElements, visibleScheduleRows, type ScheduleTree } from '../data/scheduleTree.ts';

const ROW = 28;
const STATUS = ['Hors planning', 'À venir', 'En cours', 'Terminé'];
const dateLabel = (day: number) => new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(day * 86400000));

/** Local construction playback. Tasks and links are separate from the immutable model. */
export class SchedulePanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly toggle: HTMLButtonElement;
  private readonly body = h('div', { class: 'schedule-body', attrs: { hidden: '' } });
  private readonly title = h('span', { class: 'schedule-title', text: 'Relier un planning à la maquette' });
  private readonly input = h('input', { attrs: { type: 'file', accept: '.json,application/json', hidden: '' } });
  private readonly summary = h('p', { class: 'schedule-summary' });
  private readonly empty = h('p', { class: 'schedule-empty', text: 'Importez un planning JSON séparé, ou choisissez les propriétés qui contiennent les dates de début et de fin. La maquette reste en lecture seule.' });
  private readonly controls = h('div', { class: 'schedule-controls', attrs: { hidden: '' } });
  private readonly play: HTMLButtonElement;
  private readonly date = h('input', { attrs: { type: 'date', 'aria-label': 'Date de simulation' } });
  private readonly slider = h('input', { attrs: { type: 'range', step: '1', 'aria-label': 'Date du planning' } });
  private readonly speed = h('select', { attrs: { 'aria-label': 'Vitesse de lecture' } });
  private readonly context = h('input', { attrs: { type: 'checkbox' } });
  private readonly gantt = h('div', { class: 'schedule-gantt', attrs: { hidden: '' } });
  private readonly ticks = h('div', { class: 'schedule-ticks' });
  private readonly scroll = h('div', { class: 'schedule-scroll', attrs: { role: 'region', 'aria-label': 'Tâches du planning', tabindex: '0' } });
  private readonly rows = h('div', { class: 'schedule-rows' });
  private readonly cursor = h('div', { class: 'schedule-cursor', attrs: { 'aria-hidden': 'true' } });
  private readonly example: HTMLButtonElement;
  private readonly exportButton: HTMLButtonElement;
  private compiled: CompiledSchedule | null = null;
  private model: Model | null = null;
  private source = '';
  private day = 0;
  private timer = 0;
  private elapsed = 0;
  private lastTick = 0;
  private ticket = 0;
  private taskState: Uint8Array = new Uint8Array();
  private frame: ScheduleFrame | undefined;
  private order: { index: number; depth: number; hasChildren: boolean }[] = [];
  private tree: ScheduleTree = { roots: [], children: new Map(), descendantTaskCounts: new Uint32Array() };
  private readonly collapsed = new Set<string>();
  private fadeFrame = 0;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private metadataMapping: Parameters<typeof scheduleFromMetadata>[2] | null = null;
  private metadataNote = '';
  private bindingError = '';
  private selectedTask = -1;
  private readonly visibleRows = new Map<number, HTMLElement>();

  constructor(app: App) {
    this.app = app;
    this.toggle = button('▤ Planning 4D', () => this.setOpen(this.body.hidden), { attrs: { 'aria-expanded': 'false' } });
    this.play = button('▶ Lire', () => this.timer ? this.pause() : this.start(), { attrs: { 'aria-label': 'Lire le planning' } });
    this.context.checked = true;
    this.reducedMotion.addEventListener('change', () => {
      if (this.reducedMotion.matches) { this.stopFade(); this.applyDay(); }
    });
    this.context.addEventListener('change', () => this.applyDay());
    this.date.addEventListener('change', () => {
      try { this.seek(parseScheduleDate(this.date.value)); } catch { this.date.value = formatScheduleDate(this.day); }
    });
    this.slider.addEventListener('input', () => this.seek(Number(this.slider.value)));
    for (const n of [1, 7, 30]) this.speed.append(h('option', { text: `${n} jour${n > 1 ? 's' : ''}/s`, attrs: { value: String(n) } }));
    this.speed.value = '7';
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0]; this.input.value = '';
      if (file) void this.readFile(file);
    });
    this.example = button('Planning d’exemple', () => void this.loadExample(), { title: 'Dates fictives pour le petit bâtiment de démonstration' });
    this.example.hidden = true;
    this.exportButton = button('Planning JSON ↓', () => this.download(), { title: 'Télécharger le planning, ou un exemple de structure si aucun planning n’est chargé' });
    const actions = h('div', { class: 'schedule-actions' },
      button('Importer un planning…', () => this.input.click()),
      button('Depuis les métadonnées…', () => this.mapMetadata()),
      this.example, this.exportButton,
      button('Retirer le planning', () => this.clear(), { class: 'subtle' }),
    );
    this.controls.append(this.play,
      button('↤', () => this.seek(this.minimum), { title: 'Revenir au début', attrs: { 'aria-label': 'Début du planning' } }),
      this.date, this.slider, this.speed,
      h('label', {}, this.context, 'Objets hors planning'),
    );
    this.scroll.append(this.ticks, this.rows, this.cursor);
    this.scroll.addEventListener('scroll', () => this.renderRows());
    this.gantt.append(this.scroll);
    this.body.append(actions, this.empty, this.summary, this.controls, this.gantt,
      h('p', { class: 'schedule-legend', text: 'Prévision de construction · À venir : masqué · En cours : orange · Terminé : couleurs habituelles. Les filtres manuels restent prioritaires.' }));
    this.el = h('section', { class: 'schedule-panel', attrs: { 'aria-label': 'Planning 4D' } },
      h('div', { class: 'schedule-heading' }, this.toggle, this.title), this.body, this.input);
    new ResizeObserver(() => this.renderRows()).observe(this.scroll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    app.on('model', () => {
      if (this.model && this.model !== app.model) this.clear();
      this.model = app.model;
      this.example.hidden = app.fileName !== 'demo.glb';
      this.rebind();
    });
    app.on('metadata', () => this.rebind());
  }

  /** Invalid imports leave the previous planning and view untouched. */
  loadJson(raw: unknown, source = 'Planning JSON'): void {
    const schedule = parseSchedule(raw);
    const compiled = compileSchedule(schedule, this.app.model?.keys ?? [], this.app.store);
    this.ticket++; this.pause(); this.stopFade();
    this.compiled = compiled; this.frame = undefined; this.model = this.app.model; this.source = source;
    this.metadataMapping = null; this.metadataNote = ''; this.bindingError = '';
    this.day = this.minimum; this.selectedTask = -1;
    this.collapsed.clear();
    for (const { task } of compiled.tasks) if (task.parentId) this.collapsed.add(task.parentId);
    this.render(); this.setOpen(true);
  }

  private async readFile(file: File): Promise<void> {
    const ticket = ++this.ticket, model = this.app.model;
    try {
      const raw: unknown = JSON.parse(await file.text());
      if (ticket !== this.ticket || model !== this.app.model) return;
      this.loadJson(raw, file.name);
    } catch (error) { if (ticket === this.ticket) this.app.toast(error instanceof Error ? error.message : String(error), true); }
  }

  private async loadExample(): Promise<void> {
    const ticket = ++this.ticket, model = this.app.model;
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/demo-planning.json`);
      if (!response.ok) throw new Error('Planning d’exemple indisponible.');
      const data: unknown = await response.json();
      if (ticket === this.ticket && model === this.app.model) this.loadJson(data, 'Exemple — dates fictives');
    } catch (error) { if (ticket === this.ticket) this.app.toast(String(error), true); }
  }

  private get minimum(): number { return Math.max(parseScheduleDate('0001-01-01'), (this.compiled?.startDay ?? 1) - 1); }
  private get maximum(): number { return Math.min(parseScheduleDate('9999-12-31'), (this.compiled?.endDay ?? -1) + 1); }

  private setOpen(open: boolean): void {
    this.body.hidden = !open;
    this.toggle.setAttribute('aria-expanded', String(open));
    if (!open) { this.pause(); this.stopFade(); this.app.model?.state.setSchedule(null); this.app.viewer.invalidate(); }
    else { this.applyDay(); this.renderRows(); }
  }

  private clear(): void {
    this.ticket++; this.pause(); this.stopFade(); this.compiled = null; this.frame = undefined; this.metadataMapping = null; this.metadataNote = ''; this.bindingError = ''; this.collapsed.clear();
    this.app.model?.state.setSchedule(null); this.app.viewer.invalidate();
    this.render();
  }

  private rebind(): void {
    if (!this.compiled) return;
    this.pause(); this.stopFade();
    try {
      let schedule = this.compiled.schedule;
      if (this.metadataMapping && this.app.model) {
        const result = scheduleFromMetadata(this.app.model.keys, this.app.store, this.metadataMapping);
        if (!result.schedule) throw new Error('Les propriétés choisies ne contiennent plus de dates utilisables.');
        schedule = result.schedule;
        this.metadataNote = this.mappingNotice(result.report);
      }
      this.compiled = compileSchedule(schedule, this.app.model?.keys ?? [], this.app.store); this.frame = undefined;
      this.bindingError = '';
      this.day = Math.max(this.minimum, Math.min(this.maximum, this.day));
      this.render(); this.applyDay();
    } catch (error) {
      // Keep the mapping for undo, but never simulate stale dates after a metadata edit.
      this.bindingError = error instanceof Error ? error.message : String(error);
      this.app.model?.state.setSchedule(null); this.app.viewer.invalidate(); this.render();
    }
  }

  private seek(day: number): void {
    this.pause();
    if (!this.compiled || !Number.isFinite(day)) return;
    this.day = Math.max(this.minimum, Math.min(this.maximum, Math.floor(day)));
    this.applyDay(true);
  }

  private start(): void {
    if (!this.compiled || this.bindingError) return;
    if (this.day >= this.maximum) this.day = this.minimum;
    this.elapsed = 0; this.lastTick = performance.now();
    this.applyDay();
    this.play.textContent = 'Ⅱ Pause'; this.play.setAttribute('aria-label', 'Mettre le planning en pause');
    this.timer = window.setInterval(() => {
      const now = performance.now();
      this.elapsed += (now - this.lastTick) / 1000 * Number(this.speed.value); this.lastTick = now;
      if (this.elapsed < 1) return;
      const days = Math.floor(this.elapsed); this.elapsed -= days;
      this.day = Math.min(this.maximum, this.day + days); this.applyDay(true);
      if (this.day >= this.maximum) this.pause();
    }, 100);
  }

  private pause(): void {
    window.clearInterval(this.timer); this.timer = 0;
    this.play.textContent = '▶ Lire'; this.play.setAttribute('aria-label', 'Lire le planning');
  }

  private stopFade(): void {
    cancelAnimationFrame(this.fadeFrame); this.fadeFrame = 0;
  }

  private animateFade(): void {
    const model = this.app.model;
    if (this.fadeFrame || !model?.state.hasScheduleFade) return;
    this.fadeFrame = requestAnimationFrame((now) => {
      this.fadeFrame = 0;
      if (model !== this.app.model || this.body.hidden) return;
      const active = model.state.advanceScheduleFade(now);
      this.app.viewer.invalidate();
      if (active) this.animateFade();
    });
  }

  private applyDay(animate = false): void {
    if (!this.compiled || this.bindingError) return;
    const state = evaluateSchedule(this.compiled, this.day, this.frame); this.frame = state;
    this.taskState = state.tasks;
    if (!this.context.checked) for (let i = 0; i < state.elements.length; i++) if (state.elements[i] === 0) state.elements[i] = 1;
    this.app.model?.state.setSchedule(!this.body.hidden ? state.elements : null, { animate: animate && !this.reducedMotion.matches, nowMs: performance.now() });
    this.animateFade();
    this.app.viewer.invalidate();
    this.date.value = formatScheduleDate(this.day); this.slider.value = String(this.day);
    this.slider.setAttribute('aria-valuetext', dateLabel(this.day));
    this.cursor.style.left = `calc(var(--task-width) + (100% - var(--task-width)) * ${(this.day - this.minimum) / (this.maximum - this.minimum + 1)})`;
    for (const [index, row] of this.visibleRows) {
      row.dataset.status = String(this.taskState[index]);
      const { task } = this.compiled.tasks[index];
      row.title = `${task.name} · ${task.start} → ${task.end} · ${STATUS[this.taskState[index]]}`;
    }
  }

  private render(): void {
    const compiled = this.compiled;
    this.empty.hidden = !!compiled; this.controls.hidden = this.gantt.hidden = !compiled;
    this.title.textContent = compiled ? compiled.schedule.name || this.source : 'Relier un planning à la maquette';
    for (const control of [this.play, this.date, this.slider]) control.disabled = !!this.bindingError;
    this.summary.replaceChildren(); this.rows.replaceChildren(); this.visibleRows.clear();
    if (!compiled) return;
    if (this.bindingError) this.summary.append(h('span', { text: `Simulation suspendue : ${this.bindingError}`, attrs: { role: 'status' } }));
    const { report } = compiled;
    this.tree = buildScheduleTree(compiled.tasks);
    const groups = this.tree.children.size, tasks = compiled.tasks.length - groups;
    const info = `${integer.format(tasks)} tâche${tasks > 1 ? 's' : ''}${groups ? ` · ${integer.format(groups)} groupe${groups > 1 ? 's' : ''}` : ''} · ${integer.format(report.linkedElementCount)} objet${report.linkedElementCount > 1 ? 's liés' : ' lié'} · ${integer.format(report.unlinkedElementCount)} hors planning`;
    this.summary.append(info, ' ', button('Détail des liaisons', () => this.showLinks(), { class: 'subtle' }));
    if (this.metadataNote) this.summary.append(h('span', { text: this.metadataNote }));
    this.date.min = formatScheduleDate(this.minimum); this.date.max = formatScheduleDate(this.maximum);
    this.slider.min = String(this.minimum); this.slider.max = String(this.maximum);
    this.ticks.replaceChildren(h('span', { class: 'schedule-tick-label', text: 'Tâche · objets liés' }));
    const scale = h('div', { class: 'schedule-scale' });
    const days = new Set(Array.from({ length: 5 }, (_, i) => Math.round(this.minimum + i / 4 * (this.maximum - this.minimum))));
    for (const day of days) scale.append(h('span', { text: dateLabel(day), attrs: { style: `left:${(day - this.minimum) / (this.maximum - this.minimum + 1) * 100}%` } }));
    this.ticks.append(scale);
    this.layoutRows();
    this.scroll.scrollTop = 0; this.applyDay(); this.renderRows();
  }

  private layoutRows(): void {
    if (!this.compiled) return;
    const collapsedIndices = new Set<number>();
    this.compiled.tasks.forEach(({ task }, index) => { if (this.collapsed.has(task.id)) collapsedIndices.add(index); });
    this.order = visibleScheduleRows(this.tree, collapsedIndices);
    this.rows.style.height = `${this.order.length * ROW}px`;
    this.cursor.style.height = `${this.order.length * ROW}px`;
  }

  /** Only the visible Gantt rows exist in the DOM, including for large schedules. */
  private renderRows(): void {
    if (!this.compiled || this.body.hidden) return;
    this.rows.replaceChildren(); this.visibleRows.clear();
    const start = Math.max(0, Math.floor(this.scroll.scrollTop / ROW) - 2);
    const end = Math.min(this.order.length, start + Math.ceil(this.scroll.clientHeight / ROW) + 5);
    const duration = this.maximum - this.minimum + 1;
    for (let at = start; at < end; at++) {
      const { index, depth, hasChildren } = this.order[at], { task, startDay, endDay, elements } = this.compiled.tasks[index];
      const descendants = this.tree.descendantTaskCounts[index];
      const label = hasChildren ? `${task.name} · ${descendants} sous-tâche${descendants > 1 ? 's' : ''}` : `${task.name} · ${elements.length} objet${elements.length > 1 ? 's' : ''}`;
      const row = h('div', { class: `schedule-row${hasChildren ? ' schedule-group' : ''}${this.selectedTask === index ? ' selected' : ''}`, attrs: { style: `top:${at * ROW}px` } });
      const select = button('', () => {
        if (this.bindingError) return;
        this.selectedTask = index; this.seek(startDay);
        this.app.select(hasChildren ? collectTaskElements(this.tree, this.compiled!.tasks, index) : elements, 'panel'); this.renderRows();
      }, { class: 'schedule-row-select', attrs: { 'aria-label': label, 'aria-pressed': String(this.selectedTask === index) } });
      row.title = `${task.name} · ${task.start} → ${task.end} · ${STATUS[this.taskState[index]]}`;
      select.disabled = !!this.bindingError;
      row.dataset.status = String(this.taskState[index]);
      select.append(h('span', { class: 'schedule-task-name', text: label, attrs: { style: `padding-left:${30 + Math.min(depth, 10) * 12}px` } }),
        h('span', { class: 'schedule-track' }, h('span', { class: 'schedule-bar', attrs: { style: `left:${(startDay - this.minimum) / duration * 100}%;width:${(endDay - startDay + 1) / duration * 100}%` } })));
      row.append(select);
      if (hasChildren) row.append(button(this.collapsed.has(task.id) ? '▸' : '▾', () => {
        if (this.collapsed.has(task.id)) this.collapsed.delete(task.id); else this.collapsed.add(task.id);
        this.layoutRows(); this.renderRows();
        this.visibleRows.get(index)?.querySelector<HTMLButtonElement>('.schedule-expand')?.focus({ preventScroll: true });
      }, { class: 'schedule-expand', attrs: { 'aria-label': `${this.collapsed.has(task.id) ? 'Déplier' : 'Replier'} ${task.name}`, 'aria-expanded': String(!this.collapsed.has(task.id)), style: `left:${6 + Math.min(depth, 10) * 12}px` } }));
      this.rows.append(row); this.visibleRows.set(index, row);
    }
  }

  private dialog(title: string): { dialog: HTMLDialogElement; body: HTMLElement } {
    const dialog = h('dialog', { class: 'schedule-dialog', attrs: { 'aria-label': title } });
    const body = h('div', { class: 'schedule-dialog-body' });
    dialog.append(h('div', { class: 'schedule-dialog-title' }, h('h3', { text: title }), button('×', () => dialog.close(), { attrs: { 'aria-label': 'Fermer' } })), body);
    dialog.addEventListener('close', () => dialog.remove()); this.el.append(dialog); dialog.showModal();
    return { dialog, body };
  }

  private showLinks(): void {
    if (!this.compiled) return;
    const { body } = this.dialog('Liaisons du planning');
    const { report } = this.compiled;
    body.append(h('p', { text: `${report.linkedElementCount} objets liés ; ${report.unlinkedElementCount} sans tâche. ${report.multipleTaskElementCount} objets ont plusieurs tâches : ils restent visibles entre deux phases.` }));
    if (report.unlinkedTaskIds.length) body.append(h('p', { text: `Tâches sans objet lié : ${report.unlinkedTaskIds.slice(0, 100).join(', ')}${report.unlinkedTaskIds.length > 100 ? '…' : ''}` }));
    if (report.unknownElementIds.length) body.append(h('p', { text: `Identifiants introuvables (${report.unknownElementIds.length}) : ${report.unknownElementIds.slice(0, 100).join(', ')}${report.unknownElementIds.length > 100 ? '…' : ''}` }));
    if (!this.app.model) body.append(h('p', { text: 'Chargez la maquette pour résoudre les liaisons.' }));
    body.append(h('p', { text: 'Les identifiants doivent correspondre exactement aux IDs du modèle. Une liaison par propriété utilise la valeur indiquée, sans déduction à partir du nom des objets. Les tâches parentes organisent le planning ; elles n’héritent pas des objets des enfants.' }));
  }

  private mappingNotice(report: ReturnType<typeof scheduleFromMetadata>['report']): string {
    return `${report.missingDateIds.length} objets sans dates · ${report.invalidDateIds.length} dates invalides · ${report.missingTaskIdIds.length} codes tâche absents · ${report.conflictingTaskIds.length} tâches aux dates contradictoires (exclues).`;
  }

  private mapMetadata(): void {
    if (!this.app.model || !this.app.store.paths.length) { this.app.toast('Chargez une maquette avec ses métadonnées pour choisir les dates.'); return; }
    const { dialog, body } = this.dialog('Planning depuis les métadonnées');
    const choose = (label: string, optional = false) => {
      const select = h('select', { attrs: { 'aria-label': label } }, h('option', { text: optional ? 'Un objet par tâche' : 'Choisir une propriété…', attrs: { value: '' } }));
      for (const path of this.app.store.paths) select.append(h('option', { text: path, attrs: { value: path } }));
      body.append(h('label', {}, label, select)); return select;
    };
    body.append(h('p', { text: 'Choisissez les dates prévues au format AAAA-MM-JJ. Aucun nom de propriété n’est imposé. Le planning créé peut être téléchargé séparément.' }));
    const start = choose('Propriété de début'), end = choose('Propriété de fin'), id = choose('Code tâche (facultatif)', true);
    const notice = h('p', { class: 'hint', attrs: { role: 'status' } });
    body.append(notice, button('Créer le planning', () => {
      if (!start.value || !end.value) { notice.textContent = 'Choisissez une propriété de début et de fin.'; return; }
      const mapping = { startProperty: start.value, endProperty: end.value, ...(id.value ? { taskIdProperty: id.value } : {}) };
      try {
        const result = scheduleFromMetadata(this.app.model!.keys, this.app.store, mapping);
        if (!result.schedule) { notice.textContent = `Aucune tâche utilisable. ${this.mappingNotice(result.report)}`; return; }
        this.loadJson(result.schedule, 'Dates des métadonnées'); this.metadataMapping = mapping; this.metadataNote = this.mappingNotice(result.report);
        this.render(); dialog.close();
      } catch (error) { notice.textContent = error instanceof Error ? error.message : String(error); }
    }, { class: 'primary' }));
  }

  private download(): void {
    const template: Schedule = { version: 1, name: 'Planning de construction', tasks: [{ id: 'T001', name: 'Exemple de tâche', start: '2026-01-05', end: '2026-01-16', match: { property: 'Planning / Code tâche', values: ['T001'] } }] };
    const blob = new Blob([JSON.stringify({ type: 'bim-schedule', ...(this.compiled?.schedule ?? template) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = h('a', { attrs: { href: url, download: this.compiled ? 'planning.json' : 'planning-modele.json' } });
    link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
