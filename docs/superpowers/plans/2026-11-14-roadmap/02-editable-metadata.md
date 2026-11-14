# 02 — Editable metadata, saved in a JSON sidecar

## Goal

Every property the viewer shows can be modified, for Revit files as for the others. The source file
(`.rvt`, `.ifc`, `.glb`) is never written. Modifications live in the tab, are exported as a small JSON
file ("sidecar") and come back when that JSON is opened again with the same model.

## Current state (verified)

- The Revit reader locks everything it produces: every head property and every group name goes into
  `readOnly` (`revit/src/properties/mod.rs:199-209`, `225-237`). Only properties the user adds under a
  new name are editable. Checked on `wadduwa.rvt`: 490 properties, 1 editable (the one just added).
- IFC locks a fixed list, `IFC_READ_ONLY` (`src/data/metadata.ts:39`): class, type, spatial structure,
  materials, `Qto_*`. Property sets are editable.
- Locking is enforced in one place, `PropertyEdits.write` → `store.isEditable` (`src/data/PropertyEdits.ts:36`).
- Export is a full snapshot with `"propertiesMode": "replace"` (`PropertyStore.export`,
  `src/data/metadata.ts:273-287`). There is no "what changed" notion outside the undo stack.
- **Edits are lost when the `.rvt` and its exported JSON are dropped together**: the reader's own
  metadata is the first candidate and a dropped JSON replaces it only with strictly more matching keys
  (`src/ui/App.ts:1428-1436`). Same key set → tie → the JSON is ignored. Dropping the JSON after the
  model has loaded does restore them (`PropertyEdits.import`).
- A JSON without `propertiesMode` already means "complete the model's properties, JSON wins"
  (`docs/contrat-metadonnees.md:58`, `mergeProperties` in `metadata.ts:90-94`). It cannot express a deletion.
- `set_property` writes `value` as given: a number typed as text stays text (`src/assistant/tools.ts`, schema line 188).

## Decisions

1. **Lock identity only.** For Revit, `readOnly` keeps `Identifiant Revit`, the IFC GUID and
   `Source de la géométrie` (`fiche::REVIT_ID`, `fiche::IFC_GUID`, `fiche::GEOMETRY_SOURCE`). Everything
   else becomes editable. The lock list stays the file's decision (contract § 2 bis): change the reader,
   not the viewer. IFC keeps its list for now (open question 1).
2. **The sidecar is an overlay, not a snapshot.** New export "Modifications (JSON)" writes only what
   differs from the source, in merge mode (no `propertiesMode`), so it stays valid after the source file
   is re-saved in Revit: values the user did not touch come fresh from the file.
3. **A deletion is `null`.** Contract addition (optional, backward compatible): in merge mode a property
   whose value is `null` is removed. A reader that ignores it shows an empty value, which is harmless.
4. **An overlay never competes with the file's own metadata.** At load, the base is the best full
   candidate as today; every merge-mode JSON dropped with it is applied on top, in name order.
5. **A full snapshot dropped with its model wins a tie** for properties and labels; `views`, `phases`
   and `georeference` still come from the reader (they are read fresh from the file).
6. **Edited values keep the type of the property.** A number stays a number, a boolean a boolean; text
   typed with a French decimal comma is parsed. A value that cannot be converted is refused with a message.

## What to build

**Reader (`revit/src/properties/mod.rs`)**
- `read_only` contains the three identity names only. Rebuild the wasm (`npm run build:revit`), commit
  `src/revit/pkg/`. Update `docs/lecture-revit.md:594-595` and any Rust/TS test asserting the old list.

**Baseline and "modified" state (`src/data/PropertyEdits.ts`)**
- `baseline: Map<number, Entry>`: the element's entry before its first write, recorded once, dropped on
  `reset`. `import` of an overlay at load time is part of the baseline's "after", not the baseline (so
  re-exporting keeps the earlier overlay's changes).
- `isModified(index, path): boolean`, `modifiedCount: number`, `revert(indices, path)` (back to baseline,
  one undo step), `diff(): MetadataJson` (elements and properties that differ; removed ones as `null`).
- Each element in `diff()` carries the identity properties it has (for Revit: `Identifiant Revit`), so a
  script in Revit can find the element without decoding the key.
- Top-level optional `source: { name, kind }` (`kind`: `revit` | `ifc` | `glb` | `usd`), informative.

**Load (`src/ui/App.ts` `installModel`, `src/data/metadata.ts`)**
- Split candidates into full (`propertiesMode: "replace"` or the reader's own) and overlays (merge mode).
  Apply decision 4 and 5. `parseMetadata` keeps `null` values in merge mode; `mergeProperties` deletes on `null`.
- An overlay whose keys match fewer than half of its own elements: load it, and say so in the notice
  ("12 of 40 modified elements not found in this model"), never silently.

**Properties panel (`src/ui/PropertiesPanel.ts`)**
- Modified values are marked; each has "revert to the file's value". A filter "modified only".
- Type-preserving input per decision 6 (shared with `set_property`: one function, `coerceTo(existing, raw)`,
  in `src/data/metadata.ts`).

**Export (`src/ui/App.ts`)**
- Two entries: "Modifications (JSON)" (overlay, default when the model has a source file) and
  "All properties (JSON)" (today's snapshot). The first one shows the count; disabled at 0.
- `confirmReplace` message points to the modifications export.

**Assistant** — nothing to add: `set_property` and `plan_dates` go through `store.isEditable`.
Update the doc that still says the assistant never writes (`docs/contrat-metadonnees.md:130-135`).

**Back to Revit (optional, last)** — `scripts/revit/apply-sidecar.py` (pyRevit / Dynamo Python): reads
the overlay, finds each element by ElementId, sets each named parameter in one transaction, reports what
it could not write. Not run by the viewer.

## Watch out for

- The JSON contract is a public interface: both additions (`null`, `source`) are optional; old files load unchanged.
- Units: Revit values are shown converted (metres, m², degrees…) with the unit in the name. The overlay
  stores what is shown. The Revit script must convert back and skip parameters Revit itself marks read-only
  (computed areas, volumes).
- Editing a structural value (level, category) changes grouping, colour rules, plan_dates order and the
  planning by level. That is wanted, but the tree and rules must refresh on the `'*'` notification.
- A model re-saved in Revit can renumber nothing (keys derive from UniqueId) but can delete elements: the
  overlay then has orphans, reported per decision 4's notice.
- Never write the user's file; never propose it. rvt-rs has no field-level writer (its ADR-002).
- Large models: `baseline` holds touched elements only; `diff()` iterates the baseline, not the model.

## Tests

- `tests/propertyEdits.test.ts`: baseline recorded once; `diff()` holds only changes; a value set back to
  its original leaves no entry; deletion exported as `null`; `revert` is one undo step.
- `tests/metadata.test.ts`: merge mode with `null` deletes; old JSON without `null` unchanged.
- New `tests/sidecar.test.ts`: model + own metadata + overlay dropped together → edits applied (the bug
  above); snapshot tie → snapshot's properties, reader's views; orphan count reported.
- Rust: the reader's `readOnly` is exactly the three identity names (one test in `revit/tests`).
- Browser check on `revit/samples/wadduwa.rvt` (private, never commit): edit `Niveau` on one wall, export
  modifications, reload file + JSON together, value is back; file SHA unchanged.

## Open questions (owner)

1. IFC: unlock the structural fields too (class, level, materials, quantities), or keep them locked?
2. Should the tab also keep unsaved modifications in the browser (IndexedDB, keyed by file name + size)
   and offer to restore them at the next opening of the same file?
