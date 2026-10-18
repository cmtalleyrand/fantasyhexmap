# Coast component and placement reuse

Parts 3 and 4 follow the populated-map profiling and calculation reuse in
[parts 1–2](render-optimization-parts-1-2.md). The comparison source and production
build were saved in `work/part34-baseline` before these changes. The populated
input remains the frozen 40×40 all-layer fixture.

## Coast dependencies and invalidation

`coastGeometryOf` keeps bounded component records containing the silhouette,
land/water donor patches and anchors. Keys contain the ordered boundary,
closed/open state, per-edge policies, component area, ink, seeded features and
every edge in the clearance-query neighbourhood. A topology scan still runs
after base edits. Merges and splits change boundary keys; an approaching coast
changes the neighbouring clearance keys. Assembly retains the original order.

The complete coast cache now uses content snapshots, including dimensions,
seed, scale, irregularity, shape defaults, shares and ink. This survives worker
cloning and supports undo without relying on mutable array identity. Local
shape cuts retain their existing memo. Exact coupled-fit inputs have a separate
cache. Whole-coast entries retain coverage, lake topology and land predicates.

**Fitting remains conservative.** The conjugate-gradient coefficients and
stopping decisions couple all fitting rings. Separate ring solves would change
those decisions, so they are one dependency group. Any changed
input rebuilds that entire fit. Independent silhouettes are reusable, including
small aggregate islands; global topology, fitting passes and the final coverage
audit remain global when required. A new edit to a large fitted mainland can
still take seconds. This is not a fully local solver or coverage update.

## Symbol and label placement

Symbol records retain their fitted scale/offset/selection and every land query
made during candidate search, including rejected candidates. With unchanged
terrain inputs, positions are reused immediately. After terrain changes, the
record is reused only if every recorded query gives the same answer. This also
detects a newly available earlier candidate. Symbol family, terrain values,
seed, dimensions and scale are keyed; primitive colours are regenerated.

All label families cache positions separately from styling. Keys include actual
ordered obstacles, relevant ownership/names/features, placement policy, font
roles and the measurement epoch. Polity labels now include city marker bounds.
Hierarchy levels are cached together. Later families include the earlier
placements they avoid, so a moved earlier label invalidates its dependants.
Font readiness invalidates measured layout even without a lettering change.
The measurement epoch now advances when a new face is registered. Ensuring
already loaded fonts on each worker request preserves the epoch and allows
those placement caches to hit.

Map identity, dimensions or scale changes clear the persistent scene caches.
New caches have both entry and estimated-byte limits: complete coasts 4/20 MB,
components 192/16 MB, fit groups 8/12 MB, symbol fits 10,000/16 MB, terrain
revisions 4/1 MB and label families 96/8 MB. These are conservative storage
estimates, not a measured JavaScript heap cap. Existing shape/island memos have
entry caps and now clear on map replacement too.

`SceneOptions.cache = 'off'` bypasses persistent coast and placement reuse without
overwriting live entries. In the production app, `?renderFull` enables that
reference path. Profiling reports component/fit-group hits and builds, symbol
searches/revalidations, and label searches/hits.

## Verification and reproduction

The invalidation suite compares complete scenes with forced-full builds after
shore edits, merges, splits, deletion, undo, shares, concentration, passage
widths, lake/island changes, seed changes, dimensions, scale, map switching,
hidden obstacles, marker changes, ownership/hierarchy changes and lettering.
Separate tests cover font readiness and cache bounds. It explicitly requires
one rebuilt silhouette, a reused distant silhouette and zero fit rounds after
a local edit to the independent-component fixture.
Validation fixtures are type-checked too, including supported marker/font
choices and explicit large/small island counts.

Browser pixel validation replays the same sequence and compares against a
separate forced-full renderer with independent painter state. Worker views
receive cloned scenes, matching the production transfer boundary; export views
use HTMLCanvas directly. Comparisons include full-map and coast-only rendering,
fit and 4× zoom, DPR 1 and 2, with exact equality and nonempty fit coast masks.
Reference, candidate and difference PNGs are retained alongside the raw report.

Production-app benchmarks use IndexedDB loading, all eight layers, real inspector
edits, native wheel input, desktop sidebar/mobile scrolling and keyboard changes
to the opacity slider. Rapid edit bursts check that the newest request is the
one displayed. Timing scenarios run sequentially, separately from pixel checks.
The repeated shore edits alternate two states: later hits include undo/revisit
reuse, and must not be interpreted as timings for arbitrary new mainland edits.

