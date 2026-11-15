import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError, type Row } from '../src/chantier/backend/port.ts';
import { complete, enqueue, fail, groupFields, mergeRemote, nextCursor, pendingFields, retry, sameJson, sinceOf, type QueueEntry } from '../src/chantier/sync.ts';

const topic = (fields: Record<string, unknown> = {}): Row => ({
  id: 't1', project_id: 'p1', status: 'Ouverte', assigned_to: 'Durand', due_date: '2026-11-30', priority: 'Haute', title: 'Joint', description: null,
  type: 'Réserve', labels: [], stage: null, extra: {}, deleted_at: null, modified_author: 'Zaid', ...fields,
});

test('une modification envoie les groupes entiers qu’elle touche, avec son auteur', () => {
  assert.deepEqual(groupFields('topics', topic({ due_date: '2026-12-15' }), ['due_date']), { assigned_to: 'Durand', due_date: '2026-12-15', priority: 'Haute', modified_author: 'Zaid' });
  assert.deepEqual(groupFields('topics', topic(), ['status']), { status: 'Ouverte', modified_author: 'Zaid' });
  // Un champ qui n'est dans aucun groupe (numéro, projet) ne part jamais.
  assert.deepEqual(groupFields('topics', topic(), ['number', 'project_id']), {});
});

test('la file garde l’ordre et fusionne les modifications d’une même ligne', () => {
  let queue: QueueEntry[] = [];
  queue = enqueue(queue, { table: 'topics', id: 't1', op: 'insert', fields: topic() });
  queue = enqueue(queue, { table: 'comments', id: 'c1', op: 'insert', fields: { id: 'c1', topic_id: 't1', text: 'Vu' } });
  queue = enqueue(queue, { table: 'topics', id: 't1', op: 'update', fields: { status: 'En cours' } });
  // Pas encore envoyée : la modification rejoint la création, qui reste devant le commentaire qui en dépend.
  assert.deepEqual(queue.map((entry) => [entry.table, entry.op]), [['topics', 'insert'], ['comments', 'insert']]);
  assert.equal(queue[0].fields.status, 'En cours');

  queue = enqueue(queue, { table: 'topics', id: 't2', op: 'update', fields: { title: 'A' } });
  queue = enqueue(queue, { table: 'topics', id: 't2', op: 'update', fields: { title: 'B', status: 'Résolue' } });
  assert.equal(queue.length, 3);
  assert.deepEqual(queue[2].fields, { title: 'B', status: 'Résolue' });

  // Un même fichier n'est déposé qu'une fois.
  queue = enqueue(queue, { table: 'photos', id: 'p/t/x.jpg', op: 'upload', fields: {}, path: 'p/t/x.jpg' });
  queue = enqueue(queue, { table: 'photos', id: 'p/t/x.jpg', op: 'upload', fields: {}, path: 'p/t/x.jpg' });
  assert.equal(queue.filter((entry) => entry.op === 'upload').length, 1);

  // Retirer un membre jamais envoyé : rien ne part ; un membre déjà envoyé : la suppression part.
  queue = enqueue(queue, { table: 'memberships', id: 'm1', op: 'insert', fields: { email: 'a@b.fr' } });
  queue = enqueue(queue, { table: 'memberships', id: 'm1', op: 'delete', fields: {} });
  assert.equal(queue.some((entry) => entry.id === 'm1'), false);
  queue = enqueue(queue, { table: 'memberships', id: 'm2', op: 'delete', fields: {} });
  assert.equal(queue.at(-1)!.op, 'delete');
  assert.deepEqual(queue.map((entry) => entry.seq), [...queue.map((entry) => entry.seq)].sort((a, b) => a - b));
});

