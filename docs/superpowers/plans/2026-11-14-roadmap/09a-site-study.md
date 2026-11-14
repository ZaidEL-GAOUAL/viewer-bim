# 09a — Site study: our own early-stage design tool (what Forma Site Design does)

## Goal

Build our own tool for the first days of a project: pick a site, see its surroundings, sketch building
volumes, read areas live, and check sun and daylight — in the browser, on free data, with no Autodesk
service. It is a companion to the viewer, built from the same code, not a link to Forma.

Working name: **Étude de site**. "Forma" is Autodesk's trademark and is not used in the product.

## What Forma Site Design does (researched November 2026)

Autodesk's help pages need a login; items marked *(excerpt)* were read from search excerpts only.

| Area | Forma Site Design |
| --- | --- |
| Site and context | Pick a site on a globe; terrain, neighbouring buildings and roads loaded automatically (OpenStreetMap, EU-DEM, Mapbox imagery in 2023); property boundaries in some countries only |
| Modelling | Site limits, zones, constraints; buildings drawn as a line, a basic volume or houses, with height, floors, function per floor; vegetation; roads; free 3D sketch; terrain pads with cut and fill |
| Metrics | Site area, building coverage, gross floor area, rentable area, breakdown by function, user-defined ratios (plot ratio) — live |
| Options | Several proposals over one shared context; side-by-side comparison of proposals and analyses |
| Generative | "Site automation": fills a limit with blocks, bars or towers from a grid, setbacks, floors and widths |
| Analyses | Sun hours; daylight potential (vertical sky component, bins at 27 / 15 / 5 %); wind (instant machine-learning estimate, and a cloud CFD run); microclimate (perceived temperature); noise from roads and rail; solar panel potential; carbon; operational energy; views |
| Sharing | Members, boards with live widgets, image and SVG export |
| Exchange | IFC, OBJ, Revit, Rhino *(excerpt)* |

What users value: fast setup (a first analysis within fifteen minutes), nothing to install, analyses usable
without simulation training. What they find weak: modelling poorer than SketchUp or Rhino, wind and noise
only good for comparing options, context data uneven by country, no published accuracy.

**Common core of every tool of this kind** (Forma, Giraffe, TestFit, Archistar, Infrared.city): a located
site with terrain and neighbours, quick volumes with floors and use, live area figures, sun and shadow,
comparison of options, export. Wind, noise and carbon are what differentiates them and are almost always
labelled indicative.

## What we already have

- A globe under the 3D canvas with free relief (terrarium tiles, `src/geo/terrain.ts`), satellite or map
  background, and OpenStreetMap buildings through Overpass (`src/geo/`).
- Georeferencing of a model (latitude, longitude, altitude, rotation; `src/geo/georeference.ts`), place by
  click, put on the ground.
- Area and volume maths (`src/engine/meshMath.ts`, `dimensions.ts`), GLB writing (`src/engine/writeGlb.ts`),
  IFC writing in the Python pipeline, saved views, sections, the 4D panel, the assistant's command layer.
- What is missing: drawing volumes, a local scene the analyses can cast rays in, any analysis, proposals.

## Decisions

1. **A second page of the same repository** (`site.html`, built by Vite next to `index.html`), sharing
   `src/engine`, `src/geo`, `src/data` and the interface shell. The viewer's bundle does not grow.
2. **A study is a JSON file** (`docs/contrat-etude.md`, new contract, version 1): site, context snapshot,
   proposals. Open, save and share like the other JSON files. No account, no server.
