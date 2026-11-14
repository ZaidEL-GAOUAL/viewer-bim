# 04 — Assistant: results decided by code, any model, any provider

## Goal

What the assistant does is decided and reported by the viewer's code. The language model only translates
a sentence into a request the code checks. The same sentence gives the same result with Workers AI, Groq,
a personal key, a local model, or no model at all for the common commands.

## Current state (verified)

- One turn (`src/assistant/client.ts:134-178`): system prompt (≈6–13k chars) + 11 tool definitions (≈9k
  chars) sent every round, up to 6 rounds, history trimmed to 40 messages. Tool calls rely on the provider's
  native function calling (OpenAI format), normalised in the worker (`worker/src/index.ts:64-76`), with a
  rescue for one tool call written as text (`:92-103`).
- Model-specific patches are spread around: `flag()`, `asList()`, operator symbols, French dates, numbers
  as text (`src/assistant/tools.ts:362-460`), a prompt sentence about `"true"` (`prompt.ts:128`).
- The phrase → tool mapping is prose in the prompt (`prompt.ts:128`): show only / isolate, select, hide,
  show all, highlight, colour, group the tree, set a property, plan dates. Only element ids quoted by the
  user are recognised without the model (`src/assistant/mentions.ts`).
- The final sentence is free text from the model. Nothing checks it against the tool results; only prompt
  rules ask it not to claim an action.
- No evaluation: tests cover each tool with a fake context, never the choice of tool or arguments.
- Defects found while reading:
  - No timeout anywhere, client or worker.
  - `trimHistory` (`client.ts:106-112`) can send the system message alone when one turn exceeds 40 messages.
  - Unparseable tool arguments silently become `{}` (`worker/src/index.ts:51-62`).
  - Provider fallback is per request: one turn can change model between rounds.
  - Rescued tool calls always get the id `call_text_0`; ids repeat across rounds.
  - `select_elements` with `highlight` and `scope: "selection"` reports "highlighted" without applying it (`tools.ts:574`, `590`).
  - `set_visibility` without `visible` shows (`tools.ts:613`).
  - Narrowing to quoted elements applies to 2 tools out of 6 that take filters (`tools.ts:228-236`).
  - When 6 rounds run out the last tools ran but the user gets a fixed message.
  - The agent API has no result cap; `docs/contrat-metadonnees.md:130-135` and `worker/README.md:41` are out of date.

## Design: three layers

```
sentence ──▶ 1. Commands (code, no model) ──hit──▶ run tool ──▶ 3. Answer written by code
                    │ miss
                    ▼
             2. Translator (model) ──▶ JSON request ──validated by code──▶ run tool ──▶ 3.
```

### Layer 1 — Commands, without a model (`src/assistant/intent.ts`, `src/assistant/valueIndex.ts`)

- `parseIntent(text, index): Intent | Ambiguity | null`. Normalises (case, accents, apostrophes, spoken
  forms without « ne »), matches the verbs of the mapping above in French and English, and resolves the
  target against the model's real values.
- `ValueIndex`: for the loaded model, every distinct value of every property with its count, folded for
  search, plus property names. "les murs" finds `Catégorie = Murs`; "niveau 2F" finds `Niveau = 2F`.
  Plural/singular and a small stop-word list; no synonym dictionary of BIM terms (the viewer stays generic).
- Result:
  - one reading → `{ tool, args }` run directly, no network call;
  - several readings (a word matching two properties, two values) → `Ambiguity` with up to 5 choices shown
    as buttons; the user picks, nothing is guessed;
  - none → layer 2.
- Covers at least: isolate / show only, hide, show again, show all, select, highlight, colour X in <colour>,
  transparency, group the tree by, "how many X", "how many by Y", set property X to Y on Z, plan dates
  (start, end, min/max days, by property), undo the last assistant action.
- The mapping sentence leaves the prompt once the parser covers it.

### Layer 2 — Translator, model-agnostic (`src/assistant/protocol.ts`)

