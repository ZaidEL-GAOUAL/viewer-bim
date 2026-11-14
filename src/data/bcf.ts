// BCF (BIM Collaboration Format, buildingSMART) : écriture en 3.0, lecture des versions 2.1 et 3.0. Un sujet (« topic »)
// avec ses commentaires, ses points de vue (caméra, plans de coupe, éléments sélectionnés, image) et ses documents.
// Écrit au plus près du schéma 3.0 : GUID, dates ISO 8601, image de point de vue PNG ou JPEG d'au plus 1 500 px de côté,
// champ de vision entre 45 et 60°, éléments par GlobalId IFC (`IfcGuid`) ou, à défaut, par l'identifiant de l'outil auteur
// (`AuthoringToolId`). Coordonnées : celles du modèle d'origine, Z vers le haut, en mètres (voir data/modelFrame.ts).
//
// Non pris en charge (lu sans erreur, pas réécrit) : en-tête (fichiers IFC), extraits BIM (« BimSnippet »), visibilité par
// élément (exceptions), couleurs par élément, lignes, images posées dans la vue (« Bitmaps »), listes de 2.1 (extensions.xsd).

import { child, children, parseXml, XML_HEADER, xmlElement, xmlText, type XmlNode } from './xml.ts';
import { readZip, writeZip, type Inflate, type ZipInput } from './zip.ts';

export type Vec3 = [number, number, number];

/** Un élément désigné dans un point de vue. */
export interface BcfComponent {
  ifcGuid?: string;
  originatingSystem?: string;
  authoringToolId?: string;
}

export interface BcfCamera {
  kind: 'perspective' | 'orthogonal';
  viewPoint: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Perspective : champ vertical, en degrés. */
  fieldOfView?: number;
  /** Projection parallèle : hauteur de la vue, en mètres. */
  viewToWorldScale?: number;
  /** Largeur / hauteur de la vue (3.0 ; absente des fichiers 2.1). */
  aspectRatio?: number;
}

/** Un plan de coupe : `direction` est tournée vers la partie retirée. */
export interface BcfClippingPlane {
  location: Vec3;
  direction: Vec3;
}

export interface BcfViewpoint {
  guid: string;
  camera?: BcfCamera;
  clippingPlanes: BcfClippingPlane[];
  selection: BcfComponent[];
  /** PNG ou JPEG. */
  snapshot?: Blob;
}

export interface BcfComment {
  guid: string;
  date: string;
  author: string;
  text: string;
  /** Le point de vue commenté (son GUID). */
  viewpoint?: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
}

/** Un document joint : dans le fichier (`data`) ou désigné par une adresse (`url`). */
export interface BcfDocument {
  guid: string;
  /** Le GUID du document lui-même (3.0) quand il diffère de celui de la référence. */
  documentGuid?: string;
  filename: string;
  description?: string;
  url?: string;
  data?: Blob;
}

export interface BcfTopic {
  guid: string;
  type: string;
  status: string;
  title: string;
  priority?: string;
  labels: string[];
  creationDate: string;
  creationAuthor: string;
  modifiedDate?: string;
  modifiedAuthor?: string;
  dueDate?: string;
  assignedTo?: string;
  stage?: string;
  description?: string;
  referenceLinks: string[];
  relatedTopics: string[];
  documents: BcfDocument[];
  comments: BcfComment[];
  viewpoints: BcfViewpoint[];
}

/** Les listes de valeurs du projet (extensions.xml). */
export interface BcfExtensions {
  topicTypes: string[];
  topicStatuses: string[];
  priorities: string[];
  topicLabels: string[];
  users: string[];
  stages: string[];
}

export const emptyExtensions = (): BcfExtensions => ({ topicTypes: [], topicStatuses: [], priorities: [], topicLabels: [], users: [], stages: [] });

/** Plus grand côté d'une image de point de vue, en pixels (BCF 3.0). */
export const SNAPSHOT_MAX = 1500;
const FOV_MIN = 45, FOV_MAX = 60;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

