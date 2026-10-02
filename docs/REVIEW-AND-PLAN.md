# fantasyhexmap: review and user-focused improvement plan

Review date: 2026-10-02, against `main` at 492049e.

## Context

The app (React 19 + Vite client, shared `core/`/`shared/` pipeline, Express server / Worker / browser-direct transports) is functionally rich after 37 PRs, each adding a feature in isolation. The engineering underneath is sound (one scene model for canvas/PNG/SVG, version-based staleness, repair-vs-flag validation, 22 test files). The problems are in the layer users touch: several interactions are broken or silently corrupt state, the first-run path hides the most important action, and the interface has accreted controls without an organising model. There are no open GitHub issues. The findings come from two sources. The first is a static read of every component in `src/components/`, plus `src/App.tsx`, `src/state/store.ts`, `src/render/`, `src/api/` and the README and DECISIONS docs. The second is a scripted Playwright walkthrough of the running app in mock mode (`HEXMAP_MOCK=1`), whose results are recorded under "Verified in the running app" below. The baseline was clean: all 144 tests passed and `npm run typecheck` passed.

The plan is ordered by user harm: things that corrupt work or do nothing first, then things that block a new user, then friction, then polish.

## Findings

### A. Defects that corrupt state or silently do nothing

A1. Text and colour fields commit on every keystroke. Polity name, polity short name and polity colour (`Inspector.tsx` PolityEditor, ~lines 571–594), city name and population (CityEditor, ~691–705) and river name (RiverEditor, ~822–826) dispatch `upsertPolity` / `upsertCity` / `updateRiver` from `onChange`. Each dispatch goes through `commit()` in `src/state/store.ts`, which pushes an undo snapshot, bumps the layer version and writes a journal entry. Typing a 12-letter river name therefore creates 12 undo steps (the stack is 40 deep, so earlier real edits are evicted), 12 "edited by hand" journal entries (cap 400), and bumps the rivers version 12 times — which marks Vegetation, Cities, Polities and Population stale because they all `use` rivers (`shared/layers.ts`). Dragging the native colour picker does the same dozens of times per second. Renaming a city marks Polities and Population stale. The fix pattern already exists: `RangeNameInput` (`Inspector.tsx:397`) edits locally and commits on blur/Enter.

A2. Polity brush mode does nothing. PolityEditor shows a "brush" checkbox and the hint "Brush mode assigns as you drag", but `onStrokeEnd` in `App.tsx:286` only handles `PER_HEX` layers, and `setPolityOwner` is dispatched only from the Assign button. Dragging with brush on just selects.

A3. Zoom buttons zoom towards the top-left corner. `MapView.tsx:343–344` changes `scale` without adjusting `x`/`y`, unlike the wheel handler which zooms about the cursor. On a large map, pressing + pushes the area being looked at off screen.

A4. The view is fitted only once per page load. `fitted` (`MapView.tsx:86`) is never reset, so loading a save, importing JSON or starting a new map of different dimensions keeps the old pan/zoom, often leaving the new map partly or wholly off screen.

A5. Saves dialog errors are unstyled: `SavesDialog.tsx` renders `className="error"`, which has no CSS rule (the app uses `notice error`).

A6. The model list was out of date and, worse, two of its three entries probably could not generate at all. `SettingsDialog.tsx` offered `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`, and `core/pipeline.ts` sent every model the same request: a task budget with its beta, an effort level, `max_tokens: 128000` and no `thinking` field. According to the API reference, Sonnet 5 takes no task budget, and Haiku 4.5 takes no effort level, needs thinking as a fixed `budget_tokens`, and caps output at 64,000. These failures come from the reference, not from a live call, because no key was available to test with.

### B. First-run and discoverability blockers

B1. There is no Generate button for six of the eight layers. After "Create map" the user lands on Base Geography with an empty map. The inspector shows undo/redo/clear, an instruction box whose button is disabled ("Rewrite this layer with AI" requires data), and "Direct edit: Generate this layer first". The only way to generate base, elevation, climate, vegetation, cities or population is to tick the second, unlabelled checkbox on the layer row and press "generate selected (1)" in the sidebar. Only polities and rivers get a Generate button (inside "Generate in passes"). This is the single largest usability problem: the core action of the product is hidden behind an unlabelled control.

B2. Each layer row has two adjacent unlabelled checkboxes (`LayerPipeline.tsx:83–99`) — one for map visibility, one for batch selection — distinguishable only by tooltip. Visibility is conventionally an eye icon; selection for batch work is a secondary concept.