- The model is asked for **one JSON object as plain text**, never native tool calls:
  `{"tool": "<name>", "args": {…}}` or `{"answer": "<text>"}`. The request to the worker carries no `tools`
  field; providers that offer a JSON mode get it, the protocol does not need it.
- `parseAction(text): Action | ProtocolError`: takes the first balanced JSON object in the text (ignores
  code fences, `<|python_tag|>`, prose around), validates `tool` and `args` against the tool's schema —
  the same `TOOL_DEFINITIONS`, which become the single source for validation, the prompt and the agent API.
- Argument tolerance moves from scattered helpers to schema-driven coercion in one function (`coerceArgs`):
  boolean from text, number from text, list from a single item, operator symbols, dates. The helpers in
  `tools.ts` are deleted when their tests pass through `coerceArgs`.
- Invalid output → one retry carrying the exact validation message; still invalid → a fixed, honest
  message with the request untouched. Never an empty-argument call.
- The loop stays (a question may need `count_by` then `compute`), with 4 rounds and a provider pinned for
  the whole turn: the worker returns the provider it used, the client sends it back as a preference.
- The prompt lists only names and one-line purposes; a tool's full schema is sent only after the model
  names it wrongly or on retry. Target: under half of today's characters per round.

### Layer 3 — Answers written by code (`src/assistant/answers.ts`)

- Every state-changing tool has a template fed by its result: what was done, on how many elements, the
  first names, and an "Annuler" button wired to the undo of that step (properties) or to the inverse
  action (view). The model's sentence is not shown for these.
- Read tools render their result as a table or a figure built by code. The model may add at most a short
  comment, displayed under the result and visibly separate from it.
- A write over `CONFIRM_ABOVE` elements (200) or over the whole model shows the preview first — count,
  property, sample of new values — with Apply / Cancel. Applies to layers 1 and 2 alike.

## Fixes to fold in (same workstream)

Timeouts (client 60 s per round with `AbortSignal.timeout`, worker 25 s per provider); `trimHistory`
keeps the current turn whole; unparseable arguments are an error returned to the model; unique call ids;
`highlight` + `selection`; `set_visibility` requires `visible` or `showAll`; quoted-element narrowing for
every tool that takes filters; agent API: same 8,000-char cap, and a `dryRun` option for the two writers;
docs corrected.

## Evaluation, without spending the owner's quota

- `tests/fixtures/assistant/corpus.json`: sentences (French, English, dictated-style with errors) on the
  demo model and on a GF/1F-style model, each with the expected `{tool, args}` or the expected ambiguity.
  Starts with the requests already seen in this project (isolate building A, hide level R+2, colour walls,
  the planning sentence with "code étage").
- `tests/assistantIntent.test.ts` runs the corpus through layer 1 in CI: no model, no network.
- `tests/fixtures/assistant/replies/`: raw model outputs recorded once per provider dialect (native call,
  JSON in prose, python-tag, arguments as string). `tests/assistantProtocol.test.ts` replays them through
  `parseAction`. Recording is a manual script (`scripts/record-assistant.ts`) the owner runs with his key;
  CI never calls a model.
- A scorecard script prints, per provider, how many corpus sentences give the expected action. It is the
  acceptance test for "independent of the model".

## Watch out for

- Layer 1 must refuse rather than guess: a wrong instant action is worse than a model round. Ambiguity UI
  is part of the feature, not a later polish.
- The viewer stays generic: no hard-coded property names in the parser; it reads names and values from
  the loaded model. Colour words and verbs are the only vocabulary.
- French typing is loose (dictation): fold accents, accept "affiche que", "R plus 2", missing hyphens.
- The agent API (`window.viewerBim`, WebMCP) keeps its shape (`version: 1`); additions are optional.
- Heights and geometry stay out of what is sent to a model (current rule); layer 1 runs locally and may
  use them.
- Never call a model in tests. The worker is redeployed only when `worker/` changes.

## Open questions (owner)

1. When no provider is reachable, should the panel say "commands only" and keep working with layer 1?
   (Proposed: yes.)
2. Is a preview before large writes wanted for the properties panel too, or only for the assistant?
