// Le magasin de l'appareil du suivi de chantier : tout est écrit ici d'abord (IndexedDB, kv.ts), avec la modification à envoyer
// dans la file ; connecté et en ligne, `sync` envoie la file dans l'ordre puis tire ce qui a changé sur le serveur (règles dans
// sync.ts). Sans compte, rien ne part : les données restent sur l'appareil, « non synchronisé ». Les écrans et le viewer lié
// lisent et écrivent ici seulement, jamais le serveur directement.
//
// Un appareil garde les données d'un seul compte : se connecter avec un autre compte efface celles du précédent si tout a été
// envoyé, sinon le refuse (rien n'est perdu ni versé dans le mauvais compte).

import { readBcf } from '../data/bcf.ts';
import { isRecord } from '../data/json.ts';
import { defaultLists, extendLists, fromBcfTopic, mergeBooks, parseObservations, type Observation, type ObservationBook } from '../data/observations.ts';
import { BackendError, cursorColumn, type Account, type BackendPort, type Row, type Table } from './backend/port.ts';
import type { Kv, KvWrite, StoreName } from './kv.ts';
import {
  commentRows, filePath, listsOf, observationOf, rowId, sha256, topicRow, viewpointRows,
  type CommentRow, type EventRow, type MembershipRow, type PhotoRow, type PlanRow, type ProfileRow, type ProjectRow, type Role, type TopicRow, type ViewpointRow,
} from './rows.ts';
import { complete, enqueue, fail, groupFields, mergeRemote, nextCursor, pendingFields, retry, sameJson, serverFields, sinceOf, type QueueEntry } from './sync.ts';

export type SyncPhase = 'idle' | 'syncing' | 'done' | 'offline' | 'auth' | 'error';

export interface SyncState {
  phase: SyncPhase;
  /** Dernière synchronisation complète (ISO). */
  at?: string;
  message?: string;
}

/** Une étape d'écriture : une ligne (créée, modifiée, supprimée) ou un fichier à déposer. */
type Step = { table: Table; row: Row; op: 'insert' | 'update' | 'delete'; changed?: readonly string[] } | { path: string; blob: Blob };

const PROJECT_TABLES: readonly Table[] = ['topics', 'comments', 'viewpoints', 'photos', 'plans', 'events'];
/** Les champs d'une observation comparés pour savoir ce qui a changé. */
const TOPIC_FIELDS = ['type', 'status', 'title', 'priority', 'labels', 'stage', 'assigned_to', 'due_date', 'description', 'extra', 'deleted_at'] as const;

