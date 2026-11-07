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

**T2 completed, 3 November 2026 (DECISIONS §84).** The bend-list conversion is removed. All four
strong existing optimizations are retained after independent 100-pair comparisons on each fixture.
Band-line thinning is adopted after a 30-pair production-worker comparison: median paint ratio
0.9510, 95% interval 0.9235–0.9858, with no visible picture change. Serialized scenes are unchanged.
The complete edit-to-sharp-frame result is unresolved (ratio 0.9773, interval 0.9283–1.0392).
The next improvement is Group 1, step 1 below: replace the repeated global share passes.

**6 November 2026 (DECISIONS §85–§87).**
- **Fixtures corrected first (§85).** The maps every timing uses were not sensible. `mixed` had no
  straits or isthmuses. The 50×50 interaction map had invalid mixed hexes, enclosed sea holes,
  cities on glaciers and rivers over ice and open water. `populated` had the same generator faults.
  The generator is fixed, `populated-40.json` is regenerated and the tests now guard all three maps.
  Scene hashes changed; earlier absolute timings and hashes are not comparable.
- **Step 1.1 withdrawn (§86).** The global passes cannot be replaced by a solve from the trace.
  Smoothing leaves some coastal hexes with no coast in them, which the fit has no controls to reach.
  Without the passes the populated map misses 13–15 shares instead of 1.
- **Step 1.2, clearance reuse, removed (§87).** It was exact, but no faster in wall time, and 3–5%
  slower in CPU time.
- **Step 2, flat arrays for the field's samples, not adopted (§88).** Hashes were unchanged, but
  it was no faster on populated.
- **Function-level profile (§88).** Garbage collection takes 15.8% of a populated cold build. The
  two largest functions, the fit's own loops and the per-hex coverage measure, take 5.8% each, and
  nothing else reaches 5%. Kernel rewrites cannot deliver the 20–35% estimated below.
- **Steps 3.1 and 3.2 measured (§89).** `node scripts/render-edit-wait.mjs` times ten edits on
  the 50×50 map. Any edit that changes land or water waits 2.2–2.6 s, 78–91% of a cold build, and
  the coast is 57–72% of that wait. Other edits take about 0.3–0.4 s, mostly paint. One coastal edit
  rebuilds 85 of 88 coast components and refits the whole map as one group. 35 untouched coasts up to
  57 hexes away change by up to 0.0026 px.
- **3.2 fixed (§90).** The coast component cache was too small to hold one map's traces, so edits
  reused none; it is resized. Coasts are now fitted and cached per independent group. Coastal edits
  on the 50×50 map are 26–36% faster (for example 2.39 → 1.76 s and 2.36 → 1.50 s), and other groups
  are left byte-identical, which a slow test checks. Cold builds of multi-group maps are about 6%
  slower.
- **Next:**
  - In a coastal edit, after the fit: the global share passes (about 200 ms; they measure every hex
    each pass), symbol revalidation (about 150 ms; all symbols are revalidated after any land change)
    and island drawings (all 67 rebuilt; keyed on a whole-map land revision). Each can be made to
    follow only the groups or hexes an edit touches.
  - Step 4 (fit groups in parallel) to recover the cold-build cost.
  - Step 3.3 (local refit within a group) for single-continent maps, which grouping does not help.

## Route to significant gains (7 November 2026)

The goal is significant: the plan's target is a cold build of about 1 s and edits that feel quick.
On the 50×50 map, coastal edits now take 1.5–1.8 s to a sharp frame, other edits about 0.3 s (mostly
paint), and a cold build 2.9 s (§90). Shaving individual functions cannot close that gap: no
function holds more than 6% of a build (§88). The steps below change how much work is done, and
each states the gain it has to show.

| Step | What | Expected gain | Status |
|---|---|---|---|
| R1 | Place rough-coast features locally: anchor each bay and cape to page position, not to a fraction of its ring's perimeter, and seed it locally | Makes rough coasts local, which R2 needs. No speed gain by itself. Redraws the fine detail of every rough coast once (same character, different bays and capes) | Needs the owner's approval: it visibly changes existing maps |
| R2 | Windowed coastal edits: find the hexes an edit changed, rebuild the coast on the map masked to those hexes plus 9, with indices and coordinates kept, and splice it into the previous coast at seams where the two agree (§91: smooth coasts agree to under 0.5 px) | Coast part of a coastal edit, now 0.7–0.8 s, falls to about 0.05–0.15 s (window builds of 40–130 ms) | Rule relaxed (§91); after R1 for rough coasts, or now for smooth ones |
| R3 | Keep the rest of an edit local: revalidate symbols, rebuild land fills and re-place labels only in the window | About 0.3 s of a coastal edit, now spent map-wide | After R2 |
| R4 | Parallel cold build: fit independent coast groups (§90), and other independent stages, in a worker pool | Cold builds of multi-group maps 20–35% faster, also recovering §90's 6% | Needs the build in the paint worker to become asynchronous |
| R5 | Measure paint on a GPU-backed browser before working on it | Paint is 0.2–0.27 s of every edit in headless software raster, which may overstate it | Measurement only |

