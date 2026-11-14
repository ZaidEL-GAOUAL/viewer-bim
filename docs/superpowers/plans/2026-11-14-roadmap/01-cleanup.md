# 01 — Clean-up: dead code, duplicates, stale docs, missing tests

## Goal

Remove what is dead, keep one copy of what is duplicated, and correct the docs, before the features of
02–09b are built on top. Behaviour visible to the user does not change, except the bugs listed in D.

Findings come from a text-search audit of `src/`, `tests/`, `worker/`, `pipeline/`, `scripts/` and the docs
(November 2026). "Unused" means no reference in `src/`; check each one with the type-checker before deleting.
Paths are under `src/` unless written otherwise.

## A. Delete

**Never used**
- `calculateAppearance` alias (`data/appearanceRules.ts:108`).
- The `'colors'` event: declared (`ui/App.ts:42`), emitted (`:629`), never listened to.
- `App.conversion.glb`, `.model`, `.extension` (written `App.ts:1020`, type `:135`): only `.name` is read (`:1160`).
- `MapPanel.active` getter (`ui/MapPanel.ts:76-78`); `WalkControls.heights` getter (`engine/WalkControls.ts:115`).
- `ScheduleStatusValue` type (`data/schedule.ts:24`).
- `App.toolButtons` (only ever holds `'select'`, `App.ts:110`, `:216`); `App.matched` (`:173`, a copy of `store.matched`).

**Used by tests only — delete with their tests, or keep and say why in one line**
- `ElementState.isSelected`, `clearOpacity` (`engine/elementState.ts:215`, `:276`); `PropertyStore.setLabel`
  (`data/metadata.ts:268`); `elementDimensions` (`engine/dimensions.ts:129`, needed again by workstream 06: keep);
  `degreesFromIfc` (`geo/georeference.ts:106`; the real conversion is Python, `pipeline/ifc_to_glb.py:397`).

**Exported for no reason** — make module-private: `matchesCondition`, `selectIndices`, `HIGHLIGHT_IDS`,
`loadCesium`, `OVERPASS_URLS`, `SUPPORTED_VERSION`, `FLAG_VISIBLE`, `ELEMENT_FIELD_LABELS`, and about 40
internal types. (`selectIndices` and `matchesCondition` become shared in C: decide there.)

**Leftovers**
- `tests/editModel.test.ts` only tests `writeGlb`: rename to `tests/writeGlb.test.ts`.
- `.measure-remove` (`styles.css:1007`) is now the generic close button used in four places: rename to `.close-button`.
- `pipeline/__pycache__/ifc_writer*.pyc`, `test_ifc_writer*.pyc`: untracked, no source; delete, and check `.gitignore`.
- `public/samples/ifc-demo.glb`, `.json`, `.usdz` are read only by tests but ship with the site: move to
  `tests/fixtures/` (update `tests/ifcSample.test.ts:11-14`, `tests/usd.test.ts:10`).

## B. Correct comments and docs

- `App.ts:58-59` (comment above the wrong constant), `:1327` (comment belongs to `installModel`, `:1398`),
  `:276` (title overwritten at `:1236`).
- `assistant/tools.ts:22`, `:245` say the assistant has no access to geometry; `heightOf` (`tools.ts:43`,
  `ui/toolContext.ts`) gives `plan_dates` element heights. State the real rule: geometry is used by code to
  order, never sent to the model.
- `docs/contrat-metadonnees.md:132-135`: the assistant does write properties (`set_property`, `plan_dates`).
- `README.md`: `:97` against `:413` (size limit: say which is true per format); Architecture (`:294-301`)
  omits `src/geo/`; `:306` describes `scripts/` as one script, there are seven; `:245-246` against `:251`
  (meshes and `plan_dates`); "Mise en ligne" omits the root `wrangler.toml` (ask the owner: the Cloudflare
  site copy was deactivated on purpose).
- `worker/README.md:41`: the token estimate per question is far below what the prompt and tool list weigh.
- `docs/superpowers/plans/2026-10-25-rvt-natif.md`: add one line at the top, "Done; kept for history; current
  state in `docs/lecture-revit.md`".

## C. One copy instead of several

Each line: what to keep, what to replace with it. Do them one at a time, tests green between each.