const asError = (error: unknown): BackendError => (error instanceof BackendError ? error : new BackendError('refused', error instanceof Error ? error.message : String(error)));
const live = <T extends Row>(rows: T[]) => rows.filter((row) => !row.deleted_at);
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export class ChantierStore {
  readonly kv: Kv;
  readonly backend: BackendPort | null;
  account: Account | null = null;
  state: SyncState = { phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private running: Promise<void> | null = null;

  constructor(kv: Kv, backend: BackendPort | null) {
    this.kv = kv;
    this.backend = backend;
  }

  /** Le magasin, avec le compte de la session gardée (celui de l'appareil si le réseau manque pour la vérifier). */
  static async open(kv: Kv, backend: BackendPort | null): Promise<ChantierStore> {
    const store = new ChantierStore(kv, backend);
    if (!backend) return store;
    try {
      const account = await backend.account();
      if (account) await store.adopt(account);
    } catch (error) {
      const owner = (await kv.get('meta', 'owner')) as Account | undefined;
      if (asError(error).kind === 'offline' && owner) store.account = owner;
    }
    return store;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setState(state: SyncState): void {
    this.state = state;
    this.notify();
  }

  /** Une écriture à la fois (dans cette page et, avec Web Locks, entre les onglets : le viewer lié écrit dans le même magasin). */
  private locked<T>(task: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks;
    const next = this.chain.then(() => (locks ? (locks.request('suivi-de-chantier', task) as Promise<T>) : task()));
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ------------------------------------------------------------------ lectures

  async rows<T extends Row>(table: Table, projectId?: string): Promise<T[]> {
    const rows = (await this.kv.all(table)) as T[];
    return projectId === undefined ? rows : rows.filter((row) => (table === 'projects' ? row.id : row.project_id) === projectId);
  }

  async queue(): Promise<QueueEntry[]> {
    return ((await this.kv.all('queue')) as QueueEntry[]).sort((a, b) => a.seq - b.seq);
  }

  async projects(): Promise<ProjectRow[]> {
    return live(await this.rows<ProjectRow>('projects')).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  async project(id: string): Promise<ProjectRow | undefined> {
    const project = (await this.kv.get('projects', id)) as ProjectRow | undefined;
    return project && !project.deleted_at ? project : undefined;
  }

  async members(projectId: string): Promise<MembershipRow[]> {
    return (await this.rows<MembershipRow>('memberships', projectId)).sort((a, b) => a.email.localeCompare(b.email));
  }

  /** Mon rôle dans ce projet ; administrateur d'un projet créé ici et pas encore envoyé (ou sans compte). */
  async role(projectId: string): Promise<Role> {
    const email = this.account?.email;
    const mine = email ? (await this.members(projectId)).find((row) => row.email === email) : undefined;
    return mine?.role ?? 'admin';
  }

  async profile(): Promise<{ name: string; company: string }> {
    const row = this.account ? ((await this.kv.get('profiles', this.account.userId)) as ProfileRow | undefined) : undefined;
    const local = ((await this.kv.get('meta', 'profile')) as { name: string; company: string } | undefined) ?? { name: '', company: '' };
    return row ? { name: row.display_name || local.name, company: row.company || local.company } : local;
  }

  async file(path: string): Promise<Blob | undefined> {
    return (await this.kv.get('files', path)) as Blob | undefined;
  }

  /** Les observations du projet (sans les supprimées), avec photos et images présentes sur l'appareil. */
  async book(projectId: string): Promise<ObservationBook> {
    const [project, topics, comments, viewpoints, photos] = await Promise.all([
      this.kv.get('projects', projectId) as Promise<ProjectRow | undefined>, this.rows<TopicRow>('topics', projectId), this.rows<CommentRow>('comments', projectId),
      this.rows<ViewpointRow>('viewpoints', projectId), this.rows<PhotoRow>('photos', projectId),
    ]);
    const files = new Map<string, Blob>();
    for (const photo of live(photos)) {
      const blob = await this.file(photo.path);
      if (blob) files.set(photo.path, blob);
    }
    const by = <T extends { topic_id: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows) map.set(row.topic_id, [...(map.get(row.topic_id) ?? []), row]);
      return map;
    };
    const [c, v, p] = [by(comments), by(viewpoints), by(photos)];
    const list = live(topics).flatMap((topic) => observationOf(topic, c.get(topic.id) ?? [], v.get(topic.id) ?? [], p.get(topic.id) ?? [], (path) => files.get(path)) ?? []);
    return { settings: {}, lists: listsOf(project), topics: list.sort((a, b) => a.number - b.number) };
  }

  async events(topicId: string): Promise<EventRow[]> {
    return ((await this.kv.all('events')) as EventRow[]).filter((row) => row.topic_id === topicId).sort((a, b) => a.at.localeCompare(b.at));
  }

  async plans(projectId: string): Promise<PlanRow[]> {
    return live(await this.rows<PlanRow>('plans', projectId)).sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  }

  /** Ce qui attend d'être envoyé, et ce que le serveur a refusé. */
  async pending(): Promise<{ waiting: number; refused: QueueEntry[] }> {
    const queue = await this.queue();
    return { waiting: queue.filter((entry) => !entry.error).length, refused: queue.filter((entry) => entry.error) };
  }

  // ------------------------------------------------------------------ écritures (appareil d'abord, puis file)

  private async writeQueue(before: readonly QueueEntry[], after: readonly QueueEntry[], writes: KvWrite[] = []): Promise<void> {
    const kept = new Set(after.map((entry) => entry.seq));
    await this.kv.write([
      ...writes,
      ...before.filter((entry) => !kept.has(entry.seq)).map((entry): KvWrite => ({ store: 'queue', key: entry.seq })),
      ...after.map((entry): KvWrite => ({ store: 'queue', key: entry.seq, value: entry })),
    ]);
  }

  private apply(steps: readonly Step[]): Promise<void> {
    return this.locked(async () => {
      const before = await this.queue();
      let queue = before;
      const writes: KvWrite[] = [];
      for (const step of steps) {
        if ('path' in step) {
          writes.push({ store: 'files', key: step.path, value: step.blob });
          queue = enqueue(queue, { table: 'photos', id: step.path, op: 'upload', fields: {}, path: step.path });
          continue;
        }
        const { table, row, op } = step;
        writes.push({ store: table as StoreName, key: row.id, value: op === 'delete' ? undefined : row });
        const fields = op === 'insert' ? serverFields(row) : op === 'update' ? groupFields(table, row, step.changed ?? []) : {};
        if (op !== 'update' || Object.keys(fields).length > 0) queue = enqueue(queue, { table, id: row.id, op, fields });
      }
      await this.writeQueue(before, queue, writes);
    }).then(() => {
      this.notify();
      this.scheduleSync();
    });
  }

  /** Vrai (les pages) : une synchronisation part peu après chaque écriture. */
  autoSync = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Une synchronisation peu après une écriture (plusieurs écritures rapprochées n'en font qu'une). */
  private scheduleSync(): void {
    if (!this.autoSync || !this.backend || !this.account) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync(), 1500);
  }

  async createProject(name: string): Promise<ProjectRow> {
    const project: ProjectRow = { id: globalThis.crypto.randomUUID(), organisation_id: null, name: name.trim(), lists: defaultLists(), deleted_at: null };
    await this.apply([{ table: 'projects', row: project, op: 'insert' }]);
    return project;
  }

  async saveProject(project: ProjectRow, changed: readonly string[]): Promise<void> {
    await this.apply([{ table: 'projects', row: project, op: 'update', changed }]);
  }

  async addMember(projectId: string, email: string, role: Role, company: string): Promise<void> {
    const row: MembershipRow = { id: globalThis.crypto.randomUUID(), project_id: projectId, email: email.trim().toLowerCase(), role, company: company.trim() };
    await this.apply([{ table: 'memberships', row, op: 'insert' }]);
  }

  async updateMember(row: MembershipRow): Promise<void> {
    await this.apply([{ table: 'memberships', row, op: 'update', changed: ['role', 'company'] }]);
  }

  async removeMember(row: MembershipRow): Promise<void> {
    await this.apply([{ table: 'memberships', row, op: 'delete' }]);
  }

  async saveProfile(name: string, company: string): Promise<void> {
    const profile = { name: name.trim(), company: company.trim() };
    await this.kv.write([{ store: 'meta', key: 'profile', value: profile }]);
    if (this.account) await this.apply([{ table: 'profiles', row: { id: this.account.userId, display_name: profile.name, company: profile.company }, op: 'update', changed: ['display_name', 'company'] }]);
    else this.notify();
  }

  /** La ligne et le dépôt d'une photo (contenu JPEG, PNG ou WebP déjà réduit). */
  private async photoSteps(projectId: string, topicId: string, id: string, filename: string, blob: Blob, viewpointId: string | null): Promise<Step[]> {
    const hash = await sha256(blob);
    const mime = ['image/png', 'image/webp'].includes(blob.type) ? blob.type : 'image/jpeg';
    const path = filePath(projectId, topicId, hash, mime);
    const row: PhotoRow = { id, project_id: projectId, topic_id: topicId, viewpoint_id: viewpointId, filename, path, mime, size: blob.size, sha256: hash, deleted_at: null };
    return [{ path, blob }, { table: 'photos', row, op: 'insert' }];
  }

  /**
   * Enregistre une observation du projet : sa ligne (créée, ou les seuls champs changés), ses nouveaux commentaires, points de
   * vue et photos ; une photo retirée est marquée supprimée. Rien ne part si rien n'a changé.
   */
  async saveObservation(projectId: string, observation: Observation): Promise<void> {
    const [stored, comments, viewpoints, photos] = await Promise.all([
      this.kv.get('topics', observation.guid) as Promise<TopicRow | undefined>, this.rows<CommentRow>('comments', projectId),
      this.rows<ViewpointRow>('viewpoints', projectId), this.rows<PhotoRow>('photos', projectId),
    ]);
    if (stored && stored.project_id !== projectId) throw new Error('Cette observation appartient à un autre projet.');
    const row = { ...topicRow(observation, projectId), _modified: observation.modifiedDate };
    const steps: Step[] = [];
    if (!stored) steps.push({ table: 'topics', row, op: 'insert' });
    else {
      const changed = TOPIC_FIELDS.filter((name) => !sameJson(stored[name], row[name]));
      if (changed.length > 0) steps.push({ table: 'topics', row: { ...stored, ...Object.fromEntries(changed.map((name) => [name, row[name]])), modified_author: row.modified_author, _modified: row._modified }, op: 'update', changed });
    }
    const known = new Set([...comments, ...viewpoints, ...photos].map((item) => item.id));
    for (const comment of commentRows(observation, projectId)) if (!known.has(comment.id)) steps.push({ table: 'comments', row: comment, op: 'insert' });
    for (const [i, viewpoint] of viewpointRows(observation, projectId).entries()) {
      if (known.has(viewpoint.id)) continue;
      steps.push({ table: 'viewpoints', row: viewpoint, op: 'insert' });
      const snapshot = observation.viewpoints[i].snapshot;
      if (snapshot) steps.push(...await this.photoSteps(projectId, observation.guid, globalThis.crypto.randomUUID(), 'vue.png', snapshot, viewpoint.id));
    }
    for (const document of observation.documents) {
      if (!known.has(document.guid) && document.data) steps.push(...await this.photoSteps(projectId, observation.guid, document.guid, document.filename, document.data, null));
    }
    const kept = new Set(observation.documents.map((document) => document.guid));
    for (const photo of photos) {
      if (photo.topic_id === observation.guid && !photo.viewpoint_id && !photo.deleted_at && !kept.has(photo.id)) steps.push({ table: 'photos', row: { ...photo, deleted_at: new Date().toISOString() }, op: 'update', changed: ['deleted_at'] });
    }
    if (steps.length > 0) await this.apply(steps);
  }

  async deleteObservation(projectId: string, id: string, author: string): Promise<void> {
    const stored = (await this.kv.get('topics', id)) as TopicRow | undefined;
    if (!stored || stored.project_id !== projectId) return;
    await this.apply([{ table: 'topics', row: { ...stored, deleted_at: new Date().toISOString(), modified_author: author }, op: 'update', changed: ['deleted_at'] }]);
  }

  async addPlan(projectId: string, name: string, image: { blob: Blob; width: number; height: number }): Promise<PlanRow> {
    const hash = await sha256(image.blob);
    const mime = ['image/png', 'image/webp'].includes(image.blob.type) ? image.blob.type : 'image/jpeg';
    const path = filePath(projectId, 'plans', hash, mime);
    const row: PlanRow = { id: globalThis.crypto.randomUUID(), project_id: projectId, name: name.trim() || 'Plan', path, mime, size: image.blob.size, sha256: hash, width: image.width, height: image.height, deleted_at: null };
    await this.apply([{ path, blob: image.blob }, { table: 'plans', row, op: 'insert' }]);
    return row;
  }

  async savePlan(plan: PlanRow, changed: readonly string[]): Promise<void> {
    await this.apply([{ table: 'plans', row: plan, op: 'update', changed }]);
  }

  /**
   * Importe un JSON d'observations (section `observations` d'un JSON du viewer, ou la section seule) ou un .bcf dans le projet :
   * réunies par GUID comme dans le viewer (docs/contrat-observations.md § 3), les listes complétées.
   */
  async importFile(projectId: string, file: File): Promise<{ added: number; updated: number; notes: string[] }> {
    const project = await this.project(projectId);
    if (!project) throw new Error('Projet introuvable.');
    let incoming: ObservationBook;
    const notes: string[] = [];
    if (/\.json$/i.test(file.name)) {
      const raw: unknown = JSON.parse(await file.text());
      const book = parseObservations(isRecord(raw) && 'observations' in raw ? raw.observations : raw);
      if (!book) throw new Error('Ce JSON n’a pas de section « observations ».');
      incoming = book;
      if (book.topics.some((topic) => topic.documents.length > 0)) notes.push('Les photos ne sont pas dans le JSON : importez aussi le .bcf exporté du viewer.');
    } else {
      const read = await readBcf(file);
      notes.push(...read.notes);
      const ext = read.extensions;
      incoming = {
        settings: {}, topics: read.topics.map((topic) => fromBcfTopic(topic, 0)),
        lists: { kinds: ext.topicTypes, statuses: ext.topicStatuses, done: [], trades: ext.topicLabels, priorities: ext.priorities, phases: ext.stages, companies: [], transitions: {} },
      };
    }
    // Les identifiants deviennent ceux qu'accepte la base (GUID en minuscules).
    incoming.topics = incoming.topics.map((topic) => ({
      ...topic, guid: rowId(topic.guid),
      comments: topic.comments.map((comment) => ({ ...comment, guid: rowId(comment.guid), viewpoint: comment.viewpoint?.toLowerCase() })),
      viewpoints: topic.viewpoints.map((viewpoint) => ({ ...viewpoint, guid: rowId(viewpoint.guid) })),
      documents: topic.documents.map((document) => ({ ...document, guid: rowId(document.guid) })),
    }));
    const { book, added, updated } = mergeBooks(await this.book(projectId), incoming);
    for (const topic of book.topics) await this.saveObservation(projectId, topic);
    const lists = extendLists(book.lists, book.topics);
    if (JSON.stringify(lists) !== JSON.stringify(listsOf(project))) await this.saveProject({ ...project, lists }, ['lists']);
    return { added, updated, notes };
  }

  // ------------------------------------------------------------------ comptes

  /** Rattache les données de l'appareil à ce compte (voir l'en-tête). */
  private async adopt(account: Account): Promise<void> {
    const owner = (await this.kv.get('meta', 'owner')) as Account | undefined;
    if (owner && owner.userId !== account.userId) {
      const waiting = (await this.queue()).length;
      if (waiting > 0) {
        await this.backend?.signOut().catch(() => undefined);
        throw new Error(`Cet appareil garde ${plural(waiting, 'modification non envoyée', 'modifications non envoyées')} du compte ${owner.email}. Connectez-vous avec ce compte pour les envoyer, ou effacez les données de cet appareil.`);
      }
      const profile = await this.kv.get('meta', 'profile');
      await this.kv.clear();
      if (profile) await this.kv.write([{ store: 'meta', key: 'profile', value: profile }]);
    }
    await this.kv.write([{ store: 'meta', key: 'owner', value: account }]);
    this.account = account;
  }

  async signUp(email: string, password: string, name: string, company: string): Promise<{ confirmEmail: boolean }> {
    if (!this.backend) throw new Error('Ce site n’est relié à aucun serveur.');
    await this.kv.write([{ store: 'meta', key: 'profile', value: { name: name.trim(), company: company.trim() } }]);
    const result = await this.backend.signUp(email.trim(), password, name.trim());
    if (!result.confirmEmail) await this.signIn(email, password);
    return result;
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.backend) throw new Error('Ce site n’est relié à aucun serveur.');
    await this.adopt(await this.backend.signIn(email.trim(), password));
    this.notify();
    await this.sync();
    // Le nom et l'entreprise tapés à l'inscription rejoignent le profil du serveur s'il est vide.
    const local = (await this.kv.get('meta', 'profile')) as { name: string; company: string } | undefined;
    const row = this.account ? ((await this.kv.get('profiles', this.account.userId)) as ProfileRow | undefined) : undefined;
    if (local && row && ((!row.display_name && local.name) || (!row.company && local.company))) {
      await this.saveProfile(row.display_name || local.name, row.company || local.company);
      await this.sync();
    }
  }

  /** Se déconnecter : les données restent sur l'appareil (et partiront à la prochaine connexion de ce compte). */
  async signOut(): Promise<void> {
    await this.backend?.signOut();
    this.account = null;
    this.setState({ phase: 'idle' });
  }

  /** Efface tout ce que l'appareil garde du suivi de chantier (le compte, lui, reste sur le serveur). */
  async clearDevice(): Promise<void> {
    await this.locked(() => this.kv.clear());
    if (this.account) await this.kv.write([{ store: 'meta', key: 'owner', value: this.account }]);
    this.notify();
  }

  /**
   * Supprime le compte et ses données personnelles sur le serveur (fichiers des projets dont il est le seul membre d'abord),
   * puis efface l'appareil. Refusé localement s'il est le seul administrateur d'un projet partagé (le serveur le refuserait).
   */
  async deleteAccount(): Promise<void> {
    const backend = this.backend, account = this.account;
    if (!backend || !account) throw new Error('Connectez-vous d’abord.');
    const memberships = await this.rows<MembershipRow>('memberships');
    const byProject = new Map<string, MembershipRow[]>();
    for (const row of memberships) byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
    const alone: string[] = [];
    for (const [projectId, rows] of byProject) {
      const others = rows.filter((row) => row.email !== account.email);
      const mine = rows.find((row) => row.email === account.email);
      if (mine?.role === 'admin' && others.length > 0 && !others.some((row) => row.role === 'admin')) {
        const project = await this.project(projectId);
        throw new Error(`Vous êtes le seul administrateur du projet « ${project?.name ?? projectId} », partagé avec d’autres : nommez d’abord un autre administrateur.`);
      }
      if (mine && others.length === 0) alone.push(projectId);
    }
    // shortcut: fichiers retirés avant la suppression du compte ; si elle échoue ensuite (réseau), ils manquent à des projets restés. À revoir avec une fonction serveur qui supprime aussi les fichiers.
    const files = [...await this.rows<PhotoRow>('photos'), ...await this.rows<PlanRow>('plans')].filter((row) => alone.includes(row.project_id)).map((row) => row.path);
    if (files.length > 0) await backend.remove([...new Set(files)]);
    await backend.deleteAccount();
    await this.locked(() => this.kv.clear());
    this.account = null;
    this.setState({ phase: 'idle' });
  }

  // ------------------------------------------------------------------ synchronisation

  /** Envoie la file puis tire les changements ; une seule à la fois. Sans compte ou sans serveur : rien. */
  sync(): Promise<void> {
    if (!this.backend || !this.account) return Promise.resolve();
    this.running ??= this.syncNow().finally(() => { this.running = null; });
    return this.running;
  }

  /** Les envois refusés repartent. */
  async retry(): Promise<void> {
    await this.locked(async () => {
      const before = await this.queue();
      await this.writeQueue(before, retry(before));
    });
    await this.sync();
  }

  private async syncNow(): Promise<void> {
    const backend = this.backend!;
    this.setState({ ...this.state, phase: 'syncing' });
    try {
      const stopped = await this.pushAll(backend);
      if (stopped) throw stopped;
      await this.pullAll(backend);
      await this.fetchFiles(backend);
      this.setState({ phase: 'done', at: new Date().toISOString() });
    } catch (error) {
      const failure = asError(error);
      this.setState({ ...this.state, phase: failure.kind === 'offline' ? 'offline' : failure.kind === 'auth' ? 'auth' : 'error', message: failure.message });
    }
  }

  /** L'organisation où créer les projets de ce compte : la sienne (créée à l'inscription), sinon une nouvelle. */
  private async organisationId(backend: BackendPort): Promise<string> {
    const userId = this.account!.userId;
    const mine = (rows: Row[]) => rows.find((row) => row.created_by === userId)?.id;
    const local = mine(await this.rows('organisations'));
    if (local) return local;
    const pulled = await backend.pull('organisations', {});
    const found = mine(pulled);
    if (found) {
      await this.kv.write(pulled.map((row) => ({ store: 'organisations' as const, key: row.id, value: row })));
      return found;
    }
    const id = globalThis.crypto.randomUUID();
    await backend.push({ table: 'organisations', id, op: 'insert', fields: { id, name: 'Personnel' } });
    await this.kv.write([{ store: 'organisations', key: id, value: { id, name: 'Personnel', created_by: userId } }]);
    return id;
  }

  /** Envoie la file dans l'ordre ; rend l'erreur qui l'arrête (réseau, session), null si tout est parti ou marqué refusé. */
  private async pushAll(backend: BackendPort): Promise<BackendError | null> {
    for (;;) {
      const entry = (await this.queue()).find((item) => !item.error);
      if (!entry) return null;
      try {
        if (entry.op === 'upload') {
          const blob = await this.file(entry.path!);
          if (!blob) throw new BackendError('refused', 'Fichier absent de cet appareil.');
          await backend.upload(entry.path!, blob);
        } else {
          const fields = serverFields(entry.fields);
          if (entry.table === 'projects' && entry.op === 'insert' && !fields.organisation_id) fields.organisation_id = await this.organisationId(backend);
          await backend.push({ table: entry.table, id: entry.id, op: entry.op, fields });
        }
        await this.locked(async () => {
          const before = await this.queue();
          await this.writeQueue(before, complete(before, entry));
        });
      } catch (error) {
        const failure = asError(error);
        let stop = false;
        await this.locked(async () => {
          const before = await this.queue();
          const result = fail(before, entry, failure);
          stop = result.stop;
          await this.writeQueue(before, result.queue);
        });
        if (stop) return failure;
      }
      this.notify();
    }
  }

  /** Fusionne des lignes du serveur ; `replace` : la table du projet est relue entière (ce qui manque a été retiré). */
  private async merge(table: Table, remote: readonly Row[], replace?: { projectId: string }): Promise<void> {
    await this.locked(async () => {
      const queue = await this.queue();
      const writes: KvWrite[] = [];
      for (const row of remote) {
        const local = (await this.kv.get(table, row.id)) as Row | undefined;
        writes.push({ store: table, key: row.id, value: mergeRemote(local, row, pendingFields(queue, table, row.id)) });
      }
      if (replace) {
        const ids = new Set(remote.map((row) => row.id));
        for (const row of await this.rows(table, replace.projectId)) {
          if (!ids.has(row.id) && pendingFields(queue, table, row.id) !== 'all') writes.push({ store: table, key: row.id });
        }
      }
      await this.kv.write(writes);
    });
  }

  private async pullAll(backend: BackendPort): Promise<void> {
    const userId = this.account!.userId;
    await this.merge('profiles', (await backend.pull('profiles', {})).filter((row) => row.id === userId));
    await this.merge('organisations', await backend.pull('organisations', {}));
    const projects = await backend.pull('projects', {});
    await this.merge('projects', projects);
    // Un projet déjà reçu que le serveur ne montre plus (retiré du projet) reste sur l'appareil, marqué.
    const seen = new Set(projects.map((row) => row.id));
    await this.locked(async () => {
      const queue = await this.queue();
      const lost = (await this.rows<ProjectRow>('projects')).filter((row) => !seen.has(row.id) && row.created_at && !row._lost && pendingFields(queue, 'projects', row.id) !== 'all');
      await this.kv.write(lost.map((row) => ({ store: 'projects', key: row.id, value: { ...row, _lost: true } })));
    });
    for (const project of projects) {
      await this.merge('memberships', await backend.pull('memberships', { projectId: project.id }), { projectId: project.id });
      for (const table of PROJECT_TABLES) {
        const key = `cursor:${table}:${project.id}`;
        const cursor = (await this.kv.get('meta', key)) as string | undefined;
        const rows = await backend.pull(table, { projectId: project.id, since: sinceOf(cursor) });
        await this.merge(table, rows);
        const next = nextCursor(rows, cursorColumn(table), cursor);
        if (next !== cursor) await this.kv.write([{ store: 'meta', key, value: next }]);
      }
      this.notify();
    }
  }

  /** Projets ouverts sur cet appareil : leurs photos et plans y sont gardés pour travailler hors ligne. */
  async openProject(projectId: string): Promise<void> {
    const opened = ((await this.kv.get('meta', 'opened')) as string[] | undefined) ?? [];
    if (opened.includes(projectId)) return;
    await this.kv.write([{ store: 'meta', key: 'opened', value: [...opened, projectId] }]);
    void this.sync();
  }

  private async fetchFiles(backend: BackendPort): Promise<void> {
    const opened = new Set(((await this.kv.get('meta', 'opened')) as string[] | undefined) ?? []);
    const rows = [...live(await this.rows<PhotoRow>('photos')), ...live(await this.rows<PlanRow>('plans'))].filter((row) => opened.has(row.project_id));
    let fetched = 0;
    for (const path of new Set(rows.map((row) => row.path))) {
      if (await this.file(path)) continue;
      try {
        await this.kv.write([{ store: 'files', key: path, value: await backend.download(path) }]);
        fetched++;
      } catch (error) {
        if (asError(error).kind !== 'refused') throw error;
      }
    }
    if (fetched > 0) this.notify();
  }
}
