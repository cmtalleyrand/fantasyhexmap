# Populated-map profiling and coast reuse

Implemented against `4ed7acd`. The input is the confirmed 40×40 all-layer fixture,
now frozen in `test/fixtures/populated-40.json`, including its seed and settings.
Its timestamps are fixed. Performance scripts record its SHA-256 hash.

## Profiling

The initial Node diagnostic reproduced the reported construction time: 3933 ms.
This is construction without browser font loading, worker hand-off or painting;
it is not an opening-time result.

| Initial diagnostic | Time |
| --- | ---: |
| Scene construction | 3933 ms |
| Coast construction | 3334 ms |
| Initial trace | 248 ms |
| Global fitting passes, including subsequent traces | 591 ms |
| Coupled fitting | 2394 ms |
| Final coast coverage and lake bookkeeping | 26 ms |
| Everything outside coast construction | 599 ms |

Within coupled fitting, area measurements consumed 1323 ms. The fit ran eight
rounds, nine measurement batches, 3213 hex measurements and 896 solver iterations.
The top-level coast phases are non-overlapping; nested timings such as shape,
silhouette and measurement are included in their enclosing phases and must not
be added to them again.

`?renderProfile` enables build/paint-worker diagnostics in the actual app.
Ordinary rendering keeps these diagnostics off. Profiles travel alongside scenes
and bitmaps, never inside scene geometry. They carry worker time origins, stage
start/duration pairs, cache/search counters and request IDs. The browser probe
records sender `postMessage` duration, receive times, scene revisions and sharp
bitmap copies followed by two animation frames. This is a display-frame proxy,
not a hardware presentation timestamp. Receipt delay includes scheduling and
must not be described as pure cloning time. Message sizes are measured after
the timed opening has settled.

The production browser runner loads IndexedDB, enables all eight layers through
the UI, measures cold openings and optional warm reopenings, edits one exposed
mainland hex through the inspector, and injects wheel input during rebuilding.
It records all intermediate/coalesced requests, raw frame gaps, native input
response, long tasks and actual desktop/mobile scrolling. The normal app starts
with Base visible, so all-layer activation time is included in current sharp
completion; first nonblank and all-layer sharp completion are separate results.
CPU profiles and a browser trace are collected in a separate `--profile` run.

## Coast-fitting changes

- Reuse hex centres/corners, seeded swell centres, touched-hex indices and
  neighbour membership for one solve. Enumerate nearby hexes and retain the old
  matrix accumulation order.
- Keep the page-edge closure layout and measure the moving polygon rings directly,
  avoiding repeated path construction and flattening. Open ends remain fixed by
  the existing fade; a fallback handles degenerate rings.
- Reuse bounded, exact scanline crossings when neighbouring hexes query identical
  heights. Cache un-clipped crossings per ring, preserving holes and parity.
  Bin relevant ink segments by height; continue unioning the actual round ink.
- Reuse solver buffers and pack sparse matrix rows once per round, retaining
  floating-point summation order.
- Prepare clearance edge bounds and projection coefficients once per geometry
  revision, sharing them across all queries. Rebuild the index after movement.

The moving weights, normals, passage fade, clearance index and matrix coefficients
are still recomputed for each changed outline. Sampling density, fitting rounds,
solver tolerances, seeded skew and crossing/distortion checks are unchanged.
Caches do not survive the fit. Two experimental ink caches were discarded because
their allocation and lookup costs erased their savings.

## Construction and regression verification

Three fresh-process diagnostic runs per revision, with four warm edits on the
first run, gave these preliminary Node results. Baseline and candidate were run
sequentially, with the same instrumented scene stages and frozen input. These
are small samples and are not browser acceptance results.

| Median | Baseline | Candidate | Reduction |
| --- | ---: | ---: | ---: |
| Cold construction | 4265 ms | 3578 ms | 16.1% |
| Coast fitting | 2572 ms | 2081 ms | 19.1% |
| Area measurements inside fitting | 1352 ms | 965 ms | 28.6% |
| Solver work | 194 ms | 112 ms | 42.5% |
| Warm edit construction | 3487 ms | 3036 ms | 12.9% |

The proposed 30% coast-fit improvement has not been reached in these samples.
The existing one-second cold-display target is also not met by construction alone.

Full initial and edited scene JSON is compared with the baseline for the populated
map, 30×30 feature map and seven gallery cases at Smooth, Wavy, Ragged and Fractured:
60 scene comparisons, all passing. Type checking, the production build and all
50 test files also pass. Exact equality covers the resulting coordinates, coastline
sampling detail, primitives and compromise reports. Coverage tests also compare
cached and uncached measurements across holes, stroke overlaps, adjacent hexes,
three sampling densities and queries outside a prepared region. Existing coast
and strait regressions check land shares, passage topology and width constraints.

## Completed browser validation

Chromium 151.0.7922.173 now runs with the sandbox's additional network permission,
which also permits its required IPC sockets. The former environment blockage is
resolved. Runs used one raster thread, DPR 1 and a 1400×900 opening viewport.
Each revision had ten fresh-context openings, ten same-context reopenings and
20 actual inspector edits. All 20 wheel inputs per revision were delivered while
a build was in flight. Native desktop/sidebar and mobile/page scrolling moved
its target and produced no long tasks in either revision.

