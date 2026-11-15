// Les lignes de la base du suivi de chantier et l'observation du contrat (docs/contrat-observations.md) : une observation est une
// ligne `topics` (ce que le BCF n'a pas va dans `extra`), ses commentaires, ses points de vue et ses photos (fichiers à part,
// l'image d'un point de vue est une photo qui le désigne). Une observation relue passe par `parseObservations` : la même
// validation que pour un JSON ouvert dans le viewer (une ligne écrite par un autre membre n'est pas crue sur parole).

import { defined, type BcfViewpoint } from '../data/bcf.ts';
import { defaultLists, isoDate, parseObservations, type Observation, type ObservationLists } from '../data/observations.ts';
import type { Row } from './backend/port.ts';

export type Role = 'admin' | 'editor' | 'guest';
export const ROLE_LABELS: Readonly<Record<Role, string>> = { admin: 'Administrateur', editor: 'Éditeur', guest: 'Invité' };

export interface ProjectRow extends Row {
  organisation_id: string | null;
  name: string;
  lists: Partial<ObservationLists>;
  deleted_at: string | null;
  created_at?: string;
  /** Le serveur ne le montre plus à ce compte (retiré du projet, projet supprimé ailleurs). */
  _lost?: boolean;
}

export interface MembershipRow extends Row {
  project_id: string;
  email: string;
  role: Role;
  company: string;
}

export interface TopicRow extends Row {
  project_id: string;
  number: number | null;
  type: string;
  status: string;
  title: string;
  priority: string | null;
  labels: string[];
  stage: string | null;
  assigned_to: string | null;
  /** AAAA-MM-JJ. */
  due_date: string | null;
  description: string | null;
  creation_date: string;
  creation_author: string;
  modified_author: string | null;
  extra: Record<string, unknown>;
  deleted_at: string | null;
  updated_at?: string;
  /** Date de la dernière modification faite sur l'appareil, pas encore relue du serveur. */
  _modified?: string;
}

export interface CommentRow extends Row {
  project_id: string;
  topic_id: string;
  date: string;
  author: string;
  text: string;
  viewpoint_id: string | null;
}

export interface ViewpointRow extends Row {
  project_id: string;
  topic_id: string;
  position: number;
  data: Record<string, unknown>;
}

export interface FileRow extends Row {
  project_id: string;
  path: string;
  mime: string;
  size: number;
  sha256: string;
  deleted_at: string | null;
}

export interface PhotoRow extends FileRow {
  topic_id: string;
  viewpoint_id: string | null;
  filename: string;
}

export interface PlanRow extends FileRow {
  name: string;
  width: number;
  height: number;
}

export interface EventRow extends Row {
  project_id: string;
  topic_id: string;
  actor_name: string;
  action: 'insert' | 'update';
  fields: string[] | null;
  at: string;
}

export interface ProfileRow extends Row {
  display_name: string;
  company: string;
}

/** Les listes d'un projet, complétées et validées comme celles d'un JSON. */
export const listsOf = (project: Pick<ProjectRow, 'lists'> | undefined): ObservationLists =>
  parseObservations({ lists: { ...defaultLists(), ...(project?.lists ?? {}) } })?.lists ?? defaultLists();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Un identifiant accepté par la base : le GUID en minuscules, ou un nouveau s'il n'en est pas un (fichier d'un autre outil). */
export const rowId = (guid: string): string => (UUID.test(guid.toLowerCase()) ? guid.toLowerCase() : globalThis.crypto.randomUUID());

/** La ligne `topics` d'une observation (sans photos ni points de vue). */
export function topicRow(observation: Observation, projectId: string): TopicRow {
  const o = observation;
  return {
    id: o.guid, project_id: projectId, number: o.number > 0 ? o.number : null,
    type: o.type, status: o.status, title: o.title, priority: o.priority ?? null, labels: [...o.labels], stage: o.stage ?? null,
    assigned_to: o.assignedTo ?? null, due_date: o.dueDate ? o.dueDate.slice(0, 10) : null, description: o.description ?? null,
    creation_date: o.creationDate, creation_author: o.creationAuthor, modified_author: o.modifiedAuthor ?? null,
    extra: defined({ elements: o.elements, pin: o.pin, drawingPin: o.drawingPin, point: o.point, location: o.location, origin: o.origin, referenceLinks: o.referenceLinks, relatedTopics: o.relatedTopics }),
    deleted_at: null,
  };
}

export const commentRows = (observation: Observation, projectId: string): CommentRow[] => observation.comments.map((comment) => ({
  id: comment.guid, project_id: projectId, topic_id: observation.guid, date: comment.date, author: comment.author, text: comment.text, viewpoint_id: comment.viewpoint ?? null,
}));

export const viewpointRows = (observation: Observation, projectId: string): ViewpointRow[] => observation.viewpoints.map(({ guid, snapshot: _snapshot, ...data }, position) => ({
  id: guid, project_id: projectId, topic_id: observation.guid, position, data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
}));

const iso = (value: unknown): string | undefined => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? isoDate(new Date(value)) : undefined);

