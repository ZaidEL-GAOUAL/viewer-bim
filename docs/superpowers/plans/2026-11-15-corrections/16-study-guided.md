# 16 — Site study: usable from the first screen

## Report

"Studies: I did not understand how."

## What a first-time user meets (checked in the browser)

- A grey plane and two columns of fields. The first thing asked is a latitude and a longitude typed by
  hand. There is no place search and no map: the spec's "search or click a place" was not built.
- Nothing shows where one is: no imagery, no streets, until "Charger le voisinage" is found and pressed.
- Every tool is offered at once (site, neighbours, volumes, proposals, figures, sun, three analyses), with
  no order and no sign of what depends on what (ratios stay empty without a limit, analyses mean nothing
  without neighbours).
- The page is reachable only from a line on the viewer's empty screen (`src/ui/App.ts:438`).
- A study lives only in a file the user must remember to save.
- No BIM model can be brought in (spec 09a, "Bring in a model").

## What to build (`src/site/`)

**Start screen** — instead of the empty scene: "Où est votre projet ?" with one search field (address or
place, any country), "ou cliquez sur la carte", and below: "Ouvrir une étude" and the recent studies kept
in the browser. The search uses OpenStreetMap's Nominatim on Enter (no request per keystroke; its usage
policy and attribution respected; to verify: CORS from our origins), with a list of results to choose from.

**A map from the first second** — the ground is draped with imagery tiles around the chosen point
(satellite or street map, the sources and credits already declared in `src/geo/`), drawn by three.js on
the study page (no globe library on this page). Before a place is chosen, a world map at low zoom to
click on. Neighbours and relief then load **by themselves** for the default radius when the place is set,
with progress and "Recharger avec un autre rayon" afterwards.

**Five steps in a rail, always visible, done in order but free to revisit**
1. *Lieu* — search, click, or coordinates (kept, under "Coordonnées"); time zone found from the place and
   shown as a city time, editable.
2. *Terrain* — "Tracez la limite de votre terrain" directly on the imagery; where a parcel provider exists
   (France), "Choisir la parcelle" by clicking it. Area shown as it is drawn.
3. *Voisinage* — what was loaded: N buildings, how many heights are measured / tagged / assumed, with the
   assumed ones tinted; click a neighbour to correct its height or remove it.
4. *Volumes* — rectangle, polygon, bar, drawn on the ground with the dimensions shown while drawing;
   floors, floor height and use in a small card on the selected volume. Proposals as tabs above the scene.
5. *Analyses* — figures (always live, in a strip that stays visible from step 2), then sun and shadows,
   sun hours, sky component; each with one sentence saying what it shows and its limits before running.
Each step has one sentence of instruction at the top and a single primary button for its next action; a
step whose prerequisite is missing says which one ("Tracez d'abord la limite").

**Keeping a study** — studies are saved automatically in the browser (IndexedDB) and listed on the start
screen; "Enregistrer" still writes the file; opening a file adds it to the list. When the user is signed
in ([17](17-chantier-app.md) brings accounts), the same list syncs; until then nothing is promised beyond
this browser, and the page says so.

**Bring a model in** — "Ajouter une maquette" accepts the viewer's formats, **including Revit** (same
loaders as the viewer: `loadModel`, IFC conversion, `readRevit`), places it by its georeference when it
has one, else at the site origin with move / rotate handles; it casts shadows and counts as context or as
the proposal. And from the viewer: "Étudier le site de cette maquette" in the Chantier / Carte area opens
the study page on the model's georeference (the model handed over through IndexedDB, not re-read).

**Entry points** — a visible link in the viewer's header to "Étude de site" (and back), not only on the
empty screen.

## Watch out for

- Tile and geocoding servers have usage rules: cache tiles for the session, no bulk download, credits
  shown on screen and in exports; Overpass as today (once, stored in the study).
- Imagery is a backdrop: analyses keep using the stored context (footprints, heights, relief grid).
- Both hemispheres, the antimeridian and polar latitudes for the click-to-place map (Web Mercator stops
  near ±85°: say so there).
- A model brought in is context, never edited; its triangles count against the page's budget; a Revit
  model is read with the reduced budget of [14](14-revit-everywhere.md).
- IndexedDB may be unavailable (private window): the page works from files and says nothing is kept.

## Tests

- `tests/siteGeocode.test.ts`: results parsed, empty and error cases, no request under three characters.
- `tests/siteSteps.test.ts`: what each step requires; the message when a prerequisite is missing.
- `tests/siteStore.test.ts`: a study saved, listed, reopened, deleted; unavailable storage degrades.
- Browser, without help: type "Wadduwa, Sri Lanka", pick the result, draw a limit, see neighbours load,
  draw two volumes, read the figures, play the shadows on 21 June; reload the page: the study is listed.
  Add the public Revit demo as a model and see its shadow.
