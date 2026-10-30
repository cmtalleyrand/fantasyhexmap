# Tests: next steps

Written after PR #160. It is a self-contained brief for an agent
working on tests alone. Each step is a direct change and needs no further investigation before it
starts. The rest of the simplification plan (scripts, docs, render code) is in
`docs/simplification-next-steps.md`.

## Ground rules

- **No weaker checks.** Never loosen a threshold, skip a test, or delete an assertion to get green.
- **Move, don't lose.** A case moved out of the fast tier still runs in CI.
- **Same verdicts.** After each step the Node suite (`npm test`), `npm run typecheck`, `npm run build`,
  `npm run test:drawing-pixels` and `npm run test:drawing-sweeps` give the same verdicts as before.
  The sweep is red today for a known reason; see "Known red check" below.
- **Pixel comparisons need matching paints.** Chromium's 2D raster changes antialiasing under a
  different clip, and a `Path2D`'s first draw differs by ±1–2 levels from later draws (DECISIONS §72).
  Never require byte equality between paints with different clip set-ups or path histories.
- **Small PRs.** One step per PR, stating which checks guard it.

## What exists

The test tiers:

| Tier | Command | Runs in CI |
|---|---|---|
| Node suite, fast tier: 574 tests, about 52 s on 4 cores | `npm test` (`test/*.test.ts`) | Yes (`deploy.yml`) |
| Node suite, slow tier: 13 tests, about 37 s | `npm run test:slow` (`test/slow/*.test.ts`) | Yes (`deploy.yml`) |
| Browser pixel checks, including the 400-river sweep | `npm run test:drawing-pixels` | Yes (`drawing-tests.yml`) |
| Browser sweeps: 200 islands, 600 enclosed seas, 150 area cases | `npm run test:drawing-sweeps` | Yes (`drawing-tests.yml`) |
| Typecheck and build | `npm run typecheck`, `npm run build` | Yes (`deploy.yml`) |

The slowest Node files before the split (steps 2 and 3), measured per file:

