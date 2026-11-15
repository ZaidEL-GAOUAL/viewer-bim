// La page « Suivi de chantier » (chantier.html) : faite pour un téléphone d'abord, utilisable sur un ordinateur. Projets,
// liste des observations avec filtres, fiche d'une observation (photos, commentaires, historique), plans avec repères,
// membres, compte. Tout se lit et s'écrit dans le magasin de l'appareil (store.ts) ; la ligne d'état dit ce qui n'est pas encore
// envoyé. Navigation par l'adresse (#/p/<projet>/o/<observation>…) : le bouton « retour » du téléphone marche.

import { pageTabs } from '../ui/Shell.ts';
import { writeBcf } from '../data/bcf.ts';
import {
  addComment, allowedStatuses, changeStatus, extensionsOf, filterObservations, frenchDate, isOverdue, newObservation, nextNumber, statusColor, toBcfTopic, touched,
  type Observation, type ObservationBook, type ObservationLists,
} from '../data/observations.ts';
import { integer, oneDecimal, plural } from '../data/text.ts';
import { button, download, h } from '../ui/dom.ts';
import { reducePhoto } from '../ui/photo.ts';
import { planImage } from './planImage.ts';
import { initials, listsOf, ROLE_LABELS, type MembershipRow, type PhotoRow, type PlanRow, type ProjectRow, type Role } from './rows.ts';
import type { Row } from './backend/port.ts';
import type { ChantierStore } from './store.ts';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const localDay = () => new Date().toLocaleDateString('sv-SE');
const TODO = '#todo';
const FIELD_LABELS: Readonly<Record<string, string>> = {
  status: 'statut', title: 'titre', description: 'description', type: 'type', labels: 'lot', stage: 'phase', assigned_to: 'attribution', due_date: 'échéance',
  priority: 'priorité', extra: 'emplacement', deleted_at: 'suppression', modified_author: '', creation_author: 'auteur',
};
const LIST_LABELS: Readonly<Record<Exclude<keyof ObservationLists, 'transitions'>, string>> = {
  kinds: 'Types', statuses: 'Statuts', done: 'Statuts terminés', trades: 'Lots', priorities: 'Priorités', phases: 'Phases', companies: 'Entreprises',
};

function select(values: readonly string[], value: string, label: string, empty?: string): HTMLSelectElement {
  const options = [...new Set([...values, ...(value ? [value] : [])])];
  const element = h('select', { attrs: { 'aria-label': label } }, ...(empty !== undefined ? [h('option', { text: empty, attrs: { value: '' } })] : []), ...options.map((option) => h('option', { text: option, attrs: { value: option } })));
  element.value = value;
  return element;
}
const field = (label: string, control: HTMLElement, hint?: string) => h('label', { class: 'ch-field' }, h('span', { class: 'field-label', text: label }), control, hint ? h('span', { class: 'ch-hint', text: hint }) : null);
const input = (type: string, label: string, value = '', attrs: Record<string, string> = {}) => {
  const element = h('input', { attrs: { type, 'aria-label': label, ...attrs } });
  element.value = value;
  return element;
};
const link = (text: string, href: string, className?: string) => h('a', { text, class: className, attrs: { href } });

interface Filters {
  status: string;
  company: string;
  assignee: string;
  level: string;
  overdue: boolean;
  text: string;
}
const noFilters = (): Filters => ({ status: '', company: '', assignee: '', level: '', overdue: false, text: '' });

export interface PageOptions {
  /** Démonstration (serveur en mémoire) : un interrupteur simule la coupure du réseau. */
  demo?: { setOffline(offline: boolean): void; offline: boolean };
}

export class ChantierPage {
  private readonly store: ChantierStore;
  private readonly options: PageOptions;
  private readonly main = h('main', { class: 'ch-main' });
  private readonly status = h('div', { class: 'ch-status', attrs: { role: 'status' } });
  private readonly account = h('a', { class: 'ch-avatar', attrs: { href: '#/compte', title: 'Compte' } });
  private readonly toastEl = h('div', { class: 'toast ch-toast', attrs: { role: 'status', hidden: '' } });
  private urls: string[] = [];
  private filters = noFilters();
  private filtersProject = '';
  private token = 0;
  private soon: ReturnType<typeof setTimeout> | undefined;

