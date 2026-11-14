# 07 — Several models at once: federation, version comparison, clash detection

## Goal

Load more than one model in the same scene, compare two versions of the same model, and find clashes
between elements. All three work on the viewer's own data (keys, properties, triangles), so they apply to
IFC, Revit, GLB + JSON and USD alike, not to IFC only.

## Current state (verified)

- One model at a time: `App.model` is single, `installModel` disposes the previous one, and when several
  models are dropped only one is loaded with a toast (`src/ui/App.ts:937-938`, `1424-1442`).
- `src/ifc/mergeGlb.ts` already joins several GLB + JSON into one model: the shards of one IFC conversion.
  The Revit reader already makes a model grow chunk by chunk on screen.
- No spatial index: picking scans element boxes linearly; large elements have Morton-sorted blocks of 256
  triangles with boxes (`src/engine/triangleBlocks.ts:43-52`, `src/engine/Model.ts:280-330`).
- Each model is recentred by its own `Model.offset`.
- No dependency besides `three` and `cesium`. No BCF, no zip writer (USDZ is packaged in Python).
- Research: IfcOpenShell's `ifcdiff` and `ifcclash` (LGPL) are not known to run under Pyodide, would tie
  the features to IFC, and their BCF library is GPL. `three-mesh-bvh` (MIT) is the usual JS answer.

## Decisions

1. **Federation = append, not a second App.** Adding a model appends its elements to the current `Model`
   and `PropertyStore` (indices continue), the way IFC shards and Revit chunks are already joined. Every
   element gets a property `Modèle` (file name, editable label) and belongs to one `source` record. The
   tree, filters, colour rules, planning, assistant and selection work unchanged on the union.
2. **Keys stay the source's keys**, stored per source. Internally an element is `(source, key)`; the flat
   key used by the store is the plain key when unique and `<source>|<key>` when two sources share it
   (which is the normal case when comparing versions).
3. **One world frame.** A session keeps one offset, the first model's. Later models are placed by their
   original coordinates relative to it, never recentred on their own.
4. **Diff and clash are written in TypeScript on this data**, each as pure functions plus a worker.
   No Pyodide, no IfcOpenShell at run time for them.
5. **Spatial index: `three-mesh-bvh`** (MIT; the owner accepts free dependencies, 14 November 2026 —
   confirm the licence file at install). Broad phase on element boxes (sort and sweep), then the library's
   triangle tests, in a worker. The same index serves the ray casting of the site study (09a) and can
   replace the linear scan used for picking.

## Part A — Federation

- Open menu: "Add a model…" next to "Open…". Drop of several model files: ask "open together" or "replace".
- `src/engine/Model.ts`: `append(raw, sourceId)`; `sources: { id, name, kind, offset, range }[]`; remove a
  source (rebuild ranges). `src/data/metadata.ts`: store append/remove by range.
- A "Models" list: show/hide, remove, rename the label, element and triangle counts.
- Exports: metadata JSON and modifications overlay are written per source (one file each), with the
  source's own keys, so each sidecar still matches its file. GLB export of the union is allowed and says so.
- Triangle budget (`navigator.deviceMemory`) is shared by all sources; adding a model that would exceed it
  is refused with the figures, not silently truncated.

## Part B — Compare two versions

- "Compare with…" loads the other version as a source flagged `role: 'reference'` (older) against the
  current one. `src/data/compare.ts` (new, pure):
  - pair by key;
  - properties: per pair, added / removed / changed values, with ignore patterns chosen by the user (same
    pattern syntax as `readOnly`);
  - geometry signature per element: box rounded to 1 mm, triangle count, volume and area rounded to 4
    significant digits → `same`, `moved` (same shape, box translated), `changed`;
  - second pass on the unpaired: same category/class + name + shape signature within a small distance →
    "probably the same, identifier changed", shown as such, never merged silently.
- Result: `{ added, removed, modified: { properties, geometry, moved }, unchanged, renamedIds }`.
- Display: status written as a transient element state (not a property) driving colours — added green,
  removed red (drawn from the reference model, translucent), modified orange, unchanged dimmed; a tree by
  status; a before/after table for the selected element; a slider "before ⇄ after".
- Export: CSV and JSON report; the user can write the status into a property on demand.

## Part C — Clash detection

- A clash test = set A, set B (filters, same model of filters as colour rules; a set can be a source),
  type `hard` (penetration deeper than `tolerance`, default 10 mm) or `clearance` (closer than a distance),
  and exclusions.
- `src/engine/clash.ts` (new) in a worker: sweep and prune on boxes, then `three-mesh-bvh` intersection
  tests; result per pair: both elements, a point, an approximate penetration depth, the box of the overlap.
- Results panel: grouped (by pair of categories, by level, by element), sortable by depth; click frames
  the pair with a section box around it and isolates both; status per clash (`new`, `active`, `resolved`,
  `ignored`) and a comment, kept across re-runs by pairing clashes on their two keys.
- Saved in the JSON under an optional `clashTests` / `clashes` section; re-run marks disappeared clashes
  `resolved`.
- BCF 2.1 export written in TypeScript (`src/data/bcf.ts`): one topic per clash or per group, viewpoint
  (camera, selected components by GlobalId, section box), snapshot PNG from the capture path of workstream
  08. Needs a small store-only zip writer (`src/data/zip.ts`, shared with any later packaging).

## Watch out for

- Hosted elements clash by nature (a door in its wall, a pipe in its sleeve) and the viewer has no generic
  host relation. Without exclusions the list is unusable: default tolerance, "ignore pairs of the same
  source and same parent group", and user exclusions by filter are part of the first version.
- Duplicate geometry (the same element in two versions loaded as federation) gives a clash per element:
  comparison sources are excluded from clash sets by default.
- Regenerated GlobalIds make a diff of "everything deleted, everything added": the second pass and an
  explicit message when more than half the elements are unpaired.
- Memory doubles with two versions. The Revit reader streams within a budget: the reference model may
  need a lower budget, and the user is told what was reduced.
- Coordinates: two IFC exports of the same project can differ by a base-point shift. Offer "align by
  georeference" (when both have one) and a manual shift; say which is in use.
- Clash on raw triangles is O(pairs × triangles): cap pairs after the broad phase, report progress, allow
  cancel, and never run on the main thread.
- Map mode (Cesium draws the model itself): federation and transient states must be mirrored there or the
  features disabled in map mode with a clear message.
- The assistant's tools index elements by position: `toolContext` already reads `app.model` at each call;
  check `isCurrent` semantics when a source is added during a turn.

## Tests

- `tests/federation.test.ts`: append two fixtures, indices and ranges, removal, key collision → prefixed
  keys, per-source export keys unchanged.
- `tests/compare.test.ts`: added / removed / property change / moved / shape changed / renamed id on small
  fixtures; ignore patterns.
- `tests/clash.test.ts`: two overlapping boxes clash with the expected depth; touching boxes do not at
  10 mm tolerance; clearance test; exclusions; stable pairing across re-runs.
- `tests/bcf.test.ts`: archive lists `bcf.version` and one folder per topic; markup parses as XML.
- Browser check: the demo IFC against a copy with three edited elements; structure against MEP samples
  for clash, timings recorded.

## Open questions (owner)

1. Compare: two versions of the same file only, or also "IFC export against its Revit file"?