export const newGuid = (): string => globalThis.crypto.randomUUID();

/** Largeur, hauteur et type d'une image PNG ou JPEG, lus dans son en-tête ; null pour autre chose. */
export function imageSize(bytes: Uint8Array): { width: number; height: number; type: 'png' | 'jpeg' } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47 && view.getUint32(12) === 0x49484452) return { width: view.getUint32(16), height: view.getUint32(20), type: 'png' };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    // SOF0 à SOF15, sauf DHT (C4), JPG (C8) et DAC (CC) : la taille de l'image.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: view.getUint16(i + 7), height: view.getUint16(i + 5), type: 'jpeg' };
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

/** Un objet sans ses champs `undefined` : ce qu'un fichier relu redonne. */
export const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

// ------------------------------------------------------------------ écriture

const vec = (name: string, [x, y, z]: Vec3) => xmlElement(name, {}, [xmlText('X', x), xmlText('Y', y), xmlText('Z', z)]);

function visualizationInfo(viewpoint: BcfViewpoint): string {
  const camera = viewpoint.camera;
  const pose = camera ? [vec('CameraViewPoint', camera.viewPoint), vec('CameraDirection', camera.direction), vec('CameraUpVector', camera.up)] : [];
  return XML_HEADER + xmlElement('VisualizationInfo', { Guid: viewpoint.guid.toLowerCase() }, [
    xmlElement('Components', {}, [
      viewpoint.selection.length > 0 ? xmlElement('Selection', {}, viewpoint.selection.map((component) => xmlElement('Component', { IfcGuid: component.ifcGuid }, [xmlText('OriginatingSystem', component.originatingSystem), xmlText('AuthoringToolId', component.authoringToolId)]))) : '',
      xmlElement('Visibility', { DefaultVisibility: true }, []),
    ]),
    !camera ? '' : camera.kind === 'perspective'
      ? xmlElement('PerspectiveCamera', {}, [...pose, xmlText('FieldOfView', Math.min(FOV_MAX, Math.max(FOV_MIN, camera.fieldOfView ?? FOV_MAX))), xmlText('AspectRatio', camera.aspectRatio ?? 1)])
      : xmlElement('OrthogonalCamera', {}, [...pose, xmlText('ViewToWorldScale', camera.viewToWorldScale ?? 1), xmlText('AspectRatio', camera.aspectRatio ?? 1)]),
    viewpoint.clippingPlanes.length > 0 ? xmlElement('ClippingPlanes', {}, viewpoint.clippingPlanes.map((plane) => xmlElement('ClippingPlane', {}, [vec('Location', plane.location), vec('Direction', plane.direction)]))) : '',
  ]);
}

