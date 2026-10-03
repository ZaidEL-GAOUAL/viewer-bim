import { AssistantError, assistantUrl, fetchStatus, runTurn, type ApiSettings, type Message } from '../assistant/client.ts';
import { SessionUsage } from '../assistant/usage.ts';
import { buildSystemPrompt } from '../assistant/prompt.ts';
import type { ToolContext } from '../assistant/tools.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { AssistantSettings } from './AssistantSettings.ts';

const SUGGESTIONS = [
  'Résume ce modèle en quelques lignes.',
  'Combien d’éléments par niveau ?',
  'Quels éléments n’ont pas de matériau ?',
];

/**
 * Conversation avec un assistant (LLM) qui interroge les métadonnées et ajuste l'affichage au
 * moyen d'outils exécutés ici ; seuls les résultats partent vers le service d'IA.
 */
export class AssistantPanel {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly url = assistantUrl();
  private readonly status: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly suggestions: HTMLElement;
  private messages: Message[] = [];
  private busy: AbortController | null = null;
  private provider = '';
  private api: ApiSettings | null = null;
  private readonly usage = new SessionUsage();
  private readonly usageEl: HTMLElement;
  private readonly settings: AssistantSettings;

  constructor(app: App) {
    this.app = app;
    this.status = h('p', { class: 'assistant-status' });
    this.log = h('div', { class: 'assistant-log', attrs: { 'aria-live': 'polite' } });
    this.suggestions = h('div', { class: 'assistant-suggestions' });
    this.input = h('textarea', { attrs: { rows: '2', placeholder: 'Interrogez le modèle ou ajustez son affichage…', 'aria-label': 'Message à l’assistant' } });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.send = button('Envoyer', () => void this.submit(), { title: 'Envoyer (Entrée)' });
    const reset = button('Nouvelle conversation', () => this.reset(), { class: 'subtle' });
    this.usageEl = h('p', { class: 'assistant-usage', attrs: { 'aria-live': 'polite' } });
    this.settings = new AssistantSettings((settings) => {
      this.api = settings;
      this.provider = settings ? `${new URL(settings.endpoint).hostname} (${settings.model})` : '';
      this.reset();
      if (!settings) void this.checkService();
    });

    this.el = h('section', { class: 'panel assistant-panel' },
      h('div', { class: 'assistant-header' }, this.status, reset),
      this.usageEl,
      this.settings.el,
      this.log,
      this.suggestions,
      h('div', { class: 'assistant-input' }, this.input, this.send),
      h('p', { class: 'hint assistant-privacy', text: 'Les questions, un résumé des propriétés et les résultats des recherches sont envoyés au service d’IA ; le fichier n’est jamais transmis en entier.' }),
    );

    app.on('model', () => this.reset());
    this.reset();
    this.syncUsage();
    void this.checkService();
  }

  private get ready(): boolean {
    return this.url !== '' && this.app.model !== null;
  }

  private async checkService(): Promise<void> {
    if (!this.url) return;
    try {
      const status = await fetchStatus(this.url);
      if (this.api) return;
      this.provider = status.providers.map((item) => item.name).join(', ');
    } catch {
      if (!this.api) this.provider = '';
    }
    this.syncStatus();
  }

  private syncStatus(): void {
    if (!this.url) {
      this.status.textContent = 'Assistant non configuré : le service d’IA (worker Cloudflare) n’est pas déployé pour ce site.';
      this.status.classList.add('warning');
    } else if (!this.app.model) {
      this.status.textContent = 'Chargez un modèle pour interroger l’assistant.';
      this.status.classList.remove('warning');
    } else {
      this.status.textContent = this.provider ? `Service : ${this.provider}` : 'Service d’IA : connexion…';
      this.status.classList.remove('warning');
    }
    const enabled = this.ready && this.busy === null;
    this.settings.setBusy(this.busy !== null);
    this.input.disabled = !this.ready;
    this.send.disabled = !enabled;
    this.suggestions.hidden = !this.ready || this.messages.length > 1;
  }

  private syncUsage(): void {
    this.usageEl.textContent = `Jetons · Entrée ${this.usage.display('inputTokens')} · Sortie ${this.usage.display('outputTokens')} · Total ${this.usage.display('totalTokens')}`;
    this.usageEl.title = 'Session de cet onglet, toutes conversations comprises. Compteurs communiqués par les fournisseurs ; « ? » signifie qu’un appel n’a pas communiqué ce compteur. Aucune estimation.';
    if (Object.values(this.usage.missing).some((count) => count > 0)) this.usageEl.append(h('span', { class: 'assistant-usage-unknown', text: ' ? : usage non communiqué, totaux incomplets.' }));
  }

  private reset(): void {
    this.busy?.abort();
    this.busy = null;
    this.messages = [];
    clear(this.log);
    clear(this.suggestions);
    for (const text of SUGGESTIONS) {
      this.suggestions.append(button(text, () => {
        this.input.value = text;
        void this.submit();
      }, { class: 'chip' }));
    }
    this.syncStatus();
  }

  /** Le contexte des outils : lecture du magasin de propriétés et actions sur la vue. */
  private context(): ToolContext {
    const { app } = this;
    const initialModel = app.model;
    return {
      isCurrent: () => app.model === initialModel,
      get store() { return app.store; },
      get count() { return app.model?.count ?? 0; },
      get keys() { return app.model?.keys ?? []; },
      labelOf: (index) => app.elementLabel(index),
      get selection() { return app.selection; },
      select: (indices, isolate) => {
        app.select(indices, 'panel');
        if (isolate) app.isolate(indices);
        if (indices.length > 0) app.fitTo(indices);
      },
      get appearanceRules() { return app.appearanceRules; },
      setAppearanceRules: (rules) => app.setAppearanceRules(rules),
      get grouping() { return app.grouping; },
      groupBy: (paths) => app.groupBy(paths),
    };
  }

  private line(kind: 'user' | 'assistant' | 'note' | 'error', text: string): HTMLElement {
    const element = h('div', { class: `chat ${kind}`, text });
    this.log.append(element);
    this.log.scrollTop = this.log.scrollHeight;
    return element;
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || !this.ready || this.busy) return;
    const { app } = this;
    const count = app.model!.count;
    const system: Message = { role: 'system', content: buildSystemPrompt({ fileName: app.fileName, count, store: app.store }) };
    if (this.messages.length === 0) this.messages.push(system);
    else this.messages[0] = system;
    this.input.value = '';
    this.line('user', text);
    const pending = this.line('note', 'Réflexion…');
    const controller = new AbortController();
    this.busy = controller;
    this.syncStatus();
    try {
      const answer = await runTurn(this.url, this.messages, text, this.context(), {
        onTool: (note) => {
          pending.remove();
          this.line('note', note);
          this.log.append(pending);
        },
        onProvider: (provider, model) => {
          this.provider = `${provider} (${model.replace(/^@cf\//, '')})`;
        },
        onUsage: (usage) => { this.usage.add(usage); this.syncUsage(); },
      }, controller.signal, this.api ?? undefined);
      if (this.busy !== controller) return;
      pending.remove();
      this.line('assistant', answer);
    } catch (error) {
      if (this.busy !== controller) return;
      pending.remove();
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // La question reste dans l'historique ; un message d'erreur orphelin le fausserait.
      if (this.messages[this.messages.length - 1]?.role === 'user') this.messages.pop();
      this.line('error', error instanceof AssistantError ? error.message : `Erreur : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.busy === controller) {
        this.busy = null;
        this.syncStatus();
        this.input.focus();
      }
    }
  }
}
