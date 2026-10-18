# Rendering speed assessment and improvement plan

Implementation and measured results: [render-performance-implementation.md](render-performance-implementation.md).

This assessment used the older `c6bced3` baseline. The PR has since been rebased
onto `4ed7acd`; the implementation report contains the updated comparison.
The newer coastline solver from `main` supersedes the local fitting algorithm
that this assessment originally proposed optimizing.

Assessed on 18 October 2026 at `c6bced3`. This is an evaluation and implementation
plan; the renderer has not been changed.

## Assessment

Initial scene construction and base-geography edits are the main unresolved
performance problems. Navigation already uses a worker, a whole-map preview,
sharp viewport images, and a separate selection/hover canvas. Preserve these
improvements. Moving construction into a worker would keep the interface usable,
but would not by itself make the finished map arrive sooner.

Fresh measurements below are medians of three runs of the existing benchmark:

```sh
node --import tsx scripts/render-performance.ts --size 50 --runs 3
```

Node 24.19.0, two-core CPU quota, 26-pixel hex radius, Parchment style,
smooth coasts, fixed seeds. These synthetic maps populate base geography only;
these are construction times, not browser paint or complete opening times.
Raw results are in [render-performance-assessment-results.json](render-performance-assessment-results.json).

| 50×50 fixture | Fresh scene | Enable hex labels, same map | Edit one base hex |
| --- | ---: | ---: | ---: |
| Continent | 11.350 s | 0.014 s | 11.687 s |
| Archipelago | 17.128 s | 0.012 s | 18.185 s |
| Lakes | 0.635 s | 0.247 s | 0.650 s |

This shows strong sensitivity to coastal geometry and a large gap between
cached display rebuilds and base edits. It does not establish a regression
against older reports: there was no controlled before/after comparison in this
assessment, and fixtures and execution environments differ.

The repository's earlier Chromium measurements provide complementary evidence:

* A populated 40×40 map with all eight layers and labels took 4.727–5.799 s to
  construct and 5.359–6.433 s including direct canvas drawing. Median total was
  5.512 s; construction accounts for approximately 89% of that median run.
  The existing one-second cold-render budget failed.
* Recorded worker navigation tests passed their 33 ms next-frame proxy,
  33.5 ms frame-gap and one-second sharp-image budgets at DPR 1 and 2.
  Final sharp images arrived within approximately 404 ms in those runs.
* Scene data and export pixels matched the earlier reference. Worker display
  edge antialiasing differs from the old HTMLCanvas path; fidelity comparisons
  must use the same rendering backend and compositing mode.

Sources: [cold report](render-cold-followup-results.json),
[navigation report](render-navigation-stress-results.json), and
[methodology](render-performance.md). Browser tests were not rerun for this
assessment: scratch browser-driver installation was interrupted during network
permission setup. Fresh Node results and historical browser results are separate.

## Where to investigate

`MapView.tsx` calls `buildStaticScene` synchronously inside `useMemo`. React still
waits for construction on opening, relevant option changes, and data edits.
`paint.worker.ts` receives an already built scene: it moves painting off the
main thread, not construction. Its first reply also waits for both viewport and
overview rendering; measure whether this unnecessarily delays first presentation.

`scene.ts:cachedCoast` fits geometry through up to 16 global passes, repeatedly
flattening outlines, preparing coverage, and measuring affected hexes. Explicitly
fitted passages may also try endpoints and up to 12 bisection steps, retracing
candidate geometry. These are inspection-based profiling candidates, not measured
function-level attribution. Existing area-query and component caches already
avoid some work; simply adding another generic cache is insufficient.

The top-level coast cache uses base-array identity. A base edit replaces that
array, while component caches can still reuse some unchanged geometry. Large
connected coasts and their clearance/area dependencies need particular care:
an edit can affect more than the immediately adjacent hexes.

## Ordered implementation plan