test('une entrée modifiée pendant son envoi reste en file (la création devient une modification)', () => {
  const queue = enqueue([], { table: 'topics', id: 't1', op: 'insert', fields: topic() });
  const sent = queue[0];
  assert.deepEqual(complete(queue, sent), []);
  const changed = enqueue(queue, { table: 'topics', id: 't1', op: 'update', fields: { status: 'Résolue', modified_author: 'Zaid' } });
  const after = complete(changed, sent);
  assert.equal(after.length, 1);
  assert.equal(after[0].op, 'update');
  // Seuls les champs modifiables repartent (l'identifiant, le projet, le numéro sont déjà sur le serveur).
  assert.equal('project_id' in after[0].fields, false);
  assert.equal(after[0].fields.status, 'Résolue');
});

test('réseau coupé : l’envoi s’arrête et tout reste ; refus : marqué, la suite part ; « Réessayer » le relance', () => {
  let queue = enqueue(enqueue([], { table: 'topics', id: 't1', op: 'update', fields: { title: 'A' } }), { table: 'topics', id: 't2', op: 'update', fields: { title: 'B' } });
  const offline = fail(queue, queue[0], new BackendError('offline', 'Pas de réseau.'));
  assert.equal(offline.stop, true);
  assert.deepEqual(offline.queue, queue);
  const refused = fail(queue, queue[0], new BackendError('refused', 'Refusé par le serveur : droit manquant.'));
  assert.equal(refused.stop, false);
  assert.equal(refused.queue[0].error, 'Refusé par le serveur : droit manquant.');
  queue = refused.queue;
  // Une entrée refusée n'absorbe plus les modifications suivantes : elles partent à part.
  queue = enqueue(queue, { table: 'topics', id: 't1', op: 'update', fields: { title: 'C' } });
  assert.equal(queue.length, 3);
  assert.equal(retry(queue).some((entry) => entry.error), false);
});

test('ce que le serveur renvoie remplace la copie, sauf les champs encore en file', () => {
  const local = topic({ status: 'Résolue', title: 'Joint (local)', _modified: '2026-11-15T10:00:00Z' });
  const remote = topic({ status: 'Ouverte', title: 'Joint repris', due_date: '2026-12-01', updated_at: '2026-11-15T10:05:00Z' });
  let queue = enqueue([], { table: 'topics', id: 't1', op: 'update', fields: { status: 'Résolue', modified_author: 'Zaid' } });
  const merged = mergeRemote(local, remote, pendingFields(queue, 'topics', 't1'));
  assert.equal(merged.status, 'Résolue');
  assert.equal(merged.title, 'Joint repris');
  assert.equal(merged.due_date, '2026-12-01');
  assert.equal(merged._modified, '2026-11-15T10:00:00Z');
  // Plus rien en file : le serveur fait foi, la date locale part.
  assert.deepEqual(mergeRemote(local, remote, new Set()), remote);
  // Une création pas encore envoyée garde toute la copie de l'appareil.
  queue = enqueue([], { table: 'topics', id: 't1', op: 'insert', fields: local });
  assert.equal(pendingFields(queue, 'topics', 't1'), 'all');
  assert.equal(mergeRemote(local, remote, 'all').title, 'Joint (local)');
});

test('curseur : la date la plus récente, relue avec deux minutes de marge ; comparaison sans ordre de clés', () => {
  const rows = [{ id: 'a', updated_at: '2026-11-15T10:00:00.000Z' }, { id: 'b', updated_at: '2026-11-15T10:05:00.000Z' }];
  assert.equal(nextCursor(rows, 'updated_at', '2026-11-15T09:00:00.000Z'), '2026-11-15T10:05:00.000Z');
  assert.equal(nextCursor([], 'updated_at', 'x'), 'x');
  assert.equal(sinceOf('2026-11-15T10:05:00.000Z'), '2026-11-15T10:03:00.000Z');
  assert.equal(sinceOf(undefined), undefined);
  assert.equal(sameJson({ pin: { x: 1, plan: 'a' }, elements: [] }, { elements: [], pin: { plan: 'a', x: 1 } }), true);
  assert.equal(sameJson(undefined, null), true);
  assert.equal(sameJson(['a', 'b'], ['b', 'a']), false);
});
