# 06 — Missing fields computed and checked, and splitting elements from a sketch

Two owner requests: « Calcul automatique des manquants sur un élément » and « Découpage automatique via
esquisse ». The owner's instruction for both: **do what exists on the market**. This file starts from what
the market does (researched November 2026) and specifies the same behaviour.

## Current state (verified)

- Geometry helpers exist: `analyzeSolid` (volume, area, closedness, `src/engine/meshMath.ts:111-139`),
  `src/engine/dimensions.ts` (convex hull, minimal footprint rectangle, height, area, volume), `Model.parts(i)`
  for an element's triangles, per-element boxes.
- The "Cotes" card shows length, width, height, area and volume of the selection, capped at 2,000 elements
  or 1.5 M triangles (`src/ui/DimensionsCard.ts:6-20`). **Nothing is written into the properties.**
- No sketching tool. Measure has point picking and snapping (`src/engine/Measure.ts`).
- Property writes are undoable in one step (`PropertyEdits.setMany`). Geometry is never modified: the
  earlier editing feature was removed.

## Part A — Missing fields

### What the market does

- **Missing quantities.** Revit computes Area, Volume and Length itself, but they reach the IFC only if
  the exporter's option "Export base quantities" is ticked (off by default). Models exported without it
  have empty `Qto_…BaseQuantities`. This is almost certainly the owner's memory of "something in Revit or
  IFC". The fix on the market is Bonsai's "Perform quantity take-off" (IfcOpenShell `ifc5d`): it computes,
  from the shapes, the standard base quantities of each class (length, width, height, footprint, side and
  outer areas, gross and net volume) and writes them. It overwrites what exists.
- **Missing required properties.** The standard is buildingSMART's IDS 1.0 (June 2024): a file listing,
  for a kind of element, the properties that must exist and their allowed values. BIMcollab Zoom, Solibri,
  BIMvision, usBIM run an IDS and list, per failing element, property / required / actual, then create BCF
  issues. They check; they do not fill.
- **Filling.** Only Simplebim fills: copy a property into another, create it when missing, with the choice
  "overwrite, or fill empty only". Revit add-ins (DiRoots, MODPlus) fill by Excel round-trip or rules.
- No product has a command literally named "calculate missing".

### What we build

**1. Compute missing quantities**
- For the selection or the whole model, compute from the shapes: `Longueur`, `Largeur`, `Hauteur`,
  footprint area, side area, outer surface, volume.
- Where they are written, chosen by the user in a small mapping table (quantity → target property), with
  two presets: *IFC base quantities* (the standard `Qto_<Class>BaseQuantities` names, when the model has
  IFC classes) and *one group* `Quantités calculées`. The viewer itself stays generic: the standard names
  live in the preset's data file, not in the logic.
