# Simplification: next steps

Written after PR #160, from the work recorded in DECISIONS §70–75. Each step is a direct change and
needs no further investigation before it starts. The figures only explain the order.

## Ground rules

A simplification must not change behaviour.

- **Tests and checks:** the Node suite, `npm run typecheck`, `npm run build` and
  `npm run test:drawing-pixels` pass unchanged.
- **Pictures:** no visible change, shown with before/after images (§73). Byte identity is a
  convenient check where it holds, but the owner does not require it.
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

## 1. Scripts (`scripts/`): one harness

Only the 21 scripts that `package.json`, CI, tests or the drawing plan reach remain; one-off studies
were deleted (they are in Git at `8bf42c7`). The browser scripts still repeat the same boilerplate:
bundling an entry, serving it through `serveBuild`, launching the browser, wrapping worker messages
in promises, and summarising medians and p95s.

1. **Extract shared helpers** into `scripts/browser-runtime.mjs`:
   - `bundlePage(exports)` for a stdin bundle of named exports;
   - `workerClient(url)` for build, paint and next-message calls;
   - `pairedRuns(variants, rounds)`, which alternates variants and reports the median and p95;
   - `pixelDiff(a, b)`, giving changed count, max and histogram.
2. **Allow `executablePath` without flags.** `launchBrowser` needs `--chromium` to find a preinstalled
   browser. Let it read an environment variable (for example `CHROMIUM_PATH`) so managed environments
   with `/opt/pw-browsers/chromium` work by default. This is also step 6 of `docs/test-next-steps.md`;
   do it once, in whichever lands first.
3. **No new one-off scripts in the tree.** A study that is not a `package.json` command or a CI check
   lives under `work/` (not committed); its conclusion goes in DECISIONS.

## 2. Documentation

Done. `docs/` holds only open work: the drawing, test, simplification, interface and
automatic-coasts plans. Superseded plans, investigation narratives, raw results and images were
deleted, and process-only DECISIONS entries were removed; all of it is in Git at `8bf42c7`. Keep it
that way: update the relevant plan or DECISIONS entry instead of adding a new document, and delete a
plan's steps once they are done.

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
Then delete Classic's code paths, its tests, and its cases in the drawing sweeps. The step-by-step brief is `docs/test-next-steps.md` step 7.

## Suggested order

| Order | Area | Reason |
|---|---|---|
| 1 | `docs/test-next-steps.md` (separate agent) | CI coverage and cycle time for every later step; independent of the rest |
| 2 | §1 steps 1–2 (shared harness) | Every remaining performance or pixel investigation reuses it |
| 3 | §4.3, then §4.2 | Small, contained changes to code that recent work touched |
| 4 | §4.4, §4.5 | Glyph loop; Classic retirement (with test step 7) |
| 5 | §4.1 | The scene-builder split, in phase-sized PRs, each with cached/uncached equality and the pixel checks |

Done means: the ground-rule checks pass unchanged, and each step's PR states which of those checks
guard it.
