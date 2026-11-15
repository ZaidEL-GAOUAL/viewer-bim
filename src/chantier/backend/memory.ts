// Le serveur du suivi de chantier en mémoire : pour les tests et la démonstration (`chantier.html?demo=1`, en développement).
// Il suit les règles de la migration supabase/migrations/…_suivi_de_chantier.sql d'aussi près que la mémoire le permet : un
// membre ne voit que ses projets, un invité que ce qui est attribué à lui ou à son entreprise et n'en change que le statut,
// dates et numéros posés par le serveur, historique écrit à chaque création ou modification d'une observation. `offline`
// simule la coupure du réseau. Chaque instance est une connexion (un appareil) avec sa propre session ; `connect()` en ouvre une
// autre sur les mêmes données. `persist` (démonstration) garde l'état entre deux chargements de la page, `resume` la session.

import { BackendError, cursorColumn, type Account, type BackendPort, type Change, type Row, type Table } from './port.ts';

interface User {
  id: string;
  email: string;
  password: string;
  confirmed: boolean;
}

export interface MemoryState {
  users: User[];
  tables: Record<Table, Row[]>;
  files: Record<string, Blob>;
  session: string | null;
  clock: number;
}

const TABLES: readonly Table[] = ['profiles', 'organisations', 'projects', 'memberships', 'topics', 'comments', 'viewpoints', 'photos', 'plans', 'events'];
const UPDATABLE: Readonly<Partial<Record<Table, readonly string[]>>> = {
  profiles: ['display_name', 'company'], organisations: ['name'], projects: ['name', 'lists', 'deleted_at'], memberships: ['role', 'company'],
  topics: ['type', 'status', 'title', 'priority', 'labels', 'stage', 'assigned_to', 'due_date', 'description', 'modified_author', 'extra', 'deleted_at'],
  photos: ['deleted_at'], plans: ['name', 'deleted_at'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const emptyMemoryState = (): MemoryState => ({ users: [], tables: Object.fromEntries(TABLES.map((table) => [table, []])) as unknown as Record<Table, Row[]>, files: {}, session: null, clock: 0 });

const refuse = (message: string): never => { throw new BackendError('refused', message); };

interface Network {
  offline: boolean;
  /** Modifications reçues (dans l'ordre), pour les tests. */
  received: Change[];
}

export class MemoryBackend implements BackendPort {
  readonly state: MemoryState;
  private readonly persist?: (state: MemoryState) => Promise<void>;
  private readonly net: Network;
  private session: string | null;
  /** Vrai : un compte créé attend la confirmation de son adresse (`confirm(email)`). */
  confirmEmails = false;

  constructor(state: MemoryState = emptyMemoryState(), options: { persist?: (state: MemoryState) => Promise<void>; resume?: boolean } = {}, net: Network = { offline: false, received: [] }) {
    this.state = state;
    this.persist = options.persist;
    this.net = net;
    this.session = options.resume ? state.session : null;
  }

  /** Une autre connexion au même serveur (un autre appareil) : mêmes données, même réseau, sa propre session. */
  connect(): MemoryBackend {
    return new MemoryBackend(this.state, { persist: this.persist }, this.net);
  }

  get offline(): boolean {
    return this.net.offline;
  }

  set offline(value: boolean) {
    this.net.offline = value;
  }

  get received(): readonly Change[] {
    return this.net.received;
  }

  // ------------------------------------------------------------------ outils

  private online(): void {
    if (this.offline) throw new BackendError('offline', 'Pas de réseau.');
  }

  private me(): User {
    this.online();
    const user = this.state.users.find((item) => item.id === this.session);
    if (!user) throw new BackendError('auth', 'Connectez-vous.');
    return user;
  }

  private now(): string {
    this.state.clock = Math.max(Date.now(), this.state.clock + 1);
    return new Date(this.state.clock).toISOString();
  }

  private rows(table: Table): Row[] {
    return this.state.tables[table];
  }

  private save(): Promise<void> {
    return this.persist?.(this.state) ?? Promise.resolve();
  }

  private role(user: User | undefined, projectId: unknown): string | undefined {
    if (!user?.confirmed) return undefined;
    return this.rows('memberships').find((row) => row.project_id === projectId && row.email === user.email)?.role as string | undefined;
  }

  private sees(user: User, topic: Row | undefined): boolean {
    if (!topic) return false;
    const membership = user.confirmed ? this.rows('memberships').find((row) => row.project_id === topic.project_id && row.email === user.email) : undefined;
    if (!membership) return false;
    if (membership.role !== 'guest') return true;
    const assigned = typeof topic.assigned_to === 'string' ? topic.assigned_to.toLowerCase() : '';
    return assigned !== '' && (assigned === membership.email || (membership.company !== '' && assigned === String(membership.company).toLowerCase()));
  }

  private topic(id: unknown): Row | undefined {
    return this.rows('topics').find((row) => row.id === id);
  }

  private visible(user: User, table: Table, row: Row): boolean {
    switch (table) {
      case 'profiles': return row.id === user.id;
      case 'organisations': return row.created_by === user.id || this.rows('projects').some((project) => project.organisation_id === row.id && this.role(user, project.id));
      case 'projects': return this.role(user, row.id) !== undefined;
      case 'memberships': return (user.confirmed && row.email === user.email) || ['admin', 'editor'].includes(this.role(user, row.project_id) ?? '');
      case 'topics': return this.sees(user, row);
      case 'plans': return this.role(user, row.project_id) !== undefined;
      default: return this.sees(user, this.topic(row.topic_id));
    }
  }

  private canInsert(user: User, table: Table, row: Row): boolean {
    const role = this.role(user, row.project_id);
    const team = role === 'admin' || role === 'editor';
    const topic = this.topic(row.topic_id);
    switch (table) {
      case 'organisations': return true;
      case 'projects': return this.rows('organisations').some((org) => org.id === row.organisation_id && org.created_by === user.id) && user.confirmed;
      case 'memberships': return role === 'admin';
      case 'topics': case 'viewpoints': case 'plans': return team && (table !== 'viewpoints' || topic?.project_id === row.project_id);
      case 'comments': case 'photos': return topic?.project_id === row.project_id && this.sees(user, topic);
      default: return false;
    }
  }

  private canUpdate(user: User, table: Table, row: Row, fields: Record<string, unknown>): boolean {
    const role = this.role(user, row.project_id);
    switch (table) {
      case 'profiles': return row.id === user.id;
      case 'organisations': return row.created_by === user.id;
      case 'projects': return this.role(user, row.id) === 'admin';
      case 'memberships': return role === 'admin' && row.email !== user.email;
      case 'topics': return this.sees(user, row) && (role !== 'guest' || Object.keys(fields).every((name) => name === 'status' || name === 'modified_author'));
      case 'photos': case 'plans': return role === 'admin' || role === 'editor';
      default: return false;
    }
  }

  private event(user: User, topic: Row, action: 'insert' | 'update', fields: string[] | null): void {
    const name = this.rows('profiles').find((row) => row.id === user.id)?.display_name;
    this.rows('events').push({ id: globalThis.crypto.randomUUID(), project_id: topic.project_id, topic_id: topic.id, actor: user.id, actor_name: typeof name === 'string' ? name : '', action, fields, at: this.now() });
  }

  private canUseFile(user: User, path: string, write: boolean): boolean {
    const [project, folder, name, ...rest] = path.split('/');
    if (!project || !folder || !name || rest.length > 0 || !UUID.test(project)) return false;
    const role = this.role(user, project);
    if (folder === 'plans') return write ? role === 'admin' || role === 'editor' : role !== undefined;
    const topic = this.topic(folder);
    return topic?.project_id === project && this.sees(user, topic);
  }

  /** Une copie (le serveur ne partage pas ses objets avec l'appelant). */
  private copy(row: Row): Row {
    return structuredClone(row);
  }

  // ------------------------------------------------------------------ comptes

  async account(): Promise<Account | null> {
    const user = this.state.users.find((item) => item.id === this.session);
    return user ? { userId: user.id, email: user.email } : null;
  }

  async signUp(email: string, password: string, displayName: string): Promise<{ confirmEmail: boolean }> {
    this.online();
    const address = email.trim().toLowerCase();
    if (this.state.users.some((user) => user.email === address)) refuse('Un compte existe déjà avec cette adresse.');
    if (password.length < 8) refuse('Mot de passe trop court (8 caractères au moins).');
    const user: User = { id: globalThis.crypto.randomUUID(), email: address, password, confirmed: !this.confirmEmails };
    this.state.users.push(user);
    const now = this.now();
    this.rows('profiles').push({ id: user.id, display_name: displayName.slice(0, 120), company: '', created_at: now, updated_at: now });
    this.rows('organisations').push({ id: globalThis.crypto.randomUUID(), name: 'Personnel', created_by: user.id, created_at: now, updated_at: now });
    await this.save();
    return { confirmEmail: !user.confirmed };
  }

  /** Confirme l'adresse d'un compte (le lien de l'e-mail). */
  confirm(email: string): void {
    const user = this.state.users.find((item) => item.email === email.toLowerCase());
    if (user) user.confirmed = true;
  }

  async signIn(email: string, password: string): Promise<Account> {
    this.online();
    const user = this.state.users.find((item) => item.email === email.trim().toLowerCase() && item.password === password);
    if (!user) throw new BackendError('auth', 'E-mail ou mot de passe incorrect.');
    if (!user.confirmed) throw new BackendError('auth', 'Adresse e-mail pas encore confirmée : ouvrez le lien reçu par e-mail.');
    this.session = this.state.session = user.id;
    await this.save();
    return { userId: user.id, email: user.email };
  }

  async signOut(): Promise<void> {
    this.session = this.state.session = null;
    await this.save();
  }

  async deleteAccount(): Promise<void> {
    const user = this.me();
    const mine = this.rows('memberships').filter((row) => row.email === user.email);
    const others = (project: unknown) => this.rows('memberships').filter((row) => row.project_id === project && row.email !== user.email);
    if (mine.some((row) => row.role === 'admin' && others(row.project_id).length > 0 && !others(row.project_id).some((other) => other.role === 'admin'))) {
      refuse('Vous êtes le seul administrateur d’un projet partagé : nommez d’abord un autre administrateur.');
    }
    const gone = new Set(mine.filter((row) => others(row.project_id).length === 0).map((row) => row.project_id));
    for (const table of TABLES) {
      this.state.tables[table] = this.rows(table).filter((row) => !gone.has(table === 'projects' ? row.id : row.project_id) && !(table === 'memberships' && row.email === user.email) && !(table === 'profiles' && row.id === user.id));
    }
    for (const row of this.rows('topics')) if (row.created_by === user.id) row.creation_author = 'Compte supprimé';
    for (const row of this.rows('comments')) if (row.created_by === user.id) row.author = 'Compte supprimé';
    for (const row of this.rows('events')) if (row.actor === user.id) row.actor_name = 'Compte supprimé';
    this.state.users = this.state.users.filter((item) => item.id !== user.id);
    this.session = this.state.session = null;
    await this.save();
  }

  // ------------------------------------------------------------------ lignes

  async pull(table: Table, filter: { projectId?: string; since?: string }): Promise<Row[]> {
    const user = this.me();
    const column = cursorColumn(table);
    const since = filter.since ? Date.parse(filter.since) : -Infinity;
    return this.rows(table)
      .filter((row) => (!filter.projectId || (table === 'projects' ? row.id : row.project_id) === filter.projectId) && Date.parse(String(row[column])) >= since && this.visible(user, table, row))
      .sort((a, b) => Date.parse(String(a[column])) - Date.parse(String(b[column])))
      .map((row) => this.copy(row));
  }

  async push(change: Change): Promise<void> {
    const user = this.me();
    this.net.received.push(structuredClone(change));
    const rows = this.rows(change.table);
    const existing = rows.find((row) => row.id === change.id);
    if (change.op === 'delete') {
      if (!existing) return;
      if (change.table !== 'memberships' || !this.canUpdate(user, 'memberships', existing, {})) refuse('Suppression refusée.');
      rows.splice(rows.indexOf(existing), 1);
    } else if (change.op === 'insert') {
      if (existing) return;
      const now = this.now();
      const row: Row = { ...change.fields, id: change.id, created_at: now, updated_at: now, created_by: user.id };
      if (change.table === 'memberships' || change.table === 'profiles') delete row.created_by;
      if (!this.canInsert(user, change.table, row)) refuse('Création refusée : vous n’avez pas ce droit dans ce projet.');
      if (change.table === 'topics') {
        const numbers = rows.filter((other) => other.project_id === row.project_id).map((other) => Number(other.number));
        if (typeof row.number !== 'number' || numbers.includes(row.number)) row.number = Math.max(0, ...numbers) + 1;
      }
      rows.push(row);
      if (change.table === 'projects') this.rows('memberships').push({ id: globalThis.crypto.randomUUID(), project_id: row.id, email: user.email, role: 'admin', company: '', created_at: now, updated_at: now });
      if (change.table === 'topics') this.event(user, row, 'insert', null);
    } else {
      const allowed = UPDATABLE[change.table] ?? [];
      const names = Object.keys(change.fields);
      if (names.some((name) => !allowed.includes(name))) refuse(`Champ non modifiable : ${names.find((name) => !allowed.includes(name))}.`);
      if (!existing || !this.visible(user, change.table, existing) || !this.canUpdate(user, change.table, existing, change.fields)) refuse('Modification refusée : introuvable ou non autorisée.');
      const changed = names.filter((name) => JSON.stringify(existing![name] ?? null) !== JSON.stringify(change.fields[name] ?? null)).sort();
      Object.assign(existing!, structuredClone(change.fields), { updated_at: this.now() });
      if (change.table === 'topics' && changed.length > 0) this.event(user, existing!, 'update', changed);
    }
    await this.save();
  }

  // ------------------------------------------------------------------ fichiers

  async upload(path: string, blob: Blob): Promise<void> {
    const user = this.me();
    if (!this.canUseFile(user, path, true)) refuse('Dépôt du fichier refusé.');
    this.state.files[path] ??= blob;
    await this.save();
  }

  async download(path: string): Promise<Blob> {
    const user = this.me();
    const blob = this.canUseFile(user, path, false) ? this.state.files[path] : undefined;
    if (!blob) refuse('Fichier introuvable.');
    return blob!;
  }

  async remove(paths: readonly string[]): Promise<void> {
    const user = this.me();
    for (const path of paths) {
      const role = this.role(user, path.split('/')[0]);
      if (role === 'admin' || role === 'editor') delete this.state.files[path];
    }
    await this.save();
  }
}
