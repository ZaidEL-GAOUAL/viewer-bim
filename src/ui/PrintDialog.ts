import { levelPlans } from '../data/levels.ts';
import { PAPERS, SCALES, fitRect, frameOnScreen, nextPaperThatFits, parseScale, sheetOf, worldSize, type Paper } from '../data/sheet.ts';
import { integer, oneDecimal, s } from '../data/text.ts';
import { viewHeld } from '../engine/capture.ts';
import type { App } from './App.ts';
import { button, clear, download, h, stored } from './dom.ts';
import { pdfName, previewPages, printToPdf, viewFacts, type PagePreview, type PrintPage, type PrintSettings } from './printJob.ts';

const STORE_KEY = 'viewer-bim.print';
/** Au-delà, l'impression est longue et le fichier lourd : la carte le dit. */
const BIG_IMAGE_PIXELS = 60e6;
/** Délai avant l'aperçu : quelques réglages changés de suite ne lancent qu'un aperçu. */
const PREVIEW_DELAY = 250;

interface Remembered { paper: Paper; landscape: boolean; fit: boolean; scale: string; dpi: number; project: string; author: string }

/** Ce dont dépend la vignette d'une page. */
const previewKey = (page: PrintPage, settings: PrintSettings): string => [page.label, settings.paper, settings.landscape, settings.fit ? 'ajuster' : settings.scale].join('|');

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

