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
| Node suite: 71 files, about 10,500 lines, 562 tests | `npm test` (`tsx --test test/*.test.ts`) | No |
| Browser pixel checks, including the 400-river sweep | `npm run test:drawing-pixels` | Yes (`drawing-tests.yml`) |
| Browser sweeps: 200 islands, 600 enclosed seas, 150 area cases | `npm run test:drawing-sweeps` | Yes (`drawing-tests.yml`) |
| Typecheck and build | `npm run typecheck`, `npm run build` | Yes (`deploy.yml`) |

The slowest Node files, measured per file:

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

### 1. Run the Node suite in CI

No workflow runs `npm test`. The 562 Node tests, including every cached-versus-uncached equality
test and the coast distortion test, only run when someone runs them locally.

Add an `npm test` step to the `build` job in `deploy.yml`, after typecheck, or add a separate job.
Do this first: every later step relies on CI to catch a moved or broken test.

### 2. Split a fast tier

- **Lake straits.** Keep one representative case per strait width in the default `npm test`. Move
  the full parameter set behind an opt-in tier. Either use a separate glob, such as
  `test/slow/*.test.ts` with an `npm run test:slow` script, or an environment flag that the slow
  cases check. CI runs both tiers.
- **Incremental rebuilds.** In `incrementalRender.test.ts`, keep one case per kind of edit (merge,
  split, settings, …) in the fast tier, and move the full chain of edits to the slow tier.
- **Report the gain.** State the before/after wall time of `npm test` in the PR.

### 3. Shrink the slow test from PR #160

In `riverLabelReuse.test.ts`, the scene-level test can use a 12×12 fixture with two rivers and keep its
assertions. The random-obstacle test in the same file already covers the exactness of the reuse.

### 4. One helper for cached-versus-uncached equality

Add `assertRebuildsMatchUncached(map, options, edits)` to a shared test helper module. It applies
each edit, builds with caches on, builds the same state with `cache: 'off'`, and compares the two
scenes. Replace the hand-written versions with it. The helper's failure message names the edit and the
first differing prim path.

### 5. Query by meaning, not appearance

- **Role tags.** Add a stable role tag on prims that tests need to find: realm band, river clip
  group, coast fill, lake band, glacier group. Use the existing `LabelTag` on lettering as the
  pattern. Rewrite the 14 structure-coupled files to find prims through it, so that paint
  optimisations stop breaking tests.
- **Geometric checks.** Where a test checks a property of the picture, prefer a land/water predicate
  or a coverage measurement over the presence of a particular prim.

### 6. Make the browser sweeps report what failed

- **List each failing case.** `scripts/drawing-investigation-extended.mjs --check` prints only a
  per-preset summary (median, maximum, worst case) and one generic error. Print every case over the
  land-share tolerance (preset, seed, share, drawn %) before throwing, and name the failed group
  (islands, enclosed seas, coverage) in the error.
- **Find the browser without a flag.** `scripts/browser-runtime.mjs` (`launchBrowser`) finds a
  preinstalled Chromium only with `--chromium <path>`. Also read an environment variable such as
  `CHROMIUM_PATH`, so managed environments with `/opt/pw-browsers/chromium` work without flags.

### 7. Drop Classic's cases when Classic is retired

The owner does not need the Classic preset's look preserved (`docs/simplification-next-steps.md`
§4.5). When it is retired, delete its cases from the sweeps (`['classic','parchment','atlas']` in the
coverage loop) and from the Node tests, together with tests of Classic-only fallbacks. Keep the
legacy-normalisation test, changed to expect saved Classic choices to load as the default preset.

## Known red check

`npm run test:drawing-sweeps` fails on `main` and on PR #160 for one reason. The land-share tolerance
is 5 percentage points. Four coverage cases at a 90% share draw too little land:

- `coverage-8`: 77.3–77.4% under parchment and atlas;
- `coverage-2`: 81.4% under parchment and atlas.

The cause is in coast geometry, not in the tests. A jutting high-share hex starts with too little land.
The coast fit then stops at the cumulative distortion bound from #158, which
`test/coastFitDistortion.test.ts` asserts. `docs/drawing-work-plan.md` §4 sets out the options. Test work must not change
either the 5-point gate or that bound to make the sweep pass.

## Suggested order

| Order | Step | Reason |
|---|---|---|
| 1 | 1 (Node suite in CI) | Without it, nothing below is checked in CI |
| 2 | 2, 3 (fast tier) | Cuts every later cycle |
| 3 | 6 (sweep reporting) | Small; makes the known red check readable |
| 4 | 4 (equality helper) | Removes duplication before the larger rewrite |
| 5 | 5 (role tags) | The largest step; touches 14 files |
| 6 | 7 | Only once Classic is retired |