1. **Establish a measured baseline and fidelity gate.** Profile the actual
   production browser build with separate spans for surface construction,
   coastline tracing, area fitting, symbol fitting, labels, scene copying,
   worker overview, sharp paint, and presentation. Record cold, warm and edit
   cases separately. Retain the current fixed seeds and add explicit strait,
   isthmus, dense island, lake and ice fixtures, all irregularity settings,
   map-edge coasts, and extreme land-share/width values. Measure true map-open
   time including fonts and first worker reply as well as the existing isolated
   rendering interval. Start with three independent runs; use more runs for
   latency percentiles rather than reporting a p95 from three observations.

2. **Remove repeated work without changing fitting results.** Use the profile
   to select the first hotspot. Reuse immutable candidate outlines, flattened
   rings, bounds, stroke coverage preparations and spatial indexes within a
   fitting pass. Preserve global ray parity for enclosing contours and holes.
   Reuse unchanged component results across candidate traces only when their
   full shape and clearance constraints match. Keep arithmetic order where
   practical and require unchanged scene hashes. Do not reduce samples,
   iterations, tolerances, roughness or smoothing widths to gain speed.

3. **Make rebuilds depend on what changed.** Retain coast results for label,
   polity, city and other changes that do not alter the shoreline. Extend reuse
   across base edits with bounded component caches and explicit invalidation
   for component joins/splits, surrounding clearance, lake relationships,
   seed, dimensions, shape settings and coastline ink width. Rebuild the whole
   affected component when dependency safety cannot be established. A one-hex
   invalidation radius is not generally correct. Compare each incremental
   result with an independent fresh build after edits, undo and redo.

4. **Move scene construction into a persistent worker.** Send map/options
   snapshots and build beside the painter, retaining worker-local caches.
   Load the same fonts before layout. Return images and the compact metadata
   the UI needs, including compromises and marker information, without copying
   the full primitive tree back on every view change. Preserve export behavior
   and account for scene-associated WeakMap data/functions, which structured
   cloning does not transfer. Use revision IDs, one latest pending request,
   stale-result rejection and bitmap cleanup. Synchronous construction cannot
   process cancellation messages mid-build; add yielding between safe stages
   or accept completion before starting the latest request. Keep the existing
   map visible with a busy indication until its replacement is ready.

5. **Optimize first paint only if the profile warrants it.** Measure posting
   the sharp viewport before building the overview, with navigation behavior
   defined while overview coverage is pending. Reuse dense clipped layers or
   spatially indexed raster tiles if painting remains significant. Keep
   drawing order, donor colors, clipping rules and globally shared coast
   geometry. Tiles need stroke/effect gutters and seam tests at fractional
   zoom and DPR 1/2. Bound bitmap/cache memory and close evicted images.

## Acceptance and coastline protection

Deliver each stage separately and rerun the same fixtures on the same machine.
The existing goal remains under one second for the populated 40×40 isolated
cold-render test; worker responsiveness is a separate result, not evidence that
this goal was met. Preserve existing navigation gates, test responsiveness
during cold construction, and report end-to-end opening/edit latency, long
tasks and memory alongside construction time. Confirm that non-coastal and
cached display cases do not materially regress.

For computational optimizations, require complete scene equality and exact
pixels against the current revision on the same backend. For worker relocation,
compare worker output to an equivalent synchronous OffscreenCanvas reference
with identical fonts and compositor. Keep SVG geometry and PNG export checks.
Inspect coast close-ups at fit scale and high zoom: donor-fill seams, holes,
land share, narrow passage connectivity/width, isolated islands, ice boundaries
and map-edge clipping must remain intact. Any unavoidable raster difference
needs a localized explanation and review; a permissive whole-image threshold
could hide a damaged narrow strait.

Run the existing component-coast, area, strait, land-share, land-placement,
canvas, bounds and worker lifecycle tests, followed by type checking, production
build and the browser fidelity/navigation scripts. No renderer implementation
or expected coastline output was changed as part of this assessment.
