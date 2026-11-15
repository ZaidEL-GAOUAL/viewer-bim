// Le lien entre la maquette ouverte dans le viewer et un projet du suivi de chantier, chargé à la demande (viewerLink.ts). Lié,
// le carnet d'observations du viewer est réuni à celui du projet (par GUID, comme un .bcf ouvert), puis chaque modification
// faite dans le viewer est écrite dans le magasin de l'appareil du suivi de chantier (même base que chantier.html) et envoyée
// avec lui quand un compte est connecté ; ce qui arrive du serveur revient dans le viewer. Le serveur (et son client) ne sont
// chargés qu'une fois la maquette liée.

import { mergeBooks, observationsToJson, type ObservationBook } from '../data/observations.ts';
import type { App } from '../ui/App.ts';
import { authorName } from '../ui/ObservationsPanel.ts';
import { button, clear, h, stored } from '../ui/dom.ts';
import { connectBackend, localDatabase } from './backend/connect.ts';
import { openKv } from './kv.ts';
import type { TopicRow } from './rows.ts';
import { ChantierStore } from './store.ts';
import { linkKey } from './viewerLink.ts';

interface Link {
  file: string;
  projectId: string;
  /** Les observations du viewer à la dernière écriture : celle qui en disparaît est supprimée du projet. */
  known: Set<string>;
}

let local: Promise<ChantierStore> | null = null;
let synced: Promise<ChantierStore> | null = null;
let current: Link | null = null;
let listening = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Le magasin de l'appareil ; `withServer` : avec le serveur (seulement pour une maquette liée). */
function openStore(withServer: boolean): Promise<ChantierStore> {
  if (withServer) {
    synced ??= (async () => {
      const store = await ChantierStore.open(await openKv(localDatabase()), await connectBackend().catch(() => null));
      store.autoSync = true;
      return store;
    })();
    return synced;
  }
  local ??= openKv(localDatabase()).then((kv) => ChantierStore.open(kv, null));
  return synced ?? local;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const textOf = (book: ObservationBook) => JSON.stringify(observationsToJson(book) ?? null);

/**
 * Réunit les observations du projet à celles du viewer ; les numéros sont ceux du projet. Celles que le projet garde
 * supprimées quittent le viewer (elles ne reviennent pas au projet) ; celles d'un autre projet y entrent sous de nouveaux
 * identifiants (`forProject`).
 */
async function pull(app: App, store: ChantierStore, link: Link): Promise<void> {
  if (app.fileName !== link.file) return;
  const project = await store.book(link.projectId);
  const deleted = new Set((await store.rows<TopicRow>('topics', link.projectId)).filter((row) => row.deleted_at).map((row) => row.id));
  const viewer = await store.forProject(link.projectId, app.observations.topics.filter((topic) => !deleted.has(topic.guid)));
  const numbers = new Map(project.topics.filter((topic) => topic.number > 0).map((topic) => [topic.guid, topic.number]));
  const { book } = mergeBooks({ ...app.observations, topics: viewer }, project);
  const merged = { ...book, topics: book.topics.map((topic) => ({ ...topic, number: numbers.get(topic.guid) ?? topic.number })) };
  if (textOf(merged) !== textOf(app.observations)) app.setObservations(merged, false);
  link.known = new Set(merged.topics.map((topic) => topic.guid));
}

/** Écrit dans le projet ce que le viewer a changé ; une observation retirée dans le viewer est supprimée du projet. */
async function push(app: App, store: ChantierStore, link: Link): Promise<void> {
  if (current !== link || app.fileName !== link.file) return;
  const book = app.observations;
  // Une observation d'un autre projet (un .bcf ouvert dans le viewer lié) : le viewer prend ses nouveaux identifiants.
  const topics = await store.forProject(link.projectId, book.topics);
  if (topics.some((topic, i) => topic !== book.topics[i]) && app.observations === book) app.setObservations({ ...book, topics }, false);
  await store.saveObservations(link.projectId, topics);
  const present = new Set(topics.map((topic) => topic.guid));
  for (const guid of link.known) if (!present.has(guid)) await store.deleteObservation(link.projectId, guid, authorName());
  link.known = present;
  // Photos et images sont gardées sur l'appareil avec le projet : plus rien n'est seulement dans la page.
  app.observationsUnsaved = false;
}

/** La maquette ouverte est liée : ses observations et celles du projet sont réunies, puis suivies dans les deux sens. */
export async function attach(app: App): Promise<void> {
  const projectId = stored.get(linkKey(app.fileName));
  current = null;
  if (!projectId || !app.model) return;
  const store = await openStore(true);
  if (!(await store.project(projectId))) {
    app.toast('Le projet lié à cette maquette n’est plus sur cet appareil : lien retiré.', true);
    stored.set(linkKey(app.fileName), null);
    return;
  }
  const link: Link = { file: app.fileName, projectId, known: new Set() };
  current = link;
  await store.openProject(projectId);
  await pull(app, store, link);
  await push(app, store, link);
  if (listening) return;
  listening = true;
  app.on('observations', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const active = current;
      if (active) void push(app, store, active).catch((error) => app.toast(`Projet lié : enregistrement impossible : ${errorText(error)}`, true));
    }, 800);
  });
  store.onChange(() => {
    const active = current;
    if (active && store.state.phase === 'done') void pull(app, store, active);
  });
}

