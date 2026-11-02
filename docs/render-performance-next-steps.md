# Rendering performance: next steps

Written 27 October 2026. PR #160 left three options for cutting what a person waits for; this brief
compares them, gives a pilot measurement for each of the first two, and sets the order of work.

**Status.**
- **Option 1: rejected and removed** (DECISIONS §78). The owner regards a stand-in picture as an
  undesirable workaround: it shows a wrong picture instead of making the real one faster. It was built
  and measured, then removed. Do not propose it again.
- **Option 2: implemented** (DECISIONS §77). It needed fixes to how frontiers meet the coast and how
  rivers bow round city icons first.
- **Option 3:** stays rejected.
- **Picture checks:** the scripts now judge pictures by visible change (§76).

What remains is the last section, the fit's own cost. Its first step, removing overhead without
changing any result, is done (DECISIONS §80 and §81), scenes byte-identical. In paired runs each step
cut the populated cold build by a median of 11% and 16% respectively.

**Measurement caveat (DECISIONS §82).** Timings on this container vary by over a third between
sessions and about 10% within a batch. Every absolute time below was taken on 27 October, mostly from
one run per variant; compare only paired before/after ratios from a single session.

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
(`scripts/render-profile-input.ts`), one run per variant, so differences under about half a second are
within run-to-run noise (§82). The variants were made with temporary hooks,
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

## Option 1: stand-in picture while the exact coast fits (rejected; see Status)

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

## What remains

With option 2 the exact opening still cost about 7 s on the pilot (27 October timings; see the caveat above). The solver (about 2.8 s), the
global passes (about 1.15 s) and the fixed setup of each coverage measurement (about 1.3 s) are
untouched, and they are the only route to a faster first picture now that a stand-in is ruled out.

## Suggested order

| Order | Step | Reason |
|---|---|---|
| — | Option 1 | Rejected by the owner as a workaround (§78) |
| 1 | Option 2 at 64 lines (done; §77) | One constant and existing checks, plus the fixes it exposed |
| 2 | The fit's own cost: overhead with identical results (done; §80, §81) | Free: no picture change |
| 3 | Task A: a robust paired benchmark | Every later decision depends on it (§82) |
| 4 | Task B: test each complexity-adding change on its own | Keep only changes that pay for their complexity |
| 5 | Task C: retest promising changes that were rejected for no gain | They may have been measured wrongly |
| 6 | The fit's own cost: fewer rounds, passes or measurements | What still bounds the picture; judged by §76 |

## Tasks A–C: measure reliably, then re-judge past changes

Do these three tasks in order, A, then B, then C, because B and C both use the tool that A builds.
Each task ends in its own commit and its own DECISIONS entry. Read DECISIONS §82 before you start.

Some rules apply to every task:
- Never compare timings taken on different days, or from one run per variant.
- Never change what a scene contains while doing B or C, except where C explicitly says so.
- If a check fails and you do not understand why, stop and report it. Do not loosen the check.

### Task A: a paired benchmark that gives a confidence interval

**Why.** On this container, run times move by about 10% within a batch and by over a third between
days. The five-pair comparisons used so far cannot detect differences under about 3–4%. Task B needs
to detect 0.5%.

**What to build.** Build a script, `scripts/perf-compare.ts`, and add it to `package.json` as
`perf:compare`. It compares two source trees. The usual inputs are a git worktree of the base commit
and the working tree.

**How it measures.**
- Each sample is one fresh Node process running
  `scripts/render-construction-profile.ts --sample --root <tree> --edits 0 --kind <kind>`, which
  prints JSON containing `cold.ms` and `hash`.
- Before timing, run each tree once and check that the two hashes are equal. If they differ, stop and
  report the difference unless `--allow-different` is passed.
- Do two warm-up samples per tree and discard them. This loads tsx caches and the disk cache.
- Run N pairs; the default is 30 and `--pairs` sets it. Alternate the order: base first in odd pairs,
  new first in even pairs.
- For each pair, record the ratio new ÷ base.

**What it reports.**
- The median ratio.
- A 95% bootstrap confidence interval of the median ratio: resample the pair ratios with replacement
  10,000 times and take the 2.5th and 97.5th percentiles of the medians.
- The minimum and maximum ratio.
- The base and new medians in ms, as context only.
- A one-word verdict:
  - `faster` if the upper end of the interval is below 1;
  - `slower` if the lower end is above 1;
  - `unresolved` otherwise.

Print a short table, and write the full sample list to `work/perf-compare/<timestamp>.json`.

**Reducing noise.** Optionally also record, per sample, the process's CPU time from
`process.cpuUsage()` around the build, and report the same statistics for it. CPU time is usually
steadier than wall time on a shared machine. If you add it, the sample script must print it; add it
to `render-construction-profile.ts` in the `run` function beside `ms`. Report both measures, and say
in the DECISIONS entry which one varied less.

**Check that the tool works.**
- Compare the working tree against itself (`--root` pointing to the same tree for both sides) with 30
  pairs. The interval must contain 1.00 and should be narrower than ±1.5%. Record its width.
- Then add a known slowdown: insert a busy loop of about 1% of a build's time at the start of
  `buildStaticScene`, in a scratch copy only, and confirm the tool reports `slower` at about 1.01.
  Remove the loop.
- If the self-comparison interval is wider than ±0.5%, then 0.5% changes cannot be resolved. Raise
  `--pairs` until it is narrower, up to 100, and record how many pairs that needed. If even 100 is
  not enough, say so in the entry and continue with the narrowest you can get.