function remembered(): Remembered {
  const fallback: Remembered = { paper: 'A3', landscape: true, fit: true, scale: '100', dpi: 150, project: '', author: '' };
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
 * Carte « Imprimer / PDF » : papier, orientation, mise à l'échelle, échelle (une vue en projection parallèle s'imprime à
 * l'échelle ; pour la vue actuelle, le cadre imprimé est dessiné sur la vue), résolution, titre du cartouche (retenu d'une fois
 * sur l'autre) et vues à imprimer, une page chacune, chacune avec sa vignette. Une vue en perspective est imprimée « non à
 * l'échelle » et le dit.
 */
export class PrintDialog {
  readonly label = 'Imprimer / PDF';
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly settings = remembered();
  private readonly paper: HTMLSelectElement;
  private readonly orientation: HTMLSelectElement;
  private readonly fit: HTMLSelectElement;
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
  private readonly previewList = h('div', { class: 'print-previews' });
  private views: PrintPage[] = [];
  private checks: HTMLInputElement[] = [];
  private controller: AbortController | null = null;
  /** Les vignettes faites, par `previewKey`. */
  private readonly previews = new Map<string, PagePreview>();
  /** L'aperçu en cours (ou en attente), et la fin du dernier lancé : une capture à la fois. */
  private previewing: AbortController | null = null;
  private previewDone: Promise<void> = Promise.resolve();
  /** Les vignettes demandées à l'aperçu en cours : le même ensemble ne le relance pas. */
  private previewKeys = '';

  constructor(app: App) {
    this.app = app;
    const saved = this.settings;
    this.paper = select('Papier', PAPERS.map((paper) => [paper, paper] as const), saved.paper);
    this.orientation = select('Orientation', [['landscape', 'Paysage'], ['portrait', 'Portrait']], saved.landscape ? 'landscape' : 'portrait');
    this.fit = select('Mise à l’échelle', [['fit', 'Ajuster à la page'], ['fixed', 'Échelle fixe']], saved.fit ? 'fit' : 'fixed');
    this.fit.title = 'Ajuster : chaque vue cochée est centrée sur ce qu’elle montre, à la plus grande échelle qui tient. Échelle fixe : à l’échelle choisie. La vue actuelle garde votre cadrage et l’échelle choisie.';
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
    for (const element of [this.paper, this.orientation, this.fit, this.scale, this.dpi, this.custom, this.project, this.author, this.current]) {
      element.addEventListener('input', () => {
        this.custom.hidden = this.scale.value !== 'custom';
        this.sync();
      });
    }
    this.el = h('section', { class: 'card tool-card', attrs: { hidden: '', 'aria-label': this.label } },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: this.label }),
        button('×', () => this.toggle(false), { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer l’impression' } })),
      h('div', { class: 'tool-row' }, this.paper, this.orientation, this.dpi),
      h('div', { class: 'tool-row' }, this.fit, this.scale, this.custom),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Projet' }), this.project),
      h('label', { class: 'tool-field' }, h('span', { class: 'field-label', text: 'Auteur' }), this.author),
      h('p', { class: 'field-label', text: 'Pages' }),
      this.pages,
      this.previewList,
      this.hint,
      h('div', { class: 'dimensions-actions' }, this.cancel, this.run),
      this.progress);
    // Le cadre imprimé, dessiné sur la vue : il suit la caméra.
    app.viewer.renderer.domElement.parentElement?.append(this.layer);
    this.layer.append(this.frame);
    app.viewer.afterRender.add(() => this.drawFrame());
    // Une capture qui tient la vue (impression, aperçu) ouvre d'autres vues : ces événements sont les siens.
    app.on('view', () => { if (!viewHeld()) this.refresh(); });
    app.on('georeference', () => this.refresh());
    // Un autre modèle, ou des vues de l'utilisateur changées : les vignettes faites ne valent plus.
    for (const event of ['model', 'userViews'] as const) app.on(event, () => { this.forgetPreviews(); this.refresh(); });
    app.viewer.onExternalCameraChange.add(() => this.sync());
  }

  toggle(open = this.el.hidden): boolean {
    this.el.hidden = !open;
    if (open) this.refresh();
    else {
      this.stopPreview();
      this.drawFrame();
    }
    return open;
  }

  /** Interrompt l'aperçu en cours (la vue de l'utilisateur est rétablie par l'aperçu lui-même). */
  private stopPreview(): void {
    this.previewing?.abort();
    this.previewKeys = '';
  }

  private forgetPreviews(): void {
    this.stopPreview();
    for (const preview of this.previews.values()) URL.revokeObjectURL(preview.url);
    this.previews.clear();
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
      settings: { paper: this.paper.value as Paper, landscape: this.orientation.value === 'landscape', fit: this.fit.value === 'fit', scale: scale ?? 100, dpi: this.dpi.value === '300' ? 300 : 150, project: this.project.value.trim(), author: this.author.value.trim() },
    };
  }

  private selected(): PrintPage[] {
    const pages: PrintPage[] = this.current.checked ? [{ label: this.app.activeView?.name ?? 'Vue courante', view: null }] : [];
    return [...pages, ...this.views.filter((_, i) => this.checks[i]?.checked)];
  }

  /**
   * Mémorise les réglages, lance l'aperçu des pages qui n'en ont pas, et dit ce que la feuille montre de la vue actuelle et
   * quelles pages ne tiennent pas.
   */
  private sync(): void {
    const { app } = this;
    if (this.el.hidden) return;
    const { settings, valid } = this.read();
    stored.set(STORE_KEY, JSON.stringify({ paper: settings.paper, landscape: settings.landscape, fit: settings.fit, scale: this.scale.value === 'custom' ? this.custom.value : String(settings.scale), dpi: settings.dpi, project: settings.project, author: settings.author }));
    const unavailable = app.model === null || app.mapOpen;
    const pages = this.selected();
    this.run.disabled = unavailable || !valid || this.controller !== null || pages.length === 0;
    this.schedulePreviews(settings, valid && !unavailable);
    this.showPreviews(settings);
    // Pendant une capture qui tient la vue, celle qui est montrée n'est pas celle de l'utilisateur : ce qui la décrit attend.
    if (viewHeld()) return;
    const lines: string[] = [];
    if (!valid) lines.push('Échelle illisible : écrivez par exemple 1:75.');
    const sheet = sheetOf(settings.paper, settings.landscape);
    if (app.model && !app.mapOpen && this.current.checked) {
      const facts = viewFacts(app);
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
    // Les pages dont l'aperçu dit qu'elles dépassent la feuille, et le premier papier où elles tiennent toutes.
    const over = pages.flatMap((page) => {
      const preview = page.view ? this.previews.get(previewKey(page, settings)) : undefined;
      return preview?.overflow ? [{ label: page.label, scale: preview.scale ?? settings.scale, extent: preview.extent ?? { width: 0, height: 0 } }] : [];
    });
    if (over.length > 0) {
      const scale = over[0].scale;
      const next = nextPaperThatFits(sheet, scale, { width: Math.max(...over.map((page) => page.extent.width)), height: Math.max(...over.map((page) => page.extent.height)) });
      const advice = next ? `Essayez ${next}.` : settings.fit ? 'Même A0 ne suffit pas.' : 'Choisissez une échelle plus petite.';
      lines.push(`${over.map((page) => `« ${page.label} »`).join(', ')} ${over.length > 1 ? 'dépassent' : 'dépasse'} la feuille à 1:${scale} : ${over.length} page${s(over.length)} sur ${pages.length}. ${advice}`);
    }
    this.hint.textContent = lines.join(' ');
    this.drawFrame();
  }

  /**
   * Lance l'aperçu des pages cochées qui n'ont pas de vignette pour ces réglages (pas la vue actuelle : son cadre est dessiné
   * sur la vue) : après un court délai, une capture à la fois, interrompu dès que ce qu'il faut montrer change.
   */
  private schedulePreviews(settings: PrintSettings, ready: boolean): void {
    const { app } = this;
    const pages = ready && this.controller === null ? this.selected().filter((page) => page.view) : [];
    const keys = pages.map((page) => previewKey(page, settings)).join('\n');
    if (keys === this.previewKeys) return;
    this.previewKeys = keys;
    this.previewing?.abort();
    const missing = pages.filter((page) => !this.previews.has(previewKey(page, settings)));
    if (missing.length === 0) return;
    const controller = this.previewing = new AbortController();
    const previous = this.previewDone;
    this.previewDone = (async () => {
      await previous;
      if (!controller.signal.aborted) await new Promise((resolve) => window.setTimeout(resolve, PREVIEW_DELAY));
      if (controller.signal.aborted) return;
      try {
        await previewPages(app, settings, missing, (page, preview) => {
          this.previews.set(previewKey(page, settings), preview);
          this.showPreviews(this.read().settings);
        }, controller.signal);
      } catch (error) {
        if (!isAbort(error)) app.toast(`Aperçu impossible : ${error instanceof Error ? error.message : String(error)}`, true);
        // Interrompu par une impression (pas par ce dialogue) : les vignettes manquantes seront refaites après elle.
        else if (this.previewing === controller && !controller.signal.aborted) this.previewKeys = '';
      } finally {
        if (this.previewing === controller) this.previewing = null;
        this.sync();
      }
    })();
  }

  /** Une vignette par page cochée (sauf la vue actuelle), avec l'échelle où elle sera imprimée ; une vignette vide prévient. */
  private showPreviews(settings: PrintSettings): void {
    const sheet = sheetOf(settings.paper, settings.landscape);
    clear(this.previewList);
    for (const page of this.selected()) {
      if (!page.view) continue;
      const preview = this.previews.get(previewKey(page, settings));
      const note = !preview ? 'aperçu…' : preview.empty ? 'vide : rien de visible' : preview.scale === null ? 'non à l’échelle' : preview.overflow ? `dépasse la feuille à 1:${preview.scale}` : `1:${preview.scale}`;
      const image = preview
        ? h('img', { attrs: { src: preview.url, alt: `Aperçu de « ${page.label} »` } })
        : h('div', { class: 'print-preview-pending', attrs: { style: `aspect-ratio: ${sheet.frame.width} / ${sheet.frame.height}` } });
      this.previewList.append(h('figure', { class: 'print-preview' }, image, h('figcaption', { class: preview && (preview.empty || preview.overflow) ? 'warning' : '', text: `${page.label} · ${note}` })));
    }
  }

  /** Le cadre imprimé sur la vue : à l'échelle pour une projection parallèle, aux proportions de la page sinon. */
  private drawFrame(): void {
    const { app } = this;
    const show = !this.el.hidden && this.controller === null && !viewHeld() && this.current.checked && app.model !== null && !app.mapOpen;
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
    if (this.controller) return;
    const controller = this.controller = new AbortController();
    this.stopPreview();
    this.run.disabled = true;
    this.cancel.hidden = false;
    this.drawFrame();
    try {
      // L'impression passe devant l'aperçu : la vignette en cours rend d'abord la main et la vue de l'utilisateur.
      await this.previewDone;
      const { settings, valid } = this.read();
      const pages = this.selected();
      if (!valid || pages.length === 0) return;
      if (controller.signal.aborted) throw new DOMException('Impression interrompue.', 'AbortError');
      const { blob, empty } = await printToPdf(app, settings, pages, (text, fraction) => { this.progress.textContent = `${text} (${Math.round(fraction * 100)} %)`; }, controller.signal);
      download(blob, pdfName(app, pages));
      const n = empty.length;
      app.toast(n === 0 ? 'PDF créé.' : `PDF créé. ${n} page${s(n)} vide${s(n)} : ${empty.join(', ')} — rien de visible dans ${n > 1 ? 'ces vues' : 'cette vue'}.`, n > 0);
    } catch (error) {
      if (isAbort(error)) app.toast('Impression annulée.');
      else app.toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.controller = null;
      this.cancel.hidden = true;
      this.progress.textContent = '';
      this.refresh();
    }
  }
}
