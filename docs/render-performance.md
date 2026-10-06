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

The stricter target is **under 1000 ms**, including cold scene construction and
canvas drawing, with all eight populated layers and labels enabled. This target
is **not met**. The follow-up remains a draft.

The offline generator and normal decoders produce a fixed 40×40 map containing
539 populated land cells in each terrain/population layer, 13 rivers, 29 cities
and 10 polities. Three independent browser pages use different rendering seeds.
The parchment preset uses smooth coastlines and its actual bundled fonts,
loaded before timing. The 1000×800 canvas displays the whole map at half scale;
reading its pixels forces queued drawing to finish inside the measured interval.
Generation, font loading and application startup are excluded from the timing.

Against merged PR #130 (`7fd124e`), measured total times in Chromium are:

| Seed | Baseline | Follow-up |
| --- | ---: | ---: |
| 0 | 7.309 s | 8.851 s |
| 1 | 5.907 s | 4.958 s |
| 2 | 6.434 s | 6.006 s |
| Median | 6.434 s | 6.006 s |

The coldest follow-up case regresses, and the median improvement is modest.
These results do not establish an adequate fix. All three complete scenes are
identical to the baseline; all three canvas comparisons have zero differing
channels. Coastline construction, geometric fitting, lettering and canvas
painting still need substantial work to reach the budget.

The follow-up prepares clearance candidates, padded convolution inputs,
scanline area edges and point-query bins once, avoids repeated clipping edge
normalization, and searches nearby river points and cumulative lengths without
scanning whole courses. The correctness suite passes all 44 test files, including
a new 10,000-point ray-parity comparison covering holes and boundary conditions.
Type checking and the production build pass.

Reproduce the full acceptance check after installing the scratch browser driver
as described above:

```sh
node scripts/render-all-layers-performance.mjs --baseline 7fd124e --check
```

`--check` exits with an error if any timed run takes 1000 ms or more. Geometry or
pixel differences also fail the script, regardless of the budget flag. Raw results
are recorded in `docs/render-all-layers-performance-results.json`; fresh runs write
`work/render-all-layers-performance.json`.
