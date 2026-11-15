-- Suivi de chantier (chantier.html) : comptes, projets, membres, observations (sujets BCF), commentaires, points de vue,
-- photos, plans, historique. Voir docs/superpowers/plans/2026-11-15-corrections/17-chantier-app.md et
-- docs/contrat-observations.md.
--
-- Règles :
-- - Chaque table refuse tout par défaut (row-level security) ; les droits sont donnés au rôle `authenticated` seulement,
--   colonne par colonne pour les mises à jour ; `anon` n'a rien.
-- - Un membre (adhésion par e-mail confirmé) voit son projet ; administrateur et éditeur voient et écrivent toutes ses
--   observations ; un invité ne voit que celles attribuées à lui (son e-mail) ou à son entreprise, et n'en change que le statut ;
--   il peut les commenter et y ajouter des photos.
-- - `events` (historique) est écrit par un déclencheur, jamais par un client : ni insertion, ni modification, ni suppression.
-- - Le stockage `photos` suit les mêmes règles par le chemin : `<project_id>/<topic_id>/<fichier>` ou `<project_id>/plans/<fichier>`.
-- - Les identifiants sont des UUID créés sur l'appareil ; `created_at`, `updated_at` et `created_by` sont posés par la base.
-- - L'application envoie chaque création en `insert … on conflict (id) do nothing` (le même envoi deux fois = une ligne) :
--   PostgreSQL relit alors la ligne nouvelle avec la politique de lecture, avant les déclencheurs `after`. Chaque politique de
--   lecture doit donc montrer à son auteur la ligne qu'il crée (voir `private.creating_project`).
-- Rejouable : `if not exists`, `create or replace`, politiques et déclencheurs supprimés avant d'être recréés.
--
-- Précondition (réglages Auth du projet Supabase) : « Confirm email » doit rester ACTIVÉ. L'adhésion à un projet se reconnaît à
-- l'e-mail confirmé (`private.my_email`) ; sans confirmation, n'importe qui pourrait s'inscrire avec l'adresse d'un invité et
-- prendre son invitation.

