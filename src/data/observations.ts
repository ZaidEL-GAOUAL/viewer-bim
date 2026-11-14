// Observations du suivi de chantier (voir docs/contrat-observations.md). Une observation est un sujet BCF (data/bcf.ts) :
// type, statut, lot (étiquette), phase (« Stage »), entreprise (« AssignedTo »), échéance, priorité, titre, description,
// commentaires (l'historique), points de vue et photos (documents). S'y ajoute ce que le BCF n'a pas, gardé à côté dans la
// section `observations` du JSON et jamais écrit dans le .bcf : un numéro, les éléments désignés par maquette et clé, le
// repère sur un plan, le point 3D, l'emplacement (niveau, local, zone) et l'origine (conflit, propriété requise).
// Coordonnées : celles du modèle d'origine, Z vers le haut, en mètres. Pur : rien ici ne touche à la vue.

import { defined, newGuid, type BcfCamera, type BcfClippingPlane, type BcfComment, type BcfComponent, type BcfDocument, type BcfExtensions, type BcfTopic, type BcfViewpoint } from './bcf.ts';
import { clashTopic, type ClashRecord, type ElementRef } from './clashes.ts';
import type { ElementAppearance } from './appearanceRules.ts';
import { isRecord } from './json.ts';
import { formatValue, ownValue, type FlatProps } from './metadata.ts';
import { yUpToZUp, zUpToYUp, type Vec3 } from './modelFrame.ts';
import { categoryColor } from './palette.ts';
import type { SavedPlane, SavedView, SavedViewCamera, SectionBoxSpec } from './savedViews.ts';
import { csvCell, fold } from './text.ts';
import { boxFaces } from '../engine/Sections.ts';

/** Le repère posé sur un plan : la vue (son identifiant, à défaut son nom) et le point, repère du modèle, Z vers le haut. */
export interface PlanPin {
  plan: string;
  x: number;
  y: number;
}

export interface ObservationLocation {
  level?: string;
  room?: string;
  zone?: string;
}

export interface Observation extends BcfTopic {
  /** Numéro lisible (« N° 12 »), unique dans le projet. */
  number: number;
  /** Les éléments, par maquette (nom de son fichier) et clé dans ce fichier. */
  elements: ElementRef[];
  pin?: PlanPin;
  /** Le point désigné, repère du modèle, Z vers le haut : il retrouve l'observation si l'élément disparaît. */
  point?: Vec3;
  location: ObservationLocation;
  /** Ce qui l'a créée (`clash:…`, `requirement:…`) : la même source n'en crée pas deux. */
  origin?: string;
}

export interface ObservationLists {
  kinds: string[];
  statuses: string[];
  /** Les statuts qui terminent une observation (plus en retard). */
  done: string[];
  trades: string[];
  /** De la plus urgente à la moins urgente. */
  priorities: string[];
  phases: string[];
  companies: string[];
  /** Statut → statuts permis ensuite. Un statut absent de la table peut aller vers tous les autres. */
  transitions: Record<string, string[]>;
}

/** Les propriétés des éléments que l'utilisateur désigne comme niveau, local et zone. */
export interface ObservationSettings {
  level?: string;
  room?: string;
  zone?: string;
}

export interface ObservationBook {
  settings: ObservationSettings;
  lists: ObservationLists;
  topics: Observation[];
}

export function defaultLists(): ObservationLists {
  return {
    kinds: ['Réserve', 'Défaut', 'Sécurité', 'Tâche'],
    statuses: ['Ouverte', 'En cours', 'Résolue', 'Contestée', 'Clôturée'],
    done: ['Résolue', 'Clôturée'],
    trades: ['Gros œuvre', 'Plâtrerie', 'Menuiserie', 'Plomberie', 'Électricité', 'CVC', 'Peinture', 'Revêtements de sol', 'Serrurerie'],
    priorities: ['Critique', 'Haute', 'Normale', 'Basse'],
    phases: ['Visite', 'OPR', 'Levée de réserves', 'GPA'],
    companies: [],
    transitions: {
      Ouverte: ['En cours', 'Résolue', 'Contestée', 'Clôturée'],
      'En cours': ['Ouverte', 'Résolue', 'Contestée'],
      Résolue: ['Clôturée', 'Ouverte', 'Contestée'],
      Contestée: ['Ouverte', 'En cours', 'Clôturée'],
      Clôturée: ['Ouverte'],
    },
  };
}

export const emptyBook = (): ObservationBook => ({ settings: {}, lists: defaultLists(), topics: [] });

