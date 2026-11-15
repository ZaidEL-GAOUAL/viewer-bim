import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBcf, writeBcf } from '../src/data/bcf.ts';
import { addComment, changeStatus, extensionsOf, newObservation, observationsToJson, toBcfTopic, touched, type Observation } from '../src/data/observations.ts';
import { MemoryBackend } from '../src/chantier/backend/memory.ts';
import { memoryKv } from '../src/chantier/kv.ts';
import { listsOf, type TopicRow } from '../src/chantier/rows.ts';
import { ChantierStore } from '../src/chantier/store.ts';

// Les écrans et la synchronisation contre le serveur en mémoire (mêmes règles que la base) et un stockage d'appareil en
// mémoire à la place d'IndexedDB (absent sous Node) : la même interface, `kv.ts`.

const PASSWORD = 'motdepasse';
const photo = (text: string) => new Blob([`photo ${text}`], { type: 'image/jpeg' });
const now = () => new Date();

async function signedIn(server: MemoryBackend, email: string, name = email.split('@')[0]): Promise<ChantierStore> {
  if (!server.state.users.some((user) => user.email === email)) await server.signUp(email, PASSWORD, name);
  const store = await ChantierStore.open(memoryKv(), server.connect());
  await store.signIn(email, PASSWORD);
  return store;
}

async function observe(store: ChantierStore, projectId: string, init: Partial<Observation>, author = 'Zaid'): Promise<Observation> {
  const book = await store.book(projectId);
  const observation = newObservation(init, author, now(), book.lists, book.topics.length + 1);
  await store.saveObservation(projectId, observation);
  return observation;
}

async function update(store: ChantierStore, projectId: string, guid: string, change: (topic: Observation) => Observation): Promise<void> {
  const topic = (await store.book(projectId)).topics.find((item) => item.guid === guid)!;
  await store.saveObservation(projectId, change(topic));
}

test('écrit hors ligne, relu après rechargement, envoyé une fois au retour du réseau, retrouvé sur un autre appareil', async () => {
  const server = new MemoryBackend();
  const kv = memoryKv(), device = server.connect();
  await server.signUp('zaid@test.fr', PASSWORD, 'Zaid');
  let store = await ChantierStore.open(kv, device);
  await store.signIn('zaid@test.fr', PASSWORD);

  server.offline = true;
  const project = await store.createProject('Résidence Les Tilleuls');
  const draft = await observe(store, project.id, { title: 'Joint silicone à reprendre', assignedTo: 'Durand', dueDate: '2026-11-30T00:00:00Z' });
  await update(store, project.id, draft.guid, (topic) => addComment(touched(topic, { documents: [{ guid: crypto.randomUUID(), filename: 'a.jpg', data: photo('a') }, { guid: crypto.randomUUID(), filename: 'b.jpg', data: photo('b') }] }, 'Zaid', now()), 'Vu avec le plombier', 'Zaid', now()));
  await store.sync();
  assert.equal(store.state.phase, 'offline');
  assert.ok((await store.pending()).waiting > 0);
  assert.equal(server.received.length, 0);

  // La page est rechargée : tout est relu de l'appareil.
  store = await ChantierStore.open(kv, device);
  let book = await store.book(project.id);
  assert.equal(book.topics.length, 1);
  assert.equal(book.topics[0].comments[0].text, 'Vu avec le plombier');
  assert.deepEqual(await Promise.all(book.topics[0].documents.map((document) => document.data!.text())), ['photo a', 'photo b']);

  server.offline = false;
  await store.sync();
  assert.equal(store.state.phase, 'done');
  assert.deepEqual(await store.pending(), { waiting: 0, refused: [] });
  // Chaque ligne n'est partie qu'une fois (la modification de l'observation encore en file a rejoint sa création).
  const sent = server.received.map((change) => `${change.table}:${change.id}`);
  assert.equal(new Set(sent).size, sent.length);
  assert.equal(server.state.tables.topics.length, 1);
  assert.equal(Object.keys(server.state.files).length, 2);
  await store.sync();
  assert.equal(server.received.length, sent.length, 'une seconde synchronisation ne renvoie rien');

  // Un autre appareil, même compte : tout est là, photos comprises une fois le projet ouvert.
  const other = await signedIn(server, 'zaid@test.fr');
  assert.deepEqual((await other.projects()).map((item) => item.name), ['Résidence Les Tilleuls']);
  await other.openProject(project.id);
  await other.sync();
  book = await other.book(project.id);
  assert.equal(book.topics[0].title, 'Joint silicone à reprendre');
  assert.equal(book.topics[0].number, 1);
  assert.equal(book.topics[0].dueDate, '2026-11-30T00:00:00Z');
  assert.deepEqual(await Promise.all(book.topics[0].documents.map((document) => document.data!.text())), ['photo a', 'photo b']);
  assert.equal((await other.events(draft.guid)).at(0)?.action, 'insert');
});

