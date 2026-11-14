import { levelPlans } from '../data/levels.ts';
import { PAPERS, SCALES, fitRect, frameOnScreen, nextPaperThatFits, parseScale, sheetOf, worldSize, type Paper } from '../data/sheet.ts';
import { integer, oneDecimal } from '../data/text.ts';
import type { App } from './App.ts';
import { button, clear, download, h, stored } from './dom.ts';
import { pdfName, printToPdf, viewFacts, type PrintPage, type PrintSettings } from './printJob.ts';

const STORE_KEY = 'viewer-bim.print';
/** Au-delà, l'impression est longue et le fichier lourd : la carte le dit. */
const BIG_IMAGE_PIXELS = 60e6;

interface Remembered { paper: Paper; landscape: boolean; scale: string; dpi: number; project: string; author: string }

function remembered(): Remembered {
  const fallback: Remembered = { paper: 'A3', landscape: true, scale: '100', dpi: 150, project: '', author: '' };
  try {
    return { ...fallback, ...JSON.parse(stored.get(STORE_KEY) ?? '{}') };
  } catch {
    return fallback;
  }
}

const select = (label: string, options: readonly (readonly [string, string])[], value: string): HTMLSelectElement => {
  const element = h('select', { attrs: { 'aria-label': label } }, ...options.map(([id, text]) => h('option', { text, attrs: { value: id } })));
  element.value = value;
  return element;
};

/**
 * Carte « Imprimer / PDF » : papier, orientation, échelle (une vue en projection parallèle s'imprime à l'échelle, le cadre
 * imprimé est dessiné sur la vue), résolution, titre du cartouche (retenu d'une fois sur l'autre) et vues à imprimer, une page
 * chacune. Une vue en perspective est imprimée « non à l'échelle » et le dit.
 */
export class PrintDialog {
  readonly label = 'Imprimer / PDF';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly settings = remembered();
  private readonly paper: HTMLSelectElement;
  private readonly orientation: HTMLSelectElement;
  private readonly scale: HTMLSelectElement;
  private readonly custom = h('input', { attrs: { type: 'text', placeholder: '1:75', 'aria-label': 'Échelle', hidden: '' } });
  private readonly dpi: HTMLSelectElement;
  private readonly project = h('input', { attrs: { type: 'text', 'aria-label': 'Projet' } });
  private readonly author = h('input', { attrs: { type: 'text', 'aria-label': 'Auteur' } });
  private readonly pages = h('div', { class: 'tool-checks' });
  private readonly current = h('input', { attrs: { type: 'checkbox', checked: '' } });
  private readonly hint = h('p', { class: 'hint' });
  private readonly progress = h('p', { class: 'hint' });
  private readonly run: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly layer = h('div', { class: 'print-layer' });
  private readonly frame = h('div', { class: 'print-frame', attrs: { hidden: '' } });
  private views: PrintPage[] = [];
  private checks: HTMLInputElement[] = [];
  private controller: AbortController | null = null;