-- ------------------------------------------------------------------ fonctions d'aide (schéma non exposé par l'API)

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ------------------------------------------------------------------ tables

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 120),
  company text not null default '' check (length(company) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organisations (
  id uuid primary key,
  name text not null check (length(name) between 1 and 200),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key,
  organisation_id uuid not null references public.organisations (id) on delete restrict,
  name text not null check (length(name) between 1 and 200),
  -- Les listes du projet (types, statuts, lots, priorités, phases, entreprises, transitions) : section `lists` du contrat.
  lists jsonb not null default '{}'::jsonb check (jsonb_typeof(lists) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$' and length(email) <= 320),
  role text not null check (role in ('admin', 'editor', 'guest')),
  company text not null default '' check (length(company) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, email)
);

create table if not exists public.topics (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  number integer check (number > 0),
  type text not null default '' check (length(type) <= 200),
  status text not null default '' check (length(status) <= 200),
  title text not null default '' check (length(title) <= 500),
  priority text check (length(priority) <= 200),
  labels text[] not null default '{}',
  stage text check (length(stage) <= 200),
  -- Entreprise ou personne (son e-mail) : ce qu'un invité voit en dépend.
  assigned_to text check (length(assigned_to) <= 320),
  due_date date,
  description text check (length(description) <= 20000),
  creation_date timestamptz not null default now(),
  creation_author text not null default '' check (length(creation_author) <= 200),
  modified_author text check (length(modified_author) <= 200),
  -- Ce que le BCF n'a pas : éléments, repères (plan de la maquette, plan du projet), point, emplacement, origine, liens.
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (id, project_id),
  unique (project_id, number)
);

create table if not exists public.comments (
  id uuid primary key,
  project_id uuid not null,
  topic_id uuid not null,
  date timestamptz not null default now(),
  author text not null default '' check (length(author) <= 200),
  text text not null check (length(text) between 1 and 20000),
  viewpoint_id uuid,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (topic_id, project_id) references public.topics (id, project_id) on delete cascade
);

create table if not exists public.viewpoints (
  id uuid primary key,
  project_id uuid not null,
  topic_id uuid not null,
  position integer not null default 0,
  -- Caméra, plans de coupe, sélection, couleurs, lignes (repère du modèle, Z vers le haut) ; l'image est une photo.
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (topic_id, project_id) references public.topics (id, project_id) on delete cascade
);

create table if not exists public.photos (
  id uuid primary key,
  project_id uuid not null,
  topic_id uuid not null,
  -- Rempli pour l'image d'un point de vue.
  viewpoint_id uuid,
  filename text not null check (length(filename) between 1 and 300),
  path text not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  size bigint not null check (size > 0 and size <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (path = project_id::text || '/' || topic_id::text || '/' || sha256 || case mime when 'image/png' then '.png' when 'image/webp' then '.webp' else '.jpg' end),
  foreign key (topic_id, project_id) references public.topics (id, project_id) on delete cascade,
  foreign key (viewpoint_id, project_id) references public.viewpoints (id, project_id) on delete cascade
);

create table if not exists public.plans (
  id uuid primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (length(name) between 1 and 300),
  path text not null,
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  size bigint not null check (size > 0 and size <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (path = project_id::text || '/plans/' || sha256 || case mime when 'image/png' then '.png' when 'image/webp' then '.webp' else '.jpg' end)
);

-- L'historique : qui a changé quels champs d'une observation, quand. Écrit par `private.topic_event` seulement.
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  topic_id uuid not null,
  actor uuid references public.profiles (id) on delete set null,
  actor_name text not null default '',
  action text not null check (action in ('insert', 'update')),
  fields text[],
  at timestamptz not null default now(),
  foreign key (topic_id, project_id) references public.topics (id, project_id) on delete cascade
);

-- ------------------------------------------------------------------ index (clés étrangères et colonnes lues par les politiques)

create index if not exists organisations_created_by on public.organisations (created_by);
create index if not exists projects_organisation on public.projects (organisation_id);
create index if not exists memberships_email on public.memberships (email);
create index if not exists topics_project_updated on public.topics (project_id, updated_at);
create index if not exists topics_project_assigned on public.topics (project_id, lower(assigned_to));
create index if not exists topics_created_by on public.topics (created_by);
create index if not exists comments_topic on public.comments (topic_id, project_id);
create index if not exists comments_project_updated on public.comments (project_id, updated_at);
create index if not exists comments_created_by on public.comments (created_by);
create index if not exists viewpoints_topic on public.viewpoints (topic_id, project_id);
create index if not exists viewpoints_project_updated on public.viewpoints (project_id, updated_at);
create index if not exists viewpoints_created_by on public.viewpoints (created_by);
create index if not exists photos_topic on public.photos (topic_id, project_id);
create index if not exists photos_viewpoint on public.photos (viewpoint_id, project_id);
create index if not exists photos_project_updated on public.photos (project_id, updated_at);
create index if not exists photos_created_by on public.photos (created_by);
create index if not exists plans_project_updated on public.plans (project_id, updated_at);
create index if not exists plans_created_by on public.plans (created_by);
create index if not exists events_topic on public.events (topic_id, project_id);
create index if not exists events_project_at on public.events (project_id, at);
create index if not exists events_actor on public.events (actor);

-- ------------------------------------------------------------------ qui est l'appelant (security definer : lisent auth.users
-- et memberships sans repasser par les politiques, sinon les politiques de memberships s'appelleraient elles-mêmes). Aucune ne
-- prend d'utilisateur en paramètre : elles ne répondent que pour l'appelant, ce qu'il pourrait lire lui-même.

-- L'e-mail confirmé de l'appelant, en minuscules ; null sans connexion ou e-mail non confirmé.
create or replace function private.my_email() returns text
language sql stable security definer set search_path = ''
as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

-- Le rôle de l'appelant dans ce projet ('admin', 'editor', 'guest') ; null s'il n'en est pas membre.
create or replace function private.project_role(p_project uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select m.role from public.memberships m where m.project_id = p_project and m.email = private.my_email()
$$;

-- Vrai si l'appelant voit une observation de ce projet attribuée à `p_assigned` : administrateur ou éditeur, ou invité à qui
-- (son e-mail) ou à l'entreprise de qui elle est attribuée.
create or replace function private.sees_topic(p_project uuid, p_assigned text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.project_id = p_project and m.email = private.my_email()
      and (m.role in ('admin', 'editor')
        or (p_assigned is not null and (lower(p_assigned) = m.email or (m.company <> '' and lower(p_assigned) = lower(m.company)))))
  )
$$;

-- La même chose, par l'identifiant de l'observation (commentaires, photos, points de vue, historique).
create or replace function private.sees_topic_id(p_topic uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.topics t where t.id = p_topic and private.sees_topic(t.project_id, t.assigned_to))
$$;

-- Vrai pendant la création d'un projet par qui a créé son organisation, avant que son adhésion d'administrateur soit écrite
-- (le déclencheur `add_creator` vient après la relecture de `on conflict … do nothing`). Un projet qui a déjà des membres ne
-- l'est plus : son créateur retiré du projet ne le voit plus.
create or replace function private.creating_project(p_project uuid, p_organisation uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.organisations o where o.id = p_organisation and o.created_by = auth.uid())
    and not exists (select 1 from public.memberships m where m.project_id = p_project)
$$;

-- Le stockage : `<project_id>/plans/<fichier>` (lu par tout membre, écrit par administrateur et éditeur) ou
-- `<project_id>/<topic_id>/<fichier>` (lu et écrit par qui voit l'observation). Tout autre chemin est refusé.
create or replace function private.can_use_object(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  uuid_pattern constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_project uuid;
  v_second text;
begin
  if p_name is null or p_name !~ ('^' || uuid_pattern || '/[^/]+/[^/]+$') then
    return false;
  end if;
  v_project := split_part(p_name, '/', 1)::uuid;
  v_second := split_part(p_name, '/', 2);
  if v_second = 'plans' then
    return case when p_write then private.project_role(v_project) in ('admin', 'editor') else private.project_role(v_project) is not null end;
  end if;
  if v_second !~ ('^' || uuid_pattern || '$') then
    return false;
  end if;
  return exists (select 1 from public.topics t where t.id = v_second::uuid and t.project_id = v_project and private.sees_topic(t.project_id, t.assigned_to));
end
$$;

revoke all on function private.my_email() from public, anon;
revoke all on function private.project_role(uuid) from public, anon;
revoke all on function private.sees_topic(uuid, text) from public, anon;
revoke all on function private.sees_topic_id(uuid) from public, anon;
revoke all on function private.can_use_object(text, boolean) from public, anon;
revoke all on function private.creating_project(uuid, uuid) from public, anon;
grant execute on function private.my_email() to authenticated;
grant execute on function private.creating_project(uuid, uuid) to authenticated;
grant execute on function private.project_role(uuid) to authenticated;
grant execute on function private.sees_topic(uuid, text) to authenticated;
grant execute on function private.sees_topic_id(uuid) to authenticated;
grant execute on function private.can_use_object(text, boolean) to authenticated;

-- ------------------------------------------------------------------ déclencheurs

-- Dates de création et de modification, auteur : posés par la base (un client ne les choisit pas). `created_by` garde ce
-- qu'une fonction système a donné quand il n'y a pas d'appelant (inscription).
create or replace function private.stamp() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new := jsonb_populate_record(new, jsonb_build_object('created_at', now(), 'updated_at', now(),
      'created_by', coalesce(auth.uid(), (to_jsonb(new) ->> 'created_by')::uuid)));
  else
    new := jsonb_populate_record(new, jsonb_build_object('updated_at', now(), 'created_at', to_jsonb(old) -> 'created_at', 'created_by', to_jsonb(old) -> 'created_by'));
  end if;
  return new;
end
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'organisations', 'projects', 'memberships', 'topics', 'comments', 'viewpoints', 'photos', 'plans'] loop
    execute format('drop trigger if exists z_stamp on public.%I', t);
    execute format('create trigger z_stamp before insert or update on public.%I for each row execute function private.stamp()', t);
  end loop;
end
$$;

-- À l'inscription : le profil (nom affiché donné à l'inscription) et une organisation personnelle.
-- Security definer : écrit dans des tables où le compte qui crée l'utilisateur (supabase_auth_admin) n'a pas de droit.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 120))
  on conflict (id) do nothing;
  insert into public.organisations (id, name, created_by) values (gen_random_uuid(), 'Personnel', new.id);
  return new;
end
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.handle_new_user() to supabase_auth_admin;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

-- Le créateur d'un projet en est l'administrateur. Security definer : l'adhésion ne peut être écrite que par un administrateur,
-- et il n'y en a pas encore.
create or replace function private.add_creator() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_email text := private.my_email();
begin
  if v_email is null then
    raise exception 'Confirmez votre adresse e-mail avant de créer un projet.' using errcode = '42501';
  end if;
  insert into public.memberships (project_id, email, role) values (new.id, v_email, 'admin');
  return null;
end
$$;
revoke all on function private.add_creator() from public, anon, authenticated;
drop trigger if exists add_creator on public.projects;
create trigger add_creator after insert on public.projects for each row execute function private.add_creator();

-- Numéro lisible d'une observation : le sien s'il est libre dans le projet, sinon le suivant. Un verrou par projet sérialise
-- les créations simultanées.
create or replace function private.topic_number() returns trigger
language plpgsql set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.project_id::text, 0));
  if new.number is null or exists (select 1 from public.topics t where t.project_id = new.project_id and t.number = new.number and t.id <> new.id) then
    select coalesce(max(t.number), 0) + 1 into new.number from public.topics t where t.project_id = new.project_id;
  end if;
  return new;