- **Fill empty only** by default; "overwrite" is an explicit option (Simplebim's behaviour, safer than
  `ifc5d`'s). One undo step. Report: filled, already present, not computable.
- Each written value is marked as computed (a `Fiabilité` property: `exact` for a closed solid,
  `indicatif` otherwise) and shown as modified (workstream 02), so it is exported in the sidecar.
- Values are **net**: our meshes arrive with openings already cut, so gross quantities cannot be derived.
  The interface says "net".

**2. Check required properties**
- Load an IDS file, or type a simple list (for these elements → these properties must have a value).
  First version reads the IDS facets entity, attribute, property (existence and simple value), which covers
  the common files; classification, material, partOf and value restrictions come after.
- Result: a table per failing element — property, required, actual — grouped by rule; click selects the
  elements; colour "conforming / failing" as a transient state.
- From the failing set: bulk-fill a value (existing property write, undoable), create observations
  (workstream 09b), export the report as CSV and BCF.
- The same check works on Revit and GLB models through a mapping "applies to" = any filter of the viewer.

**How**
- `src/engine/quantities.ts`: `computeQuantities(model, indices, onProgress)`, on the existing helpers, in a
  worker, batched, cancellable, cached per element.
- `src/data/requirements.ts`: `checkRequirements(store, rules): Failure[]` (pure) and `parseIds(xml): Rule[]`.
- `src/ui/QuantitiesPanel.ts`, `src/ui/RequirementsPanel.ts`; presets in `src/data/presets/*.json`.
- No Python at run time for either: `ifc5d` and `ifctester` (LGPL) would make every run pay for Pyodide.
  `ifctester` in the existing Pyodide stays a fallback for full IDS coverage (to verify: is it in the wheel).

**Watch out for**
- Mesh quantities differ slightly from the authoring tool's: say "computed from the displayed shape".
- Layered walls, open or self-intersecting meshes give a wrong volume: `indicatif`, never shown as exact.
- A convex hull overestimates an L-shaped footprint: use the projected outline for closed solids.
- IDS is XML with namespaces and XSD restrictions: parse strictly, and list what was ignored from a file
  instead of silently passing it.
- Whole-model runs on 12 M triangles: worker, streaming, progress, cancel.

## Part B — Splitting elements from a sketch

### What the market does

- **Revit Parts** is where the wording comes from. "Create Parts" on walls, floors, roofs, columns, beams;
  then "Divide Parts" either with a **sketch** (lines drawn on a work plane, each crossing the part
  completely) or with **intersecting references** (levels, grids, reference planes, with an offset) — this
  is the "automatic" mode. Geometry is really cut. The original stays and is hidden; parts follow it when
  it changes; deleting the parts brings it back. Each part has its own volume, area and dimensions, keeps
  "original category / family / type", and can override material and phase. Parts are scheduled, filtered
  and exported (as `IfcBuildingElementPart`). Typical use: cut a slab along construction joints, give each
  part a pour number, drive the 4D simulation.
- **Synchro 4D Pro**: subdivision by slices, by rows and columns, or free-hand polyline; pieces go to
  tasks; pieces get new identifiers and do not follow a model revision.
- **Bexel Manager** (mesh splitting): automatic by storey, by grid, at positions or intervals along an
  axis; each piece keeps a relation to its original and an "is mesh valid" flag — when false, quantities
  must not be used.
- **Powerproject BIM**: manual line, by storeys or picked objects, or N cuts along an axis with preview;
  pieces copy all properties; "remove split" recombines; build-order numbers drive the simulation.
- **Tekla**: pour breaks; a break that does not cross completely is rejected.
- Zone assignment without cutting (Vico locations, IFC spatial zones) is the norm for quantities by
  location, not for pours.
- **The norm for sequencing is a real cut into child parts.** "Automatic" means: at levels, at grids, at
  positions or intervals, or N equal pieces. Nobody splits by maximum pour size.

### Decision

Follow the market: **a real cut into parts, non-destructive**. This reopens the earlier rule "the viewer
never edits geometry" in one precise way: source elements are never modified or deleted; parts are
*derived* geometry, regenerated from a stored cut definition, and can always be removed.

### What we build

**Cutting**
- Select elements, then either draw lines in a plan or top view (each line must cross the selection
  completely; closed loops allowed), or tick references for the automatic mode: levels (workstream 05's
  `levels`), grid lines when the model has them, positions or a regular interval along X or Y, N equal
  pieces. The cut is vertical (horizontal for levels). Preview before applying; optional gap between parts.
- Result: child parts. The original is hidden, not removed. A part copies the original's properties, adds
  `Pièce / Origine` (the original's key and name) and `Pièce / Numéro`, and gets its own computed
  quantities (Part A). A part is an element like any other: selectable, filterable, colourable, plannable.
- `Pièce / Séquence` is an editable number per part; `plan_dates` can order by it, so a slab cut in six
  pours is planned pour by pour.
- "Remove the split" restores the original. Parts can be merged back two by two (same original).

**Persistence**
- The JSON stores the **cut definition**, never meshes: optional section
  `splits: [{ id, elements: [keys], lines | references, gap }]`, in original model coordinates. Parts are
  regenerated at load. Part keys derive from the original: `<key>~<n>`, numbered in a stable order (left to
  right, bottom to top) so properties and planning dates written on parts survive a reload.
- Exports: the GLB export contains the parts (and says so); the modifications sidecar contains the split
  definition and the parts' own properties.

**Zones (the lighter companion)**
- The same sketch tool draws named zones; every element (or part) is assigned to the zone holding the
  largest share of its footprint, written to a property (`Zone` by default). Saved as `zones` in the JSON.
  Useful for location-based quantities and for grouping the planning; no geometry involved.

**Engine**
- `src/engine/sketch.ts`: lines and polygons on a work plane, snapping (reuses Measure's picking).
- `src/engine/splitMesh.ts`: cut a closed triangle mesh by a plane and cap both sides. Triangle clipping is
  ours; the cap is triangulated with three.js's `ShapeUtils.triangulateShape` (earcut inside three: no new
  dependency). A polyline cut is a sequence of plane cuts restricted to their segment's slab.
- Bent or closed-loop cuts on complex solids: `manifold-3d` (Apache-2.0, WebAssembly, loaded on demand —
  free, so within the owner's rule) with its `split` by an extruded prism. To verify first on twenty real
  elements from IFC and Revit samples: Manifold refuses meshes that are not closed and oriented.
- `src/data/splits.ts`: definition, stable numbering, regeneration; `src/data/zones.ts`: assignment (pure).
- `Model` gains derived elements: appended like the chunks of a growing Revit model, with a `parent` index;
  the original's visibility is driven by "has parts".

**Watch out for**
- **Open or non-manifold meshes** cannot be capped: refuse the cut for that element, say why, and offer
  zone assignment instead. Never produce a part with a wrong volume silently: the "valid mesh" flag (as in
  Bexel) is set on every part and quantities are `indicatif` when it is false.
- **A partial cut is rejected** (Revit's and Tekla's rule): a line must cross the element completely.
- **Model revisions**: when the source file changes, cut definitions are replayed on the elements with the
  same keys; parts whose original disappeared are reported. This is the known pain of Synchro and Bexel:
  storing definitions, not meshes, is what avoids it.
- **Instancing**: cutting one instance of a repeated mesh makes its geometry unique (memory). Count it in
  the triangle budget and tell the user when a split is large.
- **Every consumer of the element list must see parts**: tree, filters, colour rules, planning, assistant
  tools, section caps, map mode (Cesium draws its own copy of the model), exports, compare and clash (07:
  a part and its hidden original must not clash).
- **Keys with `~`**: check the contract's key rules and BCF/IFC exports; a part exported to IFC references
  its original's GlobalId in a property, it does not invent one.
- Undo: a split, its removal and its edits are steps in the same history as property edits.
- Recentred coordinates (`Model.offset`): definitions are stored in original model coordinates.

## Tests

- `tests/quantities.test.ts`: a 2×3×4 box gives 24 m³ and a 6 m² footprint, `exact`; with one face removed,
  `indicatif`; fill-empty leaves existing values, overwrite replaces them; one undo step.
- `tests/requirements.test.ts`: a required property missing, empty, present; an IDS sample with entity +
  property facets parses to the expected rules; an unsupported facet is reported, not ignored.
- `tests/splitMesh.test.ts`: a 4×2×1 box cut at x = 1 gives two closed parts of 2 and 6 m³ whose volumes
  sum to the original; a cut that misses or only touches gives no part; an open mesh is refused; a
  two-line sketch gives three or four parts with stable numbers when the lines are listed in another order.
- `tests/splits.test.ts`: definition → parts → reload gives the same keys; properties written on a part
  survive; removal restores the original; a missing original is reported.
- `tests/zones.test.ts`: inside, outside, half and half, concave zone.
- Browser check on the demo: ground slab cut in four along two lines, sequence 1–4, `plan_dates` by
  sequence, 4D playback pours them in order; GLB export reopened shows four parts.

## Open questions (owner)

1. Part A is now two tools: compute missing quantities, and check required properties against a list or an
   IDS file. If you remember the tool you saw, tell me which of the two it was.
2. Parts in the IFC/GLB exports: exported as separate elements, or keep exporting the original only?