  constructor(app: App) {
    this.app = app;
    const saved = this.settings;
    this.paper = select('Papier', PAPERS.map((paper) => [paper, paper] as const), saved.paper);
    this.orientation = select('Orientation', [['landscape', 'Paysage'], ['portrait', 'Portrait']], saved.landscape ? 'landscape' : 'portrait');
    this.scale = select('Échelle', [...SCALES.map((scale) => [String(scale), `1:${scale}`] as const), ['custom', 'Autre…']], SCALES.includes(Number(saved.scale)) ? saved.scale : 'custom');
    if (this.scale.value === 'custom') {
      this.custom.hidden = false;
      this.custom.value = saved.scale;
    }
    this.dpi = select('Résolution', [['150', '150 dpi'], ['300', '300 dpi (fichier plus lourd)']], String(saved.dpi));
    this.project.value = saved.project;
    this.author.value = saved.author;
    this.run = button('Créer le PDF', () => void this.print(), { class: 'primary' });
    this.cancel = button('Annuler', () => this.controller?.abort());
    this.cancel.hidden = true;
    for (const element of [this.paper, this.orientation, this.scale, this.dpi, this.custom, this.project, this.author, this.current]) {
      element.addEventListener('input', () => {
        this.custom.hidden = this.scale.value !== 'custom';
        this.sync();
      });
    }
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer l’impression' } })),
      h('div', { class: 'tool-row' }, this.paper, this.orientation),
      h('div', { class: 'tool-row' }, this.scale, this.custom, this.dpi),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Projet' }), this.project),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Auteur' }), this.author),
      h('p', { class: 'field-label', text: 'Pages' }),
      this.pages,
      this.hint,
      h('div', { class: 'dimensions-actions' }, this.cancel, this.run),
      this.progress);
    // Le cadre imprimé, dessiné sur la vue : il suit la caméra.
    app.viewer.renderer.domElement.parentElement?.append(this.layer);
    this.layer.append(this.frame);
    app.viewer.afterRender.add(() => this.drawFrame());
    for (const event of ['model', 'view', 'userViews', 'georeference'] as const) app.on(event, () => this.refresh());
    app.viewer.onExternalCameraChange.add(() => this.sync());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) this.refresh();
    else this.drawFrame();
    return open;
  }

  /** Les vues qu'on peut cocher : celles du fichier, les siennes, un plan par niveau. */
  private refresh(): void {
    if (this.el.hidden) return;
    const { app } = this;
    const views = [...app.savedViews, ...app.userViews, ...levelPlans(app.levels, app.savedViews)];
    const ticked = new Set(this.views.flatMap((page, i) => (page.view && this.checks[i]?.checked ? [page.label] : [])));
    this.views = views.map((view) => ({ label: view.name, view }));
    clear(this.pages);
    this.checks = [];
    this.pages.append(h('label', { class: 'tool-check' }, this.current, h('span', { text: 'Vue actuelle' })));
    for (const page of this.views) {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = ticked.has(page.label);
      box.addEventListener('input', () => this.sync());
      this.checks.push(box);
      this.pages.append(h('label', { class: 'tool-check' }, box, h('span', { text: page.label })));
    }
    this.sync();
  }

  private read(): { settings: PrintSettings; valid: boolean } {
    const scale = this.scale.value === 'custom' ? parseScale(this.custom.value) : Number(this.scale.value);
    return {
      valid: scale !== null,
      settings: { paper: this.paper.value as Paper, landscape: this.orientation.value === 'landscape', scale: scale ?? 100, dpi: this.dpi.value === '300' ? 300 : 150, project: this.project.value.trim(), author: this.author.value.trim() },
    };
  }

  private selected(): PrintPage[] {
    const pages: PrintPage[] = this.current.checked ? [{ label: this.app.activeView?.name ?? 'Vue courante', view: null }] : [];
    return [...pages, ...this.views.filter((_, i) => this.checks[i]?.checked)];
  }

  /** Mémorise les réglages et dit, pour la vue actuelle, ce que la feuille montre et si le plan tient. */
  private sync(): void {
    const { app } = this;
    if (this.el.hidden) return;
    const { settings, valid } = this.read();
    stored.set(STORE_KEY, JSON.stringify({ paper: settings.paper, landscape: settings.landscape, scale: this.scale.value === 'custom' ? this.custom.value : String(settings.scale), dpi: settings.dpi, project: settings.project, author: settings.author }));
    const unavailable = app.model === null || app.mapOpen;
    this.run.disabled = unavailable || !valid || this.controller !== null || this.selected().length === 0;
    const lines: string[] = [];
    if (!valid) lines.push('Échelle illisible : écrivez par exemple 1:75.');
    if (app.model && !app.mapOpen && this.current.checked) {
      const facts = viewFacts(app);
      const sheet = sheetOf(settings.paper, settings.landscape);
      if (facts.scaled) {
        const world = worldSize(sheet, settings.scale);
        lines.push(`Le cadre montre ${oneDecimal.format(world.width)} × ${oneDecimal.format(world.height)} m à 1:${settings.scale}. Imprimez à 100 %, sans « ajuster à la page ».`);
        const next = nextPaperThatFits(sheet, settings.scale, facts.extent);
        if (next === null) lines.push(`Le modèle (${integer.format(Math.ceil(facts.extent.width))} × ${integer.format(Math.ceil(facts.extent.height))} m) est trop grand pour cette échelle : choisissez-en une plus petite.`);
        else if (next !== settings.paper) lines.push(`Le modèle entier (${integer.format(Math.ceil(facts.extent.width))} × ${integer.format(Math.ceil(facts.extent.height))} m) ne tient pas sur ${settings.paper} : essayez ${next}.`);
      } else lines.push('Vue en perspective : elle est imprimée « non à l’échelle ».');
      const sheetPixels = (sheet.frame.width * sheet.frame.height * (settings.dpi / 25.4) ** 2);
      if (sheetPixels > BIG_IMAGE_PIXELS) lines.push('Grand format : la création peut durer plusieurs minutes et le PDF peser plusieurs dizaines de Mo.');
    }
    this.hint.textContent = lines.join(' ');
    this.drawFrame();
  }

  /** Le cadre imprimé sur la vue : à l'échelle pour une projection parallèle, aux proportions de la page sinon. */
  private drawFrame(): void {
    const { app } = this;
    const show = !this.el.hidden && this.controller === null && this.current.checked && app.model !== null && !app.mapOpen;
    this.frame.hidden = !show;
    if (!show) return;
    const { settings } = this.read();
    const sheet = sheetOf(settings.paper, settings.landscape);
    const facts = viewFacts(app);
    const viewport = app.viewer.size;
    const rect = facts.scaled
      ? frameOnScreen(worldSize(sheet, settings.scale), facts.viewHeight, viewport)
      : fitRect(sheet.frame.width / sheet.frame.height, viewport);
    Object.assign(this.frame.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  private async print(): Promise<void> {
    const { app } = this;
    const { settings, valid } = this.read();
    const pages = this.selected();
    if (!valid || pages.length === 0 || this.controller) return;
    const controller = this.controller = new AbortController();
    this.run.disabled = true;
    this.cancel.hidden = false;
    this.drawFrame();
    try {
      const blob = await printToPdf(app, settings, pages, (text, fraction) => { this.progress.textContent = `${text} (${Math.round(fraction * 100)} %)`; }, controller.signal);
      download(blob, pdfName(app, pages));
      app.toast('PDF créé.');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') app.toast('Impression annulée.');
      else app.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.controller = null;
      this.cancel.hidden = true;
      this.progress.textContent = '';
      this.refresh();
    }
  }
}