/** Date et heure ISO 8601 à la seconde, en UTC (`xs:dateTime` du BCF). */
export const isoDate = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** « 2026-11-30T00:00:00Z » → « 30/11/2026 » (sans passer par le fuseau du navigateur). */
export const frenchDate = (iso: string | undefined): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

export const nextNumber = (topics: readonly Observation[]): number => topics.reduce((max, topic) => Math.max(max, topic.number), 0) + 1;

export function newObservation(init: Partial<Observation>, author: string, now: Date, lists: ObservationLists, number: number): Observation {
  return {
    guid: newGuid(), type: lists.kinds[0] ?? 'Réserve', status: lists.statuses[0] ?? 'Ouverte', title: '', labels: [],
    creationDate: isoDate(now), creationAuthor: author, referenceLinks: [], relatedTopics: [], documents: [], comments: [], viewpoints: [],
    number, elements: [], location: {}, ...init,
  };
}

/** La même observation, modifiée par `author` à `now`. */
export const touched = (topic: Observation, changes: Partial<Observation>, author: string, now: Date): Observation => ({ ...topic, ...changes, modifiedDate: isoDate(now), modifiedAuthor: author });

export function addComment(topic: Observation, text: string, author: string, now: Date): Observation {
  const comment: BcfComment = { guid: newGuid(), date: isoDate(now), author, text };
  return touched(topic, { comments: [...topic.comments, comment] }, author, now);
}

/** Les statuts vers lesquels `from` peut passer. */
export function allowedStatuses(lists: ObservationLists, from: string): string[] {
  const next = lists.statuses.includes(from) && Object.hasOwn(lists.transitions, from) ? lists.transitions[from] : undefined;
  return lists.statuses.filter((status) => status !== from && (!next || next.includes(status)));
}

/** Change le statut si la transition est permise, et l'écrit dans l'historique (un commentaire). */
export function changeStatus(topic: Observation, to: string, lists: ObservationLists, author: string, now: Date): Observation {
  if (to === topic.status) return topic;
  if (!allowedStatuses(lists, topic.status).includes(to)) throw new Error(`Passage de « ${topic.status} » à « ${to} » non permis.`);
  return { ...addComment(topic, `Statut : ${topic.status} → ${to}`, author, now), status: to };
}

/** L'emplacement d'un élément, lu dans les propriétés désignées (vides : rien). */
export function locate(props: FlatProps | undefined, settings: ObservationSettings): ObservationLocation {
  const read = (path: string | undefined) => {
    const value = path ? ownValue(props, path) : undefined;
    return value === undefined || value === null || value === '' ? undefined : formatValue(value);
  };
  return defined({ level: read(settings.level), room: read(settings.room), zone: read(settings.zone) });
}

/** Les observations dont un élément n'existe plus (fichier réexporté, élément supprimé). */
export const orphans = (topics: readonly Observation[], exists: (ref: ElementRef) => boolean): Observation[] =>
  topics.filter((topic) => topic.elements.some((ref) => !exists(ref)));

// ------------------------------------------------------------------ liste : filtres, tri, groupes

export interface ObservationFilter {
  statuses?: readonly string[];
  company?: string;
  trade?: string;
  level?: string;
  phase?: string;
  kind?: string;
  /** Échéance passée et observation pas terminée. */
  overdue?: boolean;
  /** Échéance au plus tard ce jour (AAAA-MM-JJ). */
  dueBefore?: string;
  text?: string;
}

const day = (iso: string | undefined) => iso?.slice(0, 10) ?? '';

export function isOverdue(topic: Observation, lists: ObservationLists, today: string): boolean {
  return topic.dueDate !== undefined && day(topic.dueDate) < today && !lists.done.includes(topic.status);
}

/** `today` : AAAA-MM-JJ. */
export function filterObservations(topics: readonly Observation[], filter: ObservationFilter, lists: ObservationLists, today: string): Observation[] {
  const query = filter.text ? fold(filter.text) : '';
  return topics.filter((topic) =>
    (!filter.statuses?.length || filter.statuses.includes(topic.status))
    && (!filter.company || topic.assignedTo === filter.company)
    && (!filter.trade || topic.labels.includes(filter.trade))
    && (!filter.level || topic.location.level === filter.level)
    && (!filter.phase || topic.stage === filter.phase)
    && (!filter.kind || topic.type === filter.kind)
    && (!filter.overdue || isOverdue(topic, lists, today))
    && (!filter.dueBefore || (topic.dueDate !== undefined && day(topic.dueDate) <= filter.dueBefore))
    && (!query || fold([topic.number, topic.title, topic.description, topic.assignedTo, ...topic.labels, topic.location.level, topic.location.room, topic.location.zone, ...topic.comments.map((c) => c.text)].filter(Boolean).join(' ')).includes(query)));
}

