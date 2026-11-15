// L'interface entre le suivi de chantier et son serveur (09b, décision 6) : se connecter, tirer les lignes changées, pousser une
// modification, déposer et lire un fichier. Deux adaptateurs : Supabase (supabase.ts) et en mémoire (memory.ts, tests et démo).
// Les écrans ne la voient pas : ils lisent et écrivent le magasin de l'appareil (store.ts), qui seul parle au serveur. Changer
// de moteur de synchronisation ou d'hébergeur, c'est réécrire un adaptateur.

export type Table = 'profiles' | 'organisations' | 'projects' | 'memberships' | 'topics' | 'comments' | 'viewpoints' | 'photos' | 'plans' | 'events';

/** Une ligne d'une table, colonnes de la base (snake_case). Les clés qui commencent par `_` restent sur l'appareil. */
export type Row = { id: string } & Record<string, unknown>;

export interface Account {
  userId: string;
  email: string;
}

/**
 * Une modification à envoyer. `insert` : la ligne entière, sans effet si elle existe déjà (même envoi deux fois = une
 * ligne) ; `update` : les champs donnés seulement ; `delete` : la ligne (adhésions seulement).
 */
export interface Change {
  table: Table;
  id: string;
  op: 'insert' | 'update' | 'delete';
  fields: Record<string, unknown>;
}

/**
 * `offline` : pas de réseau, serveur en pause ou injoignable (on réessaie plus tard, rien n'est perdu) ; `auth` : session
 * absente ou expirée ; `refused` : le serveur refuse cette modification (droits, contrainte) : elle reste visible, marquée.
 */
export type FailureKind = 'offline' | 'auth' | 'refused';

export class BackendError extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface BackendPort {
  /** Le compte de la session gardée par ce navigateur ; null sans session. */
  account(): Promise<Account | null>;
  /** `confirmEmail` : le compte attend la confirmation de l'adresse (lien envoyé par e-mail) avant de se connecter. */
  signUp(email: string, password: string, displayName: string): Promise<{ confirmEmail: boolean }>;
  signIn(email: string, password: string): Promise<Account>;
  signOut(): Promise<void>;
  /**
   * Les lignes visibles de la table, changées depuis `since` (ISO 8601, inclus) et du projet `projectId` s'il est donné,
   * dans l'ordre de leur date de modification (`at` pour `events`, `updated_at` ailleurs).
   */
  pull(table: Table, filter: { projectId?: string; since?: string }): Promise<Row[]>;
  push(change: Change): Promise<void>;
  /** Dépose un fichier ; un fichier déjà là (même chemin, nommé par son contenu) compte comme déposé. */
  upload(path: string, blob: Blob): Promise<void>;
  download(path: string): Promise<Blob>;
  remove(paths: readonly string[]): Promise<void>;
  /** Supprime le compte connecté et ses données personnelles (voir `delete_my_account` dans la migration). */
  deleteAccount(): Promise<void>;
}

/** La colonne qui date une modification, et sert de curseur. */
export const cursorColumn = (table: Table): string => (table === 'events' ? 'at' : 'updated_at');
