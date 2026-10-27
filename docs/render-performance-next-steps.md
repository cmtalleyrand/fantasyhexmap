# Rendering performance: next steps

Written 27 October 2026. PR #160 left three options for cutting what a person waits for; this brief
compares them, gives a pilot measurement for each of the first two, and sets the order of work.

**Status.** Options 1 and 2 are implemented, and option 3 stays rejected. What remains is the last
section, the fit's own cost.
- **Option 1:** DECISIONS §78. The stand-in skips the global share passes as well: keeping them
  delayed the exact picture by 1.5–2 s.
- **Option 2:** DECISIONS §77. It needed a fix to how frontiers meet the coast first.
- **Picture checks:** the scripts now judge pictures by visible change (§76).

The rest of this brief is the plan as written.

## Quality criterion

The owner's criterion is no visible change, not byte identity. Byte equality is a convenient check
where it happens to hold, but it is not required. Chromium's 2D raster already varies between repaints
(DECISIONS §72), so a change that moves single antialiased edge pixels, or moves a coastline by a
small fraction of a pixel, is acceptable when before/after images show no visible difference (§73).
Gates that measure geometry rather than pixels stay as they are: the land-share tolerance of
`test:drawing-sweeps`, `test/coastFitDistortion.test.ts` and cached/uncached scene equality.

## Where the time goes

Pilot: Node, cold build, geography layer only, the 40×40 `populated` fixture
(`scripts/render-profile-input.ts`), one run per variant. The variants were made with temporary hooks,
since reverted:
- the line count at `src/render/coastArea.ts:167`;
- an early return in `cachedCoastFit` (`src/render/scene.ts`);
- a zero pass count on the global-pass loop after `coastPhase('globalPasses')`.

A cold build takes about 8.2 s. The coast fit (`coast.fit`) takes 5.1–5.6 s of it:
- measuring (`fit.measure`, 9 calls, 3,177 hex measurements): 2.3–2.6 s;
- the solver: about 2.8 s (8 rounds, about 887 iterations);
- outside the fit, the global share passes: 1.15 s.

| Variant | Cold build | `fit.measure` | Effect on the coast |
|---|---:|---:|---|
| 128 lines (current) | 8.2 s | 2.3–2.6 s | — |
| 96 lines | 7.7 s | 2.1 s | moves ≤ 0.0044 hex sizes; land shares change ≤ 0.10 points |
| 64 lines | 7.3 s | 1.7 s | moves ≤ 0.0068 hex sizes (≈ 0.18 px at 1×); shares ≤ 0.19 points |
| 32 lines | 6.7 s | 1.3 s | moves ≤ 0.010 hex sizes; shares ≤ 0.43 points |
| No fit, global passes kept | 2.6 s | — | shares off by 3.9 points on average, 19 at most; 17 of 35 hexes over 1 point |
| No fit, no global passes | 1.6 s | — | shares off by 10.5 points on average, 32.6 at most |

At every line count the solver needed the same number of rounds and iterations, so fewer lines did not
add rounds. Measuring cost does not scale with the line count: at 32 lines it is still 1.3 s, so most
of it is per-call setup in `areaCoverage`, not the scanlines.

## Option 1: stand-in picture while the exact coast fits (do first)

Show a picture built without the coast fit, then replace it with the exact picture. On the pilot this
brings the first picture from about 8.2 s to about 2.6 s. The finished picture is the same as today's.

**Steps:**
1. Add a scene option that skips `cachedCoastFit` and the local `fitCoastAreas` call, keeping the
   global share passes. Without the passes the stand-in is about 1 s faster but its shares are about
   three times further off.
2. In `paint.worker.ts`, make a build request produce two replies:
   - build and paint the stand-in, reply with it marked provisional;
   - then build the exact scene and reply as today.

   A newer build abandons the second phase, as a newer scene abandons the overview.
3. In `ScenePainter` and `MapView`, treat provisional metadata as display-only. Its compromises
   ("77% land drawn instead of 90%"), inspector data, picking and exports must wait for the exact
   scene.
4. Use the same stand-in on a preset change. The plan's "previous coastline in the new colours" needs
   the cached fit reused under a different ink width, which is part of the fit's cache key. Treat it
   as a later refinement, if the unfitted stand-in looks too different.

**Known limit:** the worker builds synchronously, so during the exact build (5–6 s on the pilot) it
cannot paint. Pans in that window scale the existing bitmap, as navigation already does with the
overview. Moving the exact build to a second worker would remove that limit, at the cost of
transferring the scene; do not start with it.

**Checks:**
- **Final picture:** no visible change against the current code (`test:drawing-pixels`, before/after
  images). Do not require byte equality here: painting the stand-in first changes `Path2D` histories,
  which §72 shows can move pixels by ±1–2.
- **Scene equality:** cached/uncached scene equality must still hold for the exact scene.
- **Timing:** `npm run perf:opening` (production opening through the app) and the cold build in
  `npm run perf:interaction`. Report time to first picture and time to the exact picture, paired
  against the parent commit.
- **The jump:** before/after images of stand-in against exact on the coast gallery fixtures. This is
  the one real judgement: with the global passes kept, coastlines shift by about 4 points of land
  share on average and up to 19 in a hex.

## Option 2: fewer coverage lines in the coast fit (small, independent)

Replace the literal `128` at `src/render/coastArea.ts:167` with a named constant set to 64, or 96 if
the checks show any visible change at 64. This saves about 0.9 s (64 lines) or 0.5 s (96 lines) of an
8.2 s cold build, about 6–11%, and shortens the exact build behind option 1's stand-in. It does not
affect edits. There is precedent: the land share the scene reports, which the sweep checks, is already
measured at 96 lines (`src/render/scene.ts:829`, `areaCoverage`'s default).

**Checks:**
- `npm run perf:coast` (`scripts/render-coast-validation.mjs`).
- `test:drawing-pixels`, with before/after images reviewed for visible change rather than compared for
  byte equality.
- `test:drawing-sweeps` at unchanged tolerances. It is already red on `main` for four 90%-share
  coverage cases (see `docs/test-next-steps.md`), so the criterion is: the same four, none worse.
- `test/coastFitDistortion.test.ts` and the Node suite.
- Cold timing as for option 1.

Do not go to 32 lines: shares start to move by nearly half a point, for little further saving.

## Option 3: repaint only changed regions (do not retry)

DECISIONS §72 records it as built, measured and rejected:
- it saved at most about a fifth of one edit's paint, and only at the whole-map view;
- it was slower than a full repaint at 1× and 2×;
- it needs a scene diff engine, kept canvases and its own pixel check.

The patch was never committed, so retrying means rewriting it. The relaxed criterion above does not
change this conclusion: the cost is the map-spanning prims (coast clips, sea bands, ripples, realm
bands) that every local change reaches, not the exactness work.

## What remains after both

Even with options 1 and 2, the exact opening still costs about 7 s on the pilot. The solver (about
2.8 s), the global passes (about 1.15 s) and the fixed setup of each coverage measurement (about
1.3 s) are untouched. Making the exact picture itself fast means work on those, which none of the
three options addresses.

## Suggested order

| Order | Step | Reason |
|---|---|---|
| 1 | Option 1 (done, without the global passes; §78) | The only option that materially shortens the visible wait |
| 2 | Option 2 at 64 lines (done; §77) | One constant and existing checks, plus the frontier fix it exposed |
| 3 | The fit's own cost (solver, global passes, coverage setup) | What still bounds the exact picture |