export type SortKey = 'number' | 'due' | 'status' | 'priority' | 'created' | 'modified' | 'title' | 'company' | 'level';
export const SORT_LABELS: Readonly<Record<SortKey, string>> = { number: 'Numéro', due: 'Échéance', status: 'Statut', priority: 'Priorité', created: 'Création', modified: 'Modification', title: 'Titre', company: 'Entreprise', level: 'Niveau' };

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

/** Trié (une copie) ; à égalité, par numéro. Les valeurs absentes vont à la fin. */
export function sortObservations(topics: readonly Observation[], key: SortKey, lists: ObservationLists): Observation[] {
  const rank = (list: readonly string[], value: string | undefined) => (value !== undefined && list.includes(value) ? list.indexOf(value) : list.length);
  const text = (topic: Observation): string | undefined => ({ due: day(topic.dueDate) || undefined, created: topic.creationDate, modified: topic.modifiedDate ?? topic.creationDate, title: topic.title, company: topic.assignedTo, level: topic.location.level } as Partial<Record<SortKey, string>>)[key];
  const compare = (a: Observation, b: Observation): number => {
    if (key === 'number') return 0;
    if (key === 'status') return rank(lists.statuses, a.status) - rank(lists.statuses, b.status);
    if (key === 'priority') return rank(lists.priorities, a.priority) - rank(lists.priorities, b.priority);
    const x = text(a), y = text(b);
    return x === y ? 0 : x === undefined || x === '' ? 1 : y === undefined || y === '' ? -1 : collator.compare(x, y);
  };
  return [...topics].sort((a, b) => compare(a, b) || a.number - b.number);
}

export type GroupKey = 'none' | 'company' | 'trade' | 'level' | 'status' | 'kind' | 'phase';
export const GROUP_LABELS: Readonly<Record<GroupKey, string>> = { none: 'Sans regroupement', company: 'Entreprise', trade: 'Lot', level: 'Niveau', status: 'Statut', kind: 'Type', phase: 'Phase' };
const NONE: Readonly<Record<GroupKey, string>> = { none: 'Toutes', company: '(sans entreprise)', trade: '(sans lot)', level: '(sans niveau)', status: '(sans statut)', kind: '(sans type)', phase: '(sans phase)' };

export function groupValue(topic: Observation, key: GroupKey): string {
  const value = { none: '', company: topic.assignedTo, trade: topic.labels[0], level: topic.location.level, status: topic.status, kind: topic.type, phase: topic.stage }[key];
  return value || NONE[key];
}

/** Groupes dans l'ordre de `order` s'il est donné, sinon alphabétique ; « (sans …) » en dernier. L'ordre des observations est gardé. */
export function groupObservations(topics: readonly Observation[], key: GroupKey, order: readonly string[] = []): { label: string; topics: Observation[] }[] {
  const groups = new Map<string, Observation[]>();
  for (const topic of topics) {
    const label = groupValue(topic, key);
    const list = groups.get(label);
    if (list) list.push(topic);
    else groups.set(label, [topic]);
  }
  const rank = (label: string) => (label === NONE[key] ? Infinity : order.includes(label) ? order.indexOf(label) : order.length);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || collator.compare(a, b)).map(([label, list]) => ({ label, topics: list }));
}

// ------------------------------------------------------------------ couleurs par statut

const STATUS_COLORS: Readonly<Record<string, string>> = { Ouverte: '#dc2626', 'En cours': '#f59e0b', Résolue: '#2563eb', Contestée: '#9333ea', Clôturée: '#16a34a' };

// Un statut vient d'un fichier : jamais lu comme un membre d'Object (« constructor »…).
export const statusColor = (status: string, lists: ObservationLists): string => (Object.hasOwn(STATUS_COLORS, status) ? STATUS_COLORS[status] : categoryColor(Math.max(0, lists.statuses.indexOf(status)), status));

/** L'état passager « couleur par statut » : chaque élément prend la couleur de son observation la moins avancée. */
export function statusLayer(topics: readonly Observation[], resolve: (ref: ElementRef) => number | undefined, lists: ObservationLists): Map<number, ElementAppearance> {
  const best = new Map<number, { rank: number; status: string }>();
  for (const topic of topics) {
    const rank = lists.statuses.includes(topic.status) ? lists.statuses.indexOf(topic.status) : lists.statuses.length;
    for (const ref of topic.elements) {
      const element = resolve(ref);
      if (element === undefined) continue;
      const current = best.get(element);
      if (!current || rank < current.rank) best.set(element, { rank, status: topic.status });
    }
  }
  return new Map([...best].map(([element, { status }]) => [element, { color: statusColor(status, lists) }]));
}

