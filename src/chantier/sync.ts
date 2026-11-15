// Règles de synchronisation, pures (testées dans tests/chantierSync.test.ts). Tout s'écrit d'abord sur l'appareil ; chaque
// modification entre dans une file, envoyée ligne par ligne dans l'ordre quand on est connecté et en ligne.
//
// - Une ligne créée sur l'appareil part entière (`insert`, sans effet si elle existe déjà) ; une modification ne part qu'avec
//   les groupes de champs qu'elle touche (statut ; attribution ; texte ; emplacement) : deux personnes qui changent des groupes
//   différents hors ligne gardent toutes deux leur changement ; sur le même groupe, la dernière arrivée au serveur l'emporte
//   (l'historique `events` garde les deux).
// - Deux modifications de la même ligne encore en file n'en font qu'une (les valeurs les plus récentes).
// - Commentaires, points de vue et photos ne font que s'ajouter.
// - Ce que le serveur renvoie remplace la copie de l'appareil, sauf les champs qui ont encore une modification en file.
// - Un envoi qui échoue faute de réseau arrête l'envoi (on réessaie plus tard, dans le même ordre) ; un envoi refusé par le
//   serveur est marqué et reste visible, les suivants partent.

import type { BackendError, Row, Table } from './backend/port.ts';

export interface QueueEntry {
  /** Ordre d'envoi. */
  seq: number;
  table: Table;
  id: string;
  op: 'insert' | 'update' | 'delete' | 'upload';
  fields: Record<string, unknown>;
  /** `upload` : le chemin du fichier (gardé dans le magasin `files`). */
  path?: string;
  /** Raison du refus du serveur ; une entrée refusée attend « Réessayer ». */
  error?: string;
  /** Augmente à chaque fusion : une entrée changée pendant son envoi n'est pas retirée de la file. */
  version: number;
}

/** Les groupes de champs modifiables, par table : une modification envoie les groupes entiers qu'elle touche. */
export const GROUPS: Readonly<Partial<Record<Table, readonly (readonly string[])[]>>> = {
  topics: [['status'], ['assigned_to', 'due_date', 'priority'], ['title', 'description', 'type', 'labels', 'stage'], ['extra'], ['deleted_at']],
  projects: [['name'], ['lists'], ['deleted_at']],
  memberships: [['role', 'company']],
  profiles: [['display_name', 'company']],
  photos: [['deleted_at']],
  plans: [['name'], ['deleted_at']],
  organisations: [['name']],
};

/** Envoyés avec toute modification de la table (qui a modifié). */
const ALWAYS: Readonly<Partial<Record<Table, readonly string[]>>> = { topics: ['modified_author'] };

/** Les champs qu'une modification envoie : les groupes entiers touchés par `changed`, lus dans la ligne modifiée. */
export function groupFields(table: Table, row: Row, changed: readonly string[]): Record<string, unknown> {
  const groups = (GROUPS[table] ?? []).filter((group) => group.some((field) => changed.includes(field)));
  const names = [...groups.flat(), ...(groups.length > 0 ? ALWAYS[table] ?? [] : [])];
  return Object.fromEntries(names.map((name) => [name, row[name] ?? null]));
}

/** Les champs d'une ligne que le serveur laisse modifier. */
const updatable = (table: Table, fields: Record<string, unknown>) => {
  const names = new Set([...(GROUPS[table] ?? []).flat(), ...(ALWAYS[table] ?? [])]);
  return Object.fromEntries(Object.entries(fields).filter(([name]) => names.has(name)));
};

/** Sans les clés locales (`_…`) : ce qui part au serveur. */
export const serverFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => !name.startsWith('_')));

const same = (entry: QueueEntry, table: Table, id: string) => entry.table === table && entry.id === id && !entry.error;

/**
 * La file avec cette modification en plus : fusionnée dans une création ou une modification encore en file de la même ligne
 * (les valeurs nouvelles l'emportent), sinon ajoutée à la fin. Supprimer une ligne jamais envoyée la retire simplement.
 */