end
$$;
drop trigger if exists a_number on public.topics;
create trigger a_number before insert on public.topics for each row execute function private.topic_number();

-- Une observation ne change ni d'identifiant, ni de projet, ni de numéro ; un invité n'en change que le statut.
create or replace function private.topic_guard() returns trigger
language plpgsql set search_path = ''
as $$
declare free constant text[] := array['status', 'modified_author', 'updated_at'];
begin
  if new.id <> old.id or new.project_id <> old.project_id then
    raise exception 'Une observation ne change pas de projet.' using errcode = '42501';
  end if;
  new.number := old.number;
  if private.project_role(old.project_id) = 'guest' and (to_jsonb(new) - free) is distinct from (to_jsonb(old) - free) then
    raise exception 'Un invité ne peut changer que le statut d’une observation.' using errcode = '42501';
  end if;
  return new;
end
$$;
drop trigger if exists a_guard on public.topics;
create trigger a_guard before update on public.topics for each row execute function private.topic_guard();

-- L'historique de chaque création et de chaque modification d'une observation : écrit ici, il ne peut pas être sauté par un
-- client. Security definer : les clients n'ont aucun droit d'écriture sur `events`.
create or replace function private.topic_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_fields text[];
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into v_fields
    from jsonb_each(to_jsonb(new)) n
    where n.key not in ('updated_at', 'created_at') and n.value is distinct from (to_jsonb(old) -> n.key);
    if cardinality(v_fields) = 0 then
      return null;
    end if;
  end if;
  insert into public.events (project_id, topic_id, actor, actor_name, action, fields)
  values (new.project_id, new.id, auth.uid(), coalesce((select p.display_name from public.profiles p where p.id = auth.uid()), ''), lower(tg_op), v_fields);
  return null;