After R1–R3, a coastal edit should take about 0.5–0.65 s (paint about 0.25 s, the rest of the build
about 0.1 s, the window 0.15–0.3 s): about three times faster than now. A cold build of 1 s is not
reachable on one core, because the coast alone is 1.7 s of it; R4 is the route, and its gain is
bounded by the largest coast group.

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
| 3 | Group 1, step 1.1: an initial constrained solve starting from the trace | Withdrawn: dry coastal hexes have no controls (§86) |
| 4 | Group 1, step 1.2: reuse the field across rounds | Clearance reuse exact but not faster; removed (§87) |
| 5 | Group 1, step 2: typed-array field samples | Hashes unchanged, no gain; not adopted (§88) |
| 6 | Function-level CPU profile (§88) | No function above 5.8%; garbage collection 15.8% |
| 7 | Group 1, steps 3.1–3.2 measured (§89) | Land or water edits wait 2.2–2.6 s; whole map refitted |
| 8 | 3.2 fix: component cache sized, fit per group (§90) | Coastal edits 26–36% faster; multi-group cold builds about 6% slower |
| 9 — next | Per-group passes, symbols and islands in edits; step 4; step 3.3 | The remaining edit costs, the cold cost, single-continent maps |
| Done | Group 2: T1 paired benchmark (§83) and T2 review (§84) | Use these tools and retained optimizations as the baseline for future work |

## Next task: the initial coast solve

Implement Group 1, step 1.1: replace the global share passes with one initial solve using the share
targets as constraints, starting from the trace. Field reuse and the round stopping rule follow as
separate changes in steps 1.2 and 1.3.

- Start from the completed T2 renderer. Record the populated and mixed fixtures' current global-pass,
  measurement, solver-iteration and round counts before changing the fit.
- Compare the initial-solve change against its parent using `perf:compare --allow-different`, with
  alternating pairs in one session. Report wall and CPU median ratios and confidence intervals,
  together with the before/after work counts.
- Review gallery pictures under §76 and run `perf:coast`, the Node and slow suites,
  `test:drawing-pixels`, `test:drawing-sweeps` and `test/coastFitDistortion.test.ts`. Keep the known
  sweep failures at the same cases, none worse, and preserve cached/uncached scene equality.
- Deliver this part in its own commit and DECISIONS entry before proceeding to field reuse.

The T2 paint saving does not establish a faster cold coast build or a faster complete edit wait.
Use fresh paired measurements for both claims.

## Group 1: improvements, ranked by likely impact

The target is a cold build of about 1 s (about 4–5 s now) and edits that feel quick. Steps are ranked
by their expected gain; the estimates are mine, from profiles, and must be checked by measurement.
Every step that changes the coast is judged by §76 with before/after images on the gallery fixtures,
and must keep `test:drawing-sweeps` (the same failing cases as `main`, none worse) and
`test/coastFitDistortion.test.ts` passing. Measure each with T1's `perf:compare` (pass
`--allow-different` where the coast changes).

### 1. Fit a coast once, not by repeated passes and rebuilt fields (cold build; estimate 30–50%)

**Why.** A fit traces the coast, runs global share passes (about 0.65 s) that adjust it towards the
land shares one pass at a time, then runs about ten solver rounds, each rebuilding the control field
from scratch and solving again. Most of that repeats work whose inputs barely changed.

**Do, in this order, measuring each part separately:**
1. Replace the global share passes with a better first solve: one solve with the share targets as
   constraints, starting from the trace.
2. Build the control field once per fit, and in later rounds update only the parts near points the
   previous round moved.
3. Stop the rounds when every hex meets the share tolerance, instead of after a fixed count. Record the
   round counts on the populated and mixed fixtures before and after.

### 2. Rewrite the two hot kernels on flat typed arrays (cold build and edits; estimate 20–35%, no picture change)

**Why.** Most of what remains is coverage measurement (`areaCoverage` in `src/render/footprint.ts`)
and the solver round (field, conjugate-gradient solve, move and check in `src/render/coastArea.ts`),
plus about 0.75 s of garbage collection. A rewrite keeps all per-round state in preallocated typed
arrays: coordinates as `x,y` pairs, edges and bins as index arrays, no objects or tuples in a round.

**Do.** Rewrite each kernel behind its existing function signature, one kernel per commit. The scene
hash must stay identical: same arithmetic, same order. If step 1 has landed, rewrite the kernels as
they are after it.

### 3. Make edits refit only the coast they change (edits; estimate large, unknown until measured)

