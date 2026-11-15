-- Preuve des règles d'accès du suivi de chantier (supabase/migrations/20261115120000_suivi_de_chantier.sql).
-- À lancer sur la base de développement, migrations appliquées :
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/policies.sql
-- Tout se passe dans une transaction annulée à la fin : les comptes, projets et fichiers créés ici disparaissent. Chaque
-- vérification qui échoue lève « ÉCHEC : … » et arrête le script ; sans erreur, la dernière ligne est « policies.sql : tout est
-- vérifié ». Les rôles sont imités comme le fait l'API : `role` = anon ou authenticated, `request.jwt.claims` = le jeton.
--
-- Personnes : alice (administratrice de A), eve (éditrice de A), gaston (invité de A, entreprise Durand), gerard (invité de A,
-- entreprise Martin), bob (administrateur de B), ursula (invitée de A, e-mail jamais confirmé).

begin;

-- ------------------------------------------------------------------ comptes (comme postgres, sans jeton)

insert into auth.users (id, email, email_confirmed_at, aud, role, raw_user_meta_data) values
  ('00000000-0000-4000-8000-00000000000a', 'alice@test.local', now(), 'authenticated', 'authenticated', '{"display_name":"Alice"}'),
  ('00000000-0000-4000-8000-00000000000b', 'bob@test.local', now(), 'authenticated', 'authenticated', '{"display_name":"Bob"}'),
  ('00000000-0000-4000-8000-00000000000c', 'gaston@test.local', now(), 'authenticated', 'authenticated', '{"display_name":"Gaston"}'),
  ('00000000-0000-4000-8000-00000000000d', 'gerard@test.local', now(), 'authenticated', 'authenticated', '{"display_name":"Gérard"}'),
  ('00000000-0000-4000-8000-00000000000e', 'ursula@test.local', null, 'authenticated', 'authenticated', '{"display_name":"Ursula"}'),
  ('00000000-0000-4000-8000-00000000000f', 'eve@test.local', now(), 'authenticated', 'authenticated', '{"display_name":"Eve"}');

do $$ begin
  if (select count(*) from public.profiles where id::text like '00000000-0000-4000-8000-00000000000%') <> 6 then raise exception 'ÉCHEC : un profil par inscription'; end if;
  if (select count(*) from public.organisations where created_by::text like '00000000-0000-4000-8000-00000000000%') <> 6 then raise exception 'ÉCHEC : une organisation personnelle par inscription'; end if;
end $$;

-- ------------------------------------------------------------------ anonyme : tout est refusé

