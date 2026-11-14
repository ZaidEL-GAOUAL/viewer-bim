# Viewer BIM — roadmap specs (November 2026)

Eleven workstreams, one file each. Every file says what exists today (with file and line), what was decided,
what to build, what to watch out for, how to test, and what the owner still has to answer. There are no
durations and no iterations: only what has to be done and in which order things depend on each other.

> **For agents implementing a workstream:** read this page, then your workstream's file, then the code it
> cites (line numbers are from commit `3b03458`; search by name if they moved). Write the failing test
> first. One workstream per branch. Do not commit or push unless the owner asks. Anything listed under
> "Open questions (owner)" is not yours to decide: stop and ask.

## The owner's requests, and where each one is specified

| Request | Workstream |
| --- | --- |
| Modify metadata, saved in the JSON, not in the `.rvt` | [02](02-editable-metadata.md) |
| Dead features, duplicates, missing things | [01](01-cleanup.md) |
| Assistant: better, and independent of the model and provider | [04](04-assistant.md) |
| Découpage automatique via esquisse | [06](06-quantities-zoning.md), part B (real cut into parts, as Revit Parts) |
| Calcul automatique des manquants sur un élément | [06](06-quantities-zoning.md), part A (missing quantities, required properties) |
| Comment ajouter les vues | [05](05-views-sections.md), part A |
| Retravailler les coupes | [05](05-views-sections.md), part B |
| Export vue en PDF pour impression | [08](08-exports-pdf-dxf.md), parts A and B |
| Export DWG | [08](08-exports-pdf-dxf.md), part C (DXF: DWG cannot be written legally and reliably) |
| Ne plus réinstaller IfcOpenShell à chaque conversion ; le précharger | [03](03-ifc-engine.md) |
| Comparaison de deux versions d'une maquette | [07](07-federation-compare-clash.md), part B |
| Clash et autres fonctions « IFC » | [07](07-federation-compare-clash.md), parts A and C |
| Our own Forma (site study) | [09a](09a-site-study.md) |
| Our own Finalcad (site follow-up) | [09b](09b-site-follow-up.md) |
| Rework of the interface, at the end | [10](10-ui.md) |

## Order and dependencies

```
01 clean-up ──▶ 02 editable metadata ──▶ 04 assistant
      │
      ├──────▶ 03 IFC engine            (independent of the others)
      │
      └──────▶ 05 views + sections ──▶ 08 PDF + DXF ──▶ 09b site follow-up (A: files, B: shared app)
                     │                      ▲
                     └──▶ 06 quantities     │ capture
                              + zoning      │
               07 federation ──▶ compare ──▶ clash ──▶ BCF (needs 08 capture)

09a site study: needs the sketch tool (06), the spatial index (07), capture and sheet (08).
10 interface: after all of the above.
```

- 01 first: 02 and 04 both touch filter matching and number parsing, which 01 reduces to one copy.
- 03 touches only `src/ifc/` and `pipeline/`: it can be done at any moment.
- 05 produces the cut lines (`sectionCut`) that 08 prints and exports, and the `levels` section that 06
  and `plan_dates` use.
- 07 is the largest structural change (several models in one scene). Nothing before it depends on it.
- 09a and 09b are our own products, each a second page of this repository sharing the viewer's engine.
  09b part B is the first thing in the project that needs accounts and a database.

## Rules that apply to every workstream

- **Runtime dependencies:** `three` and `cesium`, plus free ones the owner accepted on 14 November 2026
  ("yes as long as it is free"): `jsPDF` (08), `three-mesh-bvh` (07, 09a), `manifold-3d` (06, on demand).
  Any other new one: free, permissive licence (MIT, BSD, Apache, ISC), loaded on demand when it is large,
  and named in the workstream. GPL and AGPL code is never bundled.
- **The viewer stays generic:** no hard-coded BIM property names in logic. The user picks properties.
- **Public interfaces:** the metadata JSON contract (`docs/contrat-metadonnees.md`), the planning contract
  (`docs/contrat-planning.md`) and `window.viewerBim` (version 1). Additions are optional fields; an older
  file must load unchanged; update the contract document in the same change.
- **Source files are never written.** Not the `.rvt`, not the `.ifc`. Modifications go to JSON.
- **Source geometry is never edited.** Two things create geometry, both on the owner's decision of
  14 November 2026: parts cut from elements (06), derived from a stored definition and removable; and
  study volumes (09a), which are new design objects, not BIM elements.
- **Backend (09b only):** PostgreSQL on Supabase (Paris) with PowerSync for offline, free plans for now, behind one interface
  so it can be moved to another account or replaced; records identified by our own UUIDs. The viewer and the site study
  stay without a server. Secrets are typed by the owner in a hidden prompt, never pasted in a chat.
- **Performance first:** no long work on the main thread (worker + progress + cancel); memory must not grow
  with file size beyond the displayed model; measure with the browser pane in front.