end
$$;
revoke all on function private.topic_event() from public, anon, authenticated;
drop trigger if exists z_event on public.topics;
create trigger z_event after insert or update on public.topics for each row execute function private.topic_event();

revoke all on function private.stamp() from public, anon, authenticated;
revoke all on function private.topic_number() from public, anon, authenticated;
revoke all on function private.topic_guard() from public, anon, authenticated;

-- ------------------------------------------------------------------ droits (colonne par colonne pour les mises à jour)

revoke all on public.profiles, public.organisations, public.projects, public.memberships, public.topics, public.comments,
  public.viewpoints, public.photos, public.plans, public.events from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name, company) on public.profiles to authenticated;
grant select, insert on public.organisations to authenticated;
grant update (name) on public.organisations to authenticated;
grant select, insert on public.projects to authenticated;
grant update (name, lists, deleted_at) on public.projects to authenticated;
grant select, insert, delete on public.memberships to authenticated;
grant update (role, company) on public.memberships to authenticated;
grant select, insert on public.topics to authenticated;
grant update (type, status, title, priority, labels, stage, assigned_to, due_date, description, modified_author, extra, deleted_at) on public.topics to authenticated;
grant select, insert on public.comments to authenticated;
grant select, insert on public.viewpoints to authenticated;
grant select, insert on public.photos to authenticated;
grant update (deleted_at) on public.photos to authenticated;
grant select, insert on public.plans to authenticated;
grant update (name, deleted_at) on public.plans to authenticated;
grant select on public.events to authenticated;

-- ------------------------------------------------------------------ politiques

alter table public.profiles enable row level security;
alter table public.organisations enable row level security;
alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.topics enable row level security;
alter table public.comments enable row level security;
alter table public.viewpoints enable row level security;
alter table public.photos enable row level security;
alter table public.plans enable row level security;
alter table public.events enable row level security;