B3. The empty map gives no guidance. The canvas draws an empty grid and the HUD says "Drag to select", which is meaningless before anything is generated. There is no "next step" prompt (generate base, then the layers it unlocks).

B4. Help text contradicts the controls. The hint under the instruction box (`Inspector.tsx:260–265`) says "use the second button" for multi-layer edits and then "The second button builds the same prompt for you to run in a chat window" — written before the multi-layer button was inserted, so "second button" now refers to two different buttons.

B5. Panning is undiscoverable and impossible on touch. Pan requires Alt-drag, right-drag or middle-drag (`MapView.tsx:157`); plain drag always selects. There is no pinch-zoom or two-finger pan, so on a tablet or phone (the CSS has a 640px breakpoint, implying mobile is intended) the user cannot move around the map at all beyond the +/−/fit buttons, which themselves zoom to the corner (A3).

### C. Workflow friction

C1. Errors appear far from their cause. All errors (generation failures, "Select a river first", "Cities cannot stand on water", move-river failures) render in the left sidebar between the progress block and the export panel, while the user is working in the map and right-hand inspector. On a short screen the message is below the fold.

C2. No keyboard support. No shortcuts for undo/redo (Ctrl/Cmd+Z, Shift+Z / Ctrl+Y), Escape does not close any of the six modals, Enter does not finish a river draft, there is no shortcut to clear selection, and modals have no focus trap or initial focus (except UnlockDialog). Only 22 `aria-`/`role` attributes exist across all components; the canvas has no accessible description.

C3. Undo is per layer with no global entry point. This is a documented design decision and should stay, but the consequence is that after a cross-layer action (a base edit that drops polity claims via `reconcile`, or a multi-layer AI rewrite) the user must visit each layer to undo. The topbar or a toast after multi-layer operations should say which layers changed and offer to undo them in one go.

C4. Destructive actions are inconsistent. "clear" layer sits next to undo/redo with no confirmation (it is undoable, but one click away from a 40-step history); "new map" erases the autosave with only a `window.confirm` and no offer to save or export first; removing a polity, city or river is an unconfirmed "×" (undoable, acceptable).

C5. The map name cannot be changed after creation. The reducer supports `setMeta { name }` but nothing in the UI dispatches it; the topbar `h1` is static. The name feeds exports, the legend title and saves.

C6. The topbar is overloaded and mixes concerns: unlock, decisions, settings, saves, export JSON, export JSON + history, import JSON (a styled `<label>` with inline styles), new map — eight similarly sized 11px buttons, with image export living separately in the left sidebar. File operations (new, saves, import, export JSON, export image, export Markdown) are scattered across three places.

C7. Selection can only be built by click, shift-click and drag-sweep. There is no "select all hexes of this value" (e.g. all Mountains, all of one polity), which is the natural way to bulk-edit or to name a mountain range, and no select-all / invert / clear shortcut.

C8. Long-running generation gives little information. Progress shows phase and character count with an indeterminate bar. Elapsed time and, on completion, token usage (already returned in `GenerateResult.usage` and `elapsedMs`) are discarded. Users paying per token cannot see what a layer cost.

C9. Several hints sit in odd places: "Polity areas use the hex size set in Settings → Map" is the first thing in the inspector whenever Polities is active, above the layer title; range-naming instructions are split between Settings → Display and the elevation inspector.

C10. Display toggles are split between Settings → Display (on-screen labels, river names, range names) and the Export panel (export labels), and the Export panel initialises its toggles from prefs only at mount, so changing a display pref later does not update the export defaults.

### D. Polish and maintainability (lower priority)

D1. Heavy use of inline `style={{…}}` for repeated patterns (inline checkbox labels appear ~10 times with the same five properties); a `.check-inline` class and a shared `Check` component (one already exists in `ExportPanel.tsx`) would remove the duplication and make the UI consistent.

D2. `App.tsx` (881 lines) holds all orchestration state; `Inspector.tsx` (1,046 lines) holds five editors. Splitting editors into their own files and moving generation orchestration into a hook (`useGeneration`) makes the fixes above easier and testable.

D3. Dark theme only, 11px base for most controls; small hit targets (tiny buttons ~20px tall) are hard on touch.

D4. The inspector legend lists every possible value (21 Köppen codes, 19 vegetation types) rather than those present; the export legend already has an "only values on the map" option (`render/legend.ts`) that could be reused.

### E. Found only by running the app