- **Never call a language model in tests or for verification.** It spends the owner's quota.
- **Private files:** `revit/samples/wadduwa.rvt` is never committed. User files are never modified.
- **Working copies and builds go on the SSD** (`/Volumes/Zaid's SSD 1/viewer-bim-travail/`). exFAT: use
  `npm run typecheck`, `npm test`, `npm install --no-bin-links`; ignore `._*` files.
- **Interface text is French**, plain and short. Commit messages are English.
- **Deploy:** a push to `main` publishes the site; the Worker is redeployed only when `worker/` changes.

## Building blocks shared by several workstreams (build once)

| Block | Built in | Used by |
| --- | --- | --- |
| `data/conditions.ts`, `data/text.ts` (one filter matcher, one text folding) | 01 | 02, 04, 06, 07 |
| `PropertyEdits` baseline and `diff()` | 02 | 04 (previews), 07 (per-source export) |
| `coerceTo(existing, raw)` typed values | 02 | 04 |
| `levels[]` contract section | 05 | 05 (plans, cut at level), 06 (zones by level), `plan_dates` |
| `engine/sectionCut.ts` (cut lines) | 05 | 08 (PDF vectors, DXF), 06 (snapping) |
| `engine/capture.ts` (tiled image of a view) | 08 | 05 (thumbnails), 07 (BCF snapshots) |
| World-frame conversion (recentred, Y up ⇄ original, Z up, metres) | 05 | 06, 07, 08 |
| `data/zip.ts`, `data/bcf.ts` (zip and BCF read/write) | 07 | 06 (requirement failures), 09b (observations) |
| `engine/sketch.ts` (lines and polygons on a work plane) | 06 | 09a (footprints, site limit) |
| Spatial index (`three-mesh-bvh`, in a worker) | 07 | 09a (sun, sky component), picking |
| Transient element states (status colours) | 07 | 06 (conforming / failing), 09b (observation status) |
| Action catalogue (name, arguments, runner) | 04 | 10 (command palette) |
| Worker job pattern (progress, cancel) | 05 | 06, 07, 08 |

**Coordinates, said once:** the viewer recentres each model (`Model.offset`) and uses Y up. Everything
that leaves the viewer in metres (zones, levels, DXF, BCF viewpoints, saved section planes, federation
placement) is expressed in the model's original coordinates, and says so in the contract.

## Feature inventory (the checklist for 01 and 10)

Toolbar: panel toggles · export format GLB/USD · Ouvrir, Dossier, Métadonnées · Exemples (demo, tower, IFC,
Revit) · Sélection · Mesures (Distance, Surface, Volume, Cotes) · Effacer les mesures · Annuler, Rétablir,
Annuler les modifications · 2D with six standard views · Visite · Carte · Vues · Coupes · Cadrer ·
Masquer/Démasquer, Isoler, Désélectionner, Tout afficher · downloads (GLB or USD, JSON, Voir sur Apple).

Viewport: empty-screen card · status bar, toasts, busy overlay · conversion card (IFC converti / Fichier
Revit lu).

Cards: Cotes (copy table) · Carte (position, background, terrain, buildings, keys, place by click) · Vues
(default, 3D views, floor plans) · Coupes (three planes, place by click, realign, fill, box) · Mode visite ·
Apple preview.

Left tabs: Arborescence (group by, search, all properties, eye buttons, add JSON) · Couleurs et filtres
(phase and phase filter, rules by value and by condition, visibility) · Assistant (status, usage, API
settings, chat).

Right: Propriétés (edit in place, delete, add, selection size).

Bottom: Planning 4D (import, from metadata, example, export, remove, playback, Gantt, link details).

Input: drag and drop · keys F, H, I, A, Échap, undo/redo, V · double-click to frame.

Exports: GLB, USDZ, metadata JSON, planning JSON, dimensions table (clipboard), Quick Look.

Agent API: `window.viewerBim` and WebMCP, eleven tools.

## Decisions waiting for the owner (collected)

1. **02** — Unlock IFC's structural fields too, or Revit only? Keep unsaved modifications in the browser?
2. **04** — "Commands only" mode when no provider answers? Preview before large writes everywhere?
3. **05** — Should a saved view also keep the planning date?
4. **06** — Which of the two "missing fields" tools did you have in mind? Are parts exported as elements?
5. **07** — Compare across formats (an IFC against its Revit file)?
6. **08** — A company title block?
7. **09a** — Public page or reserved? Which analysis after sun and daylight?
8. **09b** — Nothing blocking (decided: Postgres, observation list with phases first, client responsible
   for his data and we process it).
9. **10** — The three or four most-used actions; phone and tablet scope.
10. **01** — Keep both ways to show/hide by value? Keep the example planning button?

## What these specs do not cover

- Writing into `.rvt` files (not feasible safely; see 02).
- Hosting customers' models online outside the site follow-up application (09b part B decides it there).
- Splitting very large Revit files across several workers (already on the Revit roadmap,
  `docs/lecture-revit.md`).
- Facts not verified: Forma's help-centre details (read through excerpts), several Finalcad points (pin on
  a BIM element, offline mechanics), `ifctester` in our wheel, Manifold on real BIM meshes, DXF output
  opened in each CAD program. Each file marks them where they matter.