**Deliver.** The script, the `package.json` entry, a DECISIONS entry (§83) recording the
self-comparison widths, and an amendment to §82 that points to the tool.

### Task B: test each complexity-adding change separately (threshold 0.5%)

**Why.** DECISIONS §80 and §81 made several changes that make the code harder to read. They were only
timed together, so nobody knows whether each one pays for itself. The owner's rule: keep such a
change only if removing it makes the build at least 0.5% slower, judged by Task A's tool.

**The changes to test**, one at a time:
1. `NumberBuffer` in `src/render/footprint.ts`, the shared, reused scratch buffers `runStarts`,
   `runEnds` and `crossingXs`. To undo it, give each scanline its own new arrays
   (`Float64Array.from(list).sort()`) and delete the class.
2. The flat band bins and the flat 8-number stroke `poly` in `src/render/footprint.ts`. To undo
   them, store edges as `[a, b]` tuples and the ink quadrilateral as an array of four points.
3. The `mark` field with the `lists` generation counter in `src/render/componentCoast.ts`. To undo
   it, use a `Set` to skip repeats, keeping first-seen order.
4. The typed-array spline `support` in `src/render/coastArea.ts`, which uses `Int32Array` and
   `Float64Array` indexed `4*j..4*j+3`. To undo it, use an array of four `[index, weight]` tuples
   per point.
5. The `bends` `Int32Array` in `src/render/coastArea.ts`. To undo it, use the plain `bendList`.

Use `git log -p` on the branch to find the exact earlier code for each change. The commits that
introduced them are referenced by §80 and §81.

**Steps, for each change on its own:**
1. Make a git worktree of the current head at `/tmp/perf-base`.
2. In the working tree, undo only that one change.
3. Run `npm run typecheck` and `npm test`. Both must pass.
4. Run `npm run perf:compare -- --base /tmp/perf-base --pairs 30` (or the pair count Task A found
   necessary). The hashes must be equal; if they are not, your undo is wrong, so fix it.
5. Repeat step 4 with `--kind mixed`.
6. Decide:
   - If, on the populated fixture, the undo is `slower` and its median ratio is at least 1.005, the
     change earns its place: restore it.
   - Otherwise, keep the undo, which means the simpler code. Commit it as "Remove <change>: no
     measurable gain (median ratio x.xxx, interval a–b)".
7. Delete the worktree, and recreate it from the new head before testing the next change, so that
   each test is against the current code.

**After all five,** run the full gates: `npm run typecheck`, `npm test`, `npm run test:slow` and
`npm run test:drawing-pixels` (it needs `CHROMIUM_PATH=/opt/pw-browsers/chromium`). Confirm the
scene hashes still equal those of the original head.

**Deliver.**
- One commit per removed change.
- A DECISIONS entry (§84) with a table giving, for each change, the median ratio, the interval, the
  verdict and whether it was kept.
- One-line notes in §80 and §81 pointing to §84.

### Task C: retest changes that were rejected for showing no gain

**Why.** Some past attempts were rejected because they showed no gain. That may have been because
the measurement was too noisy, or measured the wrong thing (for example, total time when only one
part changed). Retest only the ones that, before measurement, looked likely to save 2.5% or more.

**Step 1: assessment** (write it before running anything). Go through DECISIONS §70 onwards and
this file, and list every performance change that was tried and not adopted. For each, record:
- what it was meant to speed up;
- the evidence used to reject it (how many runs, paired or not, which timing);
- whether, before measuring, it was a strong candidate, meaning the work it removed was at least
  2.5% of the timing being judged;
- whether the rejection could plausibly be a measurement problem: few or unpaired runs, an effect
  smaller than the noise, or the wrong timing measured.

Retest only the attempts that are both strong candidates and plausibly mismeasured. Do not retest
attempts rejected for a structural reason or by a large, clear margin.

My own reading, as a starting point to check rather than copy:
- **Band-line thinning (§75).** Retest. Its in-page paint fell from 246 to 198 ms, about 20%, but two
  production-worker pairs showed no reliable gain. Two pairs cannot resolve that.
  - It was also rejected because inner band edges moved by up to 32 levels at 1×. That was judged
    before §76 relaxed the criterion to no visible change, so make before/after images and judge
    them by §76 as well.
- **Composited layers for realm border groups (§75).** Probably do not retest. They were slower in
  every run (281–348 against 246 ms).
- **Batching same-style fills (§74).** Do not retest. It was about ten times slower in one case.
- **Partial repaint (§72).** Do not retest. It was rejected for structural reasons, and the owner
  has also ruled it out.
- **96 against 64 measuring lines (§77, and the table above).** Not a failure, but the pilot figures
  came from single runs. Retest only if Task A shows the pilot was badly off.

The batch timings during §81, which showed almost no gain from the third and fourth changes, are
covered by Task B, so do not retest them here.

**Step 2: retest.** For each attempt you selected, rebuild it from the description in DECISIONS.
Then measure it with the timing the change actually affects:
- Paint changes: in the browser, through `npm run perf:interaction` or `npm run perf:opening`, with
  many alternating pairs, using the same ratio and bootstrap-interval method as Task A. Extend
  `perf:compare` or write a browser equivalent.
- Build changes: with `perf:compare`.

Adopt an attempt only if it is `faster` by at least 0.5% and passes the picture gates,
`test:drawing-pixels` plus a §76 visual judgement.

**Deliver.**
- A DECISIONS entry (§85) with the assessment table and the retest results.
- The code of any attempt that is now adopted, as its own commit.
- Amendments to the earlier entries whose conclusions changed.
