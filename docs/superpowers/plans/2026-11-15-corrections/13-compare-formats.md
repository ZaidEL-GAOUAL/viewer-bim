# 13 — Comparing the same model in two formats

## Report

"The comparison works with GLB + JSON against GLB + JSON (same model, same version), but it says things
are different when I compare GLB + JSON with IFC + JSON (same model, same version). Me, or a real problem?"

## What was measured (the app's own functions, in a script; no file of the repository changed)

A real problem, but not in the pairing. With the same converter output on both sides, every route gives
**zero** differences: GLB + JSON against itself, against the IFC in either direction, against the viewer's
own GLB ↓ / JSON ↓, with 1, 2 or 4 conversion workers, 26 elements out of 26 and also on the
22,561-element tower. Keys pair (GlobalId), frames agree, properties agree.

The differences come from the two files not holding the same data, and from the comparison being too
strict about it:

1. **Two converters.** The browser converts an `.ifc` with IfcOpenShell 0.8.5 (`src/ifc/convertIfc.ts:44-45`);
   the command line uses whatever `pip` installed (`pipeline/requirements.txt`: `ifcopenshell>=0.8.4`; the
   repository's own fixture was written by 0.9.0). Two versions can triangulate a face differently, cut an
   opening differently, and write a property set differently.
2. **The shape test requires the same number of triangles** (`src/data/compare.ts:110`, and the second
   pass key at `:189`). One triangle split in two on ten elements gave ten "forme modifiée" with identical
   box, volume and area.
3. **An IFC dropped with a JSON does not take its properties from the JSON** for locked paths
   (`src/data/sidecar.ts:26`, `src/data/PropertyEdits.ts:86`): the conversion's value stays. By design,
   but the panel does not say which metadata each side used.
4. A GLB ↓ made after a split holds the pieces, so the originals read as removed and the pieces as added.

Not run: the two IfcOpenShell engines themselves (no Pyodide and no network in the investigation). Which
of the causes hit the owner's files is therefore inferred, not observed.

## What to build

**The comparison (`src/data/compare.ts`)**
- The number of triangles no longer decides anything: `same` = same box (1 mm), volume and area within
  tolerance. The count stays in the report as information ("maillage différent, même forme").
- Tolerance on volume and area: 0.1 % as today when both sides come from the same engine; 1 % and 2 mm on
  the box when they do not (below). Both are settings of the comparison, shown in the panel.
- New result line **"même forme, maillage différent"** counted apart from "modifié", dimmed like
  unchanged by default.
- Pieces of a split (`<key>~n`) are compared as their original: status of the original, with the note
  "découpé en N pièces" — never one removed plus N added.
- Duplicate keys inside one model (an IFC with repeated GlobalIds) are reported as such, not as changes.

**Knowing where each side comes from (`src/data/federation.ts`, loaders)**
- Each source records how it was produced: the glTF `asset.generator` (already written by the pipeline),
  "converti dans le navigateur (IfcOpenShell x)", "lu nativement (Revit)", "USD", and which metadata it
  uses: "de la conversion", "conversion + JSON appliqué", "JSON complet".
- The panel shows both lines above the result. When the engines differ it says so in one sentence and
  switches to the looser tolerance: "Ces deux fichiers n'ont pas été convertis par le même moteur : de
  petits écarts de maillage et de jeux de propriétés viennent de la conversion, pas de la maquette."
- Property differences on paths the user cannot edit, when the engines differ, are grouped under
  "Écarts de conversion" with their count, apart from real changes; the user can still open them.

**The pipeline** — `pipeline/requirements.txt` pinned to the version the browser uses, if that version is
published for the command line (the lead checks); otherwise the two are documented as different and the
generator check above carries the warning.

**Revit and the comparison** (with [14](14-revit-everywhere.md)) — a Revit file can be the reference. Two
versions of one Revit file pair by key. An IFC export against its Revit file pairs by key only where the
GUIDs coincide; the rest goes to the existing "probablement le même" pass, and the panel states which
share of the model was paired by key and which by resemblance.

## Watch out for

- Looser tolerances must not hide a real change: a wall moved by 5 mm or thickened by 1 % is still
  reported under the strict setting, and the panel says which setting is in use.
- Curved surfaces differ more between engines than flat ones: the 1 % applies to volume and area, never
  to position.
- The second-pass key loses the triangle count: check it does not start pairing unrelated elements of the
  same type and size (keep name + category + rounded box size + distance).
- The report exports (CSV, JSON) carry the new status and the two origin lines.

## Tests

- `tests/compare.test.ts`: same box / volume / area with another triangle count → "même forme, maillage
  différent", not modified; a 5 mm move → moved; +1 % volume under the strict setting → changed; pieces of
  a split compared as their original; duplicate keys reported; the second pass still refuses to pair two
  different elements of the same size far apart.
- `tests/federation.test.ts`: the origin line of each kind of source; engines compared.
- Browser: the IFC demo against the fixture GLB + JSON (written by another IfcOpenShell version): the
  warning sentence, no false "modifié"; one property edited by hand still shows as one change.