E1. Generating every layer in one batch leaves Vegetation stale, and it was generated without river context. `nextGenerationWave` (`shared/generationQueue.ts`) only waits for a layer's hard `requires` and otherwise follows `LAYER_ORDER`. That order puts Vegetation before Rivers, even though Vegetation `uses` Rivers. With "at once" set above 1 it gets worse: Elevation and Climate, or Rivers and Cities, run in the same wave, so the downstream layer is built without context that is about to exist and is flagged stale the moment it lands. The user pays for an expensive generation that the app itself immediately marks out of date. The fix is to hold back a pending layer while any of its pending `uses` dependencies are still pending, which is a topological order over `requires ∪ uses`. That order puts Rivers before Vegetation, since Rivers uses only Elevation. The fix belongs in Phase 1, with a test in `test/generationQueue.test.ts`.

E2. On a phone-width viewport (390px) the whole sidebar renders before the map: the topbar wraps to four rows, then come the layer list, the export panel and the description. The map starts below several screens of controls. At 390px the page does not scroll horizontally, but it is not usable as a map editor. In Phase 2 the stacked layout should put the map first, at a fixed height, with the sidebar and inspector below it or in tabs.

E3. The most prominent control on a new, empty map is "Rewrite this layer with AI". It is a full-width primary button that is disabled, and at 45% opacity it still reads as active. It is the obvious thing to click, and clicking it does nothing. In the topbar, "import JSON" is a styled `<label>` with different padding and font size from its neighbours, so it looks greyed out and disabled. Both points reinforce B1 and C6.

### Verified in the running app

These are the results of the scripted walkthrough, run against a 30×22 map created from the example description, with every layer generated through "generate selected".

| Finding | What the script did | Result |
| --- | --- | --- |
| B1 | Counted Generate buttons in the inspector on a new map | 0; the "Rewrite" button is disabled |
| A1 | Typed " Major" (6 characters) into a river name | Rivers undo went from 1 to 7. Cities, Polities and Population changed from ready to stale |
| A2 | Polities layer, target "Realm of A", brush ticked, dragged across 10 hexes | Undo stayed at 1, so nothing was assigned |
| A3 | Pressed + twice with the pointer at the viewport centre | The hex under the centre moved from 14,17 to 9,11 |
| C2 | Opened Settings and pressed Escape; pressed Ctrl+Z on the map | The dialog stayed open; nothing was undone |
| E1 | Generated all eight layers at concurrency 1 | Vegetation was stale straight away ("Rivers was generated after this layer") |

A4 (no refit after loading a map of another size) and A5 (unstyled error in the saves dialog) were not exercised by the script. Both are certain from the code.

## Decisions and progress

The owner made two decisions after the review. First, a rename is not a change: renaming or recolouring a polity, river or city is undoable, but it bumps no layer version and so marks nothing stale. City population is not cosmetic, because Polities and Population both use it. Second, Settings should offer every reasonable model. It now lists Claude Fable 5.1, Opus 5.5 (the new default), Opus 5, Opus 4.8, Sonnet 5.5, Sonnet 5, Sonnet 4.6 and Haiku 4.5. `core/models.ts` records what each model accepts, and every request is built from that table. Mythos 5.1, which is limited to Project Glasswing, and models superseded at the same price or less are left out.

Phase 1 and A6 are done. Each fix was checked in the running app. Generating every layer now finishes with every layer marked ready. Typing a new river name creates one undo step and marks nothing stale. A polity brush stroke assigns ownership as one undo step. The + button keeps the centre hex fixed. The model picker shows only the effort levels the chosen model accepts. The test suite grew from 144 to 164 tests.

Phase 2 is done.
- **Generate buttons:** every layer has a Generate or Regenerate button at the top of the inspector, and a stale layer can be regenerated from its warning.
- **Empty map:** an empty map shows a first-step card on the map itself, which also shows progress while Base Geography generates.
- **Layer list:** each row has an eye button for visibility and a labelled batch checkbox, and the list says which layers are still to generate, with one button to generate them.
- **Inspector order:** generate, then edit by hand, then edit with an instruction, then notes and reasoning.
- **Panning:** Space-drag, two-finger drag and pinch now pan and zoom, alongside the old right-drag and Alt-drag.
- **Phone layout:** the map comes first.
- **Disabled buttons:** a disabled primary button now looks disabled.

The owner also asked for three river changes, now done.
- **Joining:** sections of river can be consolidated into one river, as one undo step. Ends that don't touch are bridged by a straight run of land.
- **Length:** each river's length is calculated from the hex size and shown in the list, on the selected river's card (with and without its branches), in the hover readout and, optionally, in the exported legend.
- **Simpler editing:** select and move are now one tool. Each tool's hint sits next to the controls. The selected river gets one card with all of its actions, including reversing its flow. The list nests branches under their parent rivers. Drawing works from the keyboard: Enter finishes, Backspace takes back a whole click, Esc cancels. River errors appear in the river panel, not the far sidebar.

