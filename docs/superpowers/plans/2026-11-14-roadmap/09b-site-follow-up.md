# 09b — Site follow-up: our own field tool (what Finalcad One does)

## Goal

Build our own tool for following a construction site: note an observation on an element or on a plan with
a photo, assign it to a company, follow it until it is closed, and print the list — first inside the
viewer for one person, then as a shared application usable on a phone. It is our product, linked to the
viewer, not a connection to Finalcad.

Working name: **Suivi de chantier**. "Finalcad" is a trademark and is not used in the product.

## What Finalcad One does (researched November 2026, mostly from its help centre)

| Area | Finalcad One |
| --- | --- |
| Organisation | Organisation roles (administrator, workspace manager, member, free guest); project roles (administrator, editor, limited editor, guest who sees only what is assigned to him or his company); companies per project; phases; QR codes |
| Plans | PDF, DWG, JPG, PNG in a tree of "locations"; replacing a plan keeps the pins; annotations (dimensions, areas, arrows, text) |
| Observations | Custom modules per project (réserves, defects, tasks); customisable statuses (Open, In progress, Resolved, Contested) with transitions limited by role; priority, category, pin on plan, photos, comments, geolocation, weather; assignment to a company with notification |
| Forms | Template builder: text, number, date, list, conformity (OK / KO / n.a.), signature with timestamp, photo, grid, formula; sections that lock |
| Reports | Filtered PDF by e-mail (scheduled, recipients), Excel, CSV history; a PDF per form; meeting minutes |
| Meetings | Attendance, sections, notes linked to observations and assigned, minutes, follow-up from week to week |
| Dashboards | Standard on mobile; custom ones on the top plan |
| BIM | IFC uploaded on the web, Revit through a plug-in; walk, measure, section, exploded view, properties; needs a connection on mobile. An observation pinned to a 3D object is claimed in marketing and not confirmed in the help centre |
| Offline | Advertised; a banner shows the sync state |
| Platforms | iOS and Android native apps, web; 29 languages |
| Price (third party) | Free up to 200 observations per project; €29 and €69 per user per month; Enterprise on quote |

**Common core of every tool of this kind** (Finalcad, Dalux Field, PlanRadar, Fieldwire, Autodesk Build,
Procore, Kairnial, Archipad): a project with people and companies; a tree of plans; an observation with
title, type, status, assignee, due date, priority, photos, comments, history and a pin; filtered lists;
PDF and Excel export; checklist templates; capture offline with sync later; notification on assignment.
The BIM-centred ones (Dalux, Revizto) add: the observation attached to an element or a 3D point, automatic
location (level, room, grid), a saved viewpoint, and BCF exchange.

**The French site workflows these tools serve**
- *Visite de chantier, contrôle qualité, sécurité*: observation on the plan with a photo, assigned to a
  company, which fixes it and changes the status; an editor closes it.
- *Réception*: OPR (opérations préalables à la réception) with the list of réserves, a signed PV, the
  owner's decision, then the *levée de réserves* with its own PV. Public works follow CCAG-Travaux 2021
  art. 41 and the model forms EXE4–EXE9; private works usually NF P 03-001.
- *GPA* (garantie de parfait achèvement): the same list stays open one year and accepts new entries.
- There is no standard French data format for réserves; the open standard for issues is BCF.

## What we already have that they do not

Native Revit and IFC reading in the browser with nothing uploaded; Revit floor plans opened in 2D; saved
views and sections; element properties editable and saved in JSON; 4D planning; an assistant that
understands "show me the open réserves of level 2". What is missing: observations, photos, people,
companies, sharing, phones, reports.

## Decisions