function markup(topic: BcfTopic, files: { viewpoint: string; snapshot?: string }[]): string {
  const documents = topic.documents.filter((document) => document.data || document.url !== undefined);
  const list = (name: string, item: string, values: readonly string[]) => (values.length > 0 ? xmlElement(name, {}, values.map((value) => xmlText(item, value))) : '');
  return XML_HEADER + xmlElement('Markup', {}, [xmlElement('Topic', { Guid: topic.guid.toLowerCase(), TopicType: topic.type, TopicStatus: topic.status }, [
    list('ReferenceLinks', 'ReferenceLink', topic.referenceLinks),
    xmlText('Title', topic.title),
    xmlText('Priority', topic.priority),
    list('Labels', 'Label', topic.labels),
    xmlText('CreationDate', topic.creationDate),
    xmlText('CreationAuthor', topic.creationAuthor),
    xmlText('ModifiedDate', topic.modifiedDate),
    xmlText('ModifiedAuthor', topic.modifiedAuthor),
    xmlText('DueDate', topic.dueDate),
    xmlText('AssignedTo', topic.assignedTo),
    xmlText('Stage', topic.stage),
    xmlText('Description', topic.description),
    documents.length > 0 ? xmlElement('DocumentReferences', {}, documents.map((document) => xmlElement('DocumentReference', { Guid: document.guid.toLowerCase() }, [
      document.data ? xmlText('DocumentGuid', (document.documentGuid ?? document.guid).toLowerCase()) : xmlText('Url', document.url),
      xmlText('Description', document.description),
    ]))) : '',
    topic.relatedTopics.length > 0 ? xmlElement('RelatedTopics', {}, topic.relatedTopics.map((guid) => xmlElement('RelatedTopic', { Guid: guid.toLowerCase() }, []))) : '',
    topic.comments.length > 0 ? xmlElement('Comments', {}, topic.comments.map((comment) => xmlElement('Comment', { Guid: comment.guid.toLowerCase() }, [
      xmlText('Date', comment.date), xmlText('Author', comment.author), xmlText('Comment', comment.text),
      comment.viewpoint ? xmlElement('Viewpoint', { Guid: comment.viewpoint.toLowerCase() }, []) : '',
      xmlText('ModifiedDate', comment.modifiedDate), xmlText('ModifiedAuthor', comment.modifiedAuthor),
    ]))) : '',
    topic.viewpoints.length > 0 ? xmlElement('Viewpoints', {}, topic.viewpoints.map((viewpoint, i) => xmlElement('ViewPoint', { Guid: viewpoint.guid.toLowerCase() }, [xmlText('Viewpoint', files[i].viewpoint), xmlText('Snapshot', files[i].snapshot)]))) : '',
  ])]);
}

/** Ce que le schéma interdit, refusé avant d'écrire quoi que ce soit (un message qui dit quel sujet). */
async function check(topic: BcfTopic): Promise<void> {
  const where = `« ${topic.title || topic.guid} »`;
  const guids = [topic.guid, ...topic.relatedTopics, ...topic.comments.flatMap((c) => [c.guid, ...(c.viewpoint ? [c.viewpoint] : [])]), ...topic.viewpoints.map((v) => v.guid), ...topic.documents.flatMap((d) => [d.guid, ...(d.documentGuid ? [d.documentGuid] : [])])];
  const bad = guids.find((guid) => !GUID.test(guid));
  if (bad !== undefined) throw new Error(`${where} : « ${bad} » n’est pas un GUID.`);
  const dates = [topic.creationDate, topic.modifiedDate, topic.dueDate, ...topic.comments.flatMap((c) => [c.date, c.modifiedDate])].filter((date): date is string => date !== undefined);
  const wrong = dates.find((date) => !DATE.test(date));
  if (wrong !== undefined) throw new Error(`${where} : « ${wrong} » n’est pas une date ISO 8601.`);
  for (const viewpoint of topic.viewpoints) {
    if (!viewpoint.snapshot) continue;
    const size = imageSize(new Uint8Array(await viewpoint.snapshot.arrayBuffer()));
    if (!size) throw new Error(`${where} : l’image du point de vue n’est ni un PNG ni un JPEG.`);
    if (Math.max(size.width, size.height) > SNAPSHOT_MAX) throw new Error(`${where} : l’image du point de vue dépasse 1 500 px de côté (${size.width} × ${size.height}).`);
  }
}

/**
 * Un fichier BCF 3.0 : `bcf.version`, `extensions.xml`, un dossier par sujet (`markup.bcf`, un `.bcfv` et une image par
 * point de vue), les documents joints dans `Documents/` avec `documents.xml`. Un document sans contenu ni adresse (photo
 * restée dans un autre fichier) n'est pas écrit.
 */
