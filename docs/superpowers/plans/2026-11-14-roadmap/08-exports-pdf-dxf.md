# 08 — Printing a view to PDF, and CAD export (DXF in place of DWG)

## Goal

Any view can be printed on a sheet at a real scale, and a plan or section can be opened in AutoCAD,
BricsCAD or Revit.

## Current state (verified)

- No PDF, image, print, DXF or DWG code. No `toDataURL`, `toBlob`, `readPixels`, `window.print`,
  `@media print`.
- The renderer is created without `preserveDrawingBuffer` and with `autoClear = false`
  (`src/engine/Viewer.ts:122`); `afterRender` (`Viewer.ts:770`) is the natural hook for a capture.
- Exports today: GLB, USDZ / Quick Look, metadata JSON, planning JSON, dimensions as TSV.

## Decision on DWG

A browser cannot write DWG legally and reliably: LibreDWG is GPLv3 and its writer is experimental (R13–R2000
only, AutoCAD may refuse the files); the ODA libraries are paid; ODA's free converter may not be
redistributed nor used commercially by non-members. **The viewer exports DXF**, which AutoCAD, BricsCAD and
Revit open directly. The button says "DXF (AutoCAD, BricsCAD, Revit)". No DWG, no bundled converter.

## Part A — Capture (shared)

- `src/engine/capture.ts` (new): `captureTiles(viewer, { widthPx, heightPx, tile }): AsyncIterable<{ x, y, blob }>`
  renders the current view at any size by tiles with `camera.setViewOffset`, off the display loop, into a
  render target, and yields each tile as JPEG or PNG. `capturePng(viewer, widthPx, heightPx)` for small sizes.
- Used by: PDF pages, BCF snapshots (07), view thumbnails (05), a "Copy image" button.
- Section fill, colour rules, hidden elements and the 4D state are captured as displayed. Gizmos, the
  cursor and selection outline are not.

## Part B — PDF

**Sheet**
- Paper A4 to A0, portrait or landscape, margins. Title block: project / file name, view name, scale, date,
  author field (free text, remembered in `localStorage`), north arrow on plans, scale bar.
- Scale: orthographic views and plans print at a chosen scale (1:20, 1:50, 1:100, 1:200, 1:500 or typed);
  the framed area is shown on screen before printing. Perspective views are "not to scale" and say so.
- Several saved views → one PDF, one page each.

**Content**
- Plans and sections: the cut lines as vectors (from `cutSegments`, workstream 05), thick, over a raster of
  what lies beyond the cut. 3D views: raster.
- Raster at 150 dpi by default, 300 optional; tiles are placed in the PDF as separate images, so no canvas
  larger than a tile is ever created (browser limits: about 125 megapixels in Firefox, 16.7 on iOS).
- Text in the PDF's built-in Helvetica (accents covered by WinAnsi); no font file embedded.

**Writer**
- `jsPDF` (MIT), loaded with a dynamic `import()` only when the user exports, so it adds nothing to the
  page's first load. Accepted by the owner (free dependency, 14 November 2026); confirm the licence file
  at install. `src/data/pdf.ts` is a thin adapter so the writer can be replaced.
- `window.print()` is not used: Firefox and Safari ignore the page size in saved PDFs and the print dialog's
  "fit to page" breaks the scale.

**Files**: `src/engine/capture.ts`, `src/data/sheet.ts` (layout: paper, scale, frame → millimetres, pure),
`src/data/pdf.ts` (adapter over the writer), `src/ui/PrintDialog.ts`.

## Part C — DXF

- Scope v1: the current plan or section. One `LWPOLYLINE` per closed loop of the cut, `LINE` for open
  ones, on a layer named after the element's value for a property the user picks (default: the first
  grouping level of the tree). Layer colours from the colour rules when one applies.
- Units metres (`$INSUNITS` 6), real size, original model coordinates (see below), so two exports of
  different levels overlay in CAD.
- Optional texts: view name, level, scale note. No dimensions, no hatches in v1.
- Writer: `src/data/dxf.ts`, our own ASCII writer (header, layer table, entities), about the size of
  `writeGlb`'s helpers; no dependency. `@tarikjabiri/dxf` (MIT) is the alternative if blocks or hatches
  become necessary.
- v2: projected edges beyond the cut (needs hidden-line removal, costly), 3D export as meshes (very large
  files), hatches.

## Watch out for

- Coordinates: the model is recentred (`Model.offset`) and Y is up in the viewer; CAD expects Z up and the
  original coordinates. One conversion function, tested, used by DXF and by the scale computation.
- Scale is only right if the PDF page size is honoured: tell the user to print at 100 %, and draw the scale
  bar so a wrong print is visible.
- A0 at 300 dpi is 140 megapixels of JPEG: stream tiles into the PDF, release each blob, show progress,
  allow cancel. Test on Firefox.
- Capturing during a Revit read (model still growing) or during planning playback: capture what is on
  screen, and note it on the sheet ("partial model").
- Map mode: the Cesium canvas is a different canvas; v1 prints the 3D model view only and disables the
  button in map mode with a reason.
- Thin lines: PDF line widths in millimetres, not pixels; minimum 0.13 mm.
- DXF readers differ on encoding: write ASCII with `\U+XXXX` escapes for accents, and test names like
  « Étage 1 ».

## Tests

- `tests/sheet.test.ts`: at 1:100 on A3 landscape with 10 mm margins, a 20 m wide plan fits and 1 m is
  10 mm; the framed model rectangle is the expected one; too-large plan reports the next paper size.
- `tests/dxf.test.ts`: a cut square gives one closed `LWPOLYLINE` with four vertices on the expected layer;
  header has `$INSUNITS` 6; output is stable (golden file); accents escaped.
- `tests/capture.test.ts`: tile rectangles cover the image exactly once (pure tiling maths; no WebGL in CI).
- Manual check, recorded in the PR: the demo's ground-floor plan as PDF measured in a PDF reader (a 5 m
  wall measures 50 mm at 1:100) and as DXF opened in a CAD program (same wall 5.000 long).

## Open questions (owner)

1. Is a company title block (logo, fixed fields) needed, or is the generic one enough to start?
