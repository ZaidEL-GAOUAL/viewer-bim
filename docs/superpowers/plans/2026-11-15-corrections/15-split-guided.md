# 15 — Splitting an element: a tool one understands without a manual

## Report

"We could not test the splitting because we did not understand how it works. It sticks to the point, I
think, or I don't know."

## What a first-time user meets (checked in the browser)

- The card floats over the 3D view and hides the element being cut.
- Nothing says there are four steps (select, choose how, draw in a top view, apply). The only guidance is
  one grey line that appears after "Dessiner les lignes", and a tooltip advising a top view.
- The view stays in 3D perspective: clicking two points there puts the line somewhere unexpected.
- The cursor jumps to vertices (snapping) with no sign of why, and no way to turn it off.
- A line that stops inside the element is refused afterwards ("must cross completely"), which is the most
  natural way to draw one.
- No preview of the pieces before "Découper".

## What to build (`src/ui/SplitPanel.ts`, `src/engine/sketch.ts`, `src/data/splits.ts`)

**A guided sequence, one step visible at a time**, with the step's sentence at the top of the panel:
1. *Quoi couper* — "Sélectionnez un ou plusieurs éléments (dalle, mur, toiture)". Shows the count and
   names; "Continuer" is enabled as soon as the selection can be cut; elements that cannot (open mesh,
   box-only Revit shape, already a part of another split) are listed with the reason.
2. *Comment* — three large choices with a pictogram and one line each: "Je trace les coupes", "Aux
   niveaux", "À intervalles réguliers" (parts égales / tous les N m / positions).
3. *Où* — on entering this step the tool **goes to a top view by itself, in parallel projection, isolates
   the chosen elements and frames them**; the previous view comes back when the tool closes.
   - Tracing: **one click, move, one click = one cut**. The cut is the whole straight line through the two
     points: it is drawn extended across the selection, so a short stroke is enough and nothing is refused
     for being short. A third click starts another cut. Backspace removes the last one; each cut is listed
     and can be removed.
   - A bent cut (several points) stays possible through "Tracé libre" and keeps the rule that it must
     cross; the refusal is shown while drawing (the stroke turns red with the reason), not after.
   - **Snapping is visible and optional**: a toggle "Aimanter" (on), a small mark and a word at the cursor
     saying what it caught (sommet, arête, milieu), Alt held = free; Shift = horizontal / vertical.
   - Typed positions for the regular modes show their cut lines live.
4. *Aperçu* — the pieces are shown in alternating colours with their numbers **before anything is
   created**, with the count and each piece's volume; "Découper" applies, "Modifier" goes back.
   After applying: "N pièces créées", the pieces selected, and the two next actions as buttons: "Numéroter
   la séquence" (opens the properties on `Pièce / Séquence`) and "Planifier par séquence".

**Existing splits** stay listed below, each with select, edit (re-enters step 3 with its cuts) and remove.

**Zones** (`src/ui/ZonesPanel.ts`) use the same drawing tool: same top view, same snapping toggle, same
live preview of the elements each zone will take.

## Watch out for

- The automatic top view must restore exactly what the user had (camera, isolation, sections): use the
  same capture/restore as printing (`captureView`).
- An extended straight cut is a plane: reuse the plane cut of `src/engine/splitMesh.ts`; the stored
  definition keeps the two points in original model coordinates (contract `splits`, unchanged shape).
  Definitions saved before this change still load.
- Preview on a large element: compute in slices (`runSliced`), cancellable when the cuts change.
- The panel must not cover the element: until the redesign ([18](18-design.md)) docks tool panels at the
  side, the card moves out of the way when step 3 starts.
- Map mode: unavailable, with the existing message.

## Tests

- `tests/splits.test.ts`: a two-point cut shorter than the element cuts it completely; a legacy definition
  with a crossing line gives the same parts as before; a bent cut that does not cross is refused with the
  reason.
- `tests/sketch.test.ts`: snapping off returns the raw point; Shift constrains; Backspace removes the last
  cut.
- Browser, without reading any help: on the IFC demo, cut the ground slab in four with two strokes and
  apply; on the Revit sample, cut a floor at a regular interval; the previous view returns on close.