## Plan

Each phase can ship on its own as one PR, with tests added to the existing `test/*.test.ts` suite (`npm test` runs them with `tsx --test`).

### Phase 0: hands-on baseline (done; results above)

Install dependencies, run `HEXMAP_MOCK=1 npm run dev`, and drive the app with Playwright (Chromium at `/opt/pw-browsers`) through: create map → generate base → generate remaining layers → rename a river/city/polity → brush polities → zoom buttons → load a save of a different size → narrow viewport. Capture screenshots to confirm A1–A4, B1–B5 and catch anything a static read missed. Run `npm test` and `npm run typecheck` to record the baseline.

### Phase 1: fix defects that corrupt or no-op (A1–A5, E1) — done

Commit-on-blur fields: generalise `RangeNameInput` into a reusable `CommitInput` (text and number variants) in `src/components/CommitInput.tsx`, committing on blur or Enter and reverting on Escape, and use it for polity name/short name, city name/population and river name. For colour inputs, commit on the native `change` event rather than React's `onChange` (React maps `onChange` to `input`); use a ref-attached listener or keep a local draft committed on blur. Add a reducer-level guard so `upsertPolity`/`upsertCity`/`updateRiver` with data identical to the current state is a no-op (no snapshot, no version bump). Further, a pure rename should arguably not mark downstream layers stale; decide whether name-only edits bump the version (recommendation: they should not, since no downstream layer's validity depends on a name — implement via a `commitCosmetic` path that snapshots for undo but leaves `version` unchanged).

Polity brush: extend `onStrokeEnd` in `App.tsx` to dispatch `setPolityOwner` with the PolityEditor's target when `activeLayer === 'polities'`. This needs the target polity lifted out of PolityEditor's local state into App (alongside `brush`), e.g. store it as `brush.polities`.

Zoom: make the +/− buttons zoom about the viewport centre using the same formula as `onWheel`; extract a `zoomAt(view, factor, px, py)` helper in `MapView.tsx`.

Refit: reset `fitted` (or call `fit()`) when `map.id`/`cols`/`rows` change. Check whether `MapState` has a stable id; if not, key `MapView` on `${cols}x${rows}-${createdAt}` in `App.tsx`.

Saves error: use `notice error`.

Tests: reducer tests that a no-op upsert does not change `past.length`/`version`; that a rename does not mark downstream layers stale (if adopted); a `zoomAt` unit test.

### Phase 2: make the core path obvious (B1–B5, C9, E2, E3) — done

Per-layer Generate: add a primary "Generate {layer}" button at the top of the inspector for every layer that is unlocked and empty, and "Regenerate" (with a confirm, since it replaces data) when it has data. For polities/rivers this button runs "both passes", with the existing pass selector folded beneath it as an advanced option. Reuse `runGeneration` / `onGeneratePass` (`App.tsx:146`, `Inspector.tsx:174–211`). Stale layers get a "Regenerate to bring in line" button inside the stale notice.

Layer rows: replace the visibility checkbox with an eye toggle button (`aria-pressed`, label "Show/Hide {layer}"); keep the batch-selection checkbox but label the batch area ("Select layers to generate or edit together") and show the checkboxes only when the user enters batch mode, or keep them visible with a column header. Recommendation: keep them always visible with a small header row ("show · batch · layer · status") — lower risk than a mode.

Empty-state guidance: when base is empty, overlay a centred card on the map ("Start by generating Base Geography" + button + "or paste a reply from a chat window" link to webchat). When base exists but other planned layers are empty, show a compact "Next: Elevation, Climate…" hint in the sidebar with a "generate all remaining" action that pre-ticks them and calls `generateSelected`.

Fix the contradictory instruction hint (B4) by rewriting it to name the buttons explicitly. Move the polity hex-size hint (C9) next to the polity area figures in the legend.

Touch and pan: plain drag on empty map space pans when no editing tool needs a drag (i.e. not brush mode, not river tools), and selection becomes click/shift-click plus a "box/sweep select" mode — or, lower-risk alternative, keep drag-to-select and add Space-drag pan plus two-pointer pan/pinch-zoom via tracked `pointerdown` events. Recommendation: the lower-risk alternative, since drag-sweep selection is a documented feature; add a HUD line explaining Space/right-drag.