| Topic | Keep | Replace |
| --- | --- | --- |
| Filter matching | One module `data/conditions.ts` built from `appearanceRules.ts:4-52` | `assistant/tools.ts:10-11`, `:258`, `:311-351`; `valueOf` = `valueAt` |
| Accent-insensitive text | One `fold()` in `data/text.ts` | `appearanceRules.ts:21`, `tools.ts:258`, `TreePanel.ts:112`; FilterPanel search (`:166`, `:346`, `:365`) starts using it |
| Number from text | `numericValue` (`appearanceRules.ts:25`) | `PropertiesPanel.ts:11`, `:22-27`; `FilterPanel.ts:279-282`; `tools.ts:317`, `:457`; `expression.ts:190-196` |
| `isRecord` | One in `data/json.ts` | five other copies in `src/` (the worker keeps its own: separate package) |
| Plurals | `plural` in `ui/dom.ts` or `data/text.ts` | `counted` (`App.ts:70`), `plural` (`tools.ts:478`), inline `> 1 ? 's'` in five panels |
| Number formats | `megabytes`, `integer`, `decimal` once | `convertIfc.ts:49` / `readRevit.ts:74`; `dom.ts:31` / `revitReport.ts:3`; `metadata.ts:172` / `DimensionsCard.ts:13` |
| Dates | `schedule.ts:55-80` | `SchedulePanel.ts:10` (hard-coded 86400000); `dayOf` (`tools.ts:446-454`) becomes `parseScheduleDate` + DD/MM/YYYY in one place |
| GLB container | `ifc/mergeGlb.ts:104-125` (handles an empty binary chunk) as `engine/glbFile.ts` | `writeGlb.ts:159-183`, `geo/cesiumGlb.ts:122-144`, `updateGlbMetadata.ts:21-25`, `tests/helpers.ts:75-90`; shared accessor helpers of `writeGlb.ts:8-52` / `cesiumGlb.ts:17-45` |
| sRGB → linear | `buildModel.ts:177` | `writeGlb.ts:114-115` |
| Download | One `download(blob, name)` in `ui/dom.ts` | `App.ts:1205-1207`, `SchedulePanel.ts:360-362` |
| Guarded `localStorage` | One `stored.get/set` | `App.ts:294-298`, `:1330-1334`; `MapPanel.ts:11-26`; `WalkPanel.ts:91-95`, `:126-130` |
| Out-of-memory detection | `readRevit.ts:105-112` | `App.ts:64-67`; the "4 GB when unknown" guess of `convertIfc.ts:210` / `readRevit.ts:48` becomes one constant |
| File kinds | One table (extension → kind) | `loadModel.ts:108`, `convertIfc.ts:90`, `loadUsd.ts:21`, `readRevit.ts:64`, `App.ts:189`, `:839`, `:926-927`, `:984` |
| Selection size | `DimensionsCard.ts:67` | "Emprise" in `PropertiesPanel.ts:106-113` |
| Small ones | — | value ranking (`prompt.ts:54-57` / `tools.ts:302-306`); path normalising (`PropertiesPanel.ts:239` / `tools.ts:270`, `:430`); FilterPanel fills one dropdown twice (`:90-91`, `:102-103`); planning JSON parsed twice (`App.ts:865`, `SchedulePanel.ts:109`); properties written twice on GLB export (`App.ts:1175`) |

Leave as they are, with a comment naming the twin: the per-element colour shader in `elementState.ts` and
its mirror in `geo/GlobeModel.ts` (two renderers), and API-address validation in `assistant/settings.ts`
and `worker/src/index.ts` (client and server). Put the "in progress" orange in one constant read by
`elementState.ts:327`, `GlobeModel.ts:42` and `schedule-panel.css:34`.

## D. Bugs found on the way (fix here, with a test each)

1. **Filters disagree.** `not_equals` on a missing value is true for the assistant and false for colour
   rules; numbers are compared differently. After C there is one behaviour. Decide it explicitly: a missing
   value is "not equal" to anything (the assistant's reading), documented in the contract.
2. **The status bar counts undo steps, not modified values** (`App.ts:136`, `:1565`; `PropertyEdits.ts:14`).
   Workstream 02 adds `modifiedCount`; use it.
3. **One message hides another**: `App.ts:931-941` shows a single notice, so a bad-JSON error disappears
   behind a texture or warning message. Show all, most serious first.
4. **Service check failure is invisible**: `AssistantPanel.ts:85` blanks the provider name; say "service
   unreachable".
5. The assistant defects are listed and fixed in workstream 04.

## E. Decide with the owner (duplicated features, not code)

- Show/hide by value exists twice: the tree's eye buttons and the "Visibilité" section of the filters
  panel (`FilterPanel.ts:66-75`, `:350-395`). Keep one (proposed: the tree) or keep both?
- The conversion card repeats the toolbar's download buttons (`App.ts:405-406` / `:276-277`).
- "Planning d'exemple" only appears for `demo.glb` (`SchedulePanel.ts:103`): keep as a demo aid or remove?
- USD export of any model runs Python in the browser (`ifcWorker.ts:120-126`). Workstream 03 stops it from
  loading IfcOpenShell; porting the writer to TypeScript is not planned.

## F. Tests that are missing

No test touches `ui/*` (about 4,400 lines, `ApplePreview.ts` excepted), `engine/Measure.ts`,
`engine/SectionHandles.ts`, `geo/GlobeView.ts`, `geo/GlobeModel.ts`, `ifc/ifcWorker.ts`,
`revit/revitWorker.ts`, `data/palette.ts`. Not everything needs one. Add, in this order:
- pure logic pulled out of panels by C (conditions, text, dates, file kinds): unit tests come with the move;
- `Measure` maths (distance, face area, volume on a known box);
- `palette.ts` (stable colour per value);
- one smoke test per panel that it builds and reacts to its main event, with a minimal fake `App` — only
  for panels the later workstreams modify (Properties, Views, Sections, Filter, Schedule).

## G. `App.ts` (1,726 lines)

Do not split it here: workstream 10 reorganises the shell. Its eleven responsibilities, for reference:
shell construction (176-446), events (450-458), selection and visibility (462-613), rules and grouping
(615-634), phases and views (636-758), camera and tools (760-829), loading (833-1132, 1263-1325, 1343-1528),
export (1134-1239, 1327-1341), property-edit pass-through (1241-1261), toast and status (1532-1573), input
handlers (1575-1725). Workstreams that add to loading or export (02, 03, 07, 08) put new code in their own
modules and call them from `App`, so the file does not grow.

## Watch out for

- exFAT: use `npm run typecheck` and `npm test`, never `npx tsc`; ignore `._*` files.
- Each replacement in C can change behaviour at the edges (percent signs, non-breaking spaces, accents):
  write the test on the kept copy first, then switch callers.
- `window.viewerBim` (version 1) and the JSON contracts are public: tool names, arguments and file formats
  do not change in this workstream.
- The worker is a separate package deployed only when `worker/` changes: do not import `src/` into it.

## Done when

`npm run typecheck`, `npm test` and `npm run build` pass; the bundle is not larger; the feature inventory in
the README of this folder still holds line by line in the browser.