drop policy if exists "profil : le sien" on public.profiles;
create policy "profil : le sien" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profil : modifier le sien" on public.profiles;
create policy "profil : modifier le sien" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "organisation : créée ou d'un de mes projets" on public.organisations;
create policy "organisation : créée ou d'un de mes projets" on public.organisations for select to authenticated
  using (created_by = (select auth.uid()) or exists (select 1 from public.projects p where p.organisation_id = organisations.id));
drop policy if exists "organisation : créer la sienne" on public.organisations;
create policy "organisation : créer la sienne" on public.organisations for insert to authenticated with check (created_by = (select auth.uid()));
drop policy if exists "organisation : renommer la sienne" on public.organisations;
create policy "organisation : renommer la sienne" on public.organisations for update to authenticated
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

drop policy if exists "projet : membre" on public.projects;
create policy "projet : membre" on public.projects for select to authenticated
  using (private.project_role(id) is not null or private.creating_project(id, organisation_id));
drop policy if exists "projet : créer dans mon organisation" on public.projects;
create policy "projet : créer dans mon organisation" on public.projects for insert to authenticated
  with check (exists (select 1 from public.organisations o where o.id = projects.organisation_id and o.created_by = (select auth.uid())));
drop policy if exists "projet : administrateur" on public.projects;
create policy "projet : administrateur" on public.projects for update to authenticated
  using (private.project_role(id) = 'admin') with check (private.project_role(id) = 'admin');

drop policy if exists "adhésion : la mienne, ou toutes pour l'équipe" on public.memberships;
create policy "adhésion : la mienne, ou toutes pour l'équipe" on public.memberships for select to authenticated
  using (email = (select private.my_email()) or private.project_role(project_id) in ('admin', 'editor'));
drop policy if exists "adhésion : ajout par un administrateur" on public.memberships;
create policy "adhésion : ajout par un administrateur" on public.memberships for insert to authenticated
  with check (private.project_role(project_id) = 'admin');
drop policy if exists "adhésion : changée par un administrateur, pas la sienne" on public.memberships;
create policy "adhésion : changée par un administrateur, pas la sienne" on public.memberships for update to authenticated
  using (private.project_role(project_id) = 'admin' and email <> (select private.my_email()))
  with check (private.project_role(project_id) = 'admin' and email <> (select private.my_email()));
drop policy if exists "adhésion : retirée par un administrateur, pas la sienne" on public.memberships;
create policy "adhésion : retirée par un administrateur, pas la sienne" on public.memberships for delete to authenticated
  using (private.project_role(project_id) = 'admin' and email <> (select private.my_email()));

drop policy if exists "observation : visible" on public.topics;
create policy "observation : visible" on public.topics for select to authenticated using (private.sees_topic(project_id, assigned_to));
drop policy if exists "observation : créée par l'équipe" on public.topics;
create policy "observation : créée par l'équipe" on public.topics for insert to authenticated
  with check (private.project_role(project_id) in ('admin', 'editor'));
drop policy if exists "observation : modifiée si visible" on public.topics;
create policy "observation : modifiée si visible" on public.topics for update to authenticated
  using (private.sees_topic(project_id, assigned_to)) with check (private.sees_topic(project_id, assigned_to));

drop policy if exists "commentaire : visible" on public.comments;
create policy "commentaire : visible" on public.comments for select to authenticated using (private.sees_topic_id(topic_id));
drop policy if exists "commentaire : ajouté si visible" on public.comments;
create policy "commentaire : ajouté si visible" on public.comments for insert to authenticated with check (private.sees_topic_id(topic_id));

drop policy if exists "point de vue : visible" on public.viewpoints;
create policy "point de vue : visible" on public.viewpoints for select to authenticated using (private.sees_topic_id(topic_id));
drop policy if exists "point de vue : ajouté par l'équipe" on public.viewpoints;
create policy "point de vue : ajouté par l'équipe" on public.viewpoints for insert to authenticated
  with check (private.project_role(project_id) in ('admin', 'editor'));

drop policy if exists "photo : visible" on public.photos;
create policy "photo : visible" on public.photos for select to authenticated using (private.sees_topic_id(topic_id));
drop policy if exists "photo : ajoutée si visible" on public.photos;
create policy "photo : ajoutée si visible" on public.photos for insert to authenticated with check (private.sees_topic_id(topic_id));
drop policy if exists "photo : retirée par l'équipe" on public.photos;
create policy "photo : retirée par l'équipe" on public.photos for update to authenticated
  using (private.project_role(project_id) in ('admin', 'editor')) with check (private.project_role(project_id) in ('admin', 'editor'));