export async function writeBcf(topics: readonly BcfTopic[], extensions: BcfExtensions = emptyExtensions()): Promise<Blob> {
  for (const topic of topics) await check(topic);
  const text = (value: string) => new TextEncoder().encode(value);
  const files: ZipInput[] = [{ name: 'bcf.version', data: text(`${XML_HEADER}<Version VersionId="3.0"/>`) }];
  const group = (name: string, item: string, values: readonly string[]) => (values.length > 0 ? xmlElement(name, {}, values.map((value) => xmlText(item, value))) : '');
  files.push({ name: 'extensions.xml', data: text(XML_HEADER + xmlElement('Extensions', {}, [
    group('TopicTypes', 'TopicType', extensions.topicTypes), group('TopicStatuses', 'TopicStatus', extensions.topicStatuses),
    group('Priorities', 'Priority', extensions.priorities), group('TopicLabels', 'TopicLabel', extensions.topicLabels),
    group('Users', 'User', extensions.users), group('Stages', 'Stage', extensions.stages),
  ])) });
  const documents: string[] = [];
  for (const topic of topics) {
    const folder = topic.guid.toLowerCase();
    const names = topic.viewpoints.map((viewpoint, i) => {
      const suffix = i === 0 ? '' : `-${viewpoint.guid.toLowerCase()}`;
      return { viewpoint: `viewpoint${suffix}.bcfv`, snapshot: viewpoint.snapshot ? `snapshot${suffix}.${viewpoint.snapshot.type === 'image/jpeg' ? 'jpg' : 'png'}` : undefined };
    });
    files.push({ name: `${folder}/markup.bcf`, data: text(markup(topic, names)) });
    topic.viewpoints.forEach((viewpoint, i) => {
      files.push({ name: `${folder}/${names[i].viewpoint}`, data: text(visualizationInfo(viewpoint)) });
      if (viewpoint.snapshot) files.push({ name: `${folder}/${names[i].snapshot}`, data: viewpoint.snapshot });
    });
    for (const document of topic.documents) {
      if (!document.data) continue;
      const guid = (document.documentGuid ?? document.guid).toLowerCase();
      documents.push(xmlElement('Document', { Guid: guid }, [xmlText('Filename', document.filename)]));
      files.push({ name: `Documents/${guid}`, data: document.data });
    }
  }
  if (documents.length > 0) files.push({ name: 'documents.xml', data: text(XML_HEADER + xmlElement('DocumentInfo', {}, [xmlElement('Documents', {}, documents)])) });
  return writeZip(files);
}