// ------------------------------------------------------------------ BCF

const IFC_GUID = /^[0-9A-Za-z_$]{22}$/;

/** Un élément pour le BCF : par GlobalId IFC, sinon par l'identifiant de l'outil auteur (`rvt-318215` → 318215). */
export function componentOf(key: string): BcfComponent {
  const revit = /^rvt-(\d+)$/.exec(key);
  if (revit) return { authoringToolId: revit[1] };
  return IFC_GUID.test(key) ? { ifcGuid: key } : { authoringToolId: key };
}

/** L'inverse de `componentOf` ; null pour un composant vide. */
export function keyOfComponent(component: BcfComponent): string | null {
  if (component.ifcGuid) return component.ifcGuid;
  const id = component.authoringToolId;
  if (!id) return null;
  return /^\d+$/.test(id) ? `rvt-${id}` : id;
}

/** Le sujet BCF d'une observation : ses champs propres retirés, ses éléments dans la sélection du premier point de vue. */
export function toBcfTopic(observation: Observation): BcfTopic {
  const { number: _number, elements, pin: _pin, point: _point, location: _location, origin: _origin, ...topic } = observation;
  void [_number, _pin, _point, _location, _origin];
  if (elements.length === 0) return topic;
  const selection = elements.map((ref) => componentOf(ref.key));
  const [first, ...rest] = topic.viewpoints;
  return { ...topic, viewpoints: first ? [{ ...first, selection }, ...rest] : [{ guid: newGuid(), clippingPlanes: [], selection }] };
}

/** Une observation lue d'un sujet BCF : les éléments sélectionnés deviennent les siens (sans maquette : cherchés dans toutes). */
export function fromBcfTopic(topic: BcfTopic, number: number): Observation {
  const keys = [...new Set(topic.viewpoints.flatMap((viewpoint) => viewpoint.selection.flatMap((component) => keyOfComponent(component) ?? [])))];
  return { ...topic, viewpoints: topic.viewpoints.map((viewpoint) => ({ ...viewpoint, selection: [] })), number, elements: keys.map((key) => ({ key })), location: {} };
}

/** Les listes du projet, telles que le BCF les décrit (extensions.xml). */
export function extensionsOf(book: ObservationBook): BcfExtensions {
  const { lists } = book;
  const users = [...new Set([...lists.companies, ...book.topics.flatMap((topic) => [topic.creationAuthor, ...topic.comments.map((comment) => comment.author)])].filter(Boolean))];
  return { topicTypes: [...lists.kinds], topicStatuses: [...lists.statuses], priorities: [...lists.priorities], topicLabels: [...lists.trades], users, stages: [...lists.phases] };
}

// ------------------------------------------------------------------ points de vue

const clean = (v: readonly number[]): Vec3 => [v[0] + 0, v[1] + 0, v[2] + 0];
const zUp = (v: readonly number[]): Vec3 => clean(yUpToZUp(v));
const yUp = (v: readonly number[]): Vec3 => clean(zUpToYUp(v));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: readonly number[]): Vec3 | null => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : null;
};

/**
 * Le point de vue BCF d'une vue (repère du modèle, Y vers le haut → Z vers le haut). Les plans de coupe libres d'abord, puis
 * la boîte de coupe en six plans (normales vers l'extérieur, la partie retirée). `aspect` : largeur / hauteur de la vue.
 */
export function viewpointOfView(view: { camera: SavedViewCamera; sections?: readonly SavedPlane[]; sectionBox?: SectionBoxSpec }, aspect: number, guid: string): BcfViewpoint {
  const { camera } = view;
  const base = { viewPoint: zUp(camera.position), direction: zUp(camera.direction), up: zUp(camera.up) };
  const planes: BcfClippingPlane[] = (view.sections ?? []).filter((plane) => plane.enabled).map((plane) => ({ location: zUp(plane.point), direction: zUp(plane.normal) }));
  if (view.sectionBox) for (const face of boxFaces(view.sectionBox)) planes.push({ location: zUp(face.centre), direction: zUp(face.normal) });
  return {
    guid,
    camera: camera.projection === 'perspective'
      ? { kind: 'perspective', ...base, fieldOfView: camera.fov ?? 45, aspectRatio: aspect }
      : { kind: 'orthogonal', ...base, viewToWorldScale: camera.size?.[1] ?? 10, aspectRatio: camera.size ? camera.size[0] / camera.size[1] : aspect },
    clippingPlanes: planes,
    selection: [],
  };
}

