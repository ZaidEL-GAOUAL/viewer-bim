# 18 — New design for the three pages

## Report

"The site's design must be redone: it is too loaded and not intuitive, I find; it is not professional."

Done last, by the lead, after files 11 to 17 have settled what the tools do. This file records what is
wrong today and the rules of the new design; the mock-up and the build follow them.

## What is wrong today (checked in the browser at 1440 × 900 and in a narrow pane)

- **Four rows of controls** above the model: file and export buttons, tool menus, view buttons, download
  buttons — about thirty controls of equal weight, most of them text buttons, none grouped by task.
- **Tool cards float over the 3D view** and hide the model they act on (splitting, printing, views,
  sections), one card per tool, each with its own layout.
- **No hierarchy**: opening a file, the main action, looks like "Copier l'image". The same file action
  appears in two rows (Export GLB/USD at the top, GLB ↓ / JSON ↓ / Modifications ↓ lower).
- **Vocabulary of the implementation** in the interface (« Modifications ↓ », « JSON ↓ », « levels »,
  « sidecar ») instead of the user's task.
- **No guidance** in tools with several steps (splitting, study, comparison, clash).
- Three pages (viewer, study, site follow-up) with no common header, so they read as three products.
- Long explanatory paragraphs inside cards stand in for structure.

## Rules of the new design

1. **The model is the page.** One slim header, one tool rail at the left, one context panel at the right.
   Nothing floats over the 3D view except the view cube, the section handles and short toasts.
2. **Tools are grouped by what the user is doing**, each group one icon in the rail: Explorer (tree,
   filters, properties), Vues et coupes, Mesurer et quantités, Contrôler (compare, clash, required
   properties), Planifier (4D), Publier (print, exports), Assistant. A tool opens in the side panel, with
   steps when it has steps.
3. **One primary action per screen**; file actions live in one "Fichier" menu (open, add, save
   everything, export as…), named by what they produce for the user.
4. **Plain words**: "Enregistrer mes modifications" rather than « Modifications ↓ »; formats appear as a
   choice inside "Exporter", not as buttons.
5. **Progressive disclosure**: defaults visible, options behind "Options"; help is one sentence at the
   top of a step, never a paragraph at the bottom of a card.
6. **One shell for the three pages**: same header, same type scale, same components; the page switcher
   (Maquette · Étude de site · Chantier) is in the header.
7. **Professional restraint**: one neutral palette with one accent, one type family, a 4 px spacing grid,
   icons from one set with text labels on the rail's hover and in the panel titles; dark and light themes
   from the same tokens; keyboard reachable, visible focus, contrast AA.
8. **Performance stays first**: no framework added; the existing `h()` helpers and CSS; no layout that
   resizes the canvas while the camera moves.

## Watch out for

- `window.viewerBim` and every keyboard shortcut keep working; tests that query the DOM by label follow.
- The phone layout of the Chantier page is its own design, not the desktop one squeezed.
- Map mode, walk mode and 2D mode each change what the rail offers: say why a tool is unavailable, in the
  panel, rather than greying a button.