/**
 * L'observation de ces lignes ; `file` donne le contenu d'un chemin s'il est sur l'appareil. Null si la ligne est illisible.
 * Les photos retirées ne sont plus des documents.
 */
export function observationOf(topic: TopicRow, comments: readonly CommentRow[], viewpoints: readonly ViewpointRow[], photos: readonly PhotoRow[], file: (path: string) => Blob | undefined): Observation | null {
  const extra = topic.extra && typeof topic.extra === 'object' ? topic.extra : {};
  const raw = {
    ...extra,
    guid: topic.id, number: topic.number ?? undefined, type: topic.type, status: topic.status, title: topic.title, priority: topic.priority ?? undefined, labels: topic.labels,
    creationDate: iso(topic.creation_date), creationAuthor: topic.creation_author, modifiedDate: topic._modified ?? iso(topic.updated_at), modifiedAuthor: topic.modified_author ?? undefined,
    dueDate: topic.due_date ? `${String(topic.due_date).slice(0, 10)}T00:00:00Z` : undefined, assignedTo: topic.assigned_to ?? undefined, stage: topic.stage ?? undefined, description: topic.description ?? undefined,
    comments: [...comments].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).map((comment) => ({ guid: comment.id, date: iso(comment.date), author: comment.author, text: comment.text, viewpoint: comment.viewpoint_id ?? undefined })),
    viewpoints: [...viewpoints].sort((a, b) => a.position - b.position).map((viewpoint) => ({ ...viewpoint.data, guid: viewpoint.id })),
    documents: photos.filter((photo) => !photo.viewpoint_id && !photo.deleted_at).map((photo) => ({ guid: photo.id, filename: photo.filename })),
  };
  const observation = parseObservations({ topics: [raw] })?.topics[0];
  if (!observation) return null;
  if (topic.number === null) observation.number = 0;
  const live = photos.filter((photo) => !photo.deleted_at);
  observation.documents = observation.documents.map((document) => {
    const photo = live.find((item) => item.id === document.guid);
    return defined({ ...document, data: photo ? file(photo.path) : undefined });
  });
  observation.viewpoints = observation.viewpoints.map((viewpoint): BcfViewpoint => {
    const photo = live.find((item) => item.viewpoint_id === viewpoint.guid);
    return defined({ ...viewpoint, snapshot: photo ? file(photo.path) : undefined });
  });
  return observation;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/webp': 'webp' };

/** Le chemin d'un fichier dans le stockage : `<projet>/<observation ou « plans »>/<sha256>.<ext>` (nommé par son contenu). */
export const filePath = (projectId: string, folder: string, sha256: string, mime: string): string => `${projectId}/${folder}/${sha256}.${EXTENSIONS[mime] ?? 'jpg'}`;

/** Un identifiant tiré d'un projet et d'un autre identifiant (SHA-256 mis en forme d'UUID) : le même à chaque fois. */
export async function derivedId(projectId: string, guid: string): Promise<string> {
  const hex = await sha256(new Blob([`${projectId}/${guid}`]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** L'empreinte SHA-256 d'un contenu, en hexadécimal. */
export async function sha256(blob: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Les initiales d'un nom (« Zaid El Gaoual » → « ZE ») ; « ? » sans nom. */
export const initials = (name: string): string => name.split(/[\s-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join('') || '?';
