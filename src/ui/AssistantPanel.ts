import { AssistantError, assistantUrl, fetchStatus, noteInHistory, runTurn, serviceLine, type ApiSettings, type Message } from '../assistant/client.ts';
import { SessionUsage } from '../assistant/usage.ts';
import { buildSystemPrompt } from '../assistant/prompt.ts';
import { toolContext, snapshotView } from './toolContext.ts';
import { describeMentions, mentionedElements } from '../assistant/mentions.ts';
import { parseIntent, type Ambiguity, type Intent } from '../assistant/intent.ts';
import { ValueIndex } from '../assistant/valueIndex.ts';
import { VIEW_TOOLS, WRITE_TOOLS, answerFor, previewAnswer, previewWrite, type Answer } from '../assistant/answers.ts';
import { runTool, type ToolContext, type ToolOutcome } from '../assistant/tools.ts';
import type { App } from './App.ts';
import { button, clear, h } from './dom.ts';
import { AssistantSettings } from './AssistantSettings.ts';

const SUGGESTIONS = [
  'Résume ce modèle en quelques lignes.',
  'Combien d’éléments par niveau ?',
  'Quels éléments n’ont pas de matériau ?',
];
const COMMANDS_HELP = 'Exemples de commandes : « isole le niveau R+1 », « masque les portes », « colorie les murs en rouge », « combien d’éléments par niveau ? », « tout afficher », « annule ».';
const COMMENT_CHARS = 500;