3. **The context is data we hold, in a local metric frame** (east, north, up from the site's origin):
   neighbouring buildings as footprints with heights, terrain as a height grid. Analyses run on that, not
   on the globe's tiles. The globe stays the backdrop.
4. **Volumes are parametric, not meshes**: a footprint polygon, a base level, floors, floor height, a use.
   Geometry is generated from them. This is new design geometry for a study; BIM models opened in the
   viewer are still never edited.
5. **Ray casting with `three-mesh-bvh`** (MIT, accepted by the owner as a free dependency; confirm the
   licence file at install), in a worker. The same index serves clash detection (workstream 07).
6. **Every country from the first version** (owner, 14 November 2026). The base is worldwide data:
   OpenStreetMap for buildings and roads, global relief tiles, satellite imagery already in the viewer.
   National sources are optional *providers* behind one interface (`ContextProvider`: buildings with
   heights, parcels, relief for a bounding box), tried in order of quality and always falling back to the
   worldwide base. France (IGN: measured heights, cadastre) is the first provider, not a requirement.
7. **Every analysis says what it is**: method, inputs, date, and "indicative" when it is a simplification.
   No result without its legend and its limits.

## First version

**Site**
- Search or click a place anywhere in the world; draw the site limit. Where a parcel provider exists for
  the country (France first: IGN API Carto, Licence Ouverte — to verify: CORS and limits), pick the
  parcel instead of drawing.
- Fetch context once and store it in the study: buildings and roads from OpenStreetMap, heights from tags
  (`height`, `building:levels`) or from a better national provider when there is one, terrain grid.
  Attribution shown and exported.
- Units, number formats and the use list follow the user's settings: metric by default, areas in m²,
  with square feet as an option; dates and sun times in the site's own time zone.
- The user can correct a neighbour's height or delete one; corrections are part of the study.

**Volumes**
- Draw a footprint (rectangle, polygon, bar along a line with a width), push it up by floors.
- Properties: floors, floor height, ground level, use (housing, offices, retail, parking, other — a list
  the user can edit), name, colour by use.
- Edit by handles (move, rotate, vertex, height), copy, array, snap to the limit and to setbacks.
- Constraints drawn on the site: setback from the limit, maximum height, no-build zones — shown, and
  volumes that break them are flagged, not blocked.

**Figures, live**
- Site area, built footprint and coverage, gross floor area total and by use, plot ratio, highest point,
  open ground, number of dwellings estimated from an average size and an efficiency ratio the user sets.
- A table per proposal and a comparison table across proposals; copy as TSV, export CSV.

**Proposals**
- Several proposals over the same site and context; duplicate, rename, compare two side by side (figures
  and analyses).

**Sun and shadow**
- Sun position from date, time and location (`suncalc`, BSD-2 — to confirm; or the published NOAA formulas
  in our own 60 lines, preferred: no dependency).
- Shadow study: a day played with a slider, for the solstices and equinoxes or any date; shadows from
  neighbours, terrain and the proposal.
- Sun hours: hours of direct sun on a ground grid and on facade points, for a date or a period; coloured
  map, value under the cursor, share of points above a threshold the user sets.

**Daylight**
- Vertical sky component on facades with the usual bins (27 / 15 / 5 %), CIE overcast sky, same ray caster
  with weighted sky samples. Sky view factor on the ground from the same computation.

**Bring in a model, send a model out**
- Place a BIM model opened in the viewer on the site as context or as the proposal (its georeference is
  reused); it casts shadows and is analysed like a volume.
- Export a proposal as GLB with properties (existing writer) and as IFC through the Python pipeline
  (one `IfcBuilding` per volume, one `IfcBuildingStorey` per floor, areas as quantities), so it opens in
  the viewer, in Revit and elsewhere.
- Print a sheet (workstream 08): plan with shadows, figures table, legend.

## Later, in this order

1. **Solar panels**: yearly yield per roof from PVGIS (European Commission; the API refuses calls from a
   browser, so through our Cloudflare Worker) multiplied by our own shading factor.
2. **Generative fill**: bars, blocks or towers on a grid inside the limit with setbacks, floors and widths,
   scored on the figures above; the user keeps one and edits it.
3. **Carbon, indicative**: emission factors per m² by use and structure. No free worldwide dataset allows
   use in software (ICE needs a paid licence); ADEME's Base Carbone (open licence) covers France. So: the
   user's own factors everywhere, with the French set as a preloaded option.
4. **Wind, comparative only**: a browser lattice-Boltzmann solver exists (WebGPU / WebGL, MIT examples) but
   none is validated; ship it only as "compare A with B", never as comfort compliance.
5. **Noise, simplified**: road emission, distance and first-order screening after CNOSSOS-EU (public
   method); needs traffic counts the open data does not carry, so the user types them.
6. **Rules of the local plan (PLU)**: height and setback rules typed by the user as constraints first;
   reading them from public data is a separate study.

## Not planned

Microclimate (depends on wind), operational energy (Forma uses proprietary models), parking solvers,
boards with live widgets, multi-user editing.

## Files

- `site.html`, `src/site/main.ts` (entry), `src/site/Study.ts` (state, undo), `src/site/study.ts` (contract
  types, parse, export), `src/site/context.ts` (fetch and normalise footprints, roads, terrain),
  `src/site/massing.ts` (parametric volume → mesh), `src/site/metrics.ts` (pure), `src/site/sun.ts`
  (position, pure), `src/site/analysis.worker.ts` (sun hours, sky component), `src/site/ui/*`.
- Shared from the viewer: `engine/sketch.ts` (polygon drawing, workstream 06), `engine/capture.ts` and the
  sheet (08), the action catalogue and command bar (04), the shell (10).
- `worker/`: one new route for PVGIS when that step comes; nothing before.

## Watch out for

- **Data terms**: Overpass's public server tolerates light use only (cache the context in the study, never
  refetch on open); OpenStreetMap needs attribution (ODbL); IGN services are free under Licence Ouverte
  with rate limits; terrain tiles need per-source attribution. Write the credits into the study and sheets.
