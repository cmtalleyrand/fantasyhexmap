# Populated-map rendering: implementation and browser validation plan

Plan against `4ed7acd`, 18 October 2026. Scope: construction, coast fitting,
incremental edits, placement reuse and first display. Each step ships with its
own browser evidence. Timings below are proposed acceptance gates, not results.

The reported 3.9-second populated-map build needs a current trace. Existing
reports use different revisions and workloads: the all-layer browser follow-up
records 4.7–5.8 seconds of construction, while the coast feature benchmark is a
separate 30×30 map. Do not use either as an explanation of the 3.9 seconds.

## 1. Profile the actual slow fixture and establish the browser gate

Start with `scripts/render-all-layers-fixture.ts` and the production-app
IndexedDB loading path in `scripts/render-app-scrolling-performance.mjs`.
Confirm this reproduces the reported map; if it does not, retain the exact slow
map as a sanitized, versioned fixture. Save its content hash, seed, dimensions,
shape settings, enabled layers, labels, style and lettering. The current
all-layer fixture regenerates mock data; freeze the input so future generator
changes cannot silently change the benchmark. Keep the 30×30 feature fixture
as additional coast coverage, not a substitute for the populated map.

Add opt-in stage timings and counters around:

- IndexedDB load, worker startup, font readiness and request queueing.
- Map cloning and `stableMap` comparison; surface/lake construction, shaping,
  component silhouette, passage re-bracketing, coupled area fitting and audit.
- Land tests, island fitting, relief/vegetation placement, city/feature/polity
  labels, and primitive assembly.
- Build-worker reply, main-thread receipt, paint-worker receipt, viewport paint,
  overview paint, bitmap receipt and the frame that displays it.

Use request IDs and map/scene revisions throughout. Record durations within
each worker and translate timestamp origins when constructing a cross-worker
timeline. Measure sender `postMessage` time and receipt delay separately;
receipt delay includes scheduling and is not pure cloning time. Count messages,
payload sizes outside timed runs, fit rounds, measurements, cache hits/misses,
rebuilt components and stale jobs. Capture a CPU profile of the actual build
worker and a browser trace including the main and paint threads. Account for
GC and unclassified time. Profile separately from acceptance runs to avoid
charging profiling overhead to the result.

Browser validation: serve the production build, load through IndexedDB, and
verify all eight populated layers and requested labels are active. Measure
opening to first nonblank map and to current sharp map, then each edit to its
correct sharp frame. Record input-to-next-frame latency, rAF gaps and main-thread
long tasks while opening and rebuilding, as well as during settled navigation.
Use native pan/zoom, sidebar scroll, mobile page scroll and selection.

Deliver a stage table and trace identifying where the measured construction
time goes, plus baseline PNGs. Run at least ten fresh-page openings and twenty
edits per scenario; report median, p95, maximum and raw samples. Separate cold
browser/font-cache runs from warm reopenings and warm worker caches. Keep
browser version, viewport, DPR, CPU settings and raster-thread settings fixed;
run baseline and candidate sequentially in alternating order. Preserve existing
navigation gates: 33 ms input response, 33.5 ms frame cadence and 1000 ms final
sharp completion, reporting every failure rather than hiding outliers.

## 2. Reuse coast-fitting work without changing the solve

Change `src/render/coastArea.ts`, `footprint.ts` and the coast stages of
`scene.ts` in measured order. Preserve sampling density, seeded skew, fit
rounds, solver tolerances, passage constraints and crossing checks initially.

Cache fixed inputs per fit: hex centres/corners, seeded swell centres, target
indices, neighbour membership, closed/open flags and target-independent page
geometry. Replace the all-pairs neighbour search with deterministic hex-neighbour
enumeration, retaining the existing accumulation order. Reuse solver buffers
where safe, clearing them between uses. Carry polygon rings directly into
coverage preparation instead of repeatedly constructing paths and flattening
the same lines. Reuse unchanged rings and coverage partitions across trials.

Keep moving quantities fresh: point weights and nearest-hex assignments,
normals, lengths, passage fade, clearance and crossing indexes must update
when their geometry changes. Cache these only by geometry revision or with a
proven conservative dependency region. Whole-ring parity and holes must remain
correct when coverage queries are prepared for one hex. Profile each change;
discard added cache complexity that does not reduce the measured cost.

Browser validation: repeat opening, coast edits and interaction-during-build
measurements on the populated and feature fixtures. Compare coast-only masks
and full-map pixels at fit-to-map, 1× and maximum supported zoom, DPR 1 and 2.
Require identical coast geometry and same-renderer pixels for reuse-only
changes. Recheck per-hex land shares including ink, compromise records, narrow
passage widths/connectivity, ring counts and island/lake separation. Target at
least 30% less coast-fit time without worsening end-to-end p95; revise the
target from the profile before implementation if fitting is a minor contributor.

## 3. Rebuild affected coast components with explicit invalidation

The existing `coastCache` is keyed by the entire base-array identity; `shapeMemo`
already reuses some local cuts. Introduce persistent component records under
`cachedCoast`, holding shaped inputs, fitted geometry, coverage, land predicates
and dependency revisions. Define components by their actual dependency graph:
connected surface boundaries, lake containment, fitting-field influence,
clearance interactions and shared passage joins. Separate rings are not
automatically independent. Keep neighbouring components coupled where required.

Diff edited base cells and shape settings. Invalidate records intersecting old
or new dependencies, then expand until the dependency closure is stable. On a
merge, invalidate every old component and build the new combined component;
on a split or deletion, discard the old component and rebuild all survivors.
Include the edited cell's old and new lake/island classification and passages.
Recompute global topology when necessary before deciding what geometry is
reusable; a cheap topology scan is preferable to stale results. Reassemble
primitives in the full builder's deterministic order.

