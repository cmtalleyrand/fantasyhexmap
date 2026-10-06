# Map rendering performance verification

Measured on 6 October 2026 against `80a1ca9` (the merged component-coastline PR #128).
The initial PR #129 addressed pointer repainting; these additional fixes address
scene construction and lake fitting. The baseline coastline geometry, sample
spacing, Gaussian filter widths, area policies, and irregular features are preserved.

## Earlier construction measurements

These are medians of three runs on fixed-seed, 50×50 synthetic maps, using the
Parchment style with smooth coasts and a 26-pixel hex radius. Each run builds a
fresh map, rebuilds with hex labels enabled, then rebuilds after editing a base
hex near the centre. Both revisions use the same fixtures and installed dependencies.
The baseline was measured first, then the final optimized runs were measured
without other tests running. Timings depend on hardware and map content.

| Fixture | Initial build before | Initial build after | Improvement | Display rebuild before → after | Base edit before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Continent | 0.776 s | 0.517 s | 1.5× | 0.011 → 0.012 s | 0.725 → 0.616 s |
| Archipelago | 4.300 s | 1.639 s | 2.6× | 0.026 → 0.024 s | 4.482 → 1.875 s |
| Lakes | 18.753 s | 0.798 s | 23.5× | 21.675 → 0.706 s | 20.095 → 0.789 s |

All nine initial scene SHA-256 hashes match the baseline exactly. This checks
complete scene data, including paths and donor fills. The recorded raw medians, hashes, browser checks, and stress-run
results are in [render-performance-results.json](render-performance-results.json).

## Earlier browser checks

Chromium 151 was run through Puppeteer with software rendering. The browser
script builds the actual baseline and current modules, renders three fixed-seed
30×30 maps, and mounts the real React MapView for interaction checks.

- Continent, archipelago, and lake scenes match exactly as JSON and have zero
  differing canvas pixel channels when rendered at scale 0.5.
- Fifteen hover moves reduce canvas stroke calls from 48,720 to 15. Selection
  updates also copy the viewport instead of repainting the scene.
- Zoom invalidates the viewport and redraws the map; the image changes and
  full-scene stroke calls resume.
- At the viewport's non-integer fit scale, one of 480,000 pixels differs by one
  channel level. The test allows only a one-level rounding difference affecting
  at most 0.01% of pixels. Geometry remains identical.

Pointer timings include browser automation and two animation frames per event,
so stroke counts are the interaction regression gate, not an FPS claim.

## Changes and correctness

Gaussian coefficients are computed once per component radius. Source-edge
roughness and width policies are computed once per edge. Clearance bins use
numeric keys, avoid duplicate edge visits, and reject distant bounding boxes.
Closed components unchanged between fitting passes reuse their silhouettes;
the cache key includes surrounding constraints and policy values, so nearby
coast edits invalidate it. Open coasts skip this cache because their local cuts
move during fitting.

Lake fitting attributes shoreline length to hexes once per pass. Prepared
area scans reuse outline bounds and ignore rings and edges that cannot affect
the queried hex. Ray crossings outside the hex remain included, which is needed
for enclosing outlines and overlap handling.

New tests verify component reuse without repeating noise work, nearby-edit
invalidation with distant-component reuse, and area scans for enclosing and
overlapping contours. All 44 test files pass in the final sequential suite.
Type checking and the production build pass. An earlier concurrent run reported
one mapStyle test failure; its isolated rerun and two subsequent complete
sequential suites passed.

A single-run 100×100 stress check also completes for all three layouts. Large
maps still require seconds to construct: the archipelago initial build takes
about 6.9 seconds here. These fixes improve measured work; they do not move
construction off the browser main thread.

## Reproduce

From the repository root:

```sh
node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run typecheck
npm run build
node --import tsx scripts/render-performance.ts --baseline 80a1ca9 --size 50 --runs 3
```

The benchmark extracts the baseline into `work/`, prints medians, writes
`work/render-performance.json`, and fails if initial scene hashes differ.
An existing baseline report can be reused with `--baseline-report <path>` when
rerunning the optimized build; its size and run count must match.

For the browser geometry and interaction checks, install the driver in scratch
storage (no application dependency changes) and use an installed Chromium:

```sh
npm install --prefix work --no-audit --no-fund puppeteer-core
node scripts/render-browser-performance.mjs --baseline 80a1ca9
```

Use `--chromium /path/to/browser` if Chromium is elsewhere. The browser script
fails on changed scene data, pixel differences outside the stated bounds,
full-scene hover repainting, selection repainting, or failed zoom invalidation.
It writes `work/render-browser-performance.json`.

## Earlier 40×40 populated all-layer acceptance test

The cold-render target is **under 1000 ms**, including scene construction and
canvas drawing with all eight populated layers and labels enabled. It is
**not met**. This follow-up remains a draft.

The offline generator and normal decoders produce a fixed 40×40 map containing
539 populated land cells in each terrain/population layer, 13 rivers, 29 cities
and 10 polities. Three independent browser pages use different rendering seeds.
The parchment preset uses smooth coastlines and its actual bundled fonts,
loaded before timing. The 1000×800 canvas displays the whole map at half scale;
reading its pixels forces queued drawing to finish inside the measured interval.
Generation, font loading and application startup are excluded from the timing.
Execution order alternates between baseline-first and follow-up-first.

The comparison includes the map-bounds fix from PR #131 (`8acfcc0`) on both
sides. That PR is a rectangular drawing clip, rather than a geometry rebuild.
The two feature changes under investigation are PRs #127 and #128; the latter
introduced densely sampled whole-component coasts, their swept donor patches
and additional silhouette clips. These features are retained.

| Seed | Baseline | Follow-up |
| --- | ---: | ---: |
| 0 | 13.368 s | 4.351 s |
| 1 | 5.220 s | 5.148 s |
| 2 | 8.993 s | 7.231 s |
| Median | 8.993 s | 5.148 s |

This batch improves the median by about 43%, but the individual gains range
from about 1% to 67%. Earlier batches varied substantially, including one
median regression. These measurements do not establish a stable overall speedup
or meet the requested budget. All three complete scenes are identical to the
baseline and all three pixel comparisons have zero differing channels.

The revised construction retains raw swept polygons during coastline fitting,
materializes render commands only when needed, and omits the extra final trace
that was discarded without measurement. Realm path accumulators append each
patch once instead of repeatedly copying growing arrays. Polity label searches
stop when the maximum possible score cannot beat the best candidate. Earlier
spatial-query optimizations remain in place.

## Worker navigation and ordinary scrolling

The previous raster-cache fix was incomplete. Its small, continuous gestures
missed two expensive paths: a synchronous full paint after a 140 ms pause, and
another synchronous raster paint when panning beyond cached coverage. The new
production-app stress test reproduces both. It uses native wheel deltas of
120–160, paused zooms, large right-button drags, and double pixel density with
all eight populated layers active.

Profiling identifies a second cost inside painting: the donor-ground underlay
draws about 1,750 overlapping polygons through a 10,399-command coastline clip.
That group alone took approximately 860 ms in a diagnostic paint. Bounding-box
culling and trimming offscreen path segments did not solve this cost; those
segment-trimming experiments are not included in the change.

The renderer now retains a whole-map preview capped at four million pixels,
so navigation always has coverage. A worker builds sharp viewport images after
140 ms idle. There is one request in flight and only the latest pending view;
stale images are closed rather than displayed. Conservative bounds skip
invisible primitives. Dense clipped groups rasterize their children into a
reused transparent surface, then apply the coastline clip once to the composite.
This preserves the component geometry, holes, donor colors and layer ordering.

Cached navigation updates commit during the input event. The map is painted
directly onto the visible canvas; a separate transparent canvas holds hover
and selection marks. Pointer decoration changes therefore neither copy nor
repaint the map. Browsers without a usable worker/OffscreenCanvas retain the
previous synchronous fallback; the new timing budget is verified for Chromium's
worker path only.

The gate measures the actual input event through the next animation-frame
callback (below **33 ms**), frame gaps while the image sharpens (at most
**33.5 ms**, allowing two 60 Hz frames), and final sharp-image presentation
(below **1000 ms**). It requires zero main-thread full-scene fills. The next
callback precedes presentation and is a latency proxy; a second callback is
also recorded conservatively, rather than silently counting two-frame waiting
time as rendering work. Sharp latency starts just before automation delivers
the last input, so it includes that delivery overhead.

| Interaction | Before worst automation response, DPR 2 | After two-frame input interval, DPR 1 | After two-frame input interval, DPR 2 | After sharp image, DPR 2 |
| --- | ---: | ---: | ---: | ---: |
| large continuous zoom | 50.1 ms | 17.0 ms | 24.5 ms | 327.2 ms |
| paused zoom out | 2667.1 ms | 16.8 ms | 25.0 ms | 403.1 ms |
| paused zoom in | 51.8 ms | 19.0 ms | 28.8 ms | 327.9 ms |
| pan across cached-window boundaries | 1191.4 ms | 17.8 ms | 19.2 ms | 194.4 ms |

The before automation column and after input column have different origins;
do not calculate a speedup between them. Comparable automation timings are
retained in the raw report: paused zoom-out drops from 2667 ms to 59.5 ms
(about 98%), and the boundary pan from 1191 ms to 64.2 ms (about 95%).
Both final density runs pass all three gates, with no main-thread full-scene
fills or observed long tasks. Maximum frame gaps are 33.3 ms at DPR 1 and
16.8 ms at DPR 2. The next-frame proxy is at most 2.1 ms; the two-frame interval
is at most 19 ms / 28.8 ms. Sharp completion is at most 259 ms / 404 ms.

This environment has a two-core CPU quota but exposes many CPUs to Chromium.
With default software raster threading, one primary run had a 50 ms frame gap
and a 59 ms long task; a profiled rerun had a 116.7 ms gap. The profile showed
mostly idle/native browser time and large sampling gaps, rather than expensive
navigation JavaScript or garbage collection. The final comparison uses
`--num-raster-threads=1` on **both revisions** to match the allocated CPU budget;
it records zero quota-throttled time during the final DPR 2 gestures. The
failed unconstrained runs remain in the raw report. These results are fixed-
fixture measurements, not a universal browser or hardware frame-rate guarantee.

Scene JSON and ordinary canvas export pixels still match the previous revision
exactly for continent, archipelago and lake fixtures. The populated-map worker
images match a full, uncropped synchronous OffscreenCanvas render using the
same compositor exactly, including lettering. Selection tests require visible
ink in the transparent overlay and unchanged map pixels, with no map copy.

Displayed edge pixels are **not byte-identical** to the old renderer.
OffscreenCanvas has different coastline-edge antialiasing from HTMLCanvas,
and applying a group's clip once changes coverage accumulation where donor
patches overlap at the clip edge. The raw browser reports retain those display
pixel differences rather than treating the old and new images as identical.
The 40×40 before/after images were also inspected visually. PNG/SVG export
continues using the original rendering path.

The separate production-app scrolling test loads the map through IndexedDB,
activates all layers and uses native wheel scrolling on the desktop sidebar
and mobile page. It requires actual movement and no unchanged-map drawing.
The final settled run observes zero fills, strokes or copies and no long tasks;
worst automation responses are 67.6 ms on desktop and 52.0 ms on mobile. An
initial run caught one delayed worker completion copy. The final test waits for
actual worker-idle and sharp-frame completion before measuring scrolling,
rather than relying on an 800 ms delay. These checks do not establish
responsiveness during still-synchronous cold scene construction.

## Reproduce the follow-up checks

Install the scratch browser driver as above, then run these sequentially:

```sh
node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run typecheck
npm run build
node scripts/render-all-layers-performance.mjs --baseline 42611d2 --check
node scripts/render-navigation-stress.mjs --check
node scripts/render-navigation-stress.mjs --dpr2 --check
node scripts/render-browser-performance.mjs --baseline 42611d2
node scripts/render-navigation-performance.mjs --baseline 42611d2
node scripts/render-app-scrolling-performance.mjs
```

The cold script creates the fixture bundle used by the production-app scripts.
Its `--check` still fails the cold one-second budget. The constructor has not
been moved into the worker. Navigation has its own independent failing gates
for input latency and final sharp-image latency. Worker regression fixtures
use an esbuild worker plugin; the stress and scrolling tests serve Vite's
actual production build and exercise its worker CSP and font assets.

The stress script accepts `--dist <directory> --baseline` to serve an archived
production build without waiting for worker replies. The recorded before run
used current main at `42611d2`; the original, smaller warmed
navigation test was insufficient to characterize its worst cases.

The final sequential suite passes **427 tests in 47 files**. Type checking and
the production build pass. Both native navigation density runs pass the 33 ms next-frame,
33.5 ms cadence and 1000 ms sharp-image gates. Layout, worker-reference, overlay,
resize and unchanged-map scrolling regression checks pass.

A fresh cold check against `42611d2` still **fails**: construction takes
4.727–5.799 s before painting; total direct rendering takes
5.359–6.433 s. All three complete all-layer scenes and export pixel
buffers match exactly. This check uses the direct/export paint path rather
than the worker compositor; construction alone already exceeds the display
budget. The new strait fitting previously rebuilt global coverage and stroke
polygons for each local query. Restricting preparation to the queried hex
preserves ray crossings, holes, ink unions and the fitting sample count. The
batch's median construction falls from 6.497 s to 4.896 s;
this improvement does not meet the cold target. Tests also verify unrestricted
fallback for queries outside the prepared region. The unsuccessful crossing-
index experiment was removed.

Raw reports:

- `docs/render-all-layers-performance-results.json` (earlier cold measurements)
- `docs/render-cold-followup-results.json` (fresh cold gate and all-layer geometry/export fidelity)
- `docs/render-navigation-stress-results.json` (expanded native navigation)
- `docs/render-navigation-performance-results.json` (all-layer fidelity and small gestures)
- `docs/render-browser-performance-followup-results.json` (layout and interaction fidelity)
- `docs/render-app-scrolling-performance-results.json` (native settled scrolling)