drop policy if exists "plan : membre" on public.plans;
create policy "plan : membre" on public.plans for select to authenticated using (private.project_role(project_id) is not null);
drop policy if exists "plan : ajouté par l'équipe" on public.plans;
create policy "plan : ajouté par l'équipe" on public.plans for insert to authenticated
  with check (private.project_role(project_id) in ('admin', 'editor'));
drop policy if exists "plan : changé par l'équipe" on public.plans;
create policy "plan : changé par l'équipe" on public.plans for update to authenticated
  using (private.project_role(project_id) in ('admin', 'editor')) with check (private.project_role(project_id) in ('admin', 'editor'));

drop policy if exists "historique : visible" on public.events;
create policy "historique : visible" on public.events for select to authenticated using (private.sees_topic_id(topic_id));

-- ------------------------------------------------------------------ stockage des photos et des plans

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos : lire" on storage.objects;
create policy "photos : lire" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and private.can_use_object(name, false));
drop policy if exists "photos : déposer" on storage.objects;
create policy "photos : déposer" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and private.can_use_object(name, true));
-- Pas de mise à jour : un fichier est nommé par son contenu (SHA-256), il ne change jamais.
drop policy if exists "photos : supprimer (équipe)" on storage.objects;
create policy "photos : supprimer (équipe)" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and private.project_role(case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then split_part(name, '/', 1)::uuid end) in ('admin', 'editor'));

-- ------------------------------------------------------------------ supprimer mon compte et mes données

-- Les projets dont l'appelant est le seul membre sont supprimés (avec observations, photos, plans, historique : leurs fichiers
-- sont retirés du stockage par l'application avant l'appel) ; ailleurs son adhésion est retirée et son nom remplacé par
-- « Compte supprimé » dans ses observations (auteur, dernier à les modifier : les noms que l'historique a notés pour lui sur
-- chacune), commentaires et l'historique, et son e-mail dans « attribuée à » ; puis le compte (et son profil) est supprimé.
-- Refusé s'il est le seul administrateur d'un projet qui a d'autres membres.
-- Security definer : supprime dans auth.users et anonymise des lignes que l'appelant ne peut pas modifier.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := private.my_email();
begin
  if v_uid is null then
    raise exception 'Connexion requise.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.memberships m
    where m.email = v_email and m.role = 'admin'
      and exists (select 1 from public.memberships o where o.project_id = m.project_id and o.email <> v_email)
      and not exists (select 1 from public.memberships a where a.project_id = m.project_id and a.role = 'admin' and a.email <> v_email)
  ) then
    raise exception 'Vous êtes le seul administrateur d’un projet partagé : nommez d’abord un autre administrateur.' using errcode = 'P0001';
  end if;
  delete from public.projects p
  where exists (select 1 from public.memberships m where m.project_id = p.id and m.email = v_email)
    and not exists (select 1 from public.memberships o where o.project_id = p.id and o.email <> v_email);
  delete from public.memberships where email = v_email;
  update public.topics set creation_author = 'Compte supprimé' where created_by = v_uid;
  -- Avant l'historique, qui dit sous quels noms il a modifié chaque observation.
  update public.topics t set modified_author = 'Compte supprimé'
  where t.modified_author in (select e.actor_name from public.events e where e.topic_id = t.id and e.actor = v_uid and e.actor_name <> '');
  -- Son e-mail confirmé seulement : une adresse non confirmée ne prouve pas qu'elle est à lui.
  update public.topics set assigned_to = 'Compte supprimé' where v_email is not null and lower(assigned_to) = v_email;
  update public.comments set author = 'Compte supprimé' where created_by = v_uid;
  update public.events set actor_name = 'Compte supprimé' where actor = v_uid;
  delete from auth.users where id = v_uid;
end
$$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ------------------------------------------------------------------ comptes créés avant cette migration

-- Un compte inscrit avant que `on_auth_user_created` existe n'a ni profil ni organisation : ils sont créés ici, comme à
-- l'inscription. Rejouable : rien n'est créé deux fois.
insert into public.profiles (id, display_name)
select u.id, left(coalesce(u.raw_user_meta_data ->> 'display_name', ''), 120) from auth.users u
on conflict (id) do nothing;
insert into public.organisations (id, name, created_by)
select gen_random_uuid(), 'Personnel', u.id from auth.users u
where not exists (select 1 from public.organisations o where o.created_by = u.id);