| File | Time | Where it goes |
|---|---:|---|
| `lakeStraitRendering.test.ts` | 71 s | sixteen "representative lake strait" cases at 1.8–4.2 s each, and one continuity check at 6.1 s |
| `incrementalRender.test.ts` | 19 s | 17.5 s in one test: rebuilds after merges, splits, settings… equal uncached rebuilds |
| `riverLabelReuse.test.ts` (added in PR #160) | 14 s | 11.2 s in the scene-level ownership test on a 24×24 fixture |

How tests are coupled to the scene's structure:

- **Finding prims by appearance.** 14 test files find prims by kind, colour or nesting. For example,
  `mapStyle.test.ts` (1,762 lines, 75 tests) found the realm band by its `rgba(170, 51, 51, …)`
  stroke. §73 broke that without any change in behaviour, and the test was rewritten to find the band
  by stroke width.
- **Building scenes by hand.** 126 calls build a scene directly. The "cached build equals uncached
  build" comparison is hand-written in several files.

## Steps

### 1. Run the Node suite in CI — done

Done in PR #166. Before it, no workflow ran `npm test`. The 562 Node tests, including every cached-versus-uncached equality
test and the coast distortion test, only run when someone runs them locally.

Add an `npm test` step to the `build` job in `deploy.yml`, after typecheck, or add a separate job.
Do this first: every later step relies on CI to catch a moved or broken test.

### 2. Split a fast tier — done

`npm test` went from 82 s to 52 s wall time on 4 cores. The lake strait file keeps cases 4, 8, 12 and
14 (one per width, each also setting a junction side, land share or roughness); the other twelve run in
`test/slow/lakeStraitCases.test.ts`. `incrementalRender.test.ts` keeps every kind of edit on the Ragged
coast galleries; `test/slow/incrementalChain.test.ts` replays the whole chain, Fractured included.
The original brief:

- **Lake straits.** Keep one representative case per strait width in the default `npm test`. Move
  the full parameter set behind an opt-in tier. Either use a separate glob, such as
  `test/slow/*.test.ts` with an `npm run test:slow` script, or an environment flag that the slow
  cases check. CI runs both tiers.
- **Incremental rebuilds.** In `incrementalRender.test.ts`, keep one case per kind of edit (merge,
  split, settings, …) in the fast tier, and move the full chain of edits to the slow tier.
- **Report the gain.** State the before/after wall time of `npm test` in the PR.

### 3. Shrink the slow test from PR #160 — done

It uses a 12×12 fixture with two named rivers and six ownership edits (the first four reach both
rivers on so small a map, so none would be reused), 11.6 s down to about 2.5 s. The original brief:

In `riverLabelReuse.test.ts`, the scene-level test can use a 12×12 fixture with two rivers and keep its
assertions. The random-obstacle test in the same file already covers the exactness of the reuse.

### 4. One helper for cached-versus-uncached equality — done

`assertRebuildMatchesUncached(map, options, edit, cachedScene?)` in `test/helpers/scene.ts` replaces
the separate batch helper and the repeated comparisons in incremental rendering, shared paths,
shared shorelines and river-label reuse. Both fast and slow incremental chains use it. It accepts an
already profiled scene so cache-counter checks do not trigger an extra cached build, compares the
whole scene, and names the edit and first differing scene path when it fails.

The lake-strait tests also drop the duplicate Narrow/Normal width test and four repeated connectivity
checks. Their exact fixtures remain in the representative matrix across the fast and slow tiers.
The undo check reuses its restored scene instead of rebuilding it twice.

### 5. Query by meaning, not appearance

- **Role tags.** Add a stable role tag on prims that tests need to find: realm band, river clip
  group, coast fill, lake band, glacier group. Use the existing `LabelTag` on lettering as the
  pattern. Rewrite the 14 structure-coupled files to find prims through it, so that paint
  optimisations stop breaking tests.
- **Geometric checks.** Where a test checks a property of the picture, prefer a land/water predicate
  or a coverage measurement over the presence of a particular prim.

### 6. Make the browser sweeps report what failed — done

`--check` prints every coverage case over the tolerance, every island and enclosed-sea failure, and
throws naming the failed groups (`Drawing sweep failed: coverage`). `launchBrowser` also reads
`CHROMIUM_PATH`. The original brief:

- **List each failing case.** `scripts/drawing-investigation-extended.mjs --check` prints only a
  per-preset summary (median, maximum, worst case) and one generic error. Print every case over the
  land-share tolerance (preset, seed, share, drawn %) before throwing, and name the failed group
  (islands, enclosed seas, coverage) in the error.
- **Find the browser without a flag.** `scripts/browser-runtime.mjs` (`launchBrowser`) finds a
  preinstalled Chromium only with `--chromium <path>`. Also read an environment variable such as
  `CHROMIUM_PATH`, so managed environments with `/opt/pw-browsers/chromium` work without flags.

### 7. Retire the Classic preset, with its tests and sweep cases

The owner wants Classic retired outright; its look need not be preserved. Parchment
(`NEW_USER_STYLE_CHOICE`) becomes the only fallback. One PR, in this order:

1. **Fallbacks in `src/render/styles.ts`.** Remove `'classic'` from `StylePresetId`, the `CLASSIC`
   preset object, `PRESETS.classic` and `PRESET_ORDER`. Set `DEFAULT_STYLE_CHOICE` to
   `{ preset: 'parchment', overrides: {} }` (it can then be merged with `NEW_USER_STYLE_CHOICE`).
   `resolveStyle` and `parseStyleChoice` fall back to Parchment instead of Classic. Rename
   `CLASSIC_STYLE` to `DEFAULT_STYLE` at its uses (`scene.ts`, `export.ts`, `legend.ts`).
2. **Saved maps and prefs.** `parseStyleChoice` already maps an unknown preset to the fallback, so a
   saved `preset: 'classic'` loads as Parchment, keeping its overrides. `src/api/settings.ts` (the
   version 4 migration) writes `preset: 'classic'`; make it write the default preset. Keep, or add,
   one test: a saved Classic choice with an override loads as Parchment with that override.
3. **Sweeps.** In `scripts/drawing-investigation-extended.mjs`, drop `'classic'` from the `--preset`
   check and from both loops (coverage and enclosed seas). In `scripts/drawing-investigation-fixtures.ts`,
   drop `'classic'` from `options()` and change the `['classic', 20, 'coverage-1']` case to another
   preset. Seed names stay, so the known red cases keep their names.
4. **Tests.** About 25 tests name Classic (`grep -rni classic test`): most in `mapStyle.test.ts`, with
   others in `scenePainter`, `sceneBuilder`, `mapPresentation`, `riverSinuosity`, `drawingInvestigation`,
   `citySites`, `baseGeography` and `incrementalRender`. Delete tests that exist only to check Classic's
   look; point the rest at Parchment.
5. **The style-less default.** Many tests call `buildScene` without a `style`, so they draw Classic
   today and will draw Parchment. Run `npm test` and fix only what the change of default breaks. A
   failure that checks a Classic-only colour or stroke is deleted, not rewritten.

**Not part of this step.** The word "classic" also names three knob values that other presets offer
as options: `rivers: 'classic'` (untapered "Even strokes" rivers), `lettering: 'classic'` (Palatino) and
`cityMarkers: 'classic'` ("Dots and rings"). Retiring the preset leaves them in place. Removing any
of them is a separate decision for the owner, with its own saved-value migration. Note it in the PR;
do not do it.

**Checks.** `npm test`, `npm run test:slow`, `npm run typecheck`, `npm run build`,
`npm run test:drawing-pixels`, `npm run test:drawing-sweeps`. The sweeps must give the same verdict:
only the known `coverage-2` and `coverage-8` cases over tolerance (under Parchment and Atlas).

### 8. Delete tests that do not earn their place — first pass done

A test stays only if it fails when the app does something wrong that a user or a saved map would
notice. Done: `landBySide` and `pressIcon` (no callers), with their tests, and the helpers only
`pressIcon` used; `sceneHelpers.test.ts`; the "Opus 4.8" row test in `models.test.ts`; the river
prompt wording test, and wording and constant checks in `promptAlignment.test.ts`. That is 211 lines,
5 tests (572 to 567) and 3 dead functions.

Left for later, since each needs reading through a large file test by test:

- **Prompt wording elsewhere.** `layerResponseHandling.test.ts` and `webchatStyles.test.ts` have
  `assert.match` checks on text; keep the ones that check a value arrives, drop wording.
- **`mapStyle.test.ts`.** 76 tests in 1,800 lines, mostly rivers, overlapping `riverEditing`,
  `riverJoinLength` and `riverSinuosity`. Move what is unique to those files and delete the overlap.
  Do this after step 7, which deletes many of its Classic tests.
- **`hexShapes.test.ts`.** 44 tests in 1,000 lines; not yet reviewed.

## A red suite on main, and how it was fixed

After PR #166 put the Node suite in CI, `main` failed 7 tests. The cause was not in the tests: the
river navigability commit (8ce06a5) had been written on copies of `featureLabels.ts`, `scene.ts`
and `rivers.ts` from 34e4498, and so undid the later work in them (per-river name reuse, the opaque
see-through realm band, composited rivers, shared paths, realm areas, the city-bow tolerance). That
work was re-applied onto the navigability changes. Four tests were updated, at their old tolerances,
to that commit's deliberate changes: river widths by navigability (−15% / +15%), fills by
navigability, and a middle hex dragged onto a lake. A change written on a stale copy of a file is
now caught by CI; check `git diff <its base> <its result>` for unrelated deletions before merging.

## Suggested order

| Order | Step | Reason |
|---|---|---|
| 1 | 1 (Node suite in CI) | Done |
| 2 | 2, 3 (fast tier) | Done |
| 3 | 6 (sweep reporting) | Done |
| 4 | 8, first pass | Done |
| 5 | 7 (retire Classic) | The owner wants it; deletes many tests before the rewrites |
| 6 | 8, rest (`mapStyle.test.ts` and prompt-wording files) | Smaller after step 7 |
| 7 | 4 (equality helper) | Done |
| 8 | 5 (role tags) | The largest step; fewer files once 7 and 8 are done |