```sh
node --import tsx --test test/*.test.ts
npm run typecheck
npm run typecheck:render-fixtures
npm run build
npm run perf:incremental -- --driver /path/to/playwright-core/index.mjs
node scripts/render-parts34-validation.mjs --driver /path/to/playwright-core/index.mjs
```

The combined runner expects the saved `work/part34-baseline` checkout/build and
`work/part34-components.json`. Use `componentFixture()` from
`scripts/render-edit-fixtures.ts` to write the latter. Individual opening and
pixel runners accept output paths; the construction runner accepts `--reference`.

## Production-app results

The full 51-file test suite, application and fixture type checks, and production
build pass. Sixty complete-scene comparisons with the saved renderer pass.
Browser validation passes 944 incremental/reference comparisons across 59 edit
states and 96 saved-renderer comparisons: **1,040 exact pixel matches**, with
zero changed pixels and nonempty fit coast masks. This includes compromises,
font loading, narrowed passages and both export and worker compositors.

In a separately profiled production worker, a warm opacity rebuild reuses all
539 symbol fits and six label families with zero placement searches. The first
Settings save in that run misses the complete-coast key: it reuses the exact fit
group, revalidates 539 symbols and searches one label family. Both requests are
retained in the report rather than treating every Settings save as a cache hit.

Chromium construction timings use twenty samples per version/scenario and call
font readiness on every request, matching the build worker:

| Construction measurement (ms, median / p95) | Before | After |
| --- | ---: | ---: |
| Populated warm rebuild | 193.1 / 289.2 | 117.4 / 255.7 |
| Its symbol and label phases | 82.9 / 103.5 | 11.1 / 19.3 |
| Independent coast, alternating states | 10.3 / 15.3 | 2.3 / 6.9 |
| Twenty distinct local shore edits | 21.5 / 168.1 | 14.4 / 141.4 |

The symbol/label phase median falls 87%, exceeding the 80% construction target,
and eligible rebuilds perform zero placement searches. Distinct shore edits
include states that need the coupled fit; their 33% median construction saving
is smaller than the 78% saving when revisiting two independent coast states.

Ten fresh-context openings per version/scenario, twenty edits per scenario;
the populated scenario also has ten warm-context reopenings. Chromium uses
one raster thread, a 1400×900 viewport and DPR 1, without CPU throttling.
Baseline and candidate scenarios run sequentially. Times below include driver
click initiation, worker construction, transfer, painting and sharp display.

| Outcome (ms, median / p95 / maximum) | Before | After |
| --- | ---: | ---: |
| Populated cold opening | 4929 / 5107 / 5107 | 5056 / 5745 / 5745 |
| Populated edit, alternating two states | 3319 / 3769 / 3995 | 1088 / 1239 / 3823 |
| Small-component shore edit | 306 / 322 / 335 | 288 / 313 / 320 |
| Apply an opacity change | 1108 / 1260 / 1332 | 1120 / 1227 / 1653 |

The populated median improves 67% when revisiting states. Its first new shore
edit still takes 3823 ms (one sample; before: 3573 ms). Cold opening does not
improve: the primary populated run has a 2.6% higher median and 12.5% higher
p95. These changes therefore do not meet the opening target or establish a
first-build performance improvement.

Small-component editing misses the 250 ms p95 target and the 50% median reduction
target, despite reusing the distant silhouette. The opacity change remains
about 1.1 seconds and misses the 100 ms target. Placement reuse alone does not
remove the remaining scene assembly, transfer and paint costs.

Native input response and 33.5 ms frame cadence pass for the small-component
fixture. Populated editing passes the 33 ms input gate but fails frame cadence.
Opacity changes fail both input and cadence gates, including in the baseline.
Desktop sidebar and mobile page scrolling move correctly; rapid bursts end on
the newest build in both edited fixtures. The remaining first-display/worker
hand-off work in part 5 has not been implemented here.

Full samples, maxima, construction phases, cache counters and source hashes are
in [the browser report](render-browser-parts-3-4-results.json). Exact scenes and
pixel results are in [the coast report](render-coast-browser-parts-3-4-results.json)
and [the scene hash report](render-coast-geometry-parts-3-4-results.json).
Raw browser traces, PNG pairs/differences and per-request timings remain under
`work/part34-browser`.