| Browser result | Baseline | Candidate |
| --- | ---: | ---: |
| Cold opening median | 4981 ms | 4943 ms |
| Cold opening p95 / maximum | 6100 ms | 5363 ms |
| Warm-context reopening median | 4507 ms | 4450 ms |
| Edit-to-sharp median | 3419 ms | 3171 ms |
| Edit-to-sharp p95 | 3835 ms | 3463 ms |
| Edit-to-sharp maximum | 4166 ms | 3537 ms |
| Sampled input-to-next-frame during build, maximum | 1.3 ms | 1.7 ms |
| Frame-gap p95 during edits | 16.8 ms | 16.8 ms |
| Worst frame gap during edits | 200.0 ms | 116.8 ms |
| Main-thread long tasks during 20 edits | 29 | 30 |

Median edit latency improved by 7.2%; the opening medians are effectively
unchanged relative to the run-to-run variation. Both revisions fail the one-second
opening target and the 33.5 ms maximum frame-gap gate. Both pass the 33 ms sampled
input-response gate. The fast response of sampled wheel input does not replace
the several-second time required to display the completed edit.

The baseline batch ran before the candidate batch, with no concurrent benchmarks;
this was not an interleaved or randomized comparison. Request interception serves
local production assets and disables HTTP caching. A warm reopening preserves
the browser context, but does not establish an HTTP-cache-hit result. Display
completion is the bitmap-copy/two-animation-frame proxy described above. The
Node construction improvements should not be substituted for these browser
opening measurements.

Separate runs captured both build and paint worker CPU profiles and full browser
traces on both revisions. The candidate diagnostic shows an initial base-only
build followed by a coast-cache-hit build with all layers enabled. In that
profiled run, the first build spent 3955 ms constructing the coast, including
2601 ms in coupled fitting and 1186 ms in area measurement. The second build
reused the coast and spent 790 ms constructing the remaining scene. Profiling
overhead makes these diagnostic times unsuitable as acceptance timings.

The candidate paint diagnostic spent 529 ms painting the viewport and another
271 ms painting the overview before returning the first bitmap. Across the
uninstrumented opening runs, the synchronous main-thread scene `postMessage`
call had a median cost of about 110 ms on both revisions. The scene's JSON
representation was 23,569,472 bytes on both revisions; this is a size proxy, not
a measurement of structured-clone wire bytes. These measurements leave clear
work for the later worker-transfer/first-display phase.

All 1440 full-gallery pixel comparisons pass: 30 fixtures, initial and edited
states, fit-to-map/1×/4×, DPR 1/2, full-map/coast-only images, and separate worker
and export renderers. Another 288 comparisons center the maximum-zoom crops on
straits, isthmuses and concentrated coasts at Ragged and Fractured. **All 1728
comparisons have zero changed pixels and zero channel delta.** Every coast-only
mask contains visible ink, and the complete scene JSON matches its baseline.
The focused crops address a harness issue found by visual inspection: the first
coast vertex does not necessarily lie near the feature being tested.

During the first browser attempt, the harness also exposed two issues now fixed:
the desktop scroll viewport must actually overflow, and the wheel input must be
sent after the build request is posted, rather than after its reply arrives.
Desktop scrolling is measured at 1400×450 and mobile scrolling at 500×800;
opening and edit timings keep the original 1400×900 viewport.

Evidence:

- `docs/render-browser-parts-1-2-results.json`: timing samples, gates, profile stage
  totals, CPU sampling summaries and raw-artifact locations.
- `docs/render-coast-browser-parts-1-2-results.json`: every pixel comparison.
- `docs/render-coast-strait-4x-dpr2.png` and
  `docs/render-coast-concentration-4x-dpr2.png`: representative focused crops.
- `work/part12-browser/`: full timing reports, worker `.cpuprofile` files,
  `browser-trace.json` files and every baseline/candidate/difference PNG.

## Reproduce

```sh
npm ci
npm run typecheck
npm run build
node --import tsx --test --test-concurrency=1 test/*.test.ts

# Fresh-process Node diagnostic: 10 cold builds, 20 warm edits.
npm run perf:construction -- --runs 10 --edits 20 --output work/construction
# Separate instrumented diagnostic, not the timing acceptance run.
npm run perf:construction -- --runs 1 --edits 0 --profile --output work/construction-profile

# Install playwright-core in the usual way, or pass --driver /path/to/playwright-core/index.mjs.
# Chromium is selected with --chromium /path/to/chromium; default /usr/bin/chromium.
npm run perf:opening -- --runs 10 --edits 20 --warm --output work/opening
npm run perf:opening -- --profile --output work/opening-profile
npm run perf:coast -- --baseline 4ed7acd --output work/coast-pixels
```

The browser scripts serve the production build through request interception;
they need no HTTP server or external application service. Run the opening script
again with `--dist /path/to/baseline/dist` and a separate output directory for a
production baseline comparison. Pin browser version, DPR, viewport and CPU
settings; the launcher uses one raster thread. CPU-profile runs are separate
from uninstrumented timing runs. `--check` on the opening script enforces the
existing opening/input/frame gates; raw failures are retained in its report.

The pixel runner builds both revisions against identical frozen inputs. It saves
baseline, candidate and difference PNGs at fit-to-map, 1× and 4× zoom, at DPR 1/2,
for full maps and coastline-only images, including edited states. At 1× and 4×,
passages or explicit-share hexes determine the crop centre where available. It compares worker-style OffscreenCanvas
with the same renderer on the other revision, and does the same separately for
the ordinary HTMLCanvas export path. It requires exact pixels and full scene
JSON equality; it never compares HTMLCanvas antialiasing with OffscreenCanvas
antialiasing as though they were equivalent.