select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true);
do $$
declare t text;
begin
  foreach t in array array['profiles', 'organisations', 'projects', 'memberships', 'topics', 'comments', 'viewpoints', 'photos', 'plans', 'events'] loop
    begin
      execute format('select count(*) from public.%I', t);
      raise exception 'ÉCHEC : un anonyme lit %', t;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    perform private.project_role('10000000-0000-4000-8000-00000000000a');
    raise exception 'ÉCHEC : un anonyme appelle une fonction d''aide';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.delete_my_account();
    raise exception 'ÉCHEC : un anonyme appelle delete_my_account';
  exception when insufficient_privilege then null;
  end;
  begin
    if (select count(*) from storage.objects where bucket_id = 'photos') <> 0 then raise exception 'ÉCHEC : un anonyme voit des photos'; end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ alice crée A, bob crée B

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true), set_config('role', 'authenticated', true);
-- Chaque création comme l'application l'envoie (supabase.ts : `upsert(…, { onConflict: 'id', ignoreDuplicates: true })`) :
-- `on conflict (id) do nothing` relit la ligne nouvelle avec la politique de lecture, avant les déclencheurs `after` (dont
-- `add_creator`, qui fait du créateur l'administrateur du projet). Une politique de lecture qui ne montre pas la ligne à son
-- auteur à ce moment-là refuse la création (42501).
insert into public.organisations (id, name)
values ('60000000-0000-4000-8000-0000000000a1', 'Autre organisation d''Alice') on conflict (id) do nothing;
insert into public.projects (id, organisation_id, name)
values ('10000000-0000-4000-8000-00000000000a', (select id from public.organisations where created_by = auth.uid() and name = 'Personnel'), 'Projet A') on conflict (id) do nothing;
insert into public.memberships (id, project_id, email, role, company) values
  ('70000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', 'gaston@test.local', 'guest', 'Durand'),
  ('70000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-00000000000a', 'gerard@test.local', 'guest', 'Martin'),
  ('70000000-0000-4000-8000-0000000000a3', '10000000-0000-4000-8000-00000000000a', 'ursula@test.local', 'guest', 'Durand'),
  ('70000000-0000-4000-8000-0000000000a4', '10000000-0000-4000-8000-00000000000a', 'eve@test.local', 'editor', '') on conflict (id) do nothing;
insert into public.topics (id, project_id, number, title, status, assigned_to) values
  ('20000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', 1, 'Joint à reprendre', 'Ouverte', 'Durand'),
  ('20000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-00000000000a', 2, 'Plinthe', 'Ouverte', 'Martin'),
  ('20000000-0000-4000-8000-0000000000a3', '10000000-0000-4000-8000-00000000000a', 3, 'Pour Gaston', 'Ouverte', 'Gaston@Test.local'),
  ('20000000-0000-4000-8000-0000000000a4', '10000000-0000-4000-8000-00000000000a', 4, 'Sans entreprise', 'Ouverte', null) on conflict (id) do nothing;
-- `created_by` forgé : la base pose l'appelant.
insert into public.comments (id, project_id, topic_id, author, text, created_by) values
  ('30000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 'Alice', 'Vu sur place', '00000000-0000-4000-8000-00000000000b'),
  ('30000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a2', 'Alice', 'Martin prévenu', null) on conflict (id) do nothing;
insert into public.viewpoints (id, project_id, topic_id, position, data) values
  ('80000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 0, '{}') on conflict (id) do nothing;
insert into public.photos (id, project_id, topic_id, filename, path, mime, size, sha256) values
  ('40000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 'joint.jpg',
   '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a1/' || repeat('a', 64) || '.jpg', 'image/jpeg', 1000, repeat('a', 64)),
  ('40000000-0000-4000-8000-0000000000a2', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a2', 'plinthe.jpg',
   '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a2/' || repeat('b', 64) || '.jpg', 'image/jpeg', 1000, repeat('b', 64)) on conflict (id) do nothing;
insert into public.plans (id, project_id, name, path, mime, size, sha256, width, height) values
  ('50000000-0000-4000-8000-0000000000a1', '10000000-0000-4000-8000-00000000000a', 'RDC', '10000000-0000-4000-8000-00000000000a/plans/' || repeat('c', 64) || '.png', 'image/png', 1000, repeat('c', 64), 800, 600) on conflict (id) do nothing;
insert into storage.objects (bucket_id, name) values
  ('photos', '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a1/' || repeat('a', 64) || '.jpg'),
  ('photos', '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a2/' || repeat('b', 64) || '.jpg'),
  ('photos', '10000000-0000-4000-8000-00000000000a/plans/' || repeat('c', 64) || '.png');
do $$
declare n integer;
begin
  if private.project_role('10000000-0000-4000-8000-00000000000a') <> 'admin' then raise exception 'ÉCHEC : le créateur est administrateur'; end if;
  if (select count(*) from public.organisations where id = '60000000-0000-4000-8000-0000000000a1') <> 1 then raise exception 'ÉCHEC : organisation créée en on conflict refusée'; end if;
  if (select count(*) from public.projects where id = '10000000-0000-4000-8000-00000000000a') <> 1 then raise exception 'ÉCHEC : projet créé en on conflict refusé'; end if;
  if (select count(*) from public.memberships where project_id = '10000000-0000-4000-8000-00000000000a') <> 5 then raise exception 'ÉCHEC : adhésions créées en on conflict refusées'; end if;
  if (select count(*) from public.viewpoints where id = '80000000-0000-4000-8000-0000000000a1') <> 1 then raise exception 'ÉCHEC : point de vue créé en on conflict refusé'; end if;
  -- Le même projet renvoyé (réseau coupé après l'envoi) : sans effet, sans erreur.
  insert into public.projects (id, organisation_id, name)
  values ('10000000-0000-4000-8000-00000000000a', (select id from public.organisations where created_by = auth.uid() and name = 'Personnel'), 'Projet A') on conflict (id) do nothing;
  if (select created_by from public.comments where id = '30000000-0000-4000-8000-0000000000a1') <> auth.uid() then raise exception 'ÉCHEC : created_by forgé accepté'; end if;
  -- Le même envoi deux fois : une seule ligne ; un numéro déjà pris devient le suivant.
  insert into public.topics (id, project_id, number, title) values ('20000000-0000-4000-8000-0000000000a5', '10000000-0000-4000-8000-00000000000a', 1, 'Doublon') on conflict (id) do nothing;
  insert into public.topics (id, project_id, number, title) values ('20000000-0000-4000-8000-0000000000a5', '10000000-0000-4000-8000-00000000000a', 1, 'Doublon') on conflict (id) do nothing;
  select count(*) into n from public.topics where id = '20000000-0000-4000-8000-0000000000a5';
  if n <> 1 then raise exception 'ÉCHEC : le même envoi deux fois donne % lignes', n; end if;
  if (select number from public.topics where id = '20000000-0000-4000-8000-0000000000a5') <> 5 then raise exception 'ÉCHEC : numéro pris non remplacé'; end if;
  -- Une adresse de fichier qui ne suit pas la règle est refusée.
  begin
    insert into storage.objects (bucket_id, name) values ('photos', 'ailleurs/fichier.jpg');
    raise exception 'ÉCHEC : chemin de stockage hors règle accepté';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true), set_config('role', 'authenticated', true);
insert into public.projects (id, organisation_id, name)
values ('10000000-0000-4000-8000-00000000000b', (select id from public.organisations where created_by = auth.uid()), 'Projet B') on conflict (id) do nothing;
insert into public.topics (id, project_id, title, assigned_to) values
  ('20000000-0000-4000-8000-0000000000b1', '10000000-0000-4000-8000-00000000000b', 'Chez B', 'Durand') on conflict (id) do nothing;

-- ------------------------------------------------------------------ bob (membre de B) ne voit ni n'écrit rien de A

do $$
declare n integer;
begin
  if (select count(*) from public.projects where id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit le projet A'; end if;
  if (select count(*) from public.topics where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit les observations de A'; end if;
  if (select count(*) from public.comments where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit les commentaires de A'; end if;
  if (select count(*) from public.photos where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit les photos de A'; end if;
  if (select count(*) from public.plans where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit les plans de A'; end if;
  if (select count(*) from public.memberships where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit les membres de A'; end if;
  if (select count(*) from public.events where project_id = '10000000-0000-4000-8000-00000000000a') <> 0 then raise exception 'ÉCHEC : B lit l''historique de A'; end if;
  if (select count(*) from storage.objects where bucket_id = 'photos' and name like '10000000-0000-4000-8000-00000000000a/%') <> 0 then raise exception 'ÉCHEC : B lit les fichiers de A'; end if;
  if private.project_role('10000000-0000-4000-8000-00000000000a') is not null then raise exception 'ÉCHEC : la fonction d''aide révèle A'; end if;
  if private.sees_topic_id('20000000-0000-4000-8000-0000000000a1') then raise exception 'ÉCHEC : la fonction d''aide révèle une observation de A'; end if;
  update public.topics set title = 'piraté' where id = '20000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ÉCHEC : B modifie une observation de A'; end if;
  begin
    insert into public.memberships (project_id, email, role) values ('10000000-0000-4000-8000-00000000000a', 'bob@test.local', 'admin');
    raise exception 'ÉCHEC : B s''ajoute à A';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.topics (id, project_id, title) values ('20000000-0000-4000-8000-0000000000b9', '10000000-0000-4000-8000-00000000000a', 'intrus');
    raise exception 'ÉCHEC : B crée une observation dans A';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.comments (id, project_id, topic_id, text) values ('30000000-0000-4000-8000-0000000000b9', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 'intrus');
    raise exception 'ÉCHEC : B commente une observation de A';
  exception when insufficient_privilege then null;
  end;
  -- Un commentaire de B qui désigne une observation de A sous le projet B : refusé (l'observation n'est pas visible).
  begin
    insert into public.comments (id, project_id, topic_id, text) values ('30000000-0000-4000-8000-0000000000b8', '10000000-0000-4000-8000-00000000000b', '20000000-0000-4000-8000-0000000000a1', 'intrus');
    raise exception 'ÉCHEC : B commente A sous son propre projet';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('photos', '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a1/' || repeat('d', 64) || '.jpg');
    raise exception 'ÉCHEC : B dépose un fichier dans A';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ alice (membre de A) ne voit rien de B

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$ begin
  if (select count(*) from public.projects where id = '10000000-0000-4000-8000-00000000000b') <> 0 then raise exception 'ÉCHEC : A lit le projet B'; end if;
  if (select count(*) from public.topics where project_id = '10000000-0000-4000-8000-00000000000b') <> 0 then raise exception 'ÉCHEC : A lit les observations de B'; end if;
  -- Une organisation d'un autre ne sert pas à créer un projet.
  begin
    insert into public.projects (id, organisation_id, name)
    values ('10000000-0000-4000-8000-0000000000a9', (select id from public.organisations where created_by = '00000000-0000-4000-8000-00000000000b'), 'x');
    raise exception 'ÉCHEC : projet créé dans l''organisation d''un autre';
  exception when insufficient_privilege or not_null_violation then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ gaston, invité de A (Durand) : seulement ce qui lui est attribué

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$
declare n integer;
begin
  if (select count(*) from public.projects where id = '10000000-0000-4000-8000-00000000000a') <> 1 then raise exception 'ÉCHEC : l''invité ne voit pas son projet'; end if;
  if (select array_agg(title order by title) from public.topics) <> array['Joint à reprendre', 'Pour Gaston'] then
    raise exception 'ÉCHEC : l''invité voit %', (select array_agg(title order by title) from public.topics);
  end if;
  if (select count(*) from public.topics where project_id = '10000000-0000-4000-8000-00000000000b') <> 0 then raise exception 'ÉCHEC : l''invité de A voit B (même entreprise)'; end if;
  if (select count(*) from public.comments) <> 1 then raise exception 'ÉCHEC : l''invité voit les commentaires d''une autre entreprise'; end if;
  if (select count(*) from public.photos) <> 1 then raise exception 'ÉCHEC : l''invité voit les photos d''une autre entreprise'; end if;
  if (select count(*) from public.memberships) <> 1 then raise exception 'ÉCHEC : l''invité voit les autres membres'; end if;
  if (select count(*) from public.plans) <> 1 then raise exception 'ÉCHEC : l''invité ne voit pas les plans'; end if;
  if (select count(*) from storage.objects where bucket_id = 'photos') <> 2 then raise exception 'ÉCHEC : l''invité voit % fichiers (sa photo et le plan attendus)', (select count(*) from storage.objects where bucket_id = 'photos'); end if;
  -- Il change le statut, rien d'autre.
  update public.topics set status = 'En cours', modified_author = 'Gaston' where id = '20000000-0000-4000-8000-0000000000a1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'ÉCHEC : l''invité ne change pas le statut'; end if;
  begin
    update public.topics set title = 'autre' where id = '20000000-0000-4000-8000-0000000000a1';
    raise exception 'ÉCHEC : l''invité change le titre';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.topics set assigned_to = 'Martin' where id = '20000000-0000-4000-8000-0000000000a1';
    raise exception 'ÉCHEC : l''invité réattribue';
  exception when insufficient_privilege then null;
  end;
  update public.topics set status = 'Résolue' where id = '20000000-0000-4000-8000-0000000000a2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ÉCHEC : l''invité change une observation d''une autre entreprise'; end if;
  begin
    insert into public.topics (id, project_id, title) values ('20000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-00000000000a', 'invité');
    raise exception 'ÉCHEC : l''invité crée une observation';
  exception when insufficient_privilege then null;
  end;
  -- Il commente et ajoute une photo sur ce qui lui est attribué, pas ailleurs.
  insert into public.comments (id, project_id, topic_id, author, text) values ('30000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 'Gaston', 'Repris');
  insert into storage.objects (bucket_id, name) values ('photos', '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a1/' || repeat('e', 64) || '.jpg');
  begin
    insert into public.comments (id, project_id, topic_id, text) values ('30000000-0000-4000-8000-0000000000c2', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a2', 'intrus');
    raise exception 'ÉCHEC : l''invité commente une observation d''une autre entreprise';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('photos', '10000000-0000-4000-8000-00000000000a/20000000-0000-4000-8000-0000000000a2/' || repeat('f', 64) || '.jpg');
    raise exception 'ÉCHEC : l''invité dépose un fichier sur une observation d''une autre entreprise';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name) values ('photos', '10000000-0000-4000-8000-00000000000a/plans/' || repeat('f', 64) || '.png');
    raise exception 'ÉCHEC : l''invité dépose un plan';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.memberships (project_id, email, role) values ('10000000-0000-4000-8000-00000000000a', 'ami@test.local', 'editor');
    raise exception 'ÉCHEC : l''invité ajoute un membre';
  exception when insufficient_privilege then null;
  end;
  -- L'historique de sa modification est là, à son nom.
  if not exists (select 1 from public.events where topic_id = '20000000-0000-4000-8000-0000000000a1' and action = 'update' and 'status' = any(fields) and actor_name = 'Gaston') then
    raise exception 'ÉCHEC : la modification de l''invité n''est pas dans l''historique';
  end if;
end $$;
reset role;

-- ------------------------------------------------------------------ gerard, invité de A (Martin) ; ursula, e-mail non confirmé

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$ begin
  if (select array_agg(title) from public.topics) <> array['Plinthe'] then raise exception 'ÉCHEC : l''invité Martin voit %', (select array_agg(title) from public.topics); end if;
end $$;
reset role;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000e","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$ begin
  if (select count(*) from public.projects) <> 0 or (select count(*) from public.topics) <> 0 then raise exception 'ÉCHEC : un e-mail non confirmé ouvre une invitation'; end if;
  begin
    insert into public.projects (id, organisation_id, name)
    values ('10000000-0000-4000-8000-0000000000e1', (select id from public.organisations where created_by = auth.uid()), 'Projet U');
    raise exception 'ÉCHEC : un e-mail non confirmé crée un projet';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ eve, éditrice de A : tout A, pas l'administration

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000f","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$
declare n integer;
begin
  if (select count(*) from public.topics) <> 5 then raise exception 'ÉCHEC : l''éditrice ne voit pas toutes les observations'; end if;
  update public.topics set title = 'Plinthe à recoller', assigned_to = 'Martin' where id = '20000000-0000-4000-8000-0000000000a2';
  update public.projects set name = 'renommé' where id = '10000000-0000-4000-8000-00000000000a';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'ÉCHEC : l''éditrice renomme le projet'; end if;
  begin
    insert into public.memberships (project_id, email, role) values ('10000000-0000-4000-8000-00000000000a', 'ami@test.local', 'editor');
    raise exception 'ÉCHEC : l''éditrice ajoute un membre';
  exception when insufficient_privilege then null;
  end;
  -- Une observation ne change pas de projet, ni de numéro (pas de droit sur ces colonnes).
  begin
    update public.topics set project_id = '10000000-0000-4000-8000-00000000000b' where id = '20000000-0000-4000-8000-0000000000a2';
    raise exception 'ÉCHEC : une observation change de projet';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.topics set number = 99 where id = '20000000-0000-4000-8000-0000000000a2';
    raise exception 'ÉCHEC : un numéro est changé';
  exception when insufficient_privilege then null;
  end;
  -- Commentaires et points de vue : seulement ajoutés.
  begin
    update public.comments set text = 'changé' where id = '30000000-0000-4000-8000-0000000000a2';
    raise exception 'ÉCHEC : un commentaire est modifié';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.comments where id = '30000000-0000-4000-8000-0000000000a2';
    raise exception 'ÉCHEC : un commentaire est supprimé';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ events : ni écrit, ni modifié, ni supprimé par un client

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true), set_config('role', 'authenticated', true);
do $$ begin
  if (select count(*) from public.events where topic_id = '20000000-0000-4000-8000-0000000000a2') < 2 then raise exception 'ÉCHEC : création et modification absentes de l''historique'; end if;
  begin
    update public.events set actor_name = 'personne';
    raise exception 'ÉCHEC : l''historique est modifiable';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.events;
    raise exception 'ÉCHEC : l''historique est supprimable';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.events (project_id, topic_id, action) values ('10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a1', 'update');
    raise exception 'ÉCHEC : l''historique s''écrit à la main';
  exception when insufficient_privilege then null;
  end;
  -- Seule administratrice d'un projet partagé : son compte ne se supprime pas.
  begin
    perform public.delete_my_account();
    raise exception 'ÉCHEC : la seule administratrice supprime son compte';
  exception when raise_exception then null;
  end;
end $$;
reset role;

-- ------------------------------------------------------------------ supprimer mon compte

-- gerard (invité) : son adhésion part, son nom et son e-mail sont retirés des observations, le compte disparaît.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true), set_config('role', 'authenticated', true);
insert into public.topics (id, project_id, title, assigned_to) values
  ('20000000-0000-4000-8000-0000000000a6', '10000000-0000-4000-8000-00000000000a', 'Pour Gérard', 'Gerard@Test.local') on conflict (id) do nothing;
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000d","role":"authenticated"}', true), set_config('role', 'authenticated', true);
insert into public.comments (id, project_id, topic_id, author, text) values ('30000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-00000000000a', '20000000-0000-4000-8000-0000000000a2', 'Gérard', 'Fait') on conflict (id) do nothing;
update public.topics set status = 'Résolue', modified_author = 'Gérard' where id = '20000000-0000-4000-8000-0000000000a2';
select public.delete_my_account();
reset role;
-- bob : seul membre de B, le projet part avec lui.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true), set_config('role', 'authenticated', true);
select public.delete_my_account();
reset role;
select set_config('request.jwt.claims', '', true);
do $$ begin
  if exists (select 1 from auth.users where id in ('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000d')) then raise exception 'ÉCHEC : compte non supprimé'; end if;
  if exists (select 1 from public.profiles where id in ('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000d')) then raise exception 'ÉCHEC : profil non supprimé'; end if;
  if exists (select 1 from public.memberships where email = 'gerard@test.local') then raise exception 'ÉCHEC : adhésion non retirée'; end if;
  if (select author from public.comments where id = '30000000-0000-4000-8000-0000000000d1') <> 'Compte supprimé' then raise exception 'ÉCHEC : nom gardé dans un commentaire'; end if;
  if (select modified_author from public.topics where id = '20000000-0000-4000-8000-0000000000a2') <> 'Compte supprimé' then raise exception 'ÉCHEC : nom gardé dans « modifiée par »'; end if;
  if (select assigned_to from public.topics where id = '20000000-0000-4000-8000-0000000000a6') <> 'Compte supprimé' then raise exception 'ÉCHEC : e-mail gardé dans « attribuée à »'; end if;
  if (select assigned_to from public.topics where id = '20000000-0000-4000-8000-0000000000a1') <> 'Durand' then raise exception 'ÉCHEC : une attribution à une entreprise est changée'; end if;
  if exists (select 1 from public.events where actor_name in ('Gérard', 'Bob')) then raise exception 'ÉCHEC : nom gardé dans l''historique'; end if;
  if exists (select 1 from public.projects where id = '10000000-0000-4000-8000-00000000000b') then raise exception 'ÉCHEC : projet du seul membre gardé'; end if;
  if not exists (select 1 from public.projects where id = '10000000-0000-4000-8000-00000000000a') then raise exception 'ÉCHEC : projet partagé supprimé'; end if;
  raise notice 'policies.sql : tout est vérifié';
end $$;

rollback;
