# Drawing follow-up: enclosed seas and repeated redraw work

**Publication status: draft, with unresolved checks.** The passing results below were recorded before
rebasing onto `e40c473` (#144), which changed geography defaults. After rebase, 477 Node tests,
application typecheck and build pass, but the area sweep fails: Classic `coverage-1` at 20% shows
21.275%; Parchment `coverage-2` at 5% shows 3.695%. The existing 1 percentage point limit stays intact.
The Parchment coast has five self-crossings; the subsequent open-coast loop repair removes all five
in its targeted regression and removes its fitting notice. Its finished-pixel area and performance
have not been revalidated. The Classic fitting issue remains unresolved.

The rebased browser replay has identical scene data but two changed pixels (one colour-channel level)
in the `components/shore` and `components/undo` export/fit/DPR-1 cases. The same failure reproduces on
unchanged main. A readback-context experiment did not fix it and was reverted; the exact comparison
remains unchanged. No post-rebase performance result was obtained because that replay failed first.
The owner asked to stop rerunning and create the PR. Historical results must not be presented as a
green validation of the current head. See [the next-agent handoff](drawing-next-agent.md).

Baseline: merged main `6786d4a` (#145). The package/browser setup repair is separate in
[PR #146](https://github.com/cmtalleyrand/fantasyhexmap/pull/146). Its Drawing tests CI installed the
pinned Playwright Chromium and passed both commands without driver/browser overrides. A fresh archived
checkout completed `npm ci` and both commands locally with the documented system-Chromium override;
this managed environment blocks Playwright's download host.

This follow-up repairs the enclosed-sea defect identified in the [first investigation](drawing-investigation.md)
and removes repeated exact work in glacier, pack-ice and symbol rendering. DECISIONS.md §§59–60 record
the choices. It does not complete all 17 hypotheses.

## Geography correction

A single Sea hex surrounded by Land became a huge circular coastline. The land mask omitted the page
surrounding a closed water boundary, and aggregate fitting mistook that boundary for an island whose
area should equal all the surrounding mainland. Source-coast direction now distinguishes the two.
Land outside the closed sea belongs to the page; its area is not used to resize the sea.

| Before | After |
|---|---|
| ![Enclosed sea before](drawing-followup/enclosed-sea-before.png) | ![Enclosed sea after](drawing-followup/enclosed-sea-after.png) |

The corrected fixture is a small sea within its assigned hex. No owner's data or intended land shares
changed. Two topology/extent tests fail before and pass after. The independent pixel sweep samples the
intended land/water at hex centres, rather than accepting two calculations from the same wrong coast.
Across 200 pinned seeds and three styles, 400/600 baseline cases fail and all 600 corrected cases pass.
Half include a nested land island. Existing island-symbol checks (200 seeds), coast-share checks (150
cases, maximum error below 0.39 percentage points), 19 small drawing fixtures and 400 river seeds pass.

The pre-rebase Node suite passes 469 tests; application typecheck and production build pass. Three
populated all-layer scenes are byte-identical to the baseline. All 59 cached/full edit cases have
identical scene data and zero changed pixels across 944 browser images (zoom, DPR, worker/export modes).

## Exact redraw reuse

The populated benchmark rebuilt nine glacier-margin and sixteen pack-ice components per redraw.
Bounded content caches now retain their exact geometry/primitives. Regression tests compare cached and
uncached scenes after terrain, elevation, roughness, colour, ice-style and size edits. Returning to an
already validated terrain revision no longer repeats every probe for an unchanged symbol fit; a new
revision must still validate every successful and rejected placement probe.

The two new ice caches have four-entry/8 MB estimated storage limits, 16 MB combined extra capacity.
The symbol cache retains its existing 16 MB budget. These are accounting limits, not measured worker
heap/GC results. No approximate land grid or largest-fitting-circle algorithm was introduced.

## Performance

Matched browser construction timings against merged main, Chromium 151.0.7922.173; alternating order,
100 runs per steady-state scenario (first two omitted), five cold seeds. The strict `--check` passes.

| Scenario | Main median (ms) | Follow-up median | Main p95 | Follow-up p95 |
|---|---:|---:|---:|---:|
| Cold | 2563.7 | 2580.9 | 3025.6 | 3088.2 |
| Warm | 84.5 | 57.1 | 183.6 | 147.4 |
| Ownership edit | 81.3 | 55.7 | 202.4 | 97.1 |
| Shore edit | 118.4 | 87.6 | 324.9 | 182.8 |

Warm/ownership/shore medians improve 32.4/31.5/26.0%; p95 improves 19.7/52.0/43.7%. Cold median costs
0.7%, p95 2.1%, both below 10%. This resolves the measured gate failure against this main and fixture;
it is not a claim of universally faster maps. Timings cover scene construction, not full worker transfer
and painting. Ownership/shore states alternate and become cached; unique-edit and 50×50 measurements
remain outstanding.

Earlier diagnostic configurations are retained in the results JSON: glacier-only reuse still failed
shore p95 (223.7→303.4 ms); adding revision reuse improved shore but failed warm p95 (193→262.5 ms).
Those configurations were not accepted as the finished performance result. The final configuration
also reuses pack ice; its timed run did not overlap other local test/sweep jobs. An unchanged-code
control also showed tail variation, so no single timing result establishes GC causality.

## Status of each hypothesis

G1 = natural/readable geography; G2 = faithful owner control; G3 = useful reports.

| # | Current disposition and evidence | Goal |
|---|---|---|
| 1 | Confirmed, further repaired: enclosed-sea mask includes surrounding mainland. Other query disagreements need broader checks. | G1 |
| 2 | Confirmed/fixed in #145; river-mouth regressions retained. | G1 |
| 3 | Confirmed/fixed for #145's cases; this follow-up preserves exact ice drawing and clipping. | G1 |
| 4 | Deferred: land-derived realm-name anchors need visual validation and cost measurement. | G1 |
| 5 | Partly fixed in #145; border/ripple/sea-ice and complete city-marker raster rules remain unfinished. | G1 |
| 6 | Not concluded: fragments, knots and spurs remain. Closed-water topology was fixed separately. | G1 |
| 7 | Confirmed/expanded: 600 painted topology cases catch a shared geometry/predicate error; all seven principles are not yet covered. | G1, regression protection |
| 8 | Fixed for identified fixtures in #145; new checks pin seeds. | G2, regression protection |
| 9 | Fixed for reproduced routes in #145; 400-seed check passes. Other route families remain. | G1 |
| 10 | Ordinary-coast drift refuted in 150 cases; enclosed-water fitting error confirmed/fixed. Broader shares and realm/legend areas deferred. | G2 |
| 11 | Visibility concern confirmed/deferred; no new small-feature geometry or warning policy. | G1, G3 |
| 12 | Name-omission reports fixed in #145; furniture/river-loss policy deferred. No routine city/escarpment reports. | G3 |
| 13 | Grouping/severity fixed in #145 and retained; no losses hidden. | G3 |
| 14 | Approved 50% floor retained with its documented omission cost. | G1, G2 |
| 15 | Deferred with #4: beside-name association needs visual validation. | G1 |
| 16 | Symbol-cache survival verified; repeated validation and uncached ice work confirmed/fixed. Worker heap/GC/lifetime measurements remain. | Responsiveness |
| 17 | Deferred: no approximate grid; predicate already has an exact lazy index. 50×50 name/edit/memory study remains. | Responsiveness, G2 |

## Reproduce

```sh
npm ci
npm run test:browser:install
npm test
npm run typecheck
npm run build
npm run test:drawing-pixels
npm run test:drawing-sweeps
```

Archive `6786d4a` into `work/followup-baseline` and link its node_modules to the checkout dependencies:

```sh
node scripts/drawing-investigation-extended.mjs --source work/followup-baseline --output work/followup-extended-before --check
node scripts/drawing-investigation-performance.mjs --baseline work/followup-baseline --output work/followup-performance --runs 100 --check
node scripts/render-incremental-validation.mjs --output work/followup-incremental
```

The first command must fail on that baseline. Performance still rejects any steady-state median/p95
regression and cold costs above 10%. No test, threshold or assertion was disabled or loosened.

## Work not done

Coast knots/spurs and lake ink in open sea; realm-name anchors; finished-picture rules for all seven
principles; broader island/lake/channel shares and actual realm/legend area agreement; omitted-name
reports keyed by feature IDs; unique-edit/end-to-end worker painting latency; and the 50×50 placement/heap
study remain. No existing complaint list is treated as exhaustive.
