# 14 — Revit in every feature

## Report

"Revit must be included in all the features. Don't tell me it will be done in the future; it has to be
consistent."

## Gaps found (read-only audit of 15 November 2026, file:line checked)

| # | Feature | Today with a Revit file | Where |
| --- | --- | --- | --- |
| 1 | "Ajouter…" a model; reference version in the comparison | refused: « Un fichier Revit ne s'ajoute pas encore… » | `src/ui/addModel.ts:18`, `:59-61`; `ModelsPanel.ts:9` (`MODEL_ACCEPT` has no `.rvt`) |
| 2 | Several files dropped together | only one is read, silently (also true for two IFC) | `src/ui/App.ts:1002-1006` |
| 3 | Levels: "Plan du niveau X", cut at a level, split at levels | absent: the reader writes no `levels` | `docs/contrat-metadonnees.md:494`; `SectionPanel.ts:231`, `SplitPanel.ts:106`, `ViewsPanel.ts:55` |
| 4 | IFC base quantities preset; required properties (IDS) | match nothing: no « Classe IFC » on Revit elements | `src/data/presets/quantites-ifc.json`, `src/data/requirements.ts:156` |
| 5 | BCF identity of an element | half written | see [11](11-bcf-pointer.md) — done there |
| 6 | Elements drawn as a box (over the triangle budget or unreadable shape) | measured, clashed, compared and split as if the box were the shape | nothing reads « Source de la géométrie » outside `revitReport.ts:23` |
| 7 | Sections, elevations, ceiling plans of the file | not read | `revit/src/views/mod.rs:47-49`, `:19`, `:555`; `savedViews.ts:42` |
| 8 | Site study: bring a model in | missing for every format | see [16](16-study-guided.md) — done there |

Everything else already works with Revit (views, sections, print, DXF, zones, planning, phases, editable
properties, assistant, exports, globe).

## Half A — TypeScript (federation, comparison, loading)

**1. A Revit file as an added model and as a reference**
- `addModelFiles` gets a Revit branch: `readRevit` without `onChunk`, the list of chunks goes to
  `collect` (widen `src/engine/buildModel.ts:284` to `RawModel | RawModel[]`; `collectRaw` already
  accepts a list), metadata from the reader, the rename pass (`result.names`) applied.
- The triangle budget passed to the reader is what is left: `maxTriangles − model.triangleCount`
  (`src/revit/readRevit.ts:270` hard-codes the device budget today). When the file needs more, the user
  is told the figures before reading, and what was reduced after.
- `.rvt, .rfa, .rte, .rft` in `MODEL_ACCEPT`; the two refusal messages and the button titles updated.
- Progress and cancel while reading (the reader already reports progress), memory failures through the
  existing `isMemoryFailure` / `revitFailureToError`.
- Comparison with a Revit reference follows [13](13-compare-formats.md) (keys differ between an IFC export
  and its Revit file: pairing falls back to the "probably the same" pass, and the result says so).

**2. Several files dropped together** — for every format: the first opens, the others are added through
the same path as "Ajouter…", after the existing question "ouvrir ensemble ou remplacer". Never a file
ignored without a line saying so.

**6. Box-only elements** — the reader already marks them (« Source de la géométrie »). Expose it as a
per-element flag on the model (not a property-name test in the features), then:
- quantities: reliability `indicatif`, with the reason;
- clash: excluded by default, with a count and an option to include them;
- comparison: geometry status "non comparable (forme approchée)" instead of changed/same;
- split: refused for that element, with the reason.

## Half B — Rust reader (`revit/`), then the rebuilt WebAssembly package

Build in `CARGO_TARGET_DIR=/Volumes/Zaid's SSD 1/viewer-bim-travail/…`, commit the rebuilt `src/revit/pkg/`.
Census dumps go to `viewer-bim-travail/specks/census/` as for floor plans.

**3. Levels** — `Level` records are already decoded for their name (`revit/src/properties/native.rs:227`,
`:328`). Keep their elevation, write `"levels": [{ name, elevation }]` (metres, project frame, the same
frame as the floor plans' ranges in `views/mod.rs:552-565`) next to the georeference block
(`properties/mod.rs:~257`). To settle on the sample files before writing: which field holds the elevation,
and whether it is relative to the internal origin or to the project base point — check against the plan
ranges and the elements' real heights. Duplicate levels (same name or same elevation) merged. Update
`docs/contrat-metadonnees.md:494` and `docs/lecture-revit.md`.

**4. « Classe IFC » for Revit elements** — written by the reader for every element whose category has an
IFC equivalent:
- the element's own "export to IFC as" parameter when set (`IFC_EXPORT_ELEMENT_AS`,
  `revit/src/catalog/parameters.tsv:1869`), else
- a category → IFC class table kept as **data** (`revit/src/catalog/`, from Revit's public default export
  mapping), never as conditions in code.
The property is marked as deduced in its group so the fiche shows where it comes from; it stays editable.
With it the IFC quantities preset and IDS entity facets apply to Revit models without any change on the
TypeScript side. Elements whose category has no equivalent are counted in the reader's report.

**7. Sections, elevations, ceiling plans**
- Census of the view classes in the sample files (what `is_view_class` rejects today), their camera,
  crop box, far clip and, for ceiling plans, the view range looking up.
- Read them into `views[]` with `kind: "section" | "elevation" | "ceiling"` (contract and
  `src/data/savedViews.ts:42`, `:154-156` extended; older readers ignore unknown kinds — verify, and make
  them ignore rather than fail).
- In the viewer: a section or elevation opens as a parallel view facing its plane, cut by its crop box
  (near plane = the cut); a ceiling plan opens seen from above, mirrored as Revit shows it, cut at its cut
  height and looking up to its view depth. The Views panel gets the three groups.
- If a class cannot be decoded reliably on the samples, it is not shipped half-right: the hand-back says
  which class, what was tried, and what is missing. The other kinds ship.

## Watch out for

- Memory: two Revit files are two reader instances; chunks are kept then baked, so the peak is about twice
  the added model. Read with the reduced budget first, refuse with figures rather than crash.
- Keys: `rvt-<id>` or a GUID; two versions of one Revit file pair by key, an IFC export against its Revit
  file only when the GUIDs coincide.
- A ceiling plan decoded as a floor plan gives a wrong cut: test each kind against a screenshot of the
  same view in Revit when one is available in `revit/samples/`, else against the view's own crop box.
- The reader's messages are user-facing French; the Rust tests must run without the private sample
  (`revit/tests/wadduwa.rs` already skips when it is absent).

## Tests

- TypeScript: adding a Revit fixture (the public demo `.rvt`) to an open GLB; as a reference; budget
  refusal with figures; three files dropped together; box-only flag honoured by quantities, clash,
  compare, split.
- Rust: levels of the demo and of the private sample when present (count, order, elevation within 1 mm of
  the plans' ranges); IFC class for the main categories; each new view kind on the samples that have one.
- Browser: private sample open, the demo `.rvt` added, then compared; "Plan du niveau" and "cut at level"
  on a Revit file; IDS entity rule on a Revit file; a section and an elevation opened and printed.