This is a different kind of change from step 1. Step 1 changes how any fit is computed; this step
changes how much is fitted after an edit, and needs the previous fit's state, a rule for which part of
the coast an edit affects, and a seam where the refitted part meets the kept part.

**Do, in this order:**
1. Measure the real wait for an edit. The figure of 70–120 ms in earlier notes is the scene build in
   Node only; an edit's wait also includes the worker transfer and the paint (paint alone was about
   300–500 ms in §73–§74), and edits are reported to feel longer than that. Using
   `npm run perf:interaction` in the browser, record for ten edits of different kinds (terrain at the
   coast, terrain inland, ownership, a city) the time from input to sharp frame, split into build (and
   within it the coast fit), transfer and paint. Write the table into a DECISIONS entry. If the coast
   fit is not the largest part, report that and re-rank this step before going further.
2. Check how far a refit reaches. For one edit, record which coast groups are refitted and how far each
   moves. A coast should be refitted only when the edit touches it or reaches it through a chain of
   hexes with land in them. If unconnected groups are refitted or moved, fix that first, and add a test
   that an edit leaves unconnected coast groups byte-identical.
3. Within a group, refit only the affected region. Start the solve from the previous fit's control
   points, free the control points of the hexes whose inputs changed plus one ring of neighbours, and
   hold the rest fixed. Report the edit's coast-fit time and its wait from step 1 before and after.
   Judge the result by §76 on the edited maps, comparing with a full refit; the kept region will differ
   slightly from what a full refit would draw, and that is acceptable if not visible.

### 4. Fit independent coast groups in parallel at opening (cold build; depends on the map)

**Why.** Groups not linked through land-bearing hexes (see step 3.2) are independent, so they can be
fitted in a pool of workers, one group per task. With four or more cores a map with several sizeable
groups gains close to the core count on the fit; a single large continent gains nothing. Rank it last
for that reason, and report the gain per fixture.

**Do.** Move `fitCoastAreas` for one group into a worker entry point that takes and returns typed
arrays. The final scene must equal the serial build byte for byte.

### Not planned

**WebAssembly.** Consider it only if a profile after steps 1 and 2 shows the remaining fit time is pure
arithmetic: it adds a toolchain and a copy boundary, and typically gives 1.5–3× over well-written
typed-array JavaScript.

**Caching the fit across sessions.** Ruled out by the owner: it does not make building faster.

## Group 2: testing and review

Do T1 first, because T2 and every improvement in group 1 are measured with the tool it builds. Each task ends in its own commit and its own DECISIONS entry. Read DECISIONS §82 before you start.

Some rules apply to every task:
- Never compare timings taken on different days, or from one run per variant.
- Never change what a scene contains while doing T2, except for band-line thinning (B2), which says so.
- If a check fails and you do not understand why, stop and report it. Do not loosen the check.

### T1. A paired benchmark that gives a confidence interval

**Implemented (DECISIONS §83).** Run `npm run perf:compare -- --base /path/to/base --root .`.
Both wall and CPU time are reported. The 100-pair self-comparison contains 1.00, and an approximately
1% injected delay is detected, but this session did not reach the precision needed to resolve 0.5%
changes. See §83 for the intervals and saved sample paths. The original brief follows.

**Why.** On this container, run times move by about 10% within a batch and by over a third between
days. The five-pair comparisons used so far cannot detect differences under about 3–4%. T2 needs
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

### T2. Retest the strong candidates whose gain is unproven (threshold 0.5%)

**Complete (§84).** B0 removed the bend-list conversion. B1 retained all four strong candidates after
100 pairs on each fixture per candidate. B2 adopted band-line thinning after the production-worker
paint comparison and picture review. Typecheck, build, 589 Node tests, 14 slow tests and drawing
pixel checks pass; populated and mixed scene hashes match the original head. The assessment and
instructions below are retained as the record of the brief; their outcome column is current.

**Why.** There are two kinds of change whose effect was never measured properly:
- changes from §80 and §81 that make the code harder to read, which were only ever timed together;
- attempts that were rejected for "no gain" on too few runs.

The same rule applies to both. A change is worth testing only if, before any measurement, it looked
able to save at least 2.5% of the timing it affects. Strong candidates are measured with T1's
tool and kept only if they save at least 0.5%. A complexity-adding change that was never a strong
candidate is not worth its complexity, so undo it without timing it.

**The assessment is already done.** Do not redo it. It covers DECISIONS §70 onwards and this file.