/**
 * Conversation avec l'assistant. Les commandes courantes s'exécutent sans modèle de langage
 * (intent.ts) ; le reste est traduit par le modèle en une requête que le code vérifie. Dans les
 * deux cas, le compte rendu est écrit par le code (answers.ts) et chaque action a son « Annuler ».
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
  /** La dernière vérification du service a échoué : l'état le dit au lieu de rester sur « connexion… ». */
  private unreachable = false;
  private api: ApiSettings | null = null;
  private readonly usage = new SessionUsage();
  private readonly usageEl: HTMLElement;
  private readonly settings: AssistantSettings;
  /** Valeurs du modèle pour les commandes ; refait quand le modèle ou ses propriétés changent. */
  private index: ValueIndex | null = null;
  /** Boutons d'un choix ou d'un aperçu encore ouverts : une nouvelle demande les ferme. */
  private pending: HTMLButtonElement[] = [];
  /** « Annuler » de la dernière action de vue : une action plus récente le désactive (il rétablirait trop). */
  private viewUndo: HTMLButtonElement | null = null;
  /** Annulation de la dernière action de l'assistant, pour la commande « annule ». */
  private lastUndo: (() => void) | null = null;

  constructor(app: App) {
    this.app = app;
    this.status = h('p', { class: 'assistant-status' });
    this.log = h('div', { class: 'assistant-log', attrs: { 'aria-live': 'polite' } });
    this.suggestions = h('div', { class: 'assistant-suggestions' });
    this.input = h('textarea', { attrs: { rows: '2', placeholder: 'Une commande (« isole le niveau R+1 ») ou une question sur le modèle…', 'aria-label': 'Message à l’assistant' } });
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
      this.unreachable = false;
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
      h('p', { class: 'hint assistant-privacy', text: 'Les commandes s’exécutent dans le navigateur. Les autres questions, un résumé des propriétés et les résultats des recherches sont envoyés au service d’IA ; le fichier n’est jamais transmis en entier.' }),
    );

    app.on('model', () => { this.index = null; this.reset(); });
    app.on('metadata', () => { this.index = null; });
    this.reset();
    this.syncUsage();
    void this.checkService();
  }

  /** Un modèle de langage peut être appelé : relais configuré et joignable, ou API personnelle. */
  private get translator(): boolean {
    return this.url !== '' && (this.api !== null || !this.unreachable);
  }

  private async checkService(): Promise<void> {
    if (!this.url) return;
    try {
      const status = await fetchStatus(this.url);
      if (this.api) return;
      this.provider = status.providers.map((item) => item.name).join(', ');
      this.unreachable = false;
    } catch {
      if (!this.api) { this.provider = ''; this.unreachable = true; }
    }
    this.syncStatus();
  }

  private syncStatus(): void {
    if (!this.app.model) {
      this.status.textContent = 'Chargez un modèle pour utiliser l’assistant.';
      this.status.classList.remove('warning');
    } else if (!this.url) {
      this.status.textContent = 'Sans service d’IA : commandes seulement.';
      this.status.classList.remove('warning');
    } else {
      this.status.textContent = serviceLine(this.provider, this.unreachable && !this.api);
      this.status.classList.toggle('warning', this.unreachable && !this.provider && !this.api);
    }
    this.status.title = COMMANDS_HELP;
    this.settings.setBusy(this.busy !== null);
    this.input.disabled = !this.app.model;
    this.send.disabled = !this.app.model || this.busy !== null;
    this.suggestions.hidden = !this.app.model || this.log.childElementCount > 0;
  }

  private syncUsage(): void {
    this.usageEl.textContent = `Jetons · Entrée ${this.usage.display('inputTokens')} · Sortie ${this.usage.display('outputTokens')} · Total ${this.usage.display('totalTokens')}`;
    this.usageEl.title = 'Session de cet onglet, toutes conversations comprises. Compteurs communiqués par les fournisseurs ; « ? » signifie qu’un appel n’a pas communiqué ce compteur. Aucune estimation. Les commandes ne consomment aucun jeton.';
    if (Object.values(this.usage.missing).some((count) => count > 0)) this.usageEl.append(h('span', { class: 'assistant-usage-unknown', text: ' ? : usage non communiqué, totaux incomplets.' }));
  }

  private reset(): void {
    this.busy?.abort();
    this.busy = null;
    this.messages = [];
    this.pending = [];
    this.viewUndo = null;
    this.lastUndo = null;
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

  private line(kind: 'user' | 'assistant' | 'note' | 'error' | 'comment', text: string): HTMLElement {
    const element = h('div', { class: `chat ${kind}`, text });
    this.log.append(element);
    this.log.scrollTop = this.log.scrollHeight;
    return element;
  }

  // ---------------------------------------------------------------- cartes

  /** Compte rendu écrit par le code : phrase, chiffres, tableau, puis les boutons. */
  private card(answer: Answer, ...actions: HTMLButtonElement[]): HTMLElement {
    const element = h('div', { class: `chat ${answer.kind === 'error' ? 'error' : 'assistant'} assistant-result` }, h('p', { text: answer.text }));
    if (answer.figures?.length) element.append(h('dl', { class: 'assistant-figures' }, ...answer.figures.flatMap(([label, value]) => [h('dt', { text: label }), h('dd', { text: value })])));
    if (answer.table) {
      element.append(h('div', { class: 'assistant-table' }, h('table', {},
        h('thead', {}, h('tr', {}, ...answer.table.columns.map((column) => h('th', { text: column })))),
        h('tbody', {}, ...answer.table.rows.map((row) => h('tr', {}, ...row.map((value) => h('td', { text: value }))))))));
      if (answer.table.more) element.append(h('p', { class: 'assistant-more', text: `… et ${answer.table.more.toLocaleString('fr-FR')} de plus.` }));
    }
    if (actions.length > 0) element.append(h('div', { class: 'assistant-actions' }, ...actions));
    this.log.append(element);
    this.log.scrollTop = this.log.scrollHeight;
    return element;
  }

  private closePending(): void {
    for (const control of this.pending) control.disabled = true;
    this.pending = [];
  }

  /** Contexte des outils pour cette demande : les identifiants cités tels quels priment (mentions.ts). */
  private context(text: string): ToolContext {
    const context = toolContext(this.app);
    context.mentioned = new Set(mentionedElements(text, this.app.model?.keys ?? []));
    return context;
  }

  private valueIndex(): ValueIndex {
    const { app } = this;
    this.index ??= new ValueIndex(app.store, app.model!.count, app.model!.keys, (index) => app.elementLabel(index));
    return this.index;
  }

  /** Exécute un outil validé et en rend compte. Une écriture large, ou corrigée par le modèle (`corrected`), n'est d'abord que montrée (`stop`). */
  private execute(name: string, args: Record<string, unknown>, context: ToolContext, corrected = false): { outcome: ToolOutcome; stop?: boolean } {
    const preview = previewWrite(name, args, context, corrected);
    if (preview) {
      if (corrected) this.line('note', 'Requête corrigée par le modèle après un refus : vérifiez l’aperçu avant d’appliquer.');
      this.showPreview(name, args, preview);
      return { outcome: { result: { ...(preview.result as object), pending: 'Aperçu montré à l’utilisateur ; rien n’est écrit tant qu’il n’a pas confirmé.' }, note: preview.note }, stop: true };
    }
    return { outcome: this.runAndShow(name, args, context) };
  }

  private runAndShow(name: string, args: Record<string, unknown>, context: ToolContext): ToolOutcome {
    const { app } = this;
    const restore = VIEW_TOOLS.has(name) ? snapshotView(app) : null;
    const before = app.propertyEdits?.lastChange ?? null;
    const outcome = runTool(name, args, context);
    const answer = answerFor(name, args, outcome);
    let undo: (() => void) | null = null;
    if (answer.kind === 'view' && restore) undo = restore;
    const step = app.propertyEdits?.lastChange ?? null;
    if (answer.kind === 'write' && step && step !== before) {
      // On n'annule que sa propre étape : si d'autres modifications l'ont suivie, on le dit au lieu d'annuler la mauvaise.
      undo = () => {
        if (app.propertyEdits?.lastChange === step) app.undoProperties();
        else this.line('note', 'D’autres modifications ont suivi : annulez-les d’abord avec « Annuler » dans la barre d’outils.');
      };
    }
    if (!undo) { this.card(answer); return outcome; }
    const control = button('Annuler', () => {
      control.disabled = true;
      if (this.lastUndo === run) this.lastUndo = null;
      undo();
      this.line('note', 'Action annulée.');
    }, { class: 'subtle', title: answer.kind === 'write' ? 'Annuler cette modification des propriétés' : 'Revenir à l’affichage d’avant cette action' });
    const run = () => control.click();
    if (answer.kind === 'view') {
      if (this.viewUndo) this.viewUndo.disabled = true;
      this.viewUndo = control;
    }
    this.lastUndo = run;
    this.card(answer, control);
    return outcome;
  }

  private showPreview(name: string, args: Record<string, unknown>, preview: ToolOutcome): void {
    const answer = previewAnswer(name, preview, this.app.model?.count ?? 0);
    const apply = button('Appliquer', () => {
      this.closePending();
      const text = this.runAndShow(name, args, toolContext(this.app));
      noteInHistory(this.messages, '[Viewer] L’utilisateur a confirmé l’écriture.', answerFor(name, args, text).text);
    });
    const cancel = button('Annuler', () => {
      this.closePending();
      this.line('note', 'Écriture abandonnée : rien n’a été écrit.');
      noteInHistory(this.messages, '[Viewer] L’utilisateur a abandonné l’écriture.', 'Rien n’a été écrit.');
    }, { class: 'subtle' });
    this.pending.push(apply, cancel);
    this.card(answer, apply, cancel);
  }

  private askChoice(text: string, ambiguity: Ambiguity): void {
    const choices = ambiguity.choices.map((choice) => button(choice.label, () => {
      this.closePending();
      this.line('note', `Choix : ${choice.label}`);
      this.runCommand(text, choice.intent);
    }, { class: 'chip' }));
    const other = this.translator ? [button('Aucune : demander au modèle', () => { if (this.busy) return; this.closePending(); void this.translate(text); }, { class: 'chip subtle' })] : [];
    this.pending.push(...choices, ...other);
    this.card({ kind: 'read', text: ambiguity.question }, ...choices, ...other);
  }

  /** Une commande reconnue sans modèle : exécutée ici, notée dans l'historique pour que le modèle sache ce qui s'est fait. */
  private runCommand(text: string, intent: Intent): void {
    if (intent.kind === 'undo') {
      if (this.lastUndo) this.lastUndo();
      else this.line('note', 'Rien à annuler : aucune action récente de l’assistant.');
      return;
    }
    const { outcome, stop } = this.execute(intent.tool, intent.args, this.context(text));
    noteInHistory(this.messages, text, stop ? 'Aperçu montré, en attente de confirmation.' : answerFor(intent.tool, intent.args, outcome).text);
    this.syncStatus();
  }

  // ---------------------------------------------------------------- demande

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || !this.app.model || this.busy) return;
    this.closePending();
    this.input.value = '';
    this.line('user', text);
    this.ensureSystem();
    const parsed = parseIntent(text, this.valueIndex());
    if (parsed?.kind === 'ambiguity') this.askChoice(text, parsed);
    else if (parsed) this.runCommand(text, parsed);
    else if (this.translator) await this.translate(text);
    else {
      this.line('note', `${this.url ? 'Service d’IA injoignable' : 'Pas de service d’IA'} : seules les commandes sont comprises. ${COMMANDS_HELP}`);
      if (this.url) void this.checkService();
    }
    this.syncStatus();
  }

  /** Message système à jour en tête de l'historique (le modèle chargé ou ses propriétés ont pu changer). */
  private ensureSystem(): void {
    const { app } = this;
    const system: Message = { role: 'system', content: buildSystemPrompt({ fileName: app.fileName, count: app.model!.count, store: app.store }) };
    if (this.messages[0]?.role === 'system') this.messages[0] = system;
    else this.messages.unshift(system);
  }

  /** Couche 2 : le modèle traduit, le code vérifie et exécute, puis rend compte. */
  private async translate(text: string): Promise<void> {
    const { app } = this;
    this.ensureSystem();
    // Identifiants cités tels quels : reconnus ici, signalés au modèle, et prioritaires dans les outils.
    const mentioned = mentionedElements(text, app.model!.keys);
    if (mentioned.length > 0) {
      this.line('note', `Identifiant reconnu : ${mentioned.slice(0, 3).map((index) => `« ${app.elementLabel(index)} »`).join(', ')}${mentioned.length > 3 ? ` et ${mentioned.length - 3} autres` : ''}`);
    }
    const request = text + describeMentions(mentioned, app.model!.keys, (index) => app.elementLabel(index));
    const context = this.context(text);
    const pending = this.line('note', 'Réflexion…');
    const controller = new AbortController();
    this.busy = controller;
    this.syncStatus();
    try {
      const turn = await runTurn(this.url, this.messages, request, {
        execute: (name, args, preview) => {
          pending.remove();
          const step = this.execute(name, args, context, preview);
          this.log.append(pending);
          return step;
        },
        onProvider: (provider, model) => { this.provider = `${provider} (${model.replace(/^@cf\//, '')})`; },
        onUsage: (usage) => { this.usage.add(usage); this.syncUsage(); },
        isCurrent: context.isCurrent,
      }, controller.signal, this.api ?? undefined);
      if (this.busy !== controller) return;
      pending.remove();
      const acted = turn.ran.some((name) => WRITE_TOOLS.has(name) || VIEW_TOOLS.has(name));
      const answer = turn.answer?.trim() ?? '';
      if (turn.ending === 'invalid') {
        this.line('error', `Le modèle n’a pas formulé de requête valide (${turn.invalid}). ${turn.ran.length > 0 ? 'Les actions affichées ci-dessus ont été faites ; la suite n’a pas été exécutée.' : 'Rien n’a été fait : reformulez, ou utilisez une commande.'}`);
      } else if (turn.ending === 'rounds') {
        this.line('note', turn.ran.length > 0 ? 'Quatre étapes sans conclusion : les actions affichées ci-dessus ont été faites. Reformulez pour la suite.' : 'Je n’ai pas réussi à conclure : reformulez la demande.');
      } else if (answer && !acted) {
        // Le texte du modèle n'est montré que sans action ; après une lecture, comme un commentaire à part.
        if (turn.ran.length > 0) this.line('comment', answer.length > COMMENT_CHARS ? `${answer.slice(0, COMMENT_CHARS)}…` : answer);
        else this.line('assistant', answer);
      } else if (!answer && turn.ran.length === 0 && turn.ending === undefined) {
        this.line('note', 'Pas de réponse du modèle.');
      }
    } catch (error) {
      if (this.busy !== controller) return;
      pending.remove();
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof AssistantError && error.unreachable && !this.api) { this.unreachable = true; this.provider = ''; }
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