test('sans compte rien ne part ; à la connexion, les données de l’appareil rejoignent le compte', async () => {
  const server = new MemoryBackend();
  const store = await ChantierStore.open(memoryKv(), server.connect());
  const project = await store.createProject('Chantier sans compte');
  await observe(store, project.id, { title: 'Fissure' });
  await store.sync();
  assert.equal(server.received.length, 0);
  assert.ok((await store.pending()).waiting > 0);

  await store.signUp('nouveau@test.fr', PASSWORD, 'Nouveau', 'Durand');
  assert.equal(store.account?.email, 'nouveau@test.fr');
  assert.deepEqual(await store.pending(), { waiting: 0, refused: [] });
  assert.equal(server.state.tables.projects[0].name, 'Chantier sans compte');
  assert.ok(server.state.tables.projects[0].organisation_id, 'le projet est rangé dans l’organisation du compte');
  assert.equal(await store.role(project.id), 'admin');
  assert.deepEqual(await store.profile(), { name: 'Nouveau', company: 'Durand' });
  assert.equal(server.state.tables.profiles[0].company, 'Durand', 'l’entreprise tapée à l’inscription rejoint le profil');
});

test('deux appareils hors ligne : groupes différents gardés tous deux, même champ : le dernier arrivé gagne, l’historique a les deux', async () => {
  const server = new MemoryBackend();
  const a = await signedIn(server, 'zaid@test.fr', 'Zaid');
  const project = await a.createProject('Tilleuls');
  const draft = await observe(a, project.id, { title: 'Plinthe', assignedTo: 'Durand' });
  await a.sync();
  const b = await signedIn(server, 'zaid@test.fr', 'Zaid');

  server.offline = true;
  const lists = listsOf(project);
  await update(a, project.id, draft.guid, (topic) => changeStatus(topic, 'En cours', lists, 'Zaid', now()));
  await update(b, project.id, draft.guid, (topic) => touched(topic, { dueDate: '2026-12-15T00:00:00Z' }, 'Zaid', now()));
  await update(a, project.id, draft.guid, (topic) => touched(topic, { title: 'Plinthe (A)' }, 'Zaid', now()));
  await update(b, project.id, draft.guid, (topic) => touched(topic, { title: 'Plinthe (B)' }, 'Zaid', now()));
  await update(a, project.id, draft.guid, (topic) => addComment(topic, 'Commentaire de A', 'Zaid', now()));
  await update(b, project.id, draft.guid, (topic) => addComment(topic, 'Commentaire de B', 'Zaid', now()));
  server.offline = false;
  await a.sync();
  await b.sync();
  await a.sync();

  for (const device of [a, b]) {
    const topic = (await device.book(project.id)).topics[0];
    assert.equal(topic.status, 'En cours');
    assert.equal(topic.dueDate, '2026-12-15T00:00:00Z');
    assert.equal(topic.title, 'Plinthe (B)');
    // Les commentaires ne font que s'ajouter : ceux des deux appareils, et le changement de statut.
    assert.deepEqual(topic.comments.map((comment) => comment.text).sort(), ['Commentaire de A', 'Commentaire de B', 'Statut : Ouverte → En cours']);
  }
  const titles = (await a.events(draft.guid)).filter((event) => event.fields?.includes('title'));
  assert.equal(titles.length, 2, 'les deux titres sont dans l’historique');
});