1. **An observation is a BCF topic.** Our data model is BCF 3.0's (topic, comments, viewpoints with
   selected components, camera, clipping planes, snapshot) plus the fields BCF lacks. Import and export of
   `.bcf` come for free and make us compatible with Dalux, Revizto, PlanRadar, Solibri, BIMcollab.

   | Our field | BCF |
   | --- | --- |
   | Kind (réserve, défaut, sécurité, tâche — editable list) | TopicType |
   | Status | TopicStatus |
   | Trade / lot | Labels |
   | Phase (OPR, levée, GPA…) | Stage |
   | Company or person | AssignedTo |
   | Due date, priority, title, description | DueDate, Priority, Title, Description |
   | Element | Viewpoint selection, by IFC GlobalId; Revit ElementId in AuthoringToolId |
   | View, section | Viewpoint camera and clipping planes |
   | Photos | Snapshot and document references |
   | History | Comments |
   | **Pin on a 2D plan** (plan id, x, y) | none: our own extension, kept beside the topic |

2. **The product is the shared application for professional teams** (owner, 14 November 2026): several
   companies on one project, on phones. Part A (observations in the viewer, in files) is its first
   building block and its test bed, not the destination.
3. **Part B is a second application in the same repository** (`chantier.html`, a PWA) with a real backend,
   chosen for the one thing a field tool cannot do without — working with no network:
   - **Database: PostgreSQL, hosted on Supabase**, region Paris. Standard SQL, access rules enforced by
     the database itself (row-level security), sign-in by e-mail one-time code built in, file storage
     with the same access rules, project transfer between organisations (personal account → professional
     account), and plain Postgres as the exit.
   - **Offline: PowerSync** on top of it. Each phone holds a local SQLite copy of the projects it may
     see, reads and writes it with or without network, and a queue uploads changes when the connection
     returns. To confirm by a two-day trial before building on it: its web SDK inside an installed PWA on
     iOS Safari. If the trial fails, the fallback is our own queue over the same local store (decision 6).
   - **Why not Convex** (the owner's first idea): it has no offline mode — its client only queues changes
     while the page stays open, and its sync engine was announced in 2024 and not released. Every piece
     of offline behaviour would be ours to write and maintain. No server database is "offline" by itself;
     the difference is that Postgres has a mature, ready-made answer and Convex has none.
4. **Phones work on plans first.** A phone shows the plan tree and pins, takes photos and edits
   observations offline. 3D on a phone comes later; 3D on desktop and tablet comes from the viewer.
5. **No legal value is claimed** for signatures or PVs in the first versions. Reports are working documents.
6. **Built to grow and to move.** The owner starts on a personal account and will move to a professional
   one. So:
   - the screens read and write a local store only; the store talks to the server through one interface
     (`BackendPort`: sign in, sync, upload a file), with a Supabase + PowerSync adapter and an in-memory
     adapter for tests. Swapping the sync engine or the host is rewriting one adapter;
   - every record's identity is a UUID created on the device; files are referenced by our own object key;
     people by e-mail and our member id, never the provider's user id;
   - every table carries `project_id`, indexed; lists are paginated; photos never go in the database;
   - every address and key comes from configuration; nothing account-specific in the code;
   - `docs/chantier-deplacement.md` is a written, rehearsed procedure for moving everything to another
     account (below).
7. **Free plans only for now** (owner, 14 November 2026): Supabase Free and PowerSync Free, kept as the
   backend choice. Consequences to design for, not to discover:
   - Supabase Free pauses a project after a week without activity and PowerSync Free deactivates an idle
     instance after about a week: acceptable while building and demonstrating, **not for a client's live
     site**. The application must show "server asleep, your work is kept on this device" instead of
     failing, and send everything once the server is back.
   - Limits: 500 MB of data, 1 GB of files (about 3,000 photos at 300 KB), two Supabase projects (one
     development, one demonstration), 50 phones connected at once. Photos are reduced before upload and
     each project shows its storage use.
   - Paying starts with the first real client (about $25 a month, then $49 more beyond 50 connected
     phones); nothing in the code changes when the plan does.
8. **First workflow: the observation list**, as in every tool on the market. Site visits, quality checks
   and réception are the same list seen through a **phase** (visite, OPR, levée de réserves, GPA): an
   observation belongs to a phase, lists and reports filter by it. The réception paperwork (PV layouts)
   comes later on top of that list; nothing in the data model has to change for it.
9. **Personal data: the usual arrangement of the market.** Each client is responsible for his project's
   data (data controller); we host and process it on his instructions (processor). So the product ships
   with: hosting in the EU, a data-processing agreement and privacy notice (templates to be reviewed by a
   lawyer before the first client), the list of our providers, export of a whole project and deletion of
   a project or of a person on request, and a retention rule after a project is closed.

## Part A — Observations in the viewer (files only)

- "Observations" panel. Create from the selected element or from a click on a plan or on the model: title,
  kind, status (Ouverte, En cours, Résolue, Contestée, Clôturée — editable list), company, trade, due date,
  priority, description. The current view, section and a snapshot are saved with it (capture, workstream 08).
- Photos added from disk or camera (`<input type="file" accept="image/*" capture="environment">`), reduced
  to 1,500 px on the long side before storing. Comments with date and author name (typed once, kept in
  `localStorage`).
- List with filters (status, company, trade, level, due date, text), sort, group; click opens the view and
  selects the element. In 3D and on plans: pins and "colour by status" (a transient state, like compare in 07).
- Location filled automatically from the element's properties the user designates as level, room, zone
  (zones from workstream 06).
- Save and open: `.bcf` (BCF 3.0 written, 2.1 and 3.0 read; `src/data/bcf.ts` and `zip.ts` from 07) plus our
  JSON section `observations` for the plan pins and settings. Photos travel inside the `.bcf`.
- Report: PDF grouped by company, then by level — one block per observation with the plan extract and pin,
  photo, title, status, due date; a summary table first (sheet and PDF from workstream 08). CSV / Excel-ready
  export of the list.
- Assistant: observations are a data source for its tools ("combien de réserves ouvertes par entreprise").

## Part B — Shared project, accounts, phones

**Backend (`supabase/` at the repository root: SQL migrations, policies, edge functions)**
- Tables (`supabase/migrations/*.sql`), all with `id uuid` (created on the device), `project_id`,
  `updated_at`, `deleted_at`: `project`, `member` (e-mail, role, company), `company`, `plan` (tree, object
  key, version), `model` (object key), `topic` (with `phase`), `comment`, `viewpoint`, `attachment`
  (object key, size, hash), `event` (append-only history: who, when, which record, which fields),
  `list_value` (kinds, statuses, trades, phases per project).
- **Access rules in the database** (row-level security on every table, default deny): a helper
  `member_of(project_id)` returns the caller's role and company from his verified e-mail. Policies:
  administrators and editors read and write their projects; a **guest** reads only topics assigned to his
  company and their comments, photos and viewpoints, and may update status (allowed transitions), comment
  and add a photo. `event` is insert-only for everyone. A trigger writes the `event` row for each change,
  so history cannot be skipped by a client.
- Roles, first version: **administrator** (members, companies, lists), **editor**, **guest**. Nothing finer.
- Sign-in: Supabase Auth, e-mail one-time code, with our own mail sender configured (the built-in one is
  limited to two messages an hour).
- Files: Supabase Storage, one bucket, object keys `project/<id>/…`, storage policies using the same
  `member_of`; uploads direct from the device with size and type limits, a per-project quota checked by a
  trigger on `attachment`. R2 can replace it later behind the same `uploadFile` of the interface.
- **Sync (PowerSync)**: sync rules mirror the access rules — one bucket of rows per project membership,
  narrowed to the company for guests — so a phone never even receives rows it may not see. Local writes
  go to PowerSync's upload queue and are applied through the normal Supabase API, so the database
  policies judge every write; applying the same change twice changes nothing (upsert by `id`).
- Conflicts: last write wins per column, and both writes appear in `event`. Observations, comments and
  photos rarely collide; no merge interface in the first version.
- E-mail on assignment: a database trigger queues it, an edge function sends a digest (not one mail per change).
- Later: an edge function exposing BCF-API 3.0 (`/bcf/3.0/projects/{id}/topics`…) so other BIM tools can
  read and write observations.
- Models are optional: when a project has one in storage, the viewer opens it by a signed URL. This is
  the "model reachable by a link" the viewer lacks today.

**Moving to another account (rehearse once on a copy before any client uses it)**
1. Supabase: transfer the project to the professional organisation (you must own the source and belong to
   the target; data, users, storage and region stay as they are). Or, to leave Supabase entirely:
   `pg_dump` and restore into any Postgres, copy the storage bucket.
2. PowerSync: point the instance at the database (unchanged address after a transfer), or create a new
   instance with the same sync rules; phones re-download their projects.
3. Point the application's configuration at the new addresses if they changed.
Identities are our UUIDs and files our keys: nothing inside the data changes during a move.

**Application (`chantier.html`, `src/chantier/`)**
- Installable PWA. Screens: projects, plan tree, plan with pins, observation, list with filters, capture.
- Offline: the phone's local database holds the projects the user may see; every screen reads and writes
  it, network or not. Plans and photos are kept in the device's file storage, downloaded per project on
  request ("make available offline") with the size shown. Changes are sent when the application opens or
  the connection returns (no background sync on iOS). A permanent indicator shows what is not sent yet.
- Photo capture with the camera, reduced on a canvas, stored locally until sent; annotation (arrow, circle,
  text) on the photo.
- Notification on assignment: by e-mail first (database trigger and edge function); push later (iOS only for installed apps).
- Desktop: the same list beside the viewer, the 3D pin, BCF import/export, the PDF report.

## Later, in this order

1. **Checklists and forms**: templates with text, number, date, list, conformity OK / KO / n.a., photo,
   signature drawn on screen with name and time; a filled form produces observations for each KO.
2. **Réception workflow**: phases OPR → réception → levée → GPA as stages; the list of réserves per
   company; PV documents generated from the list in the layout of the usual forms (as working documents).
3. **Meetings**: attendance, notes linked to observations, minutes PDF, carry-over of open points.
4. **Dashboards**: open / closed by company, by trade, overdue, average time to close.
5. **Finer permissions**, status transitions by role, companies' sub-accounts.
6. **3D on phones** with a reduced model, QR codes on rooms, native wrappers if the PWA limits hurt.

## Files

- Part A: `src/data/observations.ts` (model, filters, pure), `src/data/bcf.ts`, `src/data/zip.ts`,
  `src/ui/ObservationsPanel.ts`, `src/engine/pins.ts` (3D and plan markers), report layout in `src/data/sheet.ts`.
- Part B: `chantier.html`, `src/chantier/*` (app, local store, screens),
  `src/chantier/backend/port.ts` (the interface), `backend/supabase.ts` (adapter), `backend/memory.ts` (tests),
  `supabase/migrations/*.sql` (tables, policies, triggers), `supabase/functions/*` (mail digest, later
  BCF-API), `powersync/sync-rules.yaml`, `docs/chantier-deplacement.md`, `docs/chantier-donnees-personnelles.md`.
- `docs/contrat-observations.md` (new): the JSON section and the BCF mapping above.

## Watch out for

- **Personal data.** Part B stores names, e-mails and site photos (people may appear on them). Decision 9
  sets who answers for what; the application must make the client's duties easy: export and delete per
  project and per person, retention after closure, and a clear statement that — unlike the viewer, which
  uploads nothing — this application stores data on a server. Templates are not legal advice: a lawyer
  reviews them before the first client.
- **Plan limits** (to recheck at build time). Supabase free: 500 MB of data, 1 GB of files, two projects,
  and **a project pauses after a week without activity** — fine for development, not for a client.
  Supabase Pro: $25 a month (8 GB data, 100 GB files). PowerSync free: 50 phones connected at once, 2 GB
  synchronised a month, deactivated after about a week idle; Pro from $49 a month. So: free while
  building, about $25–75 a month from the first real client. Show each project's storage; refuse uploads
  cleanly at a quota we set.
- **Access rules live in two places** — database policies and PowerSync's sync rules — and must say the
  same thing. One test file states the cases once (who sees what) and runs them against both.
- **Supabase's region cannot be changed** after creation: create the project in Paris from the first day.
- **PowerSync is the least proven piece** (web SDK maturity unverified): the trial of decision 3 comes
  before anything is built on it, and the local store is behind our interface so our own queue can take
  its place.
- **Local database on a phone**: size it (rows are small; photos and plans are the weight), let the user
  choose which projects to keep offline, and handle "storage full" with a message, not a crash.
- **Deleted records** must reach phones that were offline: soft-delete (`deleted_at`), purge later.
- **iOS**: storage can be evicted and is cleared after seven days without use for sites not installed on
  the home screen; no background sync; push only when installed. Tell the user to install the app, ask for
  persistent storage, and always show what has not been sent yet.
- **Element identity**: a pin on an element relies on its key (IFC GlobalId; for Revit the key derived from
  UniqueId). A re-exported IFC with new GlobalIds orphans the pins: keep the 3D point and the level with
  the observation so it can still be found, and report orphans.
- **Replacing a plan**: keep pins when the new plan has the same extent; otherwise ask for two reference
  points to realign.
- **BCF compatibility**: write strictly to the schema (snapshot ≤ 1,500 px, GUIDs, ISO dates) and test the
  files in at least two other tools before announcing compatibility.
- **Secrets and deploy**: database migrations are applied by the Supabase CLI in CI with an access token
  and database password stored as GitHub secrets that the owner types himself in a hidden prompt
  (`gh secret set …`) — never pasted in a chat, never in the repository. The step runs only when
  `supabase/` changes, like the assistant's Worker with `worker/`. The page only ever holds the project's
  public address and public key; the service key never leaves the server side.
- **Two environments from the start**: a development project for tests and a production one; migrations
  go to development first; never try things on the project that holds a client's data.
- **Scope**: Finalcad's breadth (forms builder, meetings, dashboards, 29 languages, native apps) took a
  company years. The first shared version is observations on plans with photos and a report. Say no to the rest
  until that works on a real site.

## Tests

- `tests/observations.test.ts`: filters and grouping; status transitions; location from designated properties.
- `tests/bcf.test.ts`: write then read gives the same topics, comments, viewpoints and snapshots; a BCF 2.1
  sample file reads; the plan-pin extension survives a round trip through our JSON and is ignored by BCF.
- `tests/outbox.test.ts`: changes made offline are sent in order; a rejected change stays visible; two
  edits of different fields both survive; same field: last write wins and both appear in history.
- Database tests (pgTAP or plain SQL run by the Supabase CLI against a local database; needs Docker, so in
  CI rather than on every local run): a guest cannot read or change another company's topics; an
  unauthenticated call is refused; an editor of one project cannot see another; `event` cannot be updated
  or deleted; the same upsert twice gives one row; an upload over the quota is refused.
- `tests/accessCases.test.ts`: the table of "who sees what" cases, checked against the sync rules.
- `tests/backendPort.test.ts`: the application's screens and sync run against the in-memory adapter (no
  network): this suite must still pass the day the backend changes.
- Field check before calling Part B usable: one real site visit on an iPhone and an Android phone, in
  aeroplane mode, twenty observations with photos, then sync, then the PDF report.

## Open questions (owner)

None blocking. Decided: Supabase with PowerSync, on free plans for now. To do when the time comes: move to
paid plans with the first real client, and have the legal templates reviewed by a lawyer.