// ------------------------------------------------------------------ lecture

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? '';
const baseName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/** Un chemin relatif au dossier `folder`, ramené à la racine de l'archive. */
function resolvePath(folder: string, path: string): string {
  const parts = folder ? folder.split('/') : [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

const number = (node: XmlNode | undefined): number | undefined => {
  const value = node ? Number(node.text.trim()) : NaN;
  return Number.isFinite(value) ? value : undefined;
};
const vector = (node: XmlNode | undefined): Vec3 | undefined => {
  const values = ['X', 'Y', 'Z'].map((axis) => number(child(node, axis)));
  return values.every((value) => value !== undefined) ? (values as Vec3) : undefined;
};
const textOf = (node: XmlNode | undefined, name: string): string | undefined => child(node, name)?.text;

function readCamera(info: XmlNode | undefined): BcfCamera | undefined {
  const perspective = child(info, 'PerspectiveCamera'), node = perspective ?? child(info, 'OrthogonalCamera');
  const viewPoint = vector(child(node, 'CameraViewPoint')), direction = vector(child(node, 'CameraDirection')), up = vector(child(node, 'CameraUpVector'));
  if (!node || !viewPoint || !direction || !up) return undefined;
  return defined({
    kind: perspective ? 'perspective' : 'orthogonal', viewPoint, direction, up,
    fieldOfView: perspective ? number(child(node, 'FieldOfView')) : undefined,
    viewToWorldScale: perspective ? undefined : number(child(node, 'ViewToWorldScale')),
    aspectRatio: number(child(node, 'AspectRatio')),
  } satisfies BcfCamera);
}

function readViewpointFile(xml: string, guid: string): Omit<BcfViewpoint, 'snapshot'> {
  const info = child(parseXml(xml), 'VisualizationInfo');
  return defined({
    guid,
    camera: readCamera(info),
    clippingPlanes: children(child(info, 'ClippingPlanes'), 'ClippingPlane').flatMap((plane) => {
      const location = vector(child(plane, 'Location')), direction = vector(child(plane, 'Direction'));
      return location && direction ? [{ location, direction }] : [];
    }),
    selection: children(child(child(info, 'Components'), 'Selection'), 'Component').map((component) => defined({
      ifcGuid: component.attributes.IfcGuid, originatingSystem: textOf(component, 'OriginatingSystem')?.trim(), authoringToolId: textOf(component, 'AuthoringToolId')?.trim(),
    })),
  });
}

export interface BcfRead {
  /** « 2.1 » ou « 3.0 » (VersionId de bcf.version). */
  version: string;
  topics: BcfTopic[];
  extensions: BcfExtensions;
  /** Ce qui n'a pas pu être lu, en phrases. */
  notes: string[];
}

/** Lit un fichier BCF 2.1 ou 3.0. Un sujet illisible est écarté et noté ; les autres sont lus. */
export async function readBcf(file: Blob, inflate?: Inflate): Promise<BcfRead> {
  const entries = await readZip(file, inflate);
  const decoder = new TextDecoder();
  const read = async (name: string) => decoder.decode(await entries.get(name)!.bytes());
  const blob = async (name: string): Promise<Blob | undefined> => {
    if (!entries.has(name)) return undefined;
    const bytes = await entries.get(name)!.bytes();
    const kind = imageSize(bytes)?.type;
    return new Blob([bytes.slice()], { type: kind ? `image/${kind}` : mimeOf(name) });
  };
  const notes: string[] = [];
  let version = '';
  if (entries.has('bcf.version')) version = child(parseXml(await read('bcf.version')), 'Version')?.attributes.VersionId?.trim() ?? '';
  else notes.push('bcf.version manque : lu comme un BCF 2.1.');
  if (version && !/^[23]\./.test(version)) throw new Error(`BCF ${version} non pris en charge (versions lues : 2.1 et 3.0).`);

  const extensions = emptyExtensions();
  if (entries.has('extensions.xml')) {
    const node = child(parseXml(await read('extensions.xml')), 'Extensions');
    const list = (group: string, item: string) => children(child(node, group), item).map((value) => value.text.trim()).filter(Boolean);
    Object.assign(extensions, { topicTypes: list('TopicTypes', 'TopicType'), topicStatuses: list('TopicStatuses', 'TopicStatus'), priorities: list('Priorities', 'Priority'), topicLabels: list('TopicLabels', 'TopicLabel'), users: list('Users', 'User'), stages: list('Stages', 'Stage') });
  }
  const documentNames = new Map<string, string>();
  if (entries.has('documents.xml')) {
    for (const node of children(child(child(parseXml(await read('documents.xml')), 'DocumentInfo'), 'Documents'), 'Document')) {
      if (node.attributes.Guid) documentNames.set(node.attributes.Guid.toLowerCase(), textOf(node, 'Filename')?.trim() ?? node.attributes.Guid);
    }
  }
  const lowerNames = new Map([...entries.keys()].map((name) => [name.toLowerCase(), name]));

  const topics: BcfTopic[] = [];
  for (const name of entries.keys()) {
    const match = /^([^/]+)\/markup\.bcf$/i.exec(name);
    if (!match) continue;
    const folder = match[1];
    try {
      const root = child(parseXml(await read(name)), 'Markup');
      const node = child(root, 'Topic');
      if (!node) throw new Error('aucun sujet');
      // 3.0 : listes regroupées dans le sujet ; 2.1 : éléments répétés (commentaires et points de vue à côté du sujet).
      const nested = (group: string, item: string, flat: XmlNode | undefined = node) => {
        const inside = children(child(node, group), item);
        return inside.length > 0 ? inside : children(flat, group === 'Viewpoints' ? 'Viewpoints' : item);
      };
      const documents: BcfDocument[] = [];
      for (const reference of nested('DocumentReferences', 'DocumentReference')) {
        const documentGuid = textOf(reference, 'DocumentGuid')?.trim(), url = textOf(reference, 'Url')?.trim(), referenced = textOf(reference, 'ReferencedDocument')?.trim();
        const guid = reference.attributes.Guid ?? newGuid();
        const description = textOf(reference, 'Description');
        if (documentGuid) {
          const stored = lowerNames.get(`documents/${documentGuid.toLowerCase()}`);
          documents.push(defined({ guid, documentGuid: documentGuid.toLowerCase() === guid.toLowerCase() ? undefined : documentGuid, filename: documentNames.get(documentGuid.toLowerCase()) ?? documentGuid, description, data: stored ? await blob(stored) : undefined }));
        } else if (url) {
          documents.push(defined({ guid, filename: baseName(url), description, url }));
        } else if (referenced) {
          const external = reference.attributes.isExternal === 'true';
          const path = external ? '' : [resolvePath(folder, referenced), resolvePath('', referenced)].find((candidate) => entries.has(candidate)) ?? '';
          documents.push(defined({ guid, filename: baseName(referenced), description, url: external ? referenced : undefined, data: path ? await blob(path) : undefined }));
        }
      }
      const labels = children(node, 'Labels').flatMap((labelsNode) => (labelsNode.children.length > 0 ? children(labelsNode, 'Label').map((label) => label.text) : [labelsNode.text]));
      const viewpoints: BcfViewpoint[] = [];
      for (const reference of nested('Viewpoints', 'ViewPoint', root)) {
        const guid = reference.attributes.Guid ?? newGuid();
        const file = textOf(reference, 'Viewpoint')?.trim(), snapshot = textOf(reference, 'Snapshot')?.trim();
        const path = file ? `${folder}/${file}` : '';
        const viewpoint = path && entries.has(path) ? readViewpointFile(await read(path), guid) : { guid, clippingPlanes: [], selection: [] };
        viewpoints.push(defined({ ...viewpoint, snapshot: snapshot ? await blob(`${folder}/${snapshot}`) : undefined }));
      }
      topics.push(defined({
        guid: node.attributes.Guid ?? folder,
        type: node.attributes.TopicType ?? '',
        status: node.attributes.TopicStatus ?? '',
        title: textOf(node, 'Title') ?? '',
        priority: textOf(node, 'Priority'),
        labels,
        creationDate: textOf(node, 'CreationDate')?.trim() ?? '',
        creationAuthor: textOf(node, 'CreationAuthor') ?? '',
        modifiedDate: textOf(node, 'ModifiedDate')?.trim(),
        modifiedAuthor: textOf(node, 'ModifiedAuthor'),
        dueDate: textOf(node, 'DueDate')?.trim(),
        assignedTo: textOf(node, 'AssignedTo'),
        stage: textOf(node, 'Stage'),
        description: textOf(node, 'Description'),
        referenceLinks: nested('ReferenceLinks', 'ReferenceLink').map((link) => link.text.trim()),
        relatedTopics: nested('RelatedTopics', 'RelatedTopic').flatMap((related) => (related.attributes.Guid ? [related.attributes.Guid] : [])),
        documents,
        comments: nested('Comments', 'Comment', root).map((comment) => defined({
          guid: comment.attributes.Guid ?? newGuid(),
          date: textOf(comment, 'Date')?.trim() ?? '',
          author: textOf(comment, 'Author') ?? '',
          text: textOf(comment, 'Comment') ?? '',
          viewpoint: child(comment, 'Viewpoint')?.attributes.Guid,
          modifiedDate: textOf(comment, 'ModifiedDate')?.trim(),
          modifiedAuthor: textOf(comment, 'ModifiedAuthor'),
        })),
        viewpoints,
      }));
    } catch (error) {
      notes.push(`${name} illisible, sujet ignoré : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { version: version || '2.1', topics, extensions, notes };
}
