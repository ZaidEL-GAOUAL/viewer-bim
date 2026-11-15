# 12 — Printing views: every page shows its view

## Report

"Views only work for the current view; the others show empty PDFs (I think the views are there, but empty)."

## What was checked

Not reproduced as a blank page. In the lead's browser (Chromium, 120 Hz, pixel ratio 2), at A4 landscape,
1:100, 150 dpi: the Revit sample's 3D view and floor plans, the IFC demo's saved views and its computed
level plans all print, alone and as a multi-page file. What the check did show:

1. **A page other than the current view is framed blindly** (`src/ui/printJob.ts`, `addPage`): a parallel
   view is printed at the dialog's scale, centred on the view's camera, whatever the model's size. The
   Revit sample's ground-floor plan is cut off on three sides at 1:100; a larger model, or one whose centre
   is a courtyard or whose bounds are stretched by a stray element, gives a page of bare floor or nothing.
   The current view does not have the problem because the user framed it himself, and the dialog draws the
   printed frame on it.
2. **Nothing shows the page before the file is made**: the hint and the frame only describe the current
   view (`src/ui/PrintDialog.ts:150`, `:170`).
3. **The wait for the camera depends on the screen's refresh rate**: `settle` waits at most 100 frames for
   the 650 ms move (`printJob.ts`, `src/engine/Viewer.ts:54`); above about 150 Hz the capture can start
   mid-move.
4. Floor plans of a model without wall/floor contrast print as one grey mass (the upper floors of the
   Revit sample): readable on screen thanks to the dark background, not on paper.

## What to build

**Framing of a page that is not the current view (`printJob.ts`, `src/data/sheet.ts`)**
- Compute what the view shows: the box, in the view's plane, of the elements visible in that view (hidden
  elements, isolation, phase, section box and plan range applied) — not the model's bounds.
- New setting **"Mise à l'échelle"**: `Ajuster à la page` (default) or `Échelle fixe`.
  - Ajuster: the page is centred on that box and printed at the **largest standard scale that fits**
    (list of `SCALES`); the real scale goes in the title block and the scale bar. A perspective view is
    cropped to the box as today.
  - Échelle fixe: the chosen scale, centred on that box; when the content does not fit, the dialog says
    so per page ("« GF » dépasse la feuille à 1:100 : 3 pages sur 6") and offers the next paper size.
- The current view keeps today's behaviour (the user's framing and the frame drawn on screen).

**Preview**
- The dialog shows one thumbnail per ticked page (small capture through the same camera as the print,
  about 320 px wide, made when the page is ticked or a setting changes, cancellable, one at a time), with
  the scale it will be printed at. An empty thumbnail is the user's warning.
- After capture, a page whose image is entirely background is reported in the final toast ("2 pages
  vides : GF, 1F — rien de visible dans ces vues") instead of being delivered silently.

**Opening a view for print**
- `App.openView(view, { animate: false })`: no camera move to wait for; `settle` only waits for the cut
  (`viewer.cut.ready()`) and two frames.

**Readable plans on paper**
- In a printed parallel view, cut solids are filled in a neutral dark grey and what lies below the cut
  keeps its colours, lightened, with element edges drawn (the viewer already has an edges pass: reuse it;
  if there is none for capture, add outlines from the existing cut lines only and say so).

## Watch out for

- The box of visible elements on a 12-million-triangle model: element boxes only, never triangles.
- A plan has rotation locked and its own range: restore the user's view exactly afterwards (already done
  through `captureView`), including when a thumbnail is cancelled.
- Thumbnails must not fight the print job for the renderer: one capture at a time, print wins.
- Map mode stays unavailable for printing, with the existing message.

## Tests

- `tests/sheet.test.ts`: largest standard scale that fits a box on each paper; a box larger than A0 at the
  smallest scale is reported.
- `tests/printJob.test.ts` (new, pure parts): the visible box honours hidden elements and the plan range;
  the frame is centred on it; a view with nothing visible is reported empty.
- Browser: the Revit sample, pages "GF", "1F", "Site", "{3D}" with Ajuster: each plan entirely on its
  sheet, scale written; the same with a stray element far away added to the model: still framed on the
  building. The IFC demo's computed level plans and a user view. One 300 dpi A3 page (several tiles).
