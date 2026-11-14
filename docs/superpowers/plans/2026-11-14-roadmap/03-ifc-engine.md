# 03 — IFC engine: install once, keep warm, preload

## Goal

Converting an IFC no longer re-installs IfcOpenShell each time. The second conversion of a session starts
at once, and the first one starts faster because the engine was prepared before the user dropped a file.

## Current state (verified in code)

- Pyodide 0.29.3 comes from jsDelivr (`src/ifc/ifcWorker.ts:9`, `89-93`). The IfcOpenShell 0.8.5 wheel
  (14.6 MB, 53.6 MB installed) is fetched from `ifcopenshell.github.io/wasm-wheels/`, checked by SHA-256,
  written to the in-memory filesystem and installed with micropip (`ifcWorker.ts:70-84`,
  `src/ifc/convertIfc.ts:38-39`). The site does not host the wheel on purpose: it contains GPL code (CGAL).
- Workers live in a pool, 1 to 4 per conversion (`convertIfc.ts:99-106`). **After each operation every
  worker but the first is terminated, and the last one 30 s later** (`convertIfc.ts:78-82`). Any error
  terminates all of them (`:73-75`).
- So each conversion with N workers prepares N−1 runtimes again (Pyodide boot, micropip, wheel fetch,
  hash, unzip, `import ifcopenshell`), and after 30 s idle all N. This is the "re-install" the owner sees.
- No service worker, Cache Storage or IndexedDB anywhere in `src/`: only the HTTP cache.
- README figures (`README.md:377-381`): 21 MB IFC, 4 workers: 11.5 s first time, 6 s of it start-up; 5 s warm.
- Each shard receives the whole file and parses it fully before filtering its share of products
  (`convertIfc.ts:255`, `ifcWorker.ts:108`, `pipeline/ifc_to_glb.py:498-501`).
- **USD / Quick Look export of any model boots the IFC engine**, even for a Revit or GLB model:
  `pipeline/usd_writer.py:30` imports `ifc_to_glb`, which imports `ifcopenshell`.

## Decisions

1. **Measure first.** Add per-phase timings per worker (Pyodide boot, package load, wheel fetch, install,
   import, file parse, geometry, merge) to the conversion report. Every later choice cites these numbers.
2. **Keep the pool warm.** Replace the "all but one now, last one after 30 s" rule by: keep every prepared
   worker for `WARM_ALL_MS` (5 min) after the last operation, then shrink to one, and keep that one until
   the tab has been hidden for `WARM_HIDDEN_MS` (10 min) or the page closes. Errors still discard the
   whole pool (a dead runtime cannot answer).
3. **Cache the wheel bytes in Cache Storage**, keyed by the pinned SHA-256, around the fetch in
   `ifcWorker.ts:71`. The bytes still come from IfcOpenShell's own host to the user's browser: the site
   distributes nothing, the licence stance is unchanged. Hash is checked on every read from the cache.
4. **No micropip resolution over the network.** Load the wheel's dependencies explicitly with
   `pyodide.loadPackage([...])` in parallel with the wheel fetch, then install the wheel with `deps=False`.
5. **Preload on intent, not on every visit.** `preloadIfc()` prepares one worker when: a drag carrying
   files enters the window, the "Ouvrir" control gets focus or hover, or the page has been idle for 2 s and
   this browser has converted an IFC before (`localStorage` flag). Never when `navigator.connection.saveData`
   is on or `navigator.deviceMemory` is under 4.
6. **USD export stops loading IfcOpenShell.** `usd_writer.py` imports only what it uses; the worker gets a
   runtime level "python only" (no wheel) for the `usd` request.
7. **Stay on Pyodide 0.29.x and the 0.8.5 wheel.** The wheel's ABI is `cp313 / pyodide_2025_0`; newer
   Pyodide has no matching wheel. No memory snapshots: that API is private in Pyodide.

## What to build

- `src/ifc/ifcWorker.ts`: timings; `prepare` request kind (awaits the runtime, returns timings); runtime
  levels `python` and `ifc`; Cache Storage read/write of the wheel; explicit `loadPackage`.
- `src/ifc/convertIfc.ts`: pool policy of decision 2 as one function `settle(pool, now)` that is pure
  enough to unit-test; `export function preloadIfc(): void` going through the same queue as conversions;
  timings added to the result.
- `src/ui/App.ts`: the three intent hooks of decision 5; the IFC card shows "engine ready" or the
  preparation step, and the timings in the details.
- `pipeline/usd_writer.py`: no import of `ifc_to_glb`; shared helpers move to a small module both import.
- `README.md` § conversion and `pipeline/README.md`: new policy, measured figures before and after.

## Watch out for

- Memory: an idle runtime holds about 250 MB (the baseline assumed by `workerCount`). Four warm workers is
  1 GB: hence the 5-minute shrink, and no warm pool at all under 4 GB of device memory (keep one worker).
- `enqueue` terminates the pool on error: `preloadIfc` must not turn a failed preload (offline) into a
  failed conversion. A preload failure is silent and leaves the pool empty.
- Cache Storage can be evicted (Safari) or unavailable (private window): every access in try/catch, fall
  back to the network.
- The dependency list of decision 4 must be read from the wheel's own METADATA, not guessed, and checked
  by a test that fails when the pinned wheel changes.
- Do not change shard output: `mergeGlb` and the JSON must be byte-identical before and after (compare on
  the demo IFC).
- The whole-file parse per shard may dominate on big files. If the timings show it, the follow-up is a
  different split, not more workers. Out of scope here; record the numbers.

## Tests

- `tests/ifcPool.test.ts` (new): `settle` keeps, shrinks and releases at the stated times with a fake clock.
- Wheel cache: hit returns the same bytes; a corrupted cache entry is rejected by the hash and refetched.
- Browser check: convert the demo IFC twice in a row and after 2 minutes: no second wheel request in the
  network panel, start-up phase near zero the second time; USD export of the Revit demo makes no request
  to `ifcopenshell.github.io`.
