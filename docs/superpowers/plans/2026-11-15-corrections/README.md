# Corrections after the owner's first real use (15 November 2026)

The owner used the merged roadmap (`../2026-11-14-roadmap/`) and reported what follows. Each line is one
file of this folder. The shared rules of `../2026-11-14-roadmap/README.md` still apply (three.js only plus
the approved free dependencies, generic logic, public JSON contracts, French interface, tests without any
model call, exFAT quirks, scratch on the SSD).

| # | Report (owner's words, translated) | File |
| --- | --- | --- |
| 1 | "In the BCF, the point that points to the comment / the object is missing." | [11-bcf-pointer.md](11-bcf-pointer.md) |
| 2 | "Views only work for the current view; the others give empty PDFs." | [12-print-views.md](12-print-views.md) |
| 3 | "GLB + JSON against IFC + JSON of the same model is reported as different." | [13-compare-formats.md](13-compare-formats.md) |
| 4 | "Revit must be in every feature. Not 'later': be consistent." | [14-revit-everywhere.md](14-revit-everywhere.md) |
| 5 | "We could not test the splitting: we did not understand how it works; it sticks to points." | [15-split-guided.md](15-split-guided.md) |
| 6 | "Studies: I did not understand how." | [16-study-guided.md](16-study-guided.md) |
| 7 | "Separate our Finalcad into its own link / web interface." and "Photos are saved but lost: not tied to a user. Profiles?" | [17-chantier-app.md](17-chantier-app.md) |
| 8 | "Redo the design: too loaded, not intuitive, not professional." | [18-design.md](18-design.md) |

## Order

11, 12 and the Rust half of 14 touch separate files and run together. Then 13 with the TypeScript half of
14 (both touch federation and comparison), 15 and 16. Then 17 (it reuses the observation code fixed in 11).
18 is last and is done by the lead (Fable), not by a sub-agent: it restyles and reorganises what the other
files have settled.

## Rules for every implementer

- No commit, no push, no network call to a language model, no dev server (the lead runs them).
- Other agents may be editing other folders at the same time: if `npm run typecheck` or `npm test` fails in
  a file you do not own, report it, do not fix it.
- Never touch `revit/samples/wadduwa.rvt` (private, never committed) or `.mcp.json`.
- Every fix comes with the test that would have caught the report.
- Finish with a hand-back: files changed, behaviour, test / typecheck / build results, what was not done.

## What "done" means for the lead

Each report is replayed in the browser on the owner's kind of file (the private Revit sample, the IFC demo
with georeferenced coordinates, a GLB + JSON pair) before the commit, and the result is told to the owner
in plain words, including what could not be reproduced.
