# Simplification: next steps

Written 27 October 2026 on `ccr-66ffcf46-juu8y2` (PR #160), from the performance work recorded in
DECISIONS §70–75. It proposes simplifications; none has been done. The figures below were measured
on that branch and only explain the order. Each step is a direct change and needs no further
investigation before it starts.

## Ground rules

A simplification must not change behaviour.

- **Tests and checks:** the Node suite, `npm run typecheck`, `npm run build` and
  `npm run test:drawing-pixels` pass unchanged.
- **Pictures:** rendered output is byte-identical, unless a change is deliberately accepted under the
  "no visible change" criterion of §73 with before/after images.
- **Exactness:** keep the exactness rules in DECISIONS: finished coastline as the single land/water
  boundary, exact cached/uncached reconstruction, unchanged thresholds.
- **Size:** prefer deleting or merging over adding layers. Do one area per PR so each can be reviewed
  and reverted on its own.

Two facts from §72 matter for any test touching pixels:

- **Clipping changes antialiasing.** Chromium's 2D raster gives slightly different antialiasing under
  a different clip, even a single rectangle.
- **First draws differ.** A path's first draw differs by ±1–2 levels from later draws of the same
  `Path2D`.

So never require byte equality between paints made with different clip set-ups or different path
histories.

## 1. Scripts (`scripts/`): one harness, fewer one-off studies

There are 54 files (about 3,600 lines). About 20 of them launch Chromium, and about 16 bundle code with
esbuild, each repeating the same boilerplate:

- bundling an entry;
- serving it through `serveBuild`;
- launching the browser;
- a promise wrapper around worker messages;
- median and p95 summaries.

26 scripts are referenced only from docs or not at all. Examples:

- `coast-fit-performance.mjs`;
- `selection-tools-validation.mjs`;
- `render-browser-performance.mjs`;
- `render-all-layers-performance.mjs`;
- `render-navigation-*`.

Steps:

1. **Extract shared helpers** into `scripts/browser-runtime.mjs` (or a sibling module):
   - `bundlePage(exports)` for a stdin bundle of named exports;
   - `workerClient(url)` for build, paint and next-message calls;
   - `pairedRuns(variants, rounds)`, which alternates variants and reports the median and p95;
   - `pixelDiff(a, b)`, giving changed count, max and histogram.

   The temporary scripts written during PR #160 all re-implemented these.
2. **Allow `executablePath` without flags.** `launchBrowser` needs `--chromium` to find a preinstalled
   browser. Let it read an environment variable (for example `CHROMIUM_PATH`) so managed environments
   with `/opt/pw-browsers/chromium` work by default. This is also step 6 of `docs/test-next-steps.md`;
   do it once, in whichever lands first.
3. **Fold the latency studies into one CLI with named scenarios.** `render-interaction-study.mjs`
   (edit-paced, pan-after-edit) and `render-worker-study.mjs` (cold, warm, ownership) both drive the
   production worker. Merge them, keeping the user-facing measures (time to sharp frame, queue wait)
   as the primary output.
4. **Retire finished studies.** For each script referenced only from a dated doc, either delete it
   (its results are already recorded) or move it to `scripts/archive/` with a one-line note of the
   doc that cites it. Do not keep two live scripts measuring the same thing.

## 2. Documentation (`docs/`, `DECISIONS.md`)

Done after PR #160. `docs/` went from 29 MB to about 120 KB. The superseded plans, investigation
narratives, raw result files and images were deleted. They remain in Git at `8bf42c7`. What is left:

- **Current state and plans:** `drawing-status.md`, `drawing-work-plan.md`,
  `automatic-coasts-next-steps.md`, this document and `test-next-steps.md`.
- **Interface:** `REVIEW-AND-PLAN.md` (phase 4 open) and `UX-BASELINE.md`.

Two things remain:

- **Mark superseded decisions.** `DECISIONS.md` is over 1,500 lines, in chronological order, and some
  entries are superseded. For example, §70 replaces the earlier policy that held a sharp frame's job
  until its overview was done. Add "Superseded by §N" to the first line of each superseded entry.
- **Keep raw records out of git.** Studies write raw records to `work/` (not committed). Record
  conclusions in DECISIONS, not as new files in `docs/`.

## 3. Tests (`test/`)

Moved to `docs/test-next-steps.md`, a self-contained brief for an agent working on tests alone. It
covers running the Node suite in CI (no workflow does today), a fast tier, a shared equality helper,
role tags in place of colour and structure queries, and clearer sweep failures.

## 4. Render code

**4.1 The scene builder.** `src/render/scene.ts` is 3,510 lines. `buildStaticSceneInner` alone is
about 2,430 lines: one function with phases (`coast`, `landAndFills`, `symbols`, `borders`, `rivers`,
`featureLabels`, `polityLabels`, `cities`) sharing dozens of local closures.

Extract each phase into its own module, taking an explicit input record and returning prims plus
metadata. Two benefits:

- **Visible dependencies.** Today they are captured implicitly. For example, the band, ground and lake
  arrays feed both border painting and keys.
- **Smaller cache keys.** Each phase's cache key can be its input record, instead of a hand-assembled
  JSON array. Several current keys stringify very large inputs: the river-label family key holds every
  obstacle, course and width profile.

**4.2 Caches.** There are 11 `BoundedMemo` instances across `scene.ts`, `coast.ts`,
`placementCache.ts`, `featureLabels.ts` and `islandDrawingCache.ts`, plus many `WeakMap`s.
`prepareSceneCacheScope` clears them through a hand-maintained list (PR #160 had to add two
entries).

Replace this with a small registry. Each cache registers its name, its budget and its profile
counters, so that:

- one `clearAll()` and one budget report cover everything;
- `cache: 'off'` is enforced in one place;
- a new cache cannot be forgotten in the reset.

**4.3 Compositing in the painter** (`canvas.ts`). A clipped group goes through a composited layer when
it has 200 or more children or is marked `composite`. Measurements (§74, §75):

- **Large-area clipped groups:** the layer is essential. For the 8,583-child land group it costs
  15 ms against 151 ms clipped directly.
- **Border groups:** the layer is harmful, making them slower in every arrangement tried.

The child count is only a proxy, and it applies to every clipped group the painter meets. Move the
decision into the scene builder and drop the child-count rule from `canvas.ts`:
- **Fill groups:** where the builder creates the large coastline-clipped land and fill groups (the
  `drawnCoastLand()` groups wrapping `ground`, `rimLand` and the per-hex fills), set
  `composite: children.length >= 200`. This is the same rule, applied only where it matters, so
  output is unchanged.
- **Rivers:** keep `composite: true` on the rivers group, as today.
- **Everything else:** no flag, including the border groups' land clip (`onLand`) and the glacier
  group. They have fewer than 200 children, so they don't composite today either.

Done like this, the change paints exactly what is painted today. A later change can then tune
compositing per group deliberately, instead of through a count that silently changes cost whenever it
crosses 200.

**4.4 Glyph drawing** (`canvas.ts`). Glyph-by-glyph text builds a new prim object, by spread, for every
glyph and pass, then re-parses the CSS font for each one. Draw glyphs in a loop that sets the font
once per prim. This is behaviour-neutral, and the code gets shorter.

**4.5 Retiring the Classic preset.** This is already planned in `docs/drawing-work-plan.md`. It is
still the fallback in `styles.ts` (`PRESET_ORDER`, default choice, resolver fallbacks, legacy
normalisation). The owner does not need Classic's look preserved. So retire it outright: make the
default preset the fallback, and have legacy normalisation map saved Classic choices to that default.
Then delete Classic's code paths, its tests, and its cases in the drawing sweeps.

## Suggested order

| Order | Area | Reason |
|---|---|---|
| 1 | `docs/test-next-steps.md` (separate agent) | CI coverage and cycle time for every later step; independent of the rest |
| 2 | §1 steps 1–2 (shared harness) | Every remaining performance or pixel investigation reuses it |
| 3 | §4.3, then §4.2 | Small, contained changes to code that recent work touched |
| 4 | §2 | Mark superseded decisions |
| 5 | §4.1 | The scene-builder split, in phase-sized PRs, each with cached/uncached equality and the pixel checks |

Done means: the ground-rule checks pass unchanged, and each step's PR states which of those checks
guard it.