| Change | Strong candidate? | Outcome (§84) |
|---|---|---|
| `NumberBuffer` scratch buffers (§81, `src/render/footprint.ts`) | Yes: removes an allocation per scanline across every coverage measurement | Retained: populated undo ratio 1.0181, interval 1.0102–1.0272 |
| Flat band bins and flat 8-number stroke `poly` (§81, `footprint.ts`) | Yes: per-edge and per-segment objects in every measurement's setup, its largest cost | Retained: populated undo ratio 1.0564, interval 1.0455–1.0750 |
| `mark` field and `lists` counter in clearance (§80, `src/render/componentCoast.ts`) | Yes: replaced a `Set` per candidate list in the clearance query, a hot path | Retained: populated undo ratio 1.0240, interval 1.0101–1.0359 |
| Typed-array spline `support` (§80, `src/render/coastArea.ts`) | Yes: four tuples per coast point per solver round | Retained: populated undo ratio 1.0225, interval 1.0136–1.0306 |
| `bends` as an `Int32Array` (§81, `coastArea.ts`) | No: built once per round, tiny | Removed conversion; hashes unchanged; no speed claim |
| Band-line thinning (§75) | Yes: in-page paint fell about 20% (246 → 198 ms) | Adopted: production paint ratio 0.9510, interval 0.9235–0.9858; no visible change |
| Composited layers for realm border groups (§75) | — | Do not retest: slower in every run (281–348 against 246 ms) |
| Batching same-style fills (§74) | — | Do not retest: ten times slower in one case |
| Partial repaint (§72) | — | Do not retest: structural reasons, and ruled out by the owner |
| 96 against 64 measuring lines (§77) | — | Not a rejection; leave it |

**B0: undo `bends`.** In `src/render/coastArea.ts`, use the plain `bendList` array where the
`Int32Array` `bends` is used, and delete the conversion. Then:
- Run `npm run typecheck` and `npm test`.
- Run `perf:compare` once to confirm the hashes are equal. Do not judge its timing.
- Commit it as "Use the plain bend list".

B0, B1 and B2 are implemented in DECISIONS §84. The instructions below record the original brief.

**B1: test the four strong complexity-adding changes**, one at a time, in the order of the table.
How to undo each:
- `NumberBuffer`: give each scanline its own new arrays (`Float64Array.from(list).sort()`) and delete
  the class.
- Flat bins and `poly`: store edges as `[a, b]` tuples and the ink quadrilateral as an array of four
  points.
- `mark`: use a `Set` to skip repeats, keeping first-seen order.
- `support`: use an array of four `[index, weight]` tuples per point.

To find the exact earlier code, run `git log -p` on the files named in the table.

For each change:
1. Make a git worktree of the current head at `/tmp/perf-base`.
2. In the working tree, undo only that change.
3. Run `npm run typecheck` and `npm test`. Both must pass.
4. Run `npm run perf:compare -- --base /tmp/perf-base` with the pair count T1 found necessary,
   on the populated fixture and then with `--kind mixed`. The hashes must be equal; if they are not,
   your undo is wrong, so fix it.
5. Decide:
   - If the undo is `slower` on the populated fixture with a median ratio of at least 1.005, restore
     the change, and add a one-line comment above it naming the gain and §84.
   - Otherwise, commit the undo as "Remove <change>: no measurable gain (median ratio x.xxx,
     interval a–b)".
6. Delete the worktree, and recreate it from the new head before the next change.

**B2: retest band-line thinning.**

**Adopted (§84).** `npm run perf:paint-compare -- --base /path/to/base --root .` measures paint and
input-to-sharp-frame through the production worker, alternates 30 pairs by default, discards two
warm-up edits per side, and saves raw samples and before/after images at fit, 1× and 2×. Use
`CHROMIUM_PATH` for a preinstalled browser. A bounded invocation on Linux is
`timeout 300s env CHROMIUM_PATH=/usr/bin/chromium npm run perf:paint-compare -- --base /path/to/base`.
Each frame also has a 120-second timeout. Paint is faster; the final edit-to-sharp-frame interval
includes 1.00, so no improvement in that total is claimed.

1. Rebuild it from §75: Douglas–Peucker at 0.006 hex sizes on the realm band lines.
2. Measure paint, which is the timing it changes, not build time. Use the production worker through
   `npm run perf:interaction`, with at least 30 alternating pairs analysed by T1's
   median-ratio-and-bootstrap method. Extend `perf:compare` with a `--browser` mode or write a small
   equivalent.
3. Make before/after images at whole-map, 1× and 2× and judge them by §76.
4. Adopt it only if paint or edit-to-sharp-frame is `faster` by at least 0.5% and the images show no
   visible change.

**After B0–B2,** run the full gates: `npm run typecheck`, `npm test`, `npm run test:slow` and
`npm run test:drawing-pixels` (with `CHROMIUM_PATH=/opt/pw-browsers/chromium`). Confirm the build
hashes equal those of the original head; B2 is a paint change and does not alter them.

**Deliver.**
- One commit per undo, plus one for B2 if it is adopted.
- A DECISIONS entry (§84) containing the table above with the measured ratio, interval and outcome
  added.
- One-line pointers to §84 in §75, §80 and §81.