  constructor(root: HTMLElement, store: ChantierStore, options: PageOptions = {}) {
    this.store = store;
    this.options = options;
    root.className = 'ch-app';
    root.append(
      h('header', { class: 'ch-bar' }, link('Viewer BIM', '#/', 'ch-brand'), pageTabs('chantier'), h('span', { class: 'ch-spacer' }), this.account),
      this.status, this.main, this.toastEl,
    );
    window.addEventListener('hashchange', () => void this.render());
    store.onChange(() => {
      void this.renderStatus();
      this.renderSoon();
    });
    // Envoyer et recevoir : à l'ouverture, au retour du réseau, quand la page revient au premier plan, et chaque minute.
    window.addEventListener('online', () => void store.sync());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void store.sync(); });
    setInterval(() => { if (document.visibilityState === 'visible') void store.sync(); }, 60_000);
    void this.render();
    void store.sync();
  }

  // ------------------------------------------------------------------ outils

  private toast(text: string, error = false): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle('error', error);
    this.toastEl.hidden = false;
    clearTimeout(Number(this.toastEl.dataset.timer));
    this.toastEl.dataset.timer = String(setTimeout(() => { this.toastEl.hidden = true; }, error ? 8000 : 4000));
  }

  private url(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.push(url);
    return url;
  }

  /** Redessine après une synchronisation, sauf pendant une saisie (le champ garde le curseur ; il sera redessiné ensuite). */
  private renderSoon(): void {
    clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      const active = document.activeElement;
      if (active && this.main.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      void this.render();
    }, 300);
  }

  /** Le nom qui signe observations et commentaires : celui du profil, demandé une fois s'il manque. */
  private async author(): Promise<string> {
    const profile = await this.store.profile();
    if (profile.name) return profile.name;
    const name = window.prompt('Votre nom (il signe vos observations et vos commentaires) :')?.trim() ?? '';
    if (name) await this.store.saveProfile(name, profile.company);
    return name;
  }

  private async run(task: () => Promise<unknown>, done?: string): Promise<void> {
    try {
      await task();
      if (done) this.toast(done);
    } catch (error) {
      this.toast(errorText(error), true);
    }
  }

  private async renderStatus(): Promise<void> {
    const { store } = this;
    const { waiting, refused } = await store.pending();
    const state = store.state;
    const changes = (n: number) => plural(n, 'modification');
    let text: string;
    let warning = false;
    if (!store.backend) text = 'Ce site n’est relié à aucun serveur : vos données restent sur cet appareil.';
    else if (!store.account) {
      text = 'Non synchronisé — connectez-vous pour retrouver ces données ailleurs.';
      warning = true;
    } else if (state.phase === 'syncing') text = 'Synchronisation…';
    else if (state.phase === 'offline') {
      text = `Hors ligne : ${waiting > 0 ? `${changes(waiting)} gardée${waiting > 1 ? 's' : ''} sur cet appareil, envoyée${waiting > 1 ? 's' : ''} au retour du réseau` : 'tout est gardé sur cet appareil'}.`;
      warning = true;
    } else if (state.phase === 'auth') {
      text = `${state.message ?? 'Session expirée'} Vos données restent sur cet appareil.`;
      warning = true;
    } else if (state.phase === 'error') {
      text = `Synchronisation interrompue : ${state.message ?? ''}`;
      warning = true;
    } else text = waiting > 0 ? `${changes(waiting)} à envoyer.` : state.at ? `Synchronisé à ${new Date(state.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : 'Connecté.';
    if (!store.kv.persistent) {
      text = `Ce navigateur ne garde rien (navigation privée ?) : fermer la page efface ce qui n’est pas envoyé. ${text}`;
      warning = true;
    }
    const parts: (Node | string)[] = [h('span', { text })];
    if (refused.length > 0) {
      parts.push(h('span', { class: 'ch-refused', text: ` ${plural(refused.length, 'modification refusée', 'modifications refusées')} par le serveur : ${refused[0].error}` }), button('Réessayer', () => void store.retry()));
      warning = true;
    }
    if (store.backend && store.account && state.phase !== 'syncing') parts.push(button('Synchroniser', () => void store.sync()));
    else if (store.backend && !store.account) parts.push(link('Se connecter', '#/compte'));
    const demo = this.options.demo;
    if (demo) {
      const box = h('input', { attrs: { type: 'checkbox' } });
      box.checked = demo.offline;
      box.addEventListener('change', () => {
        demo.setOffline(box.checked);
        void store.sync();
      });
      parts.push(h('label', { class: 'ch-demo' }, box, ' Simuler hors ligne (démonstration)'));
    }
    this.status.classList.toggle('warning', warning);
    this.status.replaceChildren(...parts);
    const profile = await store.profile();
    this.account.textContent = store.account ? initials(profile.name || store.account.email) : 'Compte';
    this.account.title = store.account ? `${profile.name || store.account.email} — compte` : 'Se connecter ou créer un compte';
  }

  // ------------------------------------------------------------------ navigation

  private async render(): Promise<void> {
    const token = ++this.token;
    const previous = this.urls;
    this.urls = [];
    const [a, b, c, d, e, f] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    let nodes: (Node | null)[];
    try {
      if (a === 'compte') nodes = await this.accountScreen();
      else if (a === 'mentions') nodes = this.legalScreen();
      else if (a === 'p' && b) {
        const project = await this.store.project(b);
        if (!project) nodes = [h('p', { text: 'Projet introuvable sur cet appareil.' }), link('Retour aux projets', '#/')];
        else if (c === 'o' && d) nodes = await this.observationScreen(project, d);
        else if (c === 'plans' && d) nodes = await this.planScreen(project, d, e === 'placer' ? f : undefined);
        else if (c === 'plans') nodes = await this.plansScreen(project);
        else if (c === 'membres') nodes = await this.membersScreen(project);
        else nodes = await this.listScreen(project);
      } else nodes = await this.projectsScreen();
    } catch (error) {
      nodes = [h('p', { class: 'ch-error', text: `Affichage impossible : ${errorText(error)}` })];
    }
    if (token !== this.token) return;
    this.main.replaceChildren(...nodes.filter((node): node is Node => node !== null));
    for (const url of previous) URL.revokeObjectURL(url);
    void this.renderStatus();
  }

  private tabs(project: ProjectRow, active: 'list' | 'plans' | 'members'): HTMLElement {
    const tab = (text: string, href: string, on: boolean) => h('a', { text, class: on ? 'ch-tab active' : 'ch-tab', attrs: { href, ...(on ? { 'aria-current': 'page' } : {}) } });
    const base = `#/p/${project.id}`;
    return h('div', { class: 'ch-head' },
      link('‹ Projets', '#/', 'ch-back'),
      h('h1', { text: project.name }),
      project._lost ? h('p', { class: 'ch-note warning', text: 'Ce projet n’est plus accessible avec votre compte (vous en avez été retiré, ou il a été supprimé). Ce qui est sur cet appareil reste lisible.' }) : null,
      h('nav', { class: 'ch-tabs' }, tab('Observations', base, active === 'list'), tab('Plans', `${base}/plans`, active === 'plans'), tab('Membres', `${base}/membres`, active === 'members')));
  }

  // ------------------------------------------------------------------ projets

  private async projectsScreen(): Promise<(Node | null)[]> {
    const { store } = this;
    const [projects, topics, photos, plans] = await Promise.all([store.projects(), store.rows<Row>('topics'), store.rows<PhotoRow>('photos'), store.rows<PlanRow>('plans')]);
    const name = input('text', 'Nom du nouveau projet', '', { placeholder: 'Nom du nouveau projet', maxlength: '200' });
    const create = h('form', { class: 'ch-row' }, name, h('button', { class: 'primary', text: 'Créer le projet', attrs: { type: 'submit' } }));
    create.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!name.value.trim()) return;
      void this.run(async () => { location.hash = `#/p/${(await store.createProject(name.value)).id}`; });
    });
    const rows = projects.map((project) => {
      const lists = listsOf(project);
      const open = topics.filter((topic) => topic.project_id === project.id && !topic.deleted_at && !lists.done.includes(String(topic.status))).length;
      const bytes = [...photos, ...plans].filter((row) => row.project_id === project.id && !row.deleted_at).reduce((sum, row) => sum + Number(row.size), 0);
      const facts = [`${plural(open, 'observation non terminée', 'observations non terminées')}`, `${oneDecimal.format(bytes / 1e6)} Mo de photos et plans`,
        project._lost ? 'plus accessible avec votre compte' : !project.created_at ? 'pas encore envoyé' : ''].filter(Boolean).join(' · ');
      return h('a', { class: 'ch-card', attrs: { href: `#/p/${project.id}` } }, h('strong', { text: project.name }), h('span', { class: 'ch-hint', text: facts }));
    });
    return [
      h('h1', { text: 'Projets' }),
      ...(rows.length > 0 ? rows : [h('p', { class: 'ch-hint', text: 'Aucun projet sur cet appareil. Créez-en un, ou connectez-vous pour retrouver les vôtres.' })]),
      h('h2', { text: 'Nouveau projet' }), create,
      store.backend && !store.account ? h('p', { class: 'ch-hint' }, 'Sans compte, vos projets restent sur cet appareil. ', link('Se connecter ou créer un compte', '#/compte'), ' pour les partager et les retrouver ailleurs.') : null,
      h('p', { class: 'ch-foot' }, link('Mentions et données personnelles', '#/mentions')),
    ];
  }

  // ------------------------------------------------------------------ liste des observations

  private filtered(book: ObservationBook, members: readonly MembershipRow[]): Observation[] {
    const f = this.filters, { lists } = book;
    const companyOf = new Map(members.map((member) => [member.email, member.company]));
    const list = book.topics.filter((topic) => (!f.company || topic.assignedTo === f.company || companyOf.get(topic.assignedTo?.toLowerCase() ?? '') === f.company)
      && (!f.assignee || topic.assignedTo === f.assignee));
    return filterObservations(list, {
      statuses: f.status === TODO ? lists.statuses.filter((status) => !lists.done.includes(status)) : f.status ? [f.status] : undefined,
      level: f.level || undefined, overdue: f.overdue, text: f.text.trim() || undefined,
    }, lists, localDay());
  }

  private async listScreen(project: ProjectRow): Promise<(Node | null)[]> {
    const { store } = this;
    void store.openProject(project.id);
    if (this.filtersProject !== project.id) {
      this.filters = noFilters();
      this.filtersProject = project.id;
    }
    const [book, role, members, queue] = await Promise.all([store.book(project.id), store.role(project.id), store.members(project.id), store.queue()]);
    const unsent = new Set(queue.filter((entry) => entry.table === 'topics' || entry.table === 'comments' || entry.table === 'photos').map((entry) => String(entry.fields.topic_id ?? entry.id)));
    const { lists } = book;
    const f = this.filters;
    const rerender = () => void this.render();
    const status = select([], '', 'Statut');
    status.append(h('option', { text: 'Tous les statuts', attrs: { value: '' } }), h('option', { text: 'Non terminées', attrs: { value: TODO } }), ...lists.statuses.map((value) => h('option', { text: value, attrs: { value } })));
    status.value = f.status;
    const companies = [...new Set([...lists.companies, ...members.map((member) => member.company).filter(Boolean)])].sort();
    const company = select(companies, f.company, 'Entreprise', 'Toutes les entreprises');
    const assignee = select([...new Set(book.topics.flatMap((topic) => (topic.assignedTo ? [topic.assignedTo] : [])))].sort(), f.assignee, 'Attribuée à', 'Attribuées à tous');
    const level = select([...new Set(book.topics.flatMap((topic) => (topic.location.level ? [topic.location.level] : [])))].sort(), f.level, 'Niveau', 'Tous les niveaux');
    const overdue = h('input', { attrs: { type: 'checkbox' } });
    overdue.checked = f.overdue;
    const text = input('search', 'Rechercher', f.text, { placeholder: 'Rechercher' });
    status.addEventListener('change', () => { f.status = status.value; rerender(); });
    company.addEventListener('change', () => { f.company = company.value; rerender(); });
    assignee.addEventListener('change', () => { f.assignee = assignee.value; rerender(); });
    level.addEventListener('change', () => { f.level = level.value; rerender(); });
    overdue.addEventListener('change', () => { f.overdue = overdue.checked; rerender(); });
    text.addEventListener('change', () => { f.text = text.value; rerender(); });

    const list = this.filtered(book, members);
    const today = localDay();
    const rows = list.map((topic) => {
      const details = [topic.status, topic.assignedTo, topic.dueDate ? `échéance ${frenchDate(topic.dueDate)}` : '', isOverdue(topic, lists, today) ? 'en retard' : '', unsent.has(topic.guid) ? 'non envoyée' : ''].filter(Boolean).join(' · ');
      return h('a', { class: 'ch-card', attrs: { href: `#/p/${project.id}/o/${topic.guid}` } },
        h('strong', {}, h('span', { class: 'ch-dot', attrs: { style: `background:${statusColor(topic.status, lists)}` } }), `${topic.number > 0 ? `N° ${topic.number}` : 'N° —'} · ${topic.title || '(sans titre)'}`),
        h('span', { class: 'ch-hint', text: details }));
    });
    const open = book.topics.filter((topic) => !lists.done.includes(topic.status)).length;
    const late = book.topics.filter((topic) => isOverdue(topic, lists, today)).length;

    const importInput = h('input', { attrs: { type: 'file', accept: '.bcf,.bcfzip,.json', hidden: '' } });
    importInput.addEventListener('change', () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (file) void this.run(async () => {
        const result = await store.importFile(project.id, file);
        this.toast([`Import : ${plural(result.added, 'observation ajoutée', 'observations ajoutées')}, ${plural(result.updated, 'mise à jour', 'mises à jour')}.`, ...result.notes].join(' '));
        rerender();
      });
    });
    const team = role !== 'guest';
    return [
      this.tabs(project, 'list'),
      h('div', { class: 'ch-row ch-actions' },
        team ? button('Nouvelle observation', () => void this.createObservation(project.id), { class: 'primary' }) : null,
        button('Rapport PDF', () => void this.report(project, list)),
        button('Exporter .bcf', () => void this.exportBcf(project, book)),
        team ? button('Importer…', () => importInput.click(), { title: 'Un .bcf ou le JSON d’observations exporté du viewer : une observation déjà là est mise à jour' }) : null,
        importInput),
      h('div', { class: 'ch-filters' }, status, company, assignee, level, h('label', { class: 'ch-check' }, overdue, ' En retard'), text),
      h('p', { class: 'ch-hint', text: `${plural(book.topics.length, 'observation')}${list.length !== book.topics.length ? ` (${integer.format(list.length)} affichée${list.length > 1 ? 's' : ''})` : ''} · ${integer.format(open)} non terminée${open > 1 ? 's' : ''} · ${integer.format(late)} en retard` }),
      ...(rows.length > 0 ? rows : [h('p', { class: 'ch-hint', text: book.topics.length > 0 ? 'Aucune observation ne correspond aux filtres.' : role === 'guest' ? 'Aucune observation ne vous est attribuée.' : 'Aucune observation : « Nouvelle observation », ou « Importer… » ce que vous avez fait dans le viewer.' })]),
    ];
  }

  private async createObservation(projectId: string, drawingPin?: Observation['drawingPin']): Promise<void> {
    const author = await this.author();
    if (!author) return;
    await this.run(async () => {
      const book = await this.store.book(projectId);
      const observation = newObservation(drawingPin ? { drawingPin } : {}, author, new Date(), book.lists, nextNumber(book.topics));
      await this.store.saveObservation(projectId, observation);
      location.hash = `#/p/${projectId}/o/${observation.guid}`;
    });
  }

  private async report(project: ProjectRow, list: readonly Observation[]): Promise<void> {
    this.toast('Rapport en cours…');
    await this.run(async () => {
      const { observationsPdf } = await import('../ui/observationReport.ts');
      const author = (await this.store.profile()).name;
      download(await observationsPdf(list, listsOf(project), { title: project.name, author }), `${project.name} - observations.pdf`);
    }, 'Rapport PDF enregistré.');
  }

  private async exportBcf(project: ProjectRow, book: ObservationBook): Promise<void> {
    if (book.topics.length === 0) return this.toast('Aucune observation à exporter.');
    const missing = book.topics.reduce((sum, topic) => sum + topic.documents.filter((document) => !document.data).length, 0);
    await this.run(async () => {
      download(await writeBcf(book.topics.map((topic) => toBcfTopic(topic)), extensionsOf(book)), `${project.name} - observations.bcf`);
      if (missing > 0) this.toast(`${plural(missing, 'photo')} pas encore sur cet appareil : non écrite${missing > 1 ? 's' : ''} (synchronisez, puis exportez de nouveau).`, true);
    }, missing > 0 ? undefined : 'Fichier .bcf enregistré.');
  }

  // ------------------------------------------------------------------ fiche d'une observation

  private async edit(projectId: string, guid: string, change: (topic: Observation, author: string, now: Date) => Observation, rerender = false): Promise<void> {
    const author = await this.author();
    if (!author) return;
    await this.run(async () => {
      const topic = (await this.store.book(projectId)).topics.find((item) => item.guid === guid);
      if (!topic) throw new Error('Observation introuvable.');
      await this.store.saveObservation(projectId, change(topic, author, new Date()));
    });
    if (rerender) await this.render();
  }

  private async observationScreen(project: ProjectRow, guid: string): Promise<(Node | null)[]> {
    const { store } = this;
    void store.openProject(project.id);
    const [book, role, members, plans, events, queue] = await Promise.all([store.book(project.id), store.role(project.id), store.members(project.id), store.plans(project.id), store.events(guid), store.queue()]);
    const topic = book.topics.find((item) => item.guid === guid);
    const back = link('‹ Observations', `#/p/${project.id}`, 'ch-back');
    if (!topic) return [back, h('p', { text: 'Observation introuvable (supprimée, ou pas encore arrivée sur cet appareil).' })];
    const { lists } = book;
    const team = role !== 'guest';
    const save = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, change: (value: string) => Partial<Observation>) => {
      control.disabled = !team;
      control.addEventListener('change', () => void this.edit(project.id, guid, (t, author, now) => touched(t, change(control.value.trim()), author, now)));
    };
    const title = input('text', 'Titre', topic.title, { placeholder: 'Ce qui est constaté', maxlength: '500' });
    save(title, (value) => ({ title: value }));
    const kind = select(lists.kinds, topic.type, 'Type');
    save(kind, (value) => ({ type: value }));
    const status = select([topic.status, ...allowedStatuses(lists, topic.status)], topic.status, 'Statut');
    status.addEventListener('change', () => void this.edit(project.id, guid, (t, author, now) => changeStatus(t, status.value, lists, author, now), true));
    const priority = select(lists.priorities, topic.priority ?? '', 'Priorité', '—');
    save(priority, (value) => ({ priority: value || undefined }));
    const assignees = h('datalist', { attrs: { id: 'ch-assignees' } }, ...[...new Set([...lists.companies, ...members.map((member) => member.company), ...members.map((member) => member.email)])].filter(Boolean).map((value) => h('option', { attrs: { value } })));
    const assigned = input('text', 'Attribuée à', topic.assignedTo ?? '', { list: 'ch-assignees', placeholder: 'Entreprise ou e-mail' });
    save(assigned, (value) => ({ assignedTo: value || undefined }));
    const due = input('date', 'Échéance', topic.dueDate?.slice(0, 10) ?? '');
    save(due, (value) => ({ dueDate: value ? `${value}T00:00:00Z` : undefined }));
    const trade = select(lists.trades, topic.labels[0] ?? '', 'Lot', '—');
    save(trade, (value) => ({ labels: value ? [value] : [] }));
    const phase = select(lists.phases, topic.stage ?? '', 'Phase', '—');
    save(phase, (value) => ({ stage: value || undefined }));
    const description = h('textarea', { attrs: { rows: '4', 'aria-label': 'Description', placeholder: 'Description' } });
    description.value = topic.description ?? '';
    save(description, (value) => ({ description: value || undefined }));

    // Emplacement : repère sur un plan du projet, ou dans la maquette (posé dans le viewer).
    const pinned = topic.drawingPin ? plans.find((plan) => plan.id === topic.drawingPin!.plan) : undefined;
    const placeOn = select(plans.map((plan) => plan.name), '', 'Plan', 'Choisir un plan…');
    placeOn.addEventListener('change', () => {
      const plan = plans.find((item) => item.name === placeOn.value);
      if (plan) location.hash = `#/p/${project.id}/plans/${plan.id}/placer/${guid}`;
    });
    const where = [
      pinned ? h('span', {}, 'Repère sur le plan ', link(`« ${pinned.name} »`, `#/p/${project.id}/plans/${pinned.id}`), '.') : topic.drawingPin ? h('span', { text: 'Repère sur un plan qui n’est pas sur cet appareil.' }) : null,
      topic.pin || topic.point ? h('span', { text: ` Repère dans la maquette${topic.pin ? ` (plan « ${topic.pin.plan} » du viewer)` : ''}.` }) : null,
      [topic.location.level && `Niveau ${topic.location.level}`, topic.location.room && `Local ${topic.location.room}`, topic.location.zone && `Zone ${topic.location.zone}`].filter(Boolean).join(' · ') || null,
    ].filter(Boolean) as (Node | string)[];

    // Photos : depuis l'appareil photo ou des fichiers, réduites à 1 500 px avant d'être gardées.
    const camera = h('input', { attrs: { type: 'file', accept: 'image/*', capture: 'environment', hidden: '' } });
    const files = h('input', { attrs: { type: 'file', accept: 'image/*', multiple: '', hidden: '' } });
    for (const picker of [camera, files]) picker.addEventListener('change', () => {
      const chosen = [...(picker.files ?? [])];
      picker.value = '';
      if (chosen.length > 0) void this.addPhotos(project.id, guid, chosen);
    });
    const photos = h('div', { class: 'ch-photos' });
    for (const viewpoint of topic.viewpoints) if (viewpoint.snapshot) photos.append(h('img', { class: 'ch-photo', attrs: { src: this.url(viewpoint.snapshot), alt: 'Vue de la maquette' } }));
    for (const document of topic.documents) {
      const remove = team ? button('×', () => {
        if (window.confirm(`Retirer la photo « ${document.filename} » de l’observation ?`)) void this.edit(project.id, guid, (t, author, now) => touched(t, { documents: t.documents.filter((d) => d.guid !== document.guid) }, author, now), true);
      }, { class: 'ch-remove', title: 'Retirer cette photo', attrs: { 'aria-label': `Retirer ${document.filename}` } }) : null;
      const src = document.data ? this.url(document.data) : '';
      const image = src ? h('a', { attrs: { href: src, target: '_blank', rel: 'noopener' } }, h('img', { class: 'ch-photo', attrs: { src, alt: document.filename } })) : h('span', { class: 'ch-photo ch-missing', text: 'Photo pas encore sur cet appareil' });
      photos.append(h('span', { class: 'ch-photo-box' }, image, remove));
    }

    const comment = h('textarea', { attrs: { rows: '2', 'aria-label': 'Commentaire', placeholder: 'Commentaire' } });
    const history = [
      ...topic.comments.map((item) => ({ at: item.date, text: `${item.author} : ${item.text}` })),
      ...events.filter((event) => event.action === 'insert' || (event.fields ?? []).some((name) => FIELD_LABELS[name])).map((event) => ({
        at: event.at, text: `${event.actor_name || 'Quelqu’un'} : ${event.action === 'insert' ? 'création' : `a modifié ${(event.fields ?? []).map((name) => FIELD_LABELS[name] ?? name).filter(Boolean).join(', ')}`}`,
      })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const unsent = queue.some((entry) => entry.id === guid || entry.fields.topic_id === guid);

    return [
      back,
      h('h1', { text: `Observation ${topic.number > 0 ? `N° ${topic.number}` : '(numéro à la synchronisation)'}` }),
      unsent ? h('p', { class: 'ch-note', text: store.account ? 'Des modifications de cette observation ne sont pas encore envoyées.' : 'Non synchronisée — connectez-vous pour la retrouver ailleurs.' }) : null,
      !team ? h('p', { class: 'ch-note', text: 'Invité : vous changez le statut, commentez et ajoutez des photos.' }) : null,
      field('Titre', title),
      h('div', { class: 'ch-grid' }, field('Statut', status), field('Type', kind), field('Priorité', priority), field('Échéance', due), field('Attribuée à', assigned), field('Lot', trade), field('Phase', phase)),
      assignees,
      field('Description', description),
      h('h2', { text: 'Emplacement' }),
      h('p', { class: 'ch-hint' }, ...(where.length > 0 ? where : ['Pas encore placée.'])),
      team && plans.length > 0 ? field(topic.drawingPin ? 'Déplacer sur un plan' : 'Placer sur un plan', placeOn) : null,
      team && plans.length === 0 ? h('p', { class: 'ch-hint' }, 'Ajoutez un plan du projet dans ', link('Plans', `#/p/${project.id}/plans`), ' pour y placer l’observation.') : null,
      h('h2', { text: 'Photos' }),
      photos,
      h('div', { class: 'ch-row' }, button('Prendre une photo', () => camera.click(), { class: 'primary' }), button('Ajouter des photos', () => files.click()), camera, files),
      h('h2', { text: 'Commentaires et historique' }),
      h('ol', { class: 'ch-history' }, ...history.map((item) => h('li', {}, h('span', { class: 'ch-hint', text: new Date(item.at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) }), ` ${item.text}`))),
      comment,
      h('div', { class: 'ch-row' },
        button('Commenter', () => {
          const text = comment.value.trim();
          if (text) void this.edit(project.id, guid, (t, author, now) => addComment(t, text, author, now), true);
        }),
        team ? button('Supprimer l’observation', () => {
          if (!window.confirm(`Supprimer l’observation N° ${topic.number} ? Elle disparaît de la liste pour tous les membres.`)) return;
          void this.run(async () => {
            await store.deleteObservation(project.id, guid, await this.author());
            location.hash = `#/p/${project.id}`;
          });
        }, { class: 'ch-danger' }) : null),
    ];
  }

  /** Les photos, réduites une à une (une seule pleine taille en mémoire), puis ajoutées d'un coup. */
  private async addPhotos(projectId: string, guid: string, files: readonly File[]): Promise<void> {
    const documents: Observation['documents'] = [];
    for (const [i, file] of files.entries()) {
      this.toast(`Réduction des photos… ${i + 1} sur ${files.length}`);
      try {
        documents.push({ guid: globalThis.crypto.randomUUID(), filename: `${file.name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`, data: await reducePhoto(file) });
      } catch (error) {
        this.toast(`Photo illisible : ${errorText(error)}`, true);
      }
    }
    if (documents.length > 0) await this.edit(projectId, guid, (t, author, now) => touched(t, { documents: [...t.documents, ...documents] }, author, now), true);
    if (documents.length > 0) this.toast(`${plural(documents.length, 'photo ajoutée', 'photos ajoutées')}.`);
  }

  // ------------------------------------------------------------------ plans

  private async plansScreen(project: ProjectRow): Promise<(Node | null)[]> {
    const { store } = this;
    void store.openProject(project.id);
    const [plans, role] = await Promise.all([store.plans(project.id), store.role(project.id)]);
    const team = role !== 'guest';
    const picker = h('input', { attrs: { type: 'file', accept: 'image/*,application/pdf,.pdf', hidden: '' } });
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (!file) return;
      const name = window.prompt('Nom du plan :', file.name.replace(/\.[^.]+$/, ''))?.trim();
      if (name === undefined) return;
      this.toast('Préparation du plan…');
      void this.run(async () => {
        const plan = await store.addPlan(project.id, name, await planImage(file));
        location.hash = `#/p/${project.id}/plans/${plan.id}`;
      });
    });
    const rows = await Promise.all(plans.map(async (plan) => {
      const blob = await store.file(plan.path);
      return h('div', { class: 'ch-card ch-plan-card' },
        h('a', { attrs: { href: `#/p/${project.id}/plans/${plan.id}` } }, blob ? h('img', { class: 'ch-thumb', attrs: { src: this.url(blob), alt: '' } }) : null, h('strong', { text: plan.name })),
        team ? h('span', { class: 'ch-row' },
          button('Renommer', () => {
            const name = window.prompt('Nouveau nom du plan :', plan.name)?.trim();
            if (name) void this.run(() => store.savePlan({ ...plan, name }, ['name']));
          }),
          button('Retirer', () => {
            if (window.confirm(`Retirer le plan « ${plan.name} » ? Les observations gardent leur repère, sans plan pour l’afficher.`)) void this.run(() => store.savePlan({ ...plan, deleted_at: new Date().toISOString() }, ['deleted_at']));
          }, { class: 'ch-danger' })) : null);
    }));
    return [
      this.tabs(project, 'plans'),
      team ? h('div', { class: 'ch-row ch-actions' }, button('Ajouter un plan (image ou PDF)', () => picker.click(), { class: 'primary' }), picker) : null,
      ...(rows.length > 0 ? rows : [h('p', { class: 'ch-hint', text: 'Aucun plan. Un plan est une image (PNG, JPEG) ou un PDF (première page) : par exemple une feuille imprimée depuis le viewer.' })]),
    ];
  }

  private zoom = 1;

  private async planScreen(project: ProjectRow, planId: string, placing?: string): Promise<(Node | null)[]> {
    const { store } = this;
    const [plans, book, role] = await Promise.all([store.plans(project.id), store.book(project.id), store.role(project.id)]);
    const plan = plans.find((item) => item.id === planId);
    const back = link('‹ Plans', `#/p/${project.id}/plans`, 'ch-back');
    if (!plan) return [back, h('p', { text: 'Plan introuvable.' })];
    const blob = await store.file(plan.path);
    if (!blob) return [back, h('h1', { text: plan.name }), h('p', { class: 'ch-note', text: 'Ce plan n’est pas encore sur cet appareil : il arrive à la prochaine synchronisation.' })];
    const target = placing && placing !== 'nouvelle' ? book.topics.find((topic) => topic.guid === placing) : undefined;
    const board = h('div', { class: 'ch-board', attrs: { style: `width:${this.zoom * 100}%` } }, h('img', { attrs: { src: this.url(blob), alt: plan.name, draggable: 'false' } }));
    for (const topic of book.topics.filter((item) => item.drawingPin?.plan === plan.id)) {
      const pin = h('a', { class: 'ch-pin', text: topic.number > 0 ? String(topic.number) : '•', title: `N° ${topic.number} · ${topic.title || '(sans titre)'} · ${topic.status}`,
        attrs: { href: `#/p/${project.id}/o/${topic.guid}`, style: `left:${topic.drawingPin!.x * 100}%;top:${topic.drawingPin!.y * 100}%;background:${statusColor(topic.status, book.lists)}` } });
      board.append(pin);
    }
    board.addEventListener('click', (event) => {
      if (!placing || (event.target as Element).closest('.ch-pin')) return;
      const rect = board.getBoundingClientRect();
      const pin = { plan: plan.id, x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
      if (placing === 'nouvelle') void this.createObservation(project.id, pin);
      else void this.edit(project.id, placing, (t, author, now) => touched(t, { drawingPin: pin }, author, now)).then(() => { location.hash = `#/p/${project.id}/o/${placing}`; });
    });
    const setZoom = (zoom: number) => {
      this.zoom = Math.min(4, Math.max(1, zoom));
      board.style.width = `${this.zoom * 100}%`;
    };
    const hint = placing === 'nouvelle' ? 'Touchez le plan à l’endroit de la nouvelle observation.'
      : target ? `Touchez le plan à l’endroit de l’observation N° ${target.number} · ${target.title || '(sans titre)'}.`
        : 'Touchez un repère pour ouvrir son observation.';
    return [
      back,
      h('h1', { text: plan.name }),
      h('div', { class: 'ch-row ch-actions' },
        button('−', () => setZoom(this.zoom / 1.5), { title: 'Dézoomer', attrs: { 'aria-label': 'Dézoomer' } }),
        button('+', () => setZoom(this.zoom * 1.5), { title: 'Zoomer', attrs: { 'aria-label': 'Zoomer' } }),
        placing ? link('Annuler', target ? `#/p/${project.id}/o/${target.guid}` : `#/p/${project.id}/plans/${plan.id}`, 'ch-button')
          : role !== 'guest' ? link('Nouvelle observation sur ce plan', `#/p/${project.id}/plans/${plan.id}/placer/nouvelle`, 'ch-button primary') : null),
      h('p', { class: placing ? 'ch-note' : 'ch-hint', text: hint }),
      h('div', { class: placing ? 'ch-plan placing' : 'ch-plan' }, board),
    ];
  }

  // ------------------------------------------------------------------ membres et réglages du projet

  private async membersScreen(project: ProjectRow): Promise<(Node | null)[]> {
    const { store } = this;
    const [members, role] = await Promise.all([store.members(project.id), store.role(project.id)]);
    const admin = role === 'admin';
    const me = store.account?.email;
    const roles = (value: Role) => {
      const element = h('select', { attrs: { 'aria-label': 'Rôle' } }, ...(Object.entries(ROLE_LABELS) as [Role, string][]).map(([key, text]) => h('option', { text, attrs: { value: key } })));
      element.value = value;
      return element;
    };
    const rows = members.map((member) => {
      if (!admin || member.email === me) return h('div', { class: 'ch-card' }, h('strong', { text: member.email + (member.email === me ? ' (vous)' : '') }), h('span', { class: 'ch-hint', text: [ROLE_LABELS[member.role], member.company].filter(Boolean).join(' · ') }));
      const memberRole = roles(member.role);
      const company = input('text', 'Entreprise', member.company, { placeholder: 'Entreprise' });
      const save = () => void this.run(() => store.updateMember({ ...member, role: memberRole.value as Role, company: company.value.trim() }));
      memberRole.addEventListener('change', save);
      company.addEventListener('change', save);
      return h('div', { class: 'ch-card' }, h('strong', { text: member.email }), h('span', { class: 'ch-row' }, memberRole, company,
        button('Retirer', () => { if (window.confirm(`Retirer ${member.email} du projet ?`)) void this.run(() => store.removeMember(member)); }, { class: 'ch-danger' })));
    });
    const nodes: (Node | null)[] = [
      this.tabs(project, 'members'),
      h('p', { class: 'ch-hint', text: 'Administrateur : membres, listes et projet. Éditeur : toutes les observations. Invité : seulement les observations attribuées à lui (son e-mail) ou à son entreprise ; il change leur statut, les commente et y ajoute des photos.' }),
      ...rows,
      !store.account && members.length === 0 ? h('p', { class: 'ch-hint' }, 'Connectez-vous pour partager ce projet : ', link('Compte', '#/compte'), '.') : null,
    ];
    if (!admin) return nodes;

    const email = input('email', 'E-mail', '', { placeholder: 'E-mail', autocomplete: 'off' });
    const newRole = roles('guest');
    const company = input('text', 'Entreprise', '', { placeholder: 'Entreprise' });
    const add = h('form', { class: 'ch-row' }, email, newRole, company, h('button', { class: 'primary', text: 'Ajouter', attrs: { type: 'submit' } }));
    add.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!/^[^@\s]+@[^@\s]+$/.test(email.value.trim())) return this.toast('Adresse e-mail incomplète.', true);
      void this.run(() => store.addMember(project.id, email.value, newRole.value as Role, company.value), `${email.value.trim()} ajouté : il retrouve le projet après s’être inscrit avec cette adresse.`).then(() => this.render());
    });

    const lists = listsOf(project);
    const areas = Object.fromEntries((Object.keys(LIST_LABELS) as (keyof typeof LIST_LABELS)[]).map((name) => {
      const area = h('textarea', { attrs: { rows: '3', 'aria-label': LIST_LABELS[name], spellcheck: 'false' } });
      area.value = lists[name].join('\n');
      return [name, area];
    })) as Record<keyof typeof LIST_LABELS, HTMLTextAreaElement>;
    const saveLists = () => {
      const next: ObservationLists = { ...lists };
      for (const [name, area] of Object.entries(areas)) next[name as keyof typeof LIST_LABELS] = [...new Set(area.value.split('\n').map((line) => line.trim()).filter(Boolean))];
      if (next.statuses.length === 0) next.statuses = lists.statuses;
      void this.run(() => store.saveProject({ ...project, lists: next }, ['lists']), 'Listes enregistrées.');
    };
    const name = input('text', 'Nom du projet', project.name, { maxlength: '200' });
    nodes.push(
      h('h2', { text: 'Ajouter un membre' }), add,
      h('details', {}, h('summary', { text: 'Listes du projet' }), h('p', { class: 'ch-hint', text: 'Une valeur par ligne.' }),
        ...Object.entries(areas).map(([key, area]) => field(LIST_LABELS[key as keyof typeof LIST_LABELS], area)), button('Enregistrer les listes', saveLists, { class: 'primary' })),
      h('details', {}, h('summary', { text: 'Projet' }),
        field('Nom du projet', name), button('Renommer', () => { if (name.value.trim()) void this.run(() => store.saveProject({ ...project, name: name.value.trim() }, ['name']), 'Projet renommé.'); }),
        h('p', { class: 'ch-hint', text: 'Supprimer le projet le retire pour tous ses membres.' }),
        button('Supprimer le projet', () => {
          if (!window.confirm(`Supprimer le projet « ${project.name} » pour tous ses membres ?`)) return;
          void this.run(async () => {
            await store.saveProject({ ...project, deleted_at: new Date().toISOString() }, ['deleted_at']);
            location.hash = '#/';
          });
        }, { class: 'ch-danger' })),
    );
    return nodes;
  }

  // ------------------------------------------------------------------ compte

  private async accountScreen(): Promise<(Node | null)[]> {
    const { store } = this;
    const profile = await store.profile();
    const legal = h('p', { class: 'ch-foot' }, link('Mentions et données personnelles', '#/mentions'));
    const profileForm = () => {
      const name = input('text', 'Nom affiché', profile.name, { autocomplete: 'name', maxlength: '120' });
      const company = input('text', 'Entreprise', profile.company, { autocomplete: 'organization', maxlength: '120' });
      const form = h('form', { class: 'ch-form' }, field('Nom affiché', name, 'Il signe vos observations et vos commentaires.'), field('Entreprise', company), h('button', { class: 'primary', text: 'Enregistrer', attrs: { type: 'submit' } }));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.run(() => store.saveProfile(name.value, company.value), 'Profil enregistré.');
      });
      return form;
    };
    if (!store.backend) return [h('h1', { text: 'Compte' }), h('p', { class: 'ch-note', text: 'Ce site n’est relié à aucun serveur : vos données restent sur cet appareil, sans compte.' }), profileForm(), legal];

    if (store.account) {
      return [
        h('h1', { text: 'Compte' }),
        h('p', { class: 'ch-me' }, h('span', { class: 'ch-avatar big', text: initials(profile.name || store.account.email) }), h('span', { text: store.account.email })),
        profileForm(),
        h('div', { class: 'ch-row' },
          button('Se déconnecter', () => void this.signOut()),
          button('Effacer les données de cet appareil', () => void this.clearDevice())),
        h('h2', { text: 'Supprimer mon compte' }),
        h('p', { class: 'ch-hint', text: 'Vos projets dont vous êtes le seul membre sont supprimés avec leurs photos et leurs plans ; dans les projets partagés, votre nom est retiré de vos observations et commentaires. C’est définitif.' }),
        button('Supprimer mon compte et mes données', () => void this.deleteAccount(), { class: 'ch-danger' }),
        legal,
      ];
    }

    const email = input('email', 'E-mail', '', { autocomplete: 'email', required: '' });
    const password = input('password', 'Mot de passe', '', { autocomplete: 'current-password', required: '' });
    const signIn = h('form', { class: 'ch-form' }, field('E-mail', email), field('Mot de passe', password), h('button', { class: 'primary', text: 'Se connecter', attrs: { type: 'submit' } }));
    signIn.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.run(async () => {
        await store.signIn(email.value, password.value);
        location.hash = '#/';
      }, 'Connecté.');
    });
    const newName = input('text', 'Nom affiché', profile.name, { autocomplete: 'name', required: '', maxlength: '120' });
    const newCompany = input('text', 'Entreprise', profile.company, { autocomplete: 'organization', maxlength: '120' });
    const newEmail = input('email', 'E-mail', '', { autocomplete: 'email', required: '' });
    const newPassword = input('password', 'Mot de passe', '', { autocomplete: 'new-password', required: '', minlength: '8' });
    const signUp = h('form', { class: 'ch-form' }, field('Nom affiché', newName), field('Entreprise', newCompany), field('E-mail', newEmail),
      field('Mot de passe', newPassword, '8 caractères au moins.'), h('button', { class: 'primary', text: 'Créer le compte', attrs: { type: 'submit' } }));
    signUp.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.run(async () => {
        const result = await store.signUp(newEmail.value, newPassword.value, newName.value, newCompany.value);
        if (result.confirmEmail) this.toast(`Un e-mail de confirmation est envoyé à ${newEmail.value.trim()} (s’il n’y a pas déjà un compte à cette adresse). Ouvrez son lien, puis connectez-vous ici.`);
        else {
          this.toast('Compte créé, vous êtes connecté.');
          location.hash = '#/';
        }
      });
    });
    return [
      h('h1', { text: 'Compte' }),
      h('p', { class: 'ch-hint', text: 'Sans compte, vos observations restent sur cet appareil. Avec un compte, elles sont envoyées au serveur du projet : vous les retrouvez ailleurs et vous les partagez avec votre équipe.' }),
      this.options.demo ? h('p', { class: 'ch-note', text: 'Démonstration : le serveur est simulé dans ce navigateur, aucun e-mail n’est envoyé.' }) : null,
      h('h2', { text: 'Se connecter' }), signIn,
      h('h2', { text: 'Créer un compte' }), signUp,
      legal,
    ];
  }

  private async signOut(): Promise<void> {
    const { waiting } = await this.store.pending();
    if (waiting > 0 && !window.confirm(`${plural(waiting, 'modification n’est', 'modifications ne sont')} pas encore envoyée${waiting > 1 ? 's' : ''}. Elle${waiting > 1 ? 's restent' : ' reste'} sur cet appareil et partira${waiting > 1 ? 'ont' : ''} à votre prochaine connexion. Se déconnecter ?`)) return;
    await this.run(() => this.store.signOut(), 'Déconnecté. Vos données restent sur cet appareil.');
    await this.render();
  }

  private async clearDevice(): Promise<void> {
    const { waiting } = await this.store.pending();
    const warning = waiting > 0 ? ` ${plural(waiting, 'modification non envoyée sera perdue', 'modifications non envoyées seront perdues')}.` : ' Ce qui est envoyé reste sur le serveur.';
    if (!window.confirm(`Effacer de cet appareil les projets, observations et photos du suivi de chantier ?${warning}`)) return;
    await this.run(() => this.store.clearDevice(), 'Données de cet appareil effacées.');
    await this.render();
  }

  private async deleteAccount(): Promise<void> {
    if (!window.confirm('Supprimer votre compte ? Vos projets dont vous êtes le seul membre sont supprimés avec leurs photos ; ailleurs, votre nom est retiré de vos observations et commentaires. Cette action est définitive.')) return;
    await this.run(async () => {
      await this.store.deleteAccount();
      location.hash = '#/';
    }, 'Compte supprimé. Les données de cet appareil ont été effacées.');
  }

  // ------------------------------------------------------------------ mentions

  private legalScreen(): Node[] {
    // Modèle de mentions : à relire par un juriste avant le premier client (09b, décision 9).
    const p = (text: string) => h('p', { text });
    return [
      link('‹ Projets', '#/', 'ch-back'),
      h('h1', { text: 'Mentions et données personnelles' }),
      p('Contrairement au viewer, qui n’envoie rien, le suivi de chantier garde des données sur un serveur quand vous êtes connecté : votre nom, votre adresse e-mail, votre entreprise, les observations, commentaires, photos et plans des projets dont vous êtes membre.'),
      p('Sans compte, tout reste sur cet appareil (stockage du navigateur). Sur iPhone, installez la page sur l’écran d’accueil et connectez-vous : le navigateur peut effacer les données d’un site peu utilisé.'),
      p('Hébergement : Supabase, dans l’Union européenne (Paris). Chaque projet appartient à l’entreprise qui le crée : elle est responsable de ses données ; nous les hébergeons et les traitons pour elle.'),
      p('Vos droits : exportez un projet en .bcf ou en PDF depuis sa liste ; supprimez votre compte et vos données dans « Compte » ; pour toute autre demande, adressez-vous à l’administrateur du projet.'),
      p('Les photos de chantier peuvent montrer des personnes : prenez-les avec leur accord, ou évitez les visages.'),
    ];
  }
}
