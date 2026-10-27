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
- `render-parts34-summary.mjs`;
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
   with `/opt/pw-browsers/chromium` work by default.
3. **Fold the latency studies into one CLI with named scenarios.** `render-interaction-study.mjs`
   (edit-paced, pan-after-edit) and `render-worker-study.mjs` (cold, warm, ownership) both drive the
   production worker. Merge them, keeping the user-facing measures (time to sharp frame, queue wait)
   as the primary output.
4. **Retire finished studies.** For each script referenced only from a dated doc, either delete it
   (its results are already recorded) or move it to `scripts/archive/` with a one-line note of the
   doc that cites it. Do not keep two live scripts measuring the same thing.

## 2. Documentation (`docs/`, `DECISIONS.md`): current state versus history

What `docs/` holds:

| What | Size |
|---|---|
| All of `docs/` | 29 MB |
| 34 JSON/`.gz` raw-record files | 7.2 MB |
| PNGs | 21 MB |
| Markdown documents | 22 |

Several of the Markdown documents are overlapping plans for the same topic:
- `render-performance.md`, `render-performance-plan.md` and `render-performance-implementation.md`;
- `render-optimization-implementation-plan.md` and `render-optimization-parts-{1-2,3-4}.md`;
- `coast-performance-plan.md`;
- `drawing-status.md` and `drawing-work-plan.md`.

`DECISIONS.md` is over 1,500 lines, in chronological order, and some entries are superseded. For
example, §70 replaces the earlier policy that held a sharp frame's job until its overview was done.

Steps:

1. **Write one current-state document per area** (rendering performance, coast geometry, drawing
   correctness): what is true now, which checks guard it, and the open problems. Link to the dated
   documents as history rather than merging them.
2. **Move raw records out of git:** the `*-results.json`, `*.json.gz` and evidence PNGs that no current
   doc depends on. Use release assets or a separate artifact branch, and keep a manifest with
   checksums in `docs/`.
3. **Annotate superseded decisions.** Mark each superseded DECISIONS entry with
   "Superseded by §N" on its first line. Optionally split the file into an index of current
   decisions plus the history.

## 3. Tests (`test/`): a fast tier, and fewer structure-coupled assertions

There are 71 files (about 10,500 lines). Time is concentrated in a few places (measured per file):

| File | Time | Where it goes |
|---|---:|---|
| `lakeStraitRendering.test.ts` | 71 s | sixteen "representative lake strait" cases at 1.8–4.2 s each, and one continuity check at 6.1 s |
| `incrementalRender.test.ts` | 19 s | 17.5 s in one test: rebuilds after merges, splits, settings… equal uncached rebuilds |
| `riverLabelReuse.test.ts` (added in PR #160) | 14 s | 11.2 s in the scene-level ownership test on a 24×24 fixture |

Coupling to scene structure:

- **14 test files** find prims by kind, colour or nesting. For example, `mapStyle.test.ts`
  (1,762 lines, 75 tests) found the realm band by its `rgba(170, 51, 51, …)` stroke. §73 broke that
  without any change in behaviour, and the test was rewritten to find the band by stroke width.
- **126 calls** build a scene directly, and the "cached build equals uncached build" comparison is
  hand-written in several files.

Steps:

1. **Split a fast tier.** Keep one representative case per lake-strait width in the Node suite. Move
   the full parameter sweep into the existing browser sweep (`npm run test:drawing-sweeps`), or behind
   an opt-in tag that CI runs separately. Do the same for the long incremental test: one case per kind
   of edit in the fast tier, and the full chain behind the tag.
2. **Shrink the slow test from PR #160.** In `riverLabelReuse.test.ts`, the scene-level test can use a
   12×12 fixture with two rivers and keep its assertions. The random-obstacle test already covers the
   exactness of the reuse.
3. **Share the cached-versus-uncached pattern.** Add one helper, for example
   `assertRebuildsMatchUncached(map, options, edits)`, and use it wherever that comparison is written
   by hand.
4. **Query by meaning, not appearance.**
   - **Tag prims by role:** tests that need a specific layer (realm band, river clip group, coast fill)
     should find it through a stable role tag on the prim, like the existing `LabelTag` for lettering.
     Matching colours or nesting depth breaks whenever paint is optimized.
   - **Check results geometrically:** where a test checks a picture property, prefer a land or water
     predicate, or a coverage measurement, over the presence of a particular prim.

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
normalisation). Retiring it deletes code paths and their tests, once saved maps with explicit Classic
choices have a migration.

## Suggested order

| Order | Area | Reason |
|---|---|---|
| 1 | §3 steps 1–2 (fast test tier) | Cheapest, and immediately reduces every later agent's cycle time |
| 2 | §1 steps 1–2 (shared harness) | Every remaining performance or pixel investigation reuses it |
| 3 | §4.3, then §4.2 | Small, contained changes to code that recent work touched |
| 4 | §2 | Documentation consolidation, so agents read one current state |
| 5 | §4.1 | The scene-builder split, in phase-sized PRs, each with cached/uncached equality and the pixel checks |

Done means: the ground-rule checks pass unchanged, and each step's PR states which of those checks
guard it.