export function enqueue(queue: readonly QueueEntry[], change: Omit<QueueEntry, 'seq' | 'version'>): QueueEntry[] {
  const seq = queue.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
  const fresh: QueueEntry = { ...change, seq, version: 0 };
  if (change.op === 'upload') return queue.some((entry) => entry.op === 'upload' && entry.path === change.path && !entry.error) ? [...queue] : [...queue, fresh];
  const pending = queue.filter((entry) => same(entry, change.table, change.id));
  if (change.op === 'delete') {
    const created = pending.some((entry) => entry.op === 'insert');
    const rest = queue.filter((entry) => !same(entry, change.table, change.id) || entry.op === 'upload');
    return created ? rest : [...rest, fresh];
  }
  const target = pending.find((entry) => entry.op === 'insert' || entry.op === 'update');
  if (!target || (change.op === 'insert' && target.op === 'update')) return [...queue, fresh];
  return queue.map((entry) => (entry === target ? { ...entry, fields: { ...entry.fields, ...change.fields }, version: entry.version + 1 } : entry));
}

/**
 * La file après l'envoi réussi de `sent` : l'entrée est retirée, sauf si elle a changé pendant l'envoi ; une création alors
 * déjà faite devient la modification des seuls champs modifiables. La version reste : un autre onglet qui envoyait la même
 * entrée, lue avant le changement, ne la retire pas en finissant.
 */
export function complete(queue: readonly QueueEntry[], sent: QueueEntry): QueueEntry[] {
  return queue.flatMap((entry) => {
    if (entry.seq !== sent.seq) return [entry];
    if (entry.version === sent.version) return [];
    return entry.op === 'insert' ? [{ ...entry, op: 'update' as const, fields: updatable(entry.table, entry.fields) }] : [entry];
  });
}

/** La file après un échec : `stop` (réseau, session) la garde telle quelle ; un refus marque l'entrée. */
export function fail(queue: readonly QueueEntry[], sent: QueueEntry, error: BackendError): { queue: QueueEntry[]; stop: boolean } {
  if (error.kind !== 'refused') return { queue: [...queue], stop: true };
  return { queue: queue.map((entry) => (entry.seq === sent.seq ? { ...entry, error: error.message } : entry)), stop: false };
}

/** Les entrées refusées, remises à envoyer (« Réessayer »). */
export const retry = (queue: readonly QueueEntry[]): QueueEntry[] => queue.map(({ error: _error, ...entry }) => entry);

/** Les champs de cette ligne qui ont une modification en file ; `all` si sa création n'est pas encore envoyée. */
export function pendingFields(queue: readonly QueueEntry[], table: Table, id: string): Set<string> | 'all' {
  const entries = queue.filter((entry) => entry.table === table && entry.id === id && entry.op !== 'upload');
  if (entries.some((entry) => entry.op === 'insert')) return 'all';
  return new Set(entries.flatMap((entry) => Object.keys(entry.fields)));
}

/** La ligne du serveur, fusionnée dans la copie de l'appareil : les champs encore en file restent ceux de l'appareil. */
export function mergeRemote(local: Row | undefined, remote: Row, pending: Set<string> | 'all'): Row {
  if (!local) return remote;
  if (pending === 'all') return { ...remote, ...local };
  const kept = Object.fromEntries([...pending].filter((name) => name in local).map((name) => [name, local[name]]));
  const own = Object.fromEntries(Object.entries(local).filter(([name]) => name.startsWith('_') && pending.size > 0));
  return { ...remote, ...own, ...kept };
}

const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value);

/** Deux valeurs JSON égales quel que soit l'ordre des clés (jsonb range les siennes à sa façon) ; absent vaut null. */
export const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

/** Le curseur après ces lignes : la plus grande date de modification (le précédent sans ligne). */
export function nextCursor(rows: readonly Row[], column: string, previous: string | undefined): string | undefined {
  return rows.reduce<string | undefined>((max, row) => {
    const value = row[column];
    return typeof value === 'string' && (!max || Date.parse(value) > Date.parse(max)) ? value : max;
  }, previous);
}

/**
 * Le curseur à demander : un peu avant le dernier vu. Une ligne écrite par une transaction lente peut porter une date
 * antérieure à des lignes déjà lues ; relire deux minutes ne coûte qu'une fusion de plus (sans effet).
 */
export const sinceOf = (cursor: string | undefined): string | undefined => (cursor ? new Date(Date.parse(cursor) - 120_000).toISOString() : undefined);