### Phase 3: workflow friction (C1–C8, C10)

Errors: render errors as a dismissible toast/banner anchored above the map (top of `.mapwrap`), and tool-specific errors (river move/extend, city on water) inline in the relevant inspector panel. Keep generation errors also listed against the layer row.

Keyboard: global handler in `App.tsx` for Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z / Ctrl+Y (undo/redo the active layer, ignored when focus is in a text field), Escape (cancel river draft, else clear selection), Enter (finish river draft). A shared `Modal` component (`src/components/Modal.tsx`) providing backdrop, Escape-to-close, initial focus, focus trap, `role="dialog"` and `aria-labelledby`; migrate Settings, Saves, Plan, DecisionLog, Webchat and Unlock dialogs to it.

Cross-layer undo: after a multi-layer rewrite or multi-layer webchat import, show a toast listing the changed layers with "Undo all" that dispatches `undo` for each in reverse order. No change to the per-layer model.

Destructive actions: confirm "clear" (with the layer name); "new map" dialog offering "Save to browser", "Export JSON" or "Discard" before clearing the autosave.

Editable map name: make the topbar title click-to-edit using `CommitInput`, dispatching `setMeta { name }`.

File menu: consolidate new map, saves, import JSON, export JSON (with an "include undo history" checkbox), export image (opens the existing ExportPanel as a dialog), and export decisions Markdown into a single "File" menu in the topbar; keep Settings and Decisions as top-level buttons. This frees the left sidebar for layers, progress and the description.

Select by value: in PerHexEditor and PolityEditor add "select all hexes with this value / of this polity" and in the hover HUD's hex add nothing; add Ctrl/Cmd+A (select all in-bounds hexes) when the map has focus.

Generation feedback: show elapsed time in the progress row; on completion keep `usage`/`elapsedMs` from `GenerateResult` on the journal entry (add optional `usage` to `JournalEntry` in `shared/types.ts`) and show it in the DecisionLog entry and a brief completion toast.

Display/export toggles: initialise ExportPanel label toggles from current prefs whenever prefs change unless the user has touched them (track a "dirty" flag), or drop the duplicate toggles and use a single "same as screen" default with overrides.

### Phase 4: polish and maintainability (D1–D4; A6 done early)

Refactor: split `Inspector.tsx` editors into `src/components/editors/{PerHex,Polity,City,River,MountainRange}Editor.tsx`; extract generation orchestration from `App.tsx` into `src/state/useGeneration.ts`. Do this after phases 1–3 land, not before, so behavioural fixes are reviewable on their own.

Styling: add `.check-inline` and a shared `Check` component; raise tiny-button hit targets to at least 28px on coarse pointers via `@media (pointer: coarse)`; consider a light theme via `prefers-color-scheme` (low priority — map colours are tuned for the dark canvas background).

Inspector legend: add an "only values on this map" toggle reusing the logic in `src/render/legend.ts`.

## Critical files

`src/App.tsx` (stroke handling, errors, keyboard, topbar), `src/components/Inspector.tsx` (fields, generate button, hints), `src/components/MapView.tsx` (zoom, fit, pan/touch, empty state), `src/components/LayerPipeline.tsx` (row controls, next-step hint), `src/state/store.ts` (no-op guard, cosmetic commits), `src/components/SavesDialog.tsx`, `src/components/ExportPanel.tsx`, `src/components/SettingsDialog.tsx`, `src/styles.css`, `shared/types.ts` (journal usage), plus new `src/components/CommitInput.tsx` and `src/components/Modal.tsx`.

Existing pieces to reuse: `RangeNameInput` (commit-on-blur pattern), `runGeneration` / `generateSelected` / `nextGenerationWave` (generation), `planMultiLayerEdit` (multi-layer summaries), the `onWheel` zoom formula, `legendLayers`/only-used logic in `src/render/legend.ts`, `Check` in `ExportPanel.tsx`.

## Verification

For each phase: `npm run typecheck`, `npm test` (adding reducer and helper tests as listed), `npm run build`. Then a Playwright script against `HEXMAP_MOCK=1 npm run dev` that walks the phase-0 scenario and asserts: renaming a river by typing produces exactly one undo entry and no new stale badges; a polity brush stroke changes ownership; + / − keep the centre hex under the viewport centre; loading a differently sized save fits it on screen; a fresh map shows a Generate Base Geography button that works; Escape closes each modal; Ctrl+Z undoes the active layer. Capture before/after screenshots at 1440×900 and 390×844 for the interface changes.
