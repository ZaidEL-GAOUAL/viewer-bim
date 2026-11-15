# 17 — Site follow-up as its own application, with accounts

## Reports

- "Separate our Finalcad and put it apart, in its own link / a different web interface."
- "Saving photos works, but they are still lost in the sense that they are not tied to a user. Maybe we
  must create profiles?"

## Where we are

Observations live in the viewer (menu « Chantier ») and are kept only in the JSON the user exports
(`docs/contrat-observations.md`); photos travel inside it. Close the tab without exporting and they are
gone. `../2026-11-14-roadmap/09b-site-follow-up.md` part B already decides the answer: a second
application `chantier.html` with accounts, on Supabase (Paris, free plan) with PowerSync for offline.

## Decisions for this step

1. **`chantier.html` is built now**, as the third page of the repository (after `index.html` and
   `site.html`): its own interface, made for a phone first, linked from the viewer's header. The viewer
   keeps a light entry: "Observations de ce projet" opens the same data in a side panel when a project is
   linked; the full tool is the new page.
2. **Profiles = Supabase Auth.** A person signs up with e-mail and password (e-mail confirmation as
   Supabase sends it). The one-time code by e-mail of 09b comes with our own mail sender, later: the
   built-in sender is limited to a few messages per hour. Profile: display name, company, avatar initials.
3. **Nothing is lost, with or without an account.** Everything is written first to the device
   (IndexedDB: observations, comments, photos as blobs). Signed in, it syncs to the project in the
   database; signed out, it stays on the device and the page says "non synchronisé — connectez-vous pour
   retrouver ces données ailleurs".
4. **Sync without PowerSync for now.** PowerSync needs an instance the owner has not created; the code
   goes through the `BackendPort` of 09b (sign in, pull, push, upload file) with two adapters: Supabase
   (this step) and in-memory (tests). Sync is a pull of rows changed since the last cursor and a push of
   the local queue, row by row, last change wins per field group, `created_at` / `updated_at` set by the
   database. PowerSync replaces the queue behind the same port when its trial is done; identifiers are
   UUIDs created on the device, so nothing has to be renumbered.
5. **Access rules in the database**, as in 09b: organisation, project, membership with a role
   (administrator, editor, guest); row-level security on every table and on the photo bucket; a guest sees
   only what is assigned to him or his company. First version of invitations: an administrator adds a
   member by e-mail; the person finds the project after signing up with that e-mail.

## What to build

**Database** (`supabase/migrations/`, applied to the development project `iuxtrirwvstuzzljecwi` by the
lead, never by an implementer): `profiles`, `organisations`, `projects`, `memberships`, `topics`
(observation = BCF topic, columns of `contrat-observations.md`), `comments`, `viewpoints`, `photos`
(storage path, size, hash), `events` (append-only history), each with row-level security and the indexes
its policies need; a private storage bucket `photos` with the same rules; a trigger keeping `updated_at`;
a function creating the profile at sign-up. Policies are tested (below) before any page uses them.

**Code**
- `src/chantier/backend/port.ts` (`BackendPort`), `supabase.ts` (uses `@supabase/supabase-js`, MIT — the
  owner accepts free dependencies; pin the version), `memory.ts`.
- `src/chantier/store.ts`: local IndexedDB store and the sync queue; `src/chantier/sync.ts` (pure
  merge rules, tested).
- `src/chantier/` pages: sign in / sign up / profile; project list and creation; observation list with
  filters (status, assignee, company, level, overdue); observation form (title, type, status, priority,
  assignee, due date, photos from the camera or files, comments, history); plans with pins (a project's
  plans are PDF or image files, or sheets printed from the viewer); report PDF and BCF export through the
  existing `src/data/bcf.ts`, `src/ui/observationsPdf.ts`, `src/data/observations.ts` — moved to shared
  modules, not copied.
- `chantier.html`, a third Vite entry; web-app manifest and icons so it installs on a phone; a service
  worker that caches the page shell for offline start (data comes from IndexedDB).
- Viewer: the « Chantier » menu links a model to a project ("Lier à un projet"), then observations made
  in 3D are the project's; without a link, the file-only behaviour stays exactly as today.
- Configuration: `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (publishable key, public by design) in
  `.env.production` and the deploy workflow; without them the page works on the device only and says so.

**Moving data** — "Importer un fichier d'observations (JSON ou BCF)" brings what the owner already
created in the viewer into a project.

## Watch out for

- **Security is in the policies, not in the page**: every table denies by default; test as an anonymous
  caller, as a member of another project, as a guest. The publishable key is public; the service key never
  enters the repository or the browser.
- **"Confirm email" must stay ON** in the project's Auth settings: membership is matched on the caller's
  confirmed e-mail; with confirmation off, anyone can sign up with an invited person's address and take the
  invitation. The migration states it as a precondition.
- The app sends every creation as `insert … on conflict (id) do nothing`: PostgreSQL then checks the new row
  against the table's read policy, before `after` triggers run. Every read policy must show its author the
  row being created (the project's creator has no membership yet: `private.creating_project`).
- Supabase Free pauses an idle project after a week and limits storage to 1 GB: photos are reduced to
  1,500 px before upload (already done), the page handles "service en pause" as "hors ligne".
- Sync conflicts: two people editing the same observation offline. Field groups (status, assignment,
  text) merge independently; comments and photos only append; `events` records who changed what.
- A photo is uploaded once (content hash), resumable; a failed upload stays in the queue.
- Personal data (names, e-mails, photos of people on site): the legal notice and deletion of an account
  with its personal data are part of the first version; the client is the data controller (09b).
- iPhone: an installed web app has its own storage, separate from Safari's; storage may be evicted after
  weeks without use — another reason to sync when signed in.
- Do not break the viewer's bundle: the Supabase client loads only on `chantier.html` and when a model is
  linked to a project.

## Tests

- `tests/chantierSync.test.ts`: merge rules, queue order, retry, conflict on the same field, append-only
  comments.
- `tests/chantierStore.test.ts` (fake IndexedDB): write offline, reload, sync later.
- `supabase/tests/policies.sql` (run by the lead on the development project): anonymous refused; member
  of A cannot read B; guest sees only his assignments; `events` cannot be updated or deleted.
- Browser: sign up, create a project, add an observation with two photos, reload on another profile of
  the browser and sign in: everything is there. Offline (network cut): add an observation, reconnect: it
  syncs once.

## Still needed from the owner, later

The PowerSync instance and the iPhone trial of 09b; a mail sender for one-time codes and notifications.
None blocks this step.