/**
 * Six plans qui forment une boîte tournée autour de la verticale (trois paires opposées, une horizontale) : la boîte de coupe
 * du viewer, repère du modèle (Y vers le haut) ; sinon null.
 */
export function boxOfPlanes(planes: readonly BcfClippingPlane[]): SectionBoxSpec | null {
  if (planes.length !== 6) return null;
  const faces = planes.map((plane) => ({ point: yUp(plane.location), normal: unit(yUp(plane.direction)) }));
  if (faces.some((face) => !face.normal)) return null;
  const normals = faces.map((face) => face.normal!);
  const used = new Set<number>();
  const pairs: Vec3[] = [];
  for (let i = 0; i < 6; i++) {
    if (used.has(i)) continue;
    const j = normals.findIndex((normal, k) => k > i && !used.has(k) && dot(normal, normals[i]) < -0.9999);
    if (j < 0) return null;
    used.add(i).add(j);
    pairs.push(normals[i]);
  }
  const horizontal = pairs.filter((normal) => Math.abs(normal[1]) < 1e-6);
  if (horizontal.length !== 2 || !pairs.some((normal) => Math.abs(normal[1]) > 0.9999) || Math.abs(dot(horizontal[0], horizontal[1])) > 1e-6) return null;
  // L'axe x de la boîte (cos, 0, −sin) : la normale horizontale dont l'angle est dans ]−45°, 45°].
  const angleOf = (normal: Vec3) => (Math.atan2(-normal[2], normal[0]) * 180) / Math.PI;
  const rotation = horizontal.flatMap((normal) => [normal, clean([-normal[0], -normal[1], -normal[2]])]).map(angleOf).find((angle) => angle > -45 + 1e-9 && angle <= 45 + 1e-9)!;
  const radians = (rotation * Math.PI) / 180, c = Math.cos(radians), s = Math.sin(radians);
  const axes: Vec3[] = [[c, 0, -s], [0, 1, 0], [s, 0, c]];
  const along: number[] = [], half: number[] = [];
  for (const axis of axes) {
    const plus = faces.find((face) => dot(face.normal!, axis) > 0.9999), minus = faces.find((face) => dot(face.normal!, axis) < -0.9999);
    if (!plus || !minus) return null;
    const high = dot(plus.point, axis), low = dot(minus.point, axis);
    if (!(high > low)) return null;
    along.push((high + low) / 2);
    half.push((high - low) / 2);
  }
  const centre = [0, 1, 2].map((i) => axes[0][i] * along[0] + axes[1][i] * along[1] + axes[2][i] * along[2]);
  return { min: clean(centre.map((value, i) => value - half[i])), max: clean(centre.map((value, i) => value + half[i])), rotation };
}

/** La vue (repère du modèle, Y vers le haut) d'un point de vue BCF, à ouvrir comme une vue de l'utilisateur ; null sans caméra. */
export function viewOfViewpoint(viewpoint: BcfViewpoint, name: string): SavedView | null {
  const camera = viewpoint.camera;
  if (!camera) return null;
  const direction = unit(yUp(camera.direction)), up = unit(yUp(camera.up));
  if (!direction || !up) return null;
  const savedCamera: SavedViewCamera = camera.kind === 'perspective'
    ? defined({ position: yUp(camera.viewPoint), direction, up, projection: 'perspective' as const, fov: camera.fieldOfView })
    : { position: yUp(camera.viewPoint), direction, up, projection: 'orthographic', size: [(camera.viewToWorldScale ?? 10) * (camera.aspectRatio ?? 1), camera.viewToWorldScale ?? 10] };
  const planes = viewpoint.clippingPlanes;
  const box = planes.length >= 6 ? boxOfPlanes(planes.slice(-6)) : null;
  const free = (box ? planes.slice(0, -6) : planes).map((plane): SavedPlane => ({ point: yUp(plane.location), normal: unit(yUp(plane.direction)) ?? [0, 1, 0], enabled: true }));
  return defined({ name, kind: '3d' as const, origin: 'user' as const, camera: savedCamera, sections: free, sectionBox: box ?? undefined });
}

/** Une caméra en perspective qui regarde `point` (Z vers le haut) d'en haut, de biais, à `distance` mètres. */
export function aimAt(point: Vec3, distance = 6): BcfViewpoint['camera'] {
  const viewPoint: Vec3 = [point[0] - distance * 0.6, point[1] - distance * 0.6, point[2] + distance * 0.5];
  const direction = unit([point[0] - viewPoint[0], point[1] - viewPoint[1], point[2] - viewPoint[2]])!;
  const up = unit([-direction[2] * direction[0], -direction[2] * direction[1], 1 - direction[2] * direction[2]])!;
  return { kind: 'perspective', viewPoint, direction, up, fieldOfView: 60, aspectRatio: 1.5 };
}

