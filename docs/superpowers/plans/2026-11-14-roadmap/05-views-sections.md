# 05 — Views the user creates, and reworked sections

## Goal

The user saves what he sees as a named view and comes back to it; sections become something he can place
precisely, keep, and print. The cut itself (the lines where a plane crosses the model) becomes data that
the PDF and DXF exports reuse.

## Current state (verified)

**Views**
- Views come only from the metadata JSON `views[]` (`src/data/savedViews.ts:49-65`, parsed in
  `metadata.ts:144-145`): for Revit, named 3D views and floor plans. A view stores camera, `sectionBox`,
  hidden categories and elements, phase and phase filter. No appearance rules, no free section planes.
- The user cannot create, rename or delete a view: `savedViews` is a read-only getter (`src/ui/App.ts:644-646`),
  the panel has no editing control (`src/ui/ViewsPanel.ts`). Export writes the file's views back unchanged.
- `src/engine/views.ts` is only the six standard 2D directions.
- No level elevations in the metadata: nothing to build a plan per level from for IFC or GLB.

**Sections**
- Three free planes, movable, flippable, orientable, with one gizmo at a time; "place by click" on a face
  (`src/engine/Sections.ts:16-30`, `134-160`; `src/engine/SectionHandles.ts`; `App.ts:818-829`).
- A six-plane box exists but only a saved view can set it; no handles; the panel can only switch it on or off
  (`Sections.ts:31-40`, `src/ui/SectionPanel.ts:82-87`).
- Cut faces are filled by a stencil pass: one flat colour, closed opaque solids only, **two extra full-scene
  renders per active plane** (`src/engine/Viewer.ts:733-756`).
- Free planes are saved nowhere. Not done: hatching, lines of what lies beyond the cut, annotations.

## Part A — User views

**Model (`src/data/savedViews.ts`)**
- `SavedView` gains optional fields: `origin: 'file' | 'user'` (absent = file), `sections` (free planes:
  point, normal, enabled), `appearanceRules`, `grouping`, `isolated` (element keys), `id` (stable, for
  rename and links).
- `captureView(app): SavedView` and the existing `App.openView` applying the new fields. Hidden and isolated
  elements are stored by key, as today.
- Contract (`docs/contrat-metadonnees.md` § views): the new fields are optional; a reader that ignores them
  still opens the camera. User views are exported in both JSON exports (workstream 02).

**Panel (`src/ui/ViewsPanel.ts`)**
- "Save this view" (name prompt, default "Vue 1"), then per user view: open, update with the current state,
  rename, duplicate, delete, reorder. A file view is read-only but can be duplicated into a user view.
- A third group "Mes vues" above "Vues 3D" and "Plans d'étage".

**Levels and generated plans**
- New optional contract section `levels: [{ name, elevation }]` (metres, model coordinates). Written by the
  IFC pipeline (`IfcBuildingStorey.Elevation`, `pipeline/ifc_to_glb.py`) and by the Revit reader (Level
  elements).
- With `levels`, the panel offers "Plan of level X" for models that carry no plan: top view, orthographic,
  cut 1.2 m above the level, depth down to the level. Generated on demand, saved only if the user saves it.
- `plan_dates` uses `levels` when the ordering property's values match level names, and keeps the median
  height otherwise.

**More view kinds from Revit** (after the above): sections and elevations (`kind: "section" | "elevation"`),
then ceiling plans. Needs a census of the view classes in the sample files first, as was done for floor plans
(`viewer-bim-travail/specks/census/`).

## Part B — Sections

**One cut module (`src/engine/sectionCut.ts`, new)**
- `cutSegments(model, plane, options): { element: number; points: Float32Array }[]` — for each visible
  element whose box crosses the plane, the triangle/plane intersection segments in plane 2D coordinates.
  Uses `Model.parts` and the element boxes; runs in a worker for large models; cached per plane position.
- `chainLoops(segments, tolerance)` — joins segments into closed polylines when the solid is closed.
- Consumers: the outline drawn on screen, the PDF export, the DXF export (workstream 08), cut areas.

**Box**
- The box gets handles: one per face (push/pull) and a rotation ring about the vertical. "Box around the
  selection" and "Box around what is visible" buttons. The box can be edited after a saved view set it.

**Placing a cut**
- "Cut at level" (list from `levels`, or typed height), "Cut through the selection" (plane through its
  centre, facing the camera), numeric position and angle fields next to the gizmo, step keys.
- Each plane has a name; planes and box are part of a saved user view (Part A).

**Drawing the cut**
- Fill colour: the element's own colour (default) or one colour, user's choice; optional hatch (one diagonal
  pattern, screen-space, cheap). Thick outline along the cut from `cutSegments`.
- Open meshes are not filled (as today) and their cut outline is drawn dashed, so the user sees why.

**Cost**
- Today every active plane adds two scene renders, the box up to twelve. Fill and outline are redrawn only
  when the camera or a plane has stopped moving (the viewer already lowers resolution while moving,
  `AdaptiveResolution.ts`); while moving, draw the clip only.

## Watch out for

- Plans open with rotation disabled and their own box (`savedViews.ts:296-323`): a user view saved from a
  plan must restore that mode, not a free 3D camera looking down.
- Elements hidden at opening (`hiddenInEveryView`) and "Vue par défaut" keep their behaviour.
- A view stores keys: after the source file changes, missing keys are ignored, and the panel says how many.
- The clip planes are uniforms shared by every material, including the Cesium globe mode which mirrors
  `ElementState` in its own shader: check map mode when adding planes or per-element fill colours.
- Picking snaps to the cap (`Viewer.ts:575-607`, `tests/sectionPicking.test.ts`): keep it working with the
  editable box.
- `cutSegments` on a 12-million-triangle model: box culling first, worker, and a progress state; never block
  the main thread.
- Model coordinates are recentred (`Model.offset`): anything exported or saved in metres must say which
  frame it is in (see README, shared rules).

## Tests

- `tests/savedViews.test.ts`: a user view round-trips through JSON with every new field; an old JSON loads;
  unknown keys in `isolated` are counted, not fatal.
- `tests/sectionCut.test.ts` (new): a cube cut at mid-height gives one closed square of the right size;
  a cube cut along a face gives nothing twice; an open mesh gives open polylines; two elements stay separate.
- `tests/sections.test.ts`: box from handles equals box from numbers; box around a selection contains it.
- Browser check: save a view with a rotated box and two colour rules on the demo, reload the exported JSON,
  the view is identical (screenshot before/after).

## Open questions (owner)

1. Should a user view also store the planning date (4D position)?

Decided by the owner (14 November 2026): « ajouter les vues » means both — views the user saves himself,
and more view kinds read from Revit (sections, elevations, then ceiling plans).