test('un invité ne voit que ce qui est attribué à lui ou à son entreprise ; un refus reste visible et ne bloque pas la suite', async () => {
  const server = new MemoryBackend();
  const admin = await signedIn(server, 'alice@test.fr', 'Alice');
  const project = await admin.createProject('Tilleuls');
  await admin.addMember(project.id, 'Gaston@Durand.fr', 'guest', 'Durand');
  const mine = await observe(admin, project.id, { title: 'Pour Durand', assignedTo: 'Durand' });
  const byEmail = await observe(admin, project.id, { title: 'Pour Gaston', assignedTo: 'gaston@durand.fr' });
  await observe(admin, project.id, { title: 'Pour Martin', assignedTo: 'Martin' });
  await admin.sync();

  const guest = await signedIn(server, 'gaston@durand.fr', 'Gaston');
  assert.equal(await guest.role(project.id), 'guest');
  assert.deepEqual((await guest.book(project.id)).topics.map((topic) => topic.title).sort(), ['Pour Durand', 'Pour Gaston']);
  assert.deepEqual((await guest.members(project.id)).map((row) => row.email), ['gaston@durand.fr']);

  await update(guest, project.id, mine.guid, (topic) => touched(topic, { title: 'Titre changé' }, 'Gaston', now()));
  await update(guest, project.id, byEmail.guid, (topic) => changeStatus(topic, 'Résolue', listsOf(project), 'Gaston', now()));
  await guest.sync();
  const { refused, waiting } = await guest.pending();
  assert.equal(waiting, 0);
  assert.equal(refused.length, 1);
  assert.match(refused[0].error!, /refusée/);
  assert.equal(server.state.tables.topics.find((row) => row.id === byEmail.guid)!.status, 'Résolue');
  assert.equal(server.state.tables.topics.find((row) => row.id === mine.guid)!.title, 'Pour Durand');
  // Il ne crée pas d'observation.
  await observe(guest, project.id, { title: 'Invité' });
  await guest.sync();
  assert.equal((await guest.pending()).refused.length, 2);
});

test('un appareil garde un seul compte : un autre compte est refusé tant que tout n’est pas envoyé', async () => {
  const server = new MemoryBackend();
  await server.signUp('bob@test.fr', PASSWORD, 'Bob');
  const store = await signedIn(server, 'alice@test.fr');
  const project = await store.createProject('Chez Alice');
  server.offline = true;
  await observe(store, project.id, { title: 'Pas envoyée' });
  server.offline = false;
  await store.signOut();
  await assert.rejects(store.signIn('bob@test.fr', PASSWORD), /modifications? non envoyées? du compte alice@test\.fr/);
  assert.equal(store.account, null);
  await store.signIn('alice@test.fr', PASSWORD);
  await store.sync();
  await store.signOut();
  await store.signIn('bob@test.fr', PASSWORD);
  assert.deepEqual(await store.projects(), [], 'les données d’Alice, toutes envoyées, ont quitté l’appareil');
});

