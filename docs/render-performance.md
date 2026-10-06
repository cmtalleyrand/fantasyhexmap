# Map rendering performance verification

Measured on 6 October 2026 against `80a1ca9` (the merged component-coastline PR #128).
The initial PR #129 addressed pointer repainting; these additional fixes address
scene construction and lake fitting. The baseline coastline geometry, sample
spacing, Gaussian filter widths, area policies, and irregular features are preserved.

## Scene construction

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

## Browser checks

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

## 40×40 populated all-layer acceptance test

The cold-render target is **under 1000 ms**, including scene construction and
canvas drawing with all eight populated layers and labels enabled. It is
**not met**. PR #132 remains a draft.

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

## Navigation and ordinary scrolling

Previously every wheel/zoom or pan changed the view and replayed the complete
scene into a viewport-sized canvas. Hover caching did not cover that path.
The denser component coasts made each replay more expensive.

MapView now keeps a separate map raster. During wheel, pan and resize gestures
it copies cached pixels; 140 ms after changes stop it directly paints the
settled viewport to preserve exact antialiasing. A raster is refreshed when
its scene, pixel ratio, coverage or zoom resolution requires it. Large maps
use a viewport window with overscan instead of allocating a full-map canvas
at high zoom. Fonts load before the first full layout, avoiding a second full
layout with different metrics immediately after startup.

The navigation test uses the same populated 40×40 map and all eight layers.
It measures twenty wheel ticks, twenty pan moves and twenty resize events,
checks canvas draw counts, and compares initial and settled images exactly.
Measured navigation medians against the same map-bounds baseline are:

| Interaction | Baseline | Follow-up | Reduction |
| --- | ---: | ---: | ---: |
| Wheel zoom | 543.9 ms | 33.1 ms | 94% |
| Right-button pan | 480.0 ms | 50.0 ms | 90% |
| Resize | 477.0 ms | 33.3 ms | 93% |

The maximum follow-up response across these tests is 54.2 ms. Full-scene fills
during each twenty-event gesture drop from roughly 490,000–516,000 calls to
zero. Initial and settled canvas images match exactly. Hover decorations still
paint independently. The large-zoom raster check uses about 4.13 million pixels
rather than a full 4500×3900 scene at four-times zoom and double pixel density.

The separate production-app test loads the map through IndexedDB, activates
all layers, and uses native mouse-wheel scrolling on the desktop sidebar and
mobile page. It requires actual scroll movement, no unchanged-map redraws and
responses below one second. The final production run has medians of 50.3 ms
on desktop and 50.1 ms on mobile, maxima of 414.6 ms and 226.2 ms, and zero
canvas fills, strokes or copies. It records occasional long tasks (117–199 ms),
so the result does not establish consistently smooth frame-rate scrolling.
These tests cover settled scrolling; they do not
prove that scrolling remains responsive during synchronous cold construction.

## Reproduce the follow-up checks

Install the scratch browser driver as above, build the app, and fetch the
immutable map-bounds baseline if it is not already available:

```sh
git fetch origin pull/131/head:performance-map-bounds
node --import tsx --test --test-concurrency=1 test/*.test.ts
npm run typecheck
npm run build
node scripts/render-all-layers-performance.mjs --baseline 8acfcc0 --check
node scripts/render-navigation-performance.mjs --baseline 8acfcc0
node scripts/render-browser-performance.mjs --baseline 8acfcc0
node scripts/render-app-scrolling-performance.mjs
```

Run these sequentially so builds and suites do not compete with measurements.
The cold script creates the fixture bundle also used by the production-app
scrolling script. `--check` intentionally fails while any cold run takes 1000 ms
or more. Geometry and pixel differences fail independently of the budget flag.
Fresh raw reports are written under `work/`; reviewable results are recorded
under `docs/`.

The final complete sequential correctness suite passes all 44 test files;
type checking and the production build pass. An earlier suite had one
intermittent `mapStyle` failure; its isolated rerun and the final full suite
passed. Browser checks pass for three coastline layouts, scene data, canvas
pixels, hover, selection and immediate/settled zoom. The populated-map
navigation and production-app scrolling checks also pass. The cold one-second
acceptance check remains a failing gate.

Raw follow-up reports:

- `docs/render-all-layers-performance-results.json`
- `docs/render-navigation-performance-results.json`
- `docs/render-browser-performance-followup-results.json`
- `docs/render-app-scrolling-performance-results.json`