- **Heights are often missing in OpenStreetMap**, and coverage varies a lot between countries: say how
  many neighbours have a measured, tagged or assumed height (a default per building type, editable), and
  let the user fix them; a wrong neighbour height makes a wrong shadow.
- **Worldwide means every latitude and both hemispheres**: sun paths south of the equator, polar day and
  night, the antimeridian in bounding boxes, and time zones from the site's coordinates, not the browser's.
- **Accuracy of relief**: free terrain is about 30 m per sample; fine for shadows from hills, not for
  earthworks. No cut-and-fill in the first version.
- **Frames**: site frame is east-north-up in metres from the study origin; the viewer is Y-up and
  recentred. Use the one conversion module of workstream 05.
- **Analyses must not freeze the page**: worker, progress, cancel, and results cached per proposal and
  invalidated when a volume or a neighbour changes.
- **Sun hours on a period** multiply rays by time steps: sample the sun path (a few hundred positions per
  year is enough), not every minute.
- **What we promise**: results are for comparing options early. They are not a regulatory daylight or
  sunlight study, and the interface and the printed sheet say so.
- Map mode in the viewer draws the model with Cesium; the study page draws with three.js over the globe.
  Keep one way per page.

## Tests

- `tests/siteMetrics.test.ts`: a 20 × 10 m footprint with 5 floors on a 1,000 m² site gives 200 m²
  footprint, 20 % coverage, 1,000 m² floor area, plot ratio 1.0; by use; mixed uses per floor.
- `tests/sun.test.ts`: sun elevation and azimuth at solar noon on the solstices and equinoxes against
  published values (tolerance 0.5°) for Paris, Singapore, Sydney and Tromsø (polar night and midnight
  sun); below the horizon at night.
- `tests/context.test.ts`: a provider that fails or has no coverage falls back to the worldwide base; the
  height source of each neighbour is recorded.
- `tests/sunHours.test.ts`: a point south of a wall has full sun, a point just north of it has none at
  noon in winter; an isolated point gets the day length.
- `tests/skyComponent.test.ts`: an unobstructed vertical facade gives about 39.6 % (the theoretical value
  under the CIE overcast sky); an infinite facing wall at the same height lowers it as expected.
- `tests/study.test.ts`: a study round-trips through JSON; an unknown field is kept; version checked.
- Browser check: a site in Paris, two proposals, shadow study on 21 December, figures table, GLB export
  opened in the viewer at the right place on the globe.

## Open questions (owner)

1. Is the study page public like the viewer, or reserved?
2. Which analysis matters most to your users after sun and daylight: solar panels, carbon, wind or noise?
