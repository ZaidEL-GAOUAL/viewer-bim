# 11 — BCF: the issue must point at its object

## Report

"In the BCF, the point that points to the comment / the object concerned is missing."

## Root cause (verified by running `toBcfTopic`, `writeBcf`, `readBcf`)

1. **The pin is thrown away on export.** `src/data/observations.ts:264-265` drops `pin`, `point`,
   `location` and `origin`; `docs/contrat-observations.md:33` says they live only in the JSON section.
   BCF has no standard pin, so other tools locate an issue by the saved camera and by the components of
   the viewpoint. Ours gives them little:
   - only `Selection` is written — no `Coloring`, no `Visibility` exceptions (`src/data/bcf.ts:137-150`);
   - for an observation created by a click, the camera is wherever the user was looking
     (`src/ui/ObservationsPanel.ts:266`), not aimed at the object. Only clash and requirement observations
     aim at their point (`observations.ts:369`, `387`, `396`).
2. **Elements that are not IFC lose their identity.** `componentOf` (`observations.ts:248-252`) writes
   only `AuthoringToolId` when the key is not a 22-character GlobalId: a part `…~3` loses its parent's
   GlobalId, a Revit element with a GUID loses its ElementId, a Revit element without GUID has no
   `IfcGuid`, `OriginatingSystem` is never set.
3. **Reading back loses the place.** From a `.bcf` alone, `ObservationsPanel.ts:318-320` puts the point at
   the element's box centre, and only when the element resolves; otherwise no marker at all. The plan pin
   is never recovered. Only `Selection` is read (`bcf.ts:284`): files that mark the object through
   `Coloring` or `Visibility` exceptions give no element.
4. **Clash BCF has no snapshot**; an observation made from a selection has no marker in its image; none in
   map mode.

## What to build

**Export (`src/data/observations.ts`, `src/data/bcf.ts`)**
- Each topic gets **two viewpoints** when the user's view is not already aimed: the first aimed at the
  point (`aimAt`, framed on the elements' box, never inside a wall), the second the user's own view.
  Tools open the first.
- Components: the elements in `Selection` **and** in `Coloring` (one colour, `FF3B30` with alpha, written
  as BCF's ARGB hex); `Visibility` stays "all visible".
- The exact point as a **`Lines` cross** in the first viewpoint: three short segments (30 cm, along X, Y,
  Z) centred on the point, in model coordinates (same conversion as the camera: offset added back, Z-up).
  Standard BCF, drawn by tools that support lines, ignored by the others.
- The plan pin and the exact point are also kept for our own round trip in a file of our own inside the
  topic folder (`viewer-bim.json`: `{ point, pin }`). The specification allows extra files in a topic
  folder; other tools ignore it.
- `componentOf(key, element)`:
  - a part `<key>~n` → the parent's identity, never the part key;
  - IFC key → `IfcGuid`;
  - Revit element → `IfcGuid` when it has a GUID **and** `AuthoringToolId` from its Revit id property,
    `OriginatingSystem="Revit"`; found through the reader's own identity properties, not through a name
    hard-coded in the logic (the reader declares them: see how `readOnly` is declared);
  - anything else → `AuthoringToolId` with `OriginatingSystem` = the source's kind.
- Snapshot: always one, with the marker drawn at the projected point — also for an observation created
  from a selection (projected box centre) and for a clash. In map mode, say that the image is not
  available instead of writing none silently.

**Import**
- Read `Selection`, then `Coloring`, then `Visibility` exceptions; the first that resolves gives the
  elements.
- The point: `viewer-bim.json` if present, else the centre of a `Lines` cross if there is one, else the
  elements' box centre, else the point the camera looks at on the model (ray along the view direction),
  else none — and then the observation is listed "sans position" rather than silently unplaced.
- `AuthoringToolId` becomes a Revit key only when `OriginatingSystem` says Revit or the open model is
  Revit; otherwise it is tried as a plain key.

**In our own viewer** — opening an observation frames it, highlights its elements and shows its pin; this
must hold after a round trip through a `.bcf` in a fresh session.

## Watch out for

- BCF colours are ARGB hex without `#`; BCF 2.1 and 3.0 place `Coloring` differently: follow each schema.
- Lines and cameras are in the model's original frame, Z-up, metres; a federated session has one world
  frame.
- Keep within the size caps of `src/data/zip.ts` (two snapshots per topic now).

## Tests

- `tests/bcf.test.ts`: a topic with a point writes two viewpoints, `Coloring`, a `Lines` cross centred on
  the point within 1 mm, and `viewer-bim.json`; the markup lists both viewpoints, snapshot referenced.
- Round trip in a fresh book: point and pin identical; with `viewer-bim.json` removed, the point comes
  from the cross; with the cross removed too, from the box centre.
- `componentOf`: part key, Revit with GUID, Revit without GUID, GLB key.
- Import of a hand-written BCF 2.1 that marks the object only by `Coloring`.
- Browser: an observation on the Revit sample and one on the IFC demo, exported, the page reloaded, the
  `.bcf` imported alone: pin at the same place, element highlighted.