// ------------------------------------------------------------------ ponts : conflits et propriétés requises

const refText = (ref: ElementRef) => `${ref.model ?? ''}/${ref.key}`;

/** Une observation pour un conflit : ses deux éléments, son point (Z vers le haut), une vue qui le regarde. */
export function observationFromClash(record: ClashRecord, label: (ref: ElementRef) => string, author: string, now: Date, lists: ObservationLists): Observation {
  const topic = clashTopic(record, label);
  const point = zUp(topic.point);
  return newObservation({
    title: topic.title, type: 'Conflit', description: [topic.description, topic.comment].filter(Boolean).join('\n'),
    elements: [record.a, record.b], point, origin: `clash:${[record.a, record.b].map(refText).sort().join(' × ')}`,
    viewpoints: [{ guid: newGuid(), camera: aimAt(point), clippingPlanes: [], selection: [] }],
  }, author, now, lists, 0);
}

/** Une observation pour les propriétés requises qui manquent à un élément ; `point` : le centre de l'élément (Z vers le haut). */
export function observationFromFailures(ref: ElementRef, label: string, lines: readonly string[], point: Vec3 | undefined, author: string, now: Date, lists: ObservationLists): Observation {
  return newObservation(defined({
    title: `${label} : propriété${lines.length > 1 ? 's' : ''} requise${lines.length > 1 ? 's' : ''}`, type: 'Défaut', description: lines.join('\n'),
    elements: [ref], point, origin: `requirement:${refText(ref)}`,
    viewpoints: point ? [{ guid: newGuid(), camera: aimAt(point), clippingPlanes: [], selection: [] }] : [],
  }), author, now, lists, 0);
}

/** Ajoute les valeurs que ces observations utilisent aux listes du projet. */
export function extendLists(lists: ObservationLists, topics: readonly Observation[]): ObservationLists {
  const add = (list: readonly string[], values: (string | undefined)[]) => [...new Set([...list, ...values.filter((value): value is string => !!value)])];
  return {
    ...lists,
    kinds: add(lists.kinds, topics.map((topic) => topic.type)), statuses: add(lists.statuses, topics.map((topic) => topic.status)),
    trades: add(lists.trades, topics.flatMap((topic) => topic.labels)), priorities: add(lists.priorities, topics.map((topic) => topic.priority)),
    phases: add(lists.phases, topics.map((topic) => topic.stage)), companies: add(lists.companies, topics.map((topic) => topic.assignedTo)),
  };
}

/** Ajoute des observations (numérotées à la suite) ; une observation dont l'origine existe déjà n'est pas ajoutée. */
export function addObservations(book: ObservationBook, list: readonly Observation[]): { book: ObservationBook; added: number } {
  const origins = new Set(book.topics.flatMap((topic) => (topic.origin ? [topic.origin] : [])));
  let number = nextNumber(book.topics);
  const fresh = list.filter((topic) => !topic.origin || !origins.has(topic.origin)).map((topic) => ({ ...topic, number: number++ }));
  const topics = [...book.topics, ...fresh];
  return { book: { ...book, topics, lists: extendLists(book.lists, fresh) }, added: fresh.length };
}

// ------------------------------------------------------------------ fusion (import d'un .bcf, JSON déposé)

const time = (iso: string | undefined) => (iso ? Date.parse(iso) || 0 : 0);

function unionBy<T extends { guid: string }>(base: readonly T[], other: readonly T[], fill: (mine: T, theirs: T) => T = (mine) => mine): T[] {
  const byGuid = new Map(other.map((item) => [item.guid.toLowerCase(), item]));
  const seen = new Set(base.map((item) => item.guid.toLowerCase()));
  return [...base.map((item) => { const twin = byGuid.get(item.guid.toLowerCase()); return twin ? fill(item, twin) : item; }), ...other.filter((item) => !seen.has(item.guid.toLowerCase()))];
}

/**
 * Une même observation venue de deux côtés : la plus récemment modifiée l'emporte champ par champ ; commentaires, points de
 * vue et documents sont réunis par GUID (photos et images reprises de l'autre côté s'il le faut) ; les éléments gardent leur
 * maquette, et le repère, le point et l'emplacement viennent du côté qui les a.
 */
