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

## The design plan

**Where the look comes from.** The subject is the construction drawing and the building site: sheets with
a title block (cartouche), thin precise lines, level and section marks, site signage. The interface
borrows two things from that world and keeps everything else quiet.

**Colour** — light and dark from the same tokens; the theme follows the system and can be forced.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Papier | `#F4F5F3` | `#141A21` | page |
| Calque | `#FFFFFF` | `#1B232C` | panels, header |
| Trait | `#D6DADD` | `#2B3642` | lines, borders |
| Encre | `#17212B` | `#E6EAEE` | text |
| Encre douce | `#5E6B78` | `#93A0AD` | secondary text |
| Bleu de traçage | `#2647C8` | `#86A4FF` | the one accent: primary action, selection, focus |
| Signal | `#D9480F` | `#FF8A4C` | attention only: not saved, late, open observation |
| Fond de vue | `#E8EBED` | `#222A33` | behind the model |

**Type** — one family in two widths: Barlow for the interface, Barlow Semi Condensed for dense data
(property tables, the cartouche, the tree counts). It comes from road and site signage, reads well small,
and its narrow cut keeps long French labels on one line. Self-hosted (no call to a font service), weights
400 / 500 / 600, tabular figures in tables. Scale: 12 · 13 (base) · 15 · 18 · 24. Sentence case
everywhere; no capitals for labels.

**Layout**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Viewer BIM   Maquette  Étude de site  Chantier        Fichier ▾  Exporter ▾  │ 44
├────┬───────────────────┬─────────────────────────────────────┬───────────────┤
│ ◧  │ Explorer          │                                     │ Propriétés    │
│ ◩  │ ─ un outil à la   │                                     │ de la         │
│ ◪  │   fois, avec ses  │            la maquette              │ sélection     │
│ ◫  │   étapes          │                                     │               │
│ ▤  │                   │      ┌ outils de vue ┐              │               │
│ ✎  │                   │      └───────────────┘              │               │
├────┴───────────────────┴─────────────────────────────────────┴───────────────┤
│ Fichier wadduwa.rvt │ Éléments 437 │ Sélection 2 │ Vue 1F │ Non enregistré   │ cartouche
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Rail** (left, icons with their name underneath): Explorer · Couleurs · Vues et coupes · Mesurer ·
  Contrôler · Planifier · Chantier · Assistant. One group open at a time in the dock beside it; a group
  with several tools shows them as a short list, and a tool opens in the same place with a way back.
  The former floating cards live there: nothing covers the model.
- **View tools**: one small bar at the bottom centre of the view (select, 2D, visite, carte, cadrer,
  masquer, isoler, tout afficher, annuler / rétablir), icons with tooltips and shortcuts.
- **Header**: the three pages as tabs, then two menus. *Fichier*: ouvrir, ajouter une maquette, ouvrir un
  dossier, joindre des métadonnées, exemples. *Exporter*: enregistrer mes modifications, toutes les
  propriétés, la maquette 3D (GLB ou USD), imprimer en PDF, DXF, copier l'image, voir sur Apple.
- **Cartouche**: the status line, drawn as the title block of a sheet — labelled cells for file, elements,
  selection, current view, and the "not saved" state. This is the one characteristic element; the rest
  stays plain.
- Left aligned throughout; panels 320 px, properties 320 px, both resizable later, both collapsible.

**Checked against the usual defaults.** A rail with a dock and a properties panel is the standard layout
of professional tools: kept on purpose, because the brief is "intuitive and professional". What is
specific here: the cartouche instead of a dotted status line, the signage type in two widths, steps drawn
only where the task really is a sequence, and no card grid, no gradient, no decorative icon set.

## Watch out for

- `window.viewerBim` and every keyboard shortcut keep working; tests that query the DOM by label follow.
- The phone layout of the Chantier page is its own design, not the desktop one squeezed.
- Map mode, walk mode and 2D mode each change what the rail offers: say why a tool is unavailable, in the
  panel, rather than greying a button.
