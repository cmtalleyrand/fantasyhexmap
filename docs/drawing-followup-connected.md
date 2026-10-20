# Rounded coast and redraw continuation

This continues the owner's gridded review on `codex/coast-redraw-followup`. The earlier
[failed performance run](drawing-followup.md#current-validation-and-performance) remains retained;
it does not validate the implementation described here.

## Visible result

| Rejected cape and page join | Rounded cape and curved page continuation |
|---|---|
| ![Before, full hex grid](drawing-followup/parchment-grid-review.png) | ![After, full hex grid](drawing-followup/parchment-after-skew-proposal.png) |

Both images show the same pinned map and requested 5% land in hex (2, 2). They are actual Canvas
renders with water hexes visible. The new painted share is 4.6726%; land colour is uniform as
requested. The left straight line was a page-rim projection, while the diagonal approaching the
cape crossed the target hex. Neither was evidence that the requested land percentage should change.

The previous local-rounding attempt failed because tangential skew sharpened the repaired join
again. The stage trace and earlier-attempt review are in
[the investigation record](coast-performance-plan.md#2026-10-20-prior-attempt-review-before-further-fixes).
The connected repair rounds only joins created by removing a fold-back loop, after seeded skew
and before area fitting. Passage and crossing checks can reject a fillet. Open coast continuations
follow the endpoint tangent into the same fixed page endpoint, falling back to straight projection
if they cross retained coast. Queries, clipping, fills and coast ink use this shared geometry.
No owner data, solver rounds, area tolerances or symbol-size floor changed.

Classic remains a legacy unsmoothed style whose low-share cuts expose abrupt joins. The owner does
not use it and asked to continue retiring it. The migration note is in
[the continuation guide](drawing-next-agent.md#owner-review-defaults-and-classic-retirement).
Its separate previously measured +0.9 ms / +29% tiny-fixture cost remains disclosed; the populated-map
measurements cannot erase that relative cost.

## Performance change and causal limits

The previous implementation cached island scale but repeatedly rebuilt final island positions and
paths. A diagnostic CPU/allocation trace identifies that work alongside major-GC pauses inside
slow redraws. It does not establish that the new ice caches exclusively caused the earlier p95
regression: both versions share a browser heap, and profiler overhead changes timing.

The connected implementation retains exact completed island drawings using the existing complete
land-input revision and hex. Scalar scales and drawings share a single bounded LRU (10,000 entries,
4 MB estimated accounting). Mainland distance functions are also reused within one build. These
changes remove repeated work without approximating land or fitting. Cache-off comparisons remain
exact. Estimated cache accounting is distinct from measured retained worker heap.

## Final isolated comparison and retained intermediate results

Final renderer runtime: `be084b1a4b054acfd7b48c357ccc654019ff33ea`, after integrating current main
`6f3d5c755d8666731f21e62d9073e939cbd68a66`. The final strict comparison passes with Chromium
151.0.7922.173: 100 builds per steady-state scenario (first two omitted), five cold builds, and
alternating before/after order. No other tests, rendering or profiling overlapped it.

| Scenario | Main median (ms) | Final median | Main p95 | Final p95 |
|---|---:|---:|---:|---:|
| Cold | 2667.3 | 2688.7 | 3347.1 | 3267.0 |
| Warm | 92.6 | 46.7 | 199.3 | 80.1 |
| Ownership edit | 92.7 | 45.7 | 205.9 | 77.1 |
| Shore edit | 126.9 | 76.3 | 269.2 | 157.7 |

Cold median adds 0.8%; cold p95 improves 2.4%. Warm/ownership/shore p95 improves 59.8/62.6/41.4%.
The unchanged gate still rejects any steady-state median/p95 regression or cold cost above 10%.
This measures scene construction on the populated 40×40 fixture, not worker/painting latency.

**Benchmark control correction.** Earlier comparisons loaded both renderer bundles in one page.
They necessarily shared a JavaScript heap: a measured build could collect temporary objects from
both versions, and the benchmark itself retained the accumulated profile history there. A marked
shore diagnostic records 840 minor collections (4,822 ms) and nine major collections (935 ms),
including 67–120 ms major pauses during candidate builds and 70–156 ms during main builds.
That confirms a cross-version allocation/GC confound, not a proof that one cache exclusively caused
an earlier tail regression. The final runner uses separate browser contexts, verifies distinct
JavaScript isolate IDs, and retains the profile history in Node. Timing stays inside each build;
IPC overhead is outside it. No limit, scenario or warm-up exclusion changed.

**Additional allocation fix.** History review found `426e903` already shared the coast outline
within a redraw. The remaining derived outline, water clip and donor-ground points were recreated
on subsequent redraws. `coastPaint.ts` now retains those exact geometries with the traced coast;
their estimated weight counts against the existing 20 MB coast budget. Ownership and colours are
applied afresh. It adds no separate unbounded cache and changes no geometry. The targeted shared-heap
shore run improves median/p95 140.0/260.7→86.9/206.5 ms before the isolation correction.

The intermediate runs are retained in the records archive, not erased:

- Runtime `3471968`, main `1179712`, shared heap, 100 cold and 100 steady-state builds: passed;
  shore p95 249.7→159.8 ms. This predates retained coast paint geometry.
- Runtime `a7d9b03`, main `6f3d5c7`, shared heap, five cold and 100 steady-state builds: **failed**
  shore p95 249.6→278.2 ms, despite median 131.9→84.3 ms. Warm/ownership and cold passed.
- Retained coast paint geometry, shared heap, targeted 100 shore builds: passed as above.
- Final runtime `be084b1`, main `6f3d5c7`, independent heaps: passed all scenarios, table above.

The earlier `f67ca94` failed run also remains in the original report. These observations are not
interchangeable; none is a universal latency bound.

## 50×50 production-worker study

`render-worker-study.mjs` exercises the production `paint.worker.ts` build, viewport bitmap and
overview protocol with all layers and names. It transfers the bitmap to a visible Canvas and waits
two animation frames. It is a worker-protocol harness, not the React Inspector/input-scheduling
path. Final runtime `be084b1` and main `6f3d5c7` each have a separate browser/worker lifetime, run sequentially without
other heavy jobs. This synthetic map includes islands, ice, cities and realms. Ownership edits
change 32 different land hexes cumulatively, rather than alternating two cached states.

| Measurement (ms) | Main median / p95 | Connected median / p95 |
|---|---:|---:|
| Unique ownership build roundtrip | 615.1 / 782.4 | 482.3 / 593.9 |
| Unique ownership displayed sharp frame | 1086.4 / 1614.4 | 937.7 / 1341.7 |
| Worker viewport paint | 466.5 / 861.4 | 437.3 / 845.9 |
| Realm-name placement | 14.8 / 20.3 | 9.1 / 20.4 |

The single cold displayed frame is 6175.3→6084.8 ms (−1.5%); warm is 758.8→556.4 ms. These are
single observations, not distributions or reliable cold/warm bounds. The 32-edit distributions
show improvement in total latency but do not establish a universal guarantee. Realm-name tail
variation is small, and its source is unchanged in this continuation.

The candidate's average construction time on these edits is 493.5 ms, including **403.7 ms in
feature-name placement**, versus 11.6 ms in realm-name placement. River-label searches repeat as
realm-name obstacles change. Viewport painting still takes roughly 437 ms median and 846 ms p95. These costs remain;
the faster small-scene benchmark does not resolve them. Consult the existing name-placement cache
history before proposing another cache, and preserve exact reconstruction/obstacle behaviour.

The separate `--memory` pass records worker heap before/after explicit collection and a compressed
GC trace. Forced collections are outside build/paint samples; that pass's timings are diagnostic,
not benchmark evidence. Retained V8 heap excludes Canvas/GPU/native allocations and is not the
same quantity as estimated cache accounting.

Final retained V8 heap after explicit collection (MiB):

| Point in worker lifetime | Main | Final |
|---|---:|---:|
| Cold frame | 76.03 | 76.91 |
| Warm frame | 74.75 | 74.05 |
| 8 unique edits | 85.42 | 84.44 |
| 16 unique edits | 87.22 | 86.17 |
| 24 unique edits | 87.66 | 86.67 |
| 32 unique edits | 88.73 | 86.74 |

Reported embedder heap is about 12.96 MiB for both after editing. Final retained V8 heap is about
2 MiB below main at edit 32 and grows only 0.57 MiB from edit 16 to 32 in this run. This is one
short synthetic lifetime, not proof of an eventual bound or an allocation estimate for individual
caches. Native/Canvas allocations and longer sessions remain outside this study. Forced-GC trace
pauses are diagnostic and must not be substituted for the timing pass's natural tail latency.

## Correctness coverage

The rounded-coast implementation passed the full unchanged painted-area sweep across all 150 coast cases: maximum errors Classic 0.789,
Parchment 0.470 and Atlas 0.440 percentage points. All 200 island and 600 enclosed-sea cases pass.
All 497 merged-branch Node tests, typecheck and build pass, including finished-contour and exact
cached/full reconstruction checks. Exact replay of runtime `3471968` passed all 59 edit cases / 944
images with zero scene or pixel differences. A subsequent complete 59-case scene comparison shows
that integrating main and retaining coast paint geometry leaves every replayed scene JSON exactly
unchanged. The replay painter and exact pixel assertions are unchanged; the 944-image matrix was
not needlessly repeated after that equivalence proof. The finished-contour regression also rejects
the previously pinched cape. Island test selectors now
recognise the owner's uniform land colour and still require the same counts, own-hex containment,
coastal association and predicate/paint agreement.

The earlier 50×50 intermediate studies (runtime `3471968`, main `1179712`) remain in the records
archive; their timings and heap observations are not presented as final-runtime measurements.

The result does not complete all 17 investigation items. Land-derived realm-name anchors, independent
finished-paint coverage for every drawing branch, broader island/lake/channel shares and actual
painted realm/legend-area agreement remain separately tracked.

## Reproduce and evidence

[Compact results](drawing-followup-connected-results.json) retain version/method metadata and
validation scope. [Complete compressed records](drawing-followup-connected-records.json.gz) retain
all intermediate and final benchmark samples, worker profiles, heap observations, GC/CPU/allocation
diagnostics, area/topology results and exact replay/equivalence records. The original failed-run
archive remains unchanged.

```sh
# Archive the stated baseline and link its node_modules first.
node scripts/drawing-investigation-performance.mjs --baseline work/main-6f3d5c7 --runs 100 --cold-runs 5 --check
node scripts/render-worker-study.mjs --span 50 --edits 32 --output work/worker-final
node scripts/render-worker-study.mjs --source work/main-6f3d5c7 --span 50 --edits 32 --output work/worker-main
# Run memory passes separately from timing passes and validation.
node scripts/render-worker-study.mjs --memory --span 50 --edits 32 --output work/worker-memory
```

Add the documented `--chromium` override when required by the environment. Run timing jobs
sequentially, with no heavy tests, sweeps or renders concurrently. Do not rerun full galleries or
benchmarks without a new change, failure or unresolved measurement concern.