export function mergeTopic(mine: Observation, theirs: Observation): Observation {
  const newer = time(theirs.modifiedDate ?? theirs.creationDate) >= time(mine.modifiedDate ?? mine.creationDate);
  const [base, other] = newer ? [theirs, mine] : [mine, theirs];
  return defined({
    ...base,
    number: mine.number,
    comments: unionBy(base.comments, other.comments).sort((a, b) => time(a.date) - time(b.date)),
    viewpoints: unionBy(base.viewpoints, other.viewpoints, (item, twin) => defined({ ...item, snapshot: item.snapshot ?? twin.snapshot })),
    documents: unionBy<BcfDocument>(base.documents, other.documents, (item, twin) => defined({ ...item, data: item.data ?? twin.data })),
    elements: [mine, theirs].find((topic) => topic.elements.some((ref) => ref.model !== undefined))?.elements ?? base.elements,
    pin: base.pin ?? other.pin,
    point: base.point ?? other.point,
    location: { ...other.location, ...base.location },
    origin: base.origin ?? other.origin,
  });
}

/** Réunit deux carnets par GUID de sujet : un sujet nouveau est ajouté (numéro gardé s'il est libre), un sujet connu est fusionné. */
export function mergeBooks(current: ObservationBook, incoming: ObservationBook): { book: ObservationBook; added: number; updated: number } {
  const topics = [...current.topics];
  const index = new Map(topics.map((topic, i) => [topic.guid.toLowerCase(), i]));
  const numbers = new Set(topics.map((topic) => topic.number));
  let added = 0, updated = 0;
  for (const topic of incoming.topics) {
    const at = index.get(topic.guid.toLowerCase());
    if (at !== undefined) {
      topics[at] = mergeTopic(topics[at], topic);
      updated++;
      continue;
    }
    const number = topic.number > 0 && !numbers.has(topic.number) ? topic.number : nextNumber(topics);
    numbers.add(number);
    index.set(topic.guid.toLowerCase(), topics.length);
    topics.push({ ...topic, number });
    added++;
  }
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  const { lists } = current, other = incoming.lists;
  const merged: ObservationLists = {
    kinds: union(lists.kinds, other.kinds), statuses: union(lists.statuses, other.statuses), done: union(lists.done, other.done), trades: union(lists.trades, other.trades),
    priorities: union(lists.priorities, other.priorities), phases: union(lists.phases, other.phases), companies: union(lists.companies, other.companies),
    transitions: { ...other.transitions, ...lists.transitions },
  };
  return { book: { settings: { ...incoming.settings, ...defined(current.settings) }, lists: extendLists(merged, topics), topics }, added, updated };
}

// ------------------------------------------------------------------ section `observations` du JSON

/** La section du contrat : réglages, listes, observations sans photos ni images (elles sont dans le .bcf). Vide : rien. */
export function observationsToJson(book: ObservationBook): Record<string, unknown> | undefined {
  const settings = defined(book.settings);
  if (book.topics.length === 0 && Object.keys(settings).length === 0 && JSON.stringify(book.lists) === JSON.stringify(defaultLists())) return undefined;
  return {
    settings,
    lists: structuredClone(book.lists),
    topics: book.topics.map((topic) => ({
      ...topic,
      viewpoints: topic.viewpoints.map(({ snapshot: _snapshot, ...viewpoint }) => viewpoint),
      documents: topic.documents.map(({ data: _data, ...document }) => document),
    })),
  };
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const vec3 = (value: unknown): Vec3 | undefined => (Array.isArray(value) && value.length === 3 && value.every(finite) ? [value[0], value[1], value[2]] : undefined);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);

function parseViewpoint(raw: Record<string, unknown>): BcfViewpoint | null {
  if (typeof raw.guid !== 'string') return null;
  const camera = isRecord(raw.camera) ? raw.camera : undefined;
  const viewPoint = vec3(camera?.viewPoint), direction = vec3(camera?.direction), up = vec3(camera?.up);
  return defined({
    guid: raw.guid,
    camera: camera && viewPoint && direction && up && (camera.kind === 'perspective' || camera.kind === 'orthogonal') ? defined({
      kind: camera.kind as BcfCamera['kind'], viewPoint, direction, up,
      fieldOfView: finite(camera.fieldOfView) ? camera.fieldOfView : undefined, viewToWorldScale: finite(camera.viewToWorldScale) ? camera.viewToWorldScale : undefined, aspectRatio: finite(camera.aspectRatio) ? camera.aspectRatio : undefined,
    }) : undefined,
    clippingPlanes: records(raw.clippingPlanes).flatMap((plane) => { const location = vec3(plane.location), dir = vec3(plane.direction); return location && dir ? [{ location, direction: dir }] : []; }),
    selection: records(raw.selection).map((component) => defined({ ifcGuid: str(component.ifcGuid), originatingSystem: str(component.originatingSystem), authoringToolId: str(component.authoringToolId) })),
  });
}