Include map identity, dimensions, seed, scale, irregularity, shape defaults,
land-share/width settings and coastline ink reach in dependencies. Global
changes invalidate all affected records. Unrelated layer edits reuse coast
records. Evict records on map replacement and bound retained cache memory.
Keep a forced-full-build path and fall back to it when dependencies cannot be
bounded confidently. A large connected mainland can still require a large
rebuild; this step does not promise constant-time coastal edits.

Browser validation: replay inland and shoreline edits, shares, concentration,
widths, islands/lakes, bridges that merge components, cuts that split them,
undo/redo, dimension/seed/style changes and map switching. After every edit,
compare the incremental result with a fresh full build of the same state,
including compromises and coast pixels. Also replay rapid edit bursts and
verify only the newest revision appears. Unaffected components must have zero
fit calls and identical geometry. Target p95 under 250 ms for edits confined to
small independent components, and at least 50% lower median latency for that
set; publish large-mainland latency separately. Recheck opening time and
responsiveness so cache management does not move the cost elsewhere.

## 4. Cache symbol and label placement by its real inputs

Extend the existing `symbolFits` and polity-label cache rather than adding a
second competing cache. Split placement results from primitive styling so
colour/opacity changes can reuse positions. Use stable land/component revisions
instead of a newly allocated land-test function as evidence of terrain changes.

Symbol dependencies include the relevant terrain layer, local drawn land,
seed, symbol family/scale and any obstacles the placement actually reads.
Label dependencies include text and names, ownership, city markers, rivers,
land/lakes, visible obstacle families, placement policy, lettering/measurement
epoch, size and earlier label placements. Audit `cachedPolityLabels`: it accepts
an obstacle list but currently compares a narrower set of inputs. Give obstacle
sets explicit revisions and preserve placement order. If an earlier label
moves, invalidate downstream placements whose candidate search can encounter
it; use whole-family invalidation until a narrower dependency is proven.

Browser validation: measure warm display-option changes and unrelated edits;
instrument placement hits and require zero searches for unchanged dependencies.
Change each dependency independently, including fonts becoming ready, and
compare cached output with forced-uncached placement. Check label collisions,
symbols on land, positions, full-map pixels and unchanged coastline pixels.
Target at least 80% less placement time on eligible cache-hit rebuilds and
p95 under 100 ms from an eligible display change to sharp display. Repeat
cold opening and navigation checks to expose cache overhead or stale obstacles.

## 5. Shorten first display and worker hand-off

Today `build.worker.ts` returns the full scene to React, which sends it to the
paint worker. `paint.worker.ts` paints the viewport and then the whole overview
before returning either bitmap. `MapView.tsx` also waits 140 ms before refreshing
sharp detail when an overview is available; that timer is a navigation debounce,
not a delay on every first paint.

First, return the viewport bitmap immediately and send the overview in a separate
versioned reply. Yield between jobs so a newer scene/view can supersede an old
overview. Update `ScenePainter` to handle separate replies without dropping job
context too early, close stale bitmaps and avoid waiting for an overview to show
sharp pixels. Schedule sharp paint immediately for a new scene; retain or tune
the navigation debounce from measured responsiveness and completion latency.

Then use the trace to choose the hand-off change. Prefer a direct build-to-paint
`MessageChannel` so the large scene does not bounce through the main thread;
send React only required metadata and revision acknowledgements. Audit main-thread
scene consumers first, including decorations, compromises, export and fallback.
Request full scenes on demand where possible. If cloning still dominates,
prototype transferable packed geometry with explicit buffer ownership and
memory accounting. Do not transfer buffers that a cache still needs. Combining
workers is an alternative only if build work cannot starve navigation painting.

Browser validation: trace bytes/messages, main-thread blocking, viewport and
overview completion separately. Test pan/zoom before the overview exists, rapid
edits, resize, map switching, font changes, stale replies and worker failure.
Require displayed bitmaps to match a full same-compositor reference, with no
blank flashes after first display and no older revision overwriting a newer
one. Coast-only and export pixel gates still apply. Target first sharp receipt
within one frame of viewport-paint completion, excluding measured transfer;
overview work must not delay it. Final combined gate: populated-map cold opening
to sharp display under the existing 1000 ms budget, alongside the edit and
responsiveness gates above. If it fails, report the remaining stage costs.

## Evidence and delivery order

Implement as five reviewable changes in the order above. The early bitmap reply
can follow profiling independently of component caching. Each change includes
its stage timings, opening/edit/interaction report and coast comparison artifacts.
Extend the existing browser scripts and add a production-app opening/edit runner;
remove hard-coded scratch dependency paths so the commands work on a clean
checkout. Use the coast gallery and `coast-outline-compare.mjs` for supplementary
geometry overlays, not as a replacement for pixel comparisons.

Save baseline/candidate/reference PNGs, difference images, changed-pixel counts,
maximum channel delta, coast edge displacement, share measurements and raw
timings. Compare like renderers: HTMLCanvas and OffscreenCanvas already differ
in edge antialiasing. For these calculation/cache changes, default to exact
same-renderer equality; never accept a broad pixel tolerance that can hide a
closed strait or lost shoreline detail. Any intentional geometry change needs
separate review and explicit fixture-level evidence.

Before each change is complete, run focused invalidation/protocol tests, the
existing coast and placement regressions, `npm run typecheck`, `npm run build`,
and the applicable production browser scenarios. Run the full test suite and
all five outcome gates on the combined result. Keep the original frozen baseline
throughout so improvements are measured cumulatively as well as per change.