test('importer le .bcf et le JSON du viewer : photos, repères et commentaires suivent ; réimporter met à jour sans doublon', async () => {
  const server = new MemoryBackend();
  const store = await signedIn(server, 'zaid@test.fr');
  const project = await store.createProject('Import');
  const book = { settings: {}, lists: listsOf(project), topics: [
    { ...newObservation({ title: 'Garde-corps', assignedTo: 'Serrurerie Martin', pin: { plan: 'vue-1', x: 12.5, y: 3 }, drawingPin: { plan: 'plan-rdc', x: 0.25, y: 0.75 }, documents: [{ guid: crypto.randomUUID(), filename: 'gc.jpg', data: photo('gc') }] }, 'Zaid', now(), listsOf(project), 7) },
  ] };
  book.topics[0] = addComment(book.topics[0], 'À fixer', 'Zaid', now());
  const bcf = await writeBcf(book.topics.map((topic) => toBcfTopic(topic)), extensionsOf(book));
  // Le .bcf relu garde le repère sur le plan du projet.
  assert.deepEqual((await readBcf(bcf)).topics[0].viewerBim, { pin: { plan: 'vue-1', x: 12.5, y: 3 }, drawingPin: { plan: 'plan-rdc', x: 0.25, y: 0.75 } });

  const first = await store.importFile(project.id, new File([bcf], 'maison - observations.bcf'));
  assert.deepEqual([first.added, first.updated], [1, 0]);
  let topic = (await store.book(project.id)).topics[0];
  assert.equal(topic.title, 'Garde-corps');
  // Le .bcf ne porte pas le numéro : la suite du projet.
  assert.equal(topic.number, 1);
  assert.deepEqual(topic.drawingPin, { plan: 'plan-rdc', x: 0.25, y: 0.75 });
  assert.equal(await topic.documents[0].data!.text(), 'photo gc');
  assert.ok(listsOf(await store.project(project.id)).companies.includes('Serrurerie Martin'));

  // Le JSON du viewer (section `observations`, sans photos), avec une modification : mise à jour, rien en double.
  const json = { observations: observationsToJson({ ...book, topics: [touched(book.topics[0], { title: 'Garde-corps à refixer' }, 'Zaid', new Date(Date.now() + 60_000))] }) };
  const second = await store.importFile(project.id, new File([JSON.stringify(json)], 'maison.json'));
  assert.deepEqual([second.added, second.updated], [0, 1]);
  topic = (await store.book(project.id)).topics[0];
  assert.equal(topic.title, 'Garde-corps à refixer');
  assert.equal(topic.documents.length, 1);
  assert.equal(topic.comments.length, 1);
  await store.sync();
  assert.equal(server.state.tables.topics.length, 1);
  assert.equal(server.state.tables.photos.length, 1);
});

test('supprimer mon compte : projets dont je suis le seul membre et leurs fichiers partent, l’appareil est vidé', async () => {
  const server = new MemoryBackend();
  const store = await signedIn(server, 'zaid@test.fr', 'Zaid');
  const solo = await store.createProject('Seul');
  const shared = await store.createProject('Partagé');
  await store.addMember(shared.id, 'eve@test.fr', 'editor', '');
  await observe(store, solo.id, { title: 'A', documents: [{ guid: crypto.randomUUID(), filename: 'a.jpg', data: photo('a') }] });
  const kept = await observe(store, shared.id, { title: 'B' });
  await store.sync();
  // Seul administrateur d'un projet partagé : refusé avant de rien toucher.
  await assert.rejects(store.deleteAccount(), /seul administrateur du projet « Partagé »/);
  assert.equal(Object.keys(server.state.files).length, 1);

  const eve = await signedIn(server, 'eve@test.fr', 'Eve');
  await eve.sync();
  await store.updateMember({ ...(await store.members(shared.id)).find((row) => row.email === 'eve@test.fr')!, role: 'admin' });
  await store.sync();
  await store.deleteAccount();
  assert.equal(store.account, null);
  assert.deepEqual(await store.projects(), []);
  assert.deepEqual(server.state.tables.projects.map((row) => row.name), ['Partagé']);
  assert.deepEqual(server.state.files, {});
  assert.equal((server.state.tables.topics.find((row) => row.id === kept.guid) as TopicRow).creation_author, 'Compte supprimé');
  assert.equal(server.state.users.some((user) => user.email === 'zaid@test.fr'), false);
});