/** Le contenu de la carte : choisir un projet et lier, ou l'état du lien. */
export async function render(app: App, card: HTMLElement, openObservations: () => void): Promise<void> {
  const head = h('div', { class: 'card-head' }, h('h2', { class: 'card-title', text: 'Projet du suivi de chantier' }),
    button('×', () => { card.hidden = true; }, { class: 'close-button', title: 'Fermer', attrs: { 'aria-label': 'Fermer' } }));
  const hint = (text: string) => h('p', { class: 'hint', text });
  if (!app.model) {
    clear(card);
    card.append(head, hint('Ouvrez d’abord une maquette.'));
    return;
  }
  const projectId = stored.get(linkKey(app.fileName));
  const store = await openStore(projectId !== null);
  const projects = await store.projects();
  const nodes: (Node | null)[] = [head];
  const linked = projectId ? projects.find((project) => project.id === projectId) : undefined;
  if (linked && current?.projectId === linked.id) {
    const { waiting } = await store.pending();
    nodes.push(
      hint(`« ${app.fileName} » est liée au projet « ${linked.name} » : ses observations sont celles du projet, gardées sur cet appareil.`),
      hint(!store.backend ? 'Aucun serveur configuré : elles restent sur cet appareil.'
        : !store.account ? 'Non synchronisé — connectez-vous dans le suivi de chantier pour les retrouver ailleurs.'
          : waiting > 0 ? `${waiting} modification${waiting > 1 ? 's' : ''} à envoyer.` : 'Synchronisé.'),
      h('div', { class: 'tool-row' },
        button('Observations de ce projet', openObservations, { class: 'primary', title: 'Ouvrir la liste des observations (celles du projet)' }),
        h('a', { text: 'Ouvrir le suivi de chantier', attrs: { href: `chantier.html#/p/${linked.id}`, target: '_blank', rel: 'noopener' } }),
        button('Délier', () => {
          stored.set(linkKey(app.fileName), null);
          current = null;
          app.toast('Lien retiré : les observations restent dans le projet et dans cette page.');
          void render(app, card, openObservations);
        }, { title: 'Les observations faites ensuite ne vont plus dans le projet' })),
    );
  } else if (projects.length === 0) {
    nodes.push(hint('Aucun projet sur cet appareil.'), h('p', { class: 'hint' }, 'Créez-en un dans le ', h('a', { text: 'suivi de chantier', attrs: { href: 'chantier.html', target: '_blank', rel: 'noopener' } }), ', puis revenez ici.'));
  } else {
    const choice = h('select', { attrs: { 'aria-label': 'Projet' } }, ...projects.map((project) => h('option', { text: project.name, attrs: { value: project.id } })));
    nodes.push(
      hint('Lier la maquette à un projet : ses observations (photos et images comprises) rejoignent le projet et celles du projet viennent ici. Sans lien, elles restent dans les fichiers exportés, comme avant.'),
      h('div', { class: 'tool-row' }, choice, button('Lier à ce projet', () => {
        stored.set(linkKey(app.fileName), choice.value);
        app.busy('Lien avec le projet…');
        void attach(app)
          .then(() => app.toast(`Maquette liée au projet « ${choice.selectedOptions[0]?.text ?? ''} ».`))
          .catch((error) => app.toast(`Lien impossible : ${errorText(error)}`, true))
          .finally(() => {
            app.busy(null);
            void render(app, card, openObservations);
          });
      }, { class: 'primary' })),
    );
  }
  clear(card);
  card.append(...nodes.filter((node): node is Node => node !== null));
}