function parseTopic(raw: Record<string, unknown>, index: number): Observation | null {
  if (typeof raw.guid !== 'string' || typeof raw.title !== 'string' || typeof raw.creationDate !== 'string') return null;
  const pin = isRecord(raw.pin) && typeof raw.pin.plan === 'string' && finite(raw.pin.x) && finite(raw.pin.y) ? { plan: raw.pin.plan, x: raw.pin.x, y: raw.pin.y } : undefined;
  const location = isRecord(raw.location) ? defined({ level: str(raw.location.level), room: str(raw.location.room), zone: str(raw.location.zone) }) : {};
  return defined({
    guid: raw.guid, type: str(raw.type) ?? '', status: str(raw.status) ?? '', title: raw.title, priority: str(raw.priority), labels: strings(raw.labels),
    creationDate: raw.creationDate, creationAuthor: str(raw.creationAuthor) ?? '', modifiedDate: str(raw.modifiedDate), modifiedAuthor: str(raw.modifiedAuthor),
    dueDate: str(raw.dueDate), assignedTo: str(raw.assignedTo), stage: str(raw.stage), description: str(raw.description),
    referenceLinks: strings(raw.referenceLinks), relatedTopics: strings(raw.relatedTopics),
    documents: records(raw.documents).flatMap((document) => (typeof document.guid === 'string' && typeof document.filename === 'string'
      ? [defined({ guid: document.guid, documentGuid: str(document.documentGuid), filename: document.filename, description: str(document.description), url: str(document.url) })] : [])),
    comments: records(raw.comments).flatMap((comment) => (typeof comment.guid === 'string' && typeof comment.date === 'string'
      ? [defined({ guid: comment.guid, date: comment.date, author: str(comment.author) ?? '', text: str(comment.text) ?? '', viewpoint: str(comment.viewpoint), modifiedDate: str(comment.modifiedDate), modifiedAuthor: str(comment.modifiedAuthor) })] : [])),
    viewpoints: records(raw.viewpoints).flatMap((viewpoint) => parseViewpoint(viewpoint) ?? []),
    number: finite(raw.number) && raw.number > 0 ? raw.number : index + 1,
    elements: records(raw.elements).flatMap((ref) => (typeof ref.key === 'string' && ref.key ? [defined({ key: ref.key, model: str(ref.model) })] : [])),
    pin, point: vec3(raw.point), location, origin: str(raw.origin),
  });
}

/** Lit la section `observations` ; une section illisible donne `undefined`, une observation illisible est écartée. */
export function parseObservations(raw: unknown): ObservationBook | undefined {
  if (!isRecord(raw)) return undefined;
  const defaults = defaultLists();
  const given = isRecord(raw.lists) ? raw.lists : {};
  const list = (name: Exclude<keyof ObservationLists, 'transitions'>) => (Array.isArray(given[name]) ? strings(given[name]) : defaults[name]);
  const transitions = isRecord(given.transitions)
    ? Object.fromEntries(Object.entries(given.transitions).filter(([, next]) => Array.isArray(next)).map(([status, next]) => [status, strings(next)]))
    : defaults.transitions;
  const settings = isRecord(raw.settings) ? defined({ level: str(raw.settings.level), room: str(raw.settings.room), zone: str(raw.settings.zone) }) : {};
  return {
    settings,
    lists: { kinds: list('kinds'), statuses: list('statuses'), done: list('done'), trades: list('trades'), priorities: list('priorities'), phases: list('phases'), companies: list('companies'), transitions },
    topics: records(raw.topics).flatMap((topic, i) => parseTopic(topic, i) ?? []),
  };
}

// ------------------------------------------------------------------ CSV

/** La liste en CSV (« ; », pour un tableur réglé en français) : une ligne par observation. */
export function observationsCsv(topics: readonly Observation[]): string {
  const header = ['N°', 'Titre', 'Type', 'Statut', 'Entreprise', 'Lot', 'Phase', 'Priorité', 'Échéance', 'Niveau', 'Local', 'Zone', 'Créée le', 'Auteur', 'Description', 'Identifiant'];
  const rows = topics.map((topic) => [
    topic.number, topic.title, topic.type, topic.status, topic.assignedTo ?? '', topic.labels.join(', '), topic.stage ?? '', topic.priority ?? '',
    frenchDate(topic.dueDate), topic.location.level ?? '', topic.location.room ?? '', topic.location.zone ?? '', frenchDate(topic.creationDate), topic.creationAuthor, topic.description ?? '', topic.guid,
  ]);
  return [header, ...rows].map((row) => row.map((cell) => csvCell(cell)).join(';')).join('\r\n');
}
