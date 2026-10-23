# Shared shoreline implementation

Sea and lake shores now share tracing, shape preparation, clearance, component curves, area
fitting and final land geometry. Lake water paths are reversals of the fitted shore paths,
including their quadratic/cubic controls, with page-edge closures as needed. The same paths
drive lake fills, strokes, land tests, river clipping and realm bands. Separate lake settings,
colour and identity remain; the lake-only bulging algorithm has been removed.

Sea land percentage is available beside Coastal land in Settings and per hex in the inspector.
It defaults to 0%, applies beside whole land, and does not create land in open sea. Existing
Lake defaults and overrides remain. Loading old maps supplies the missing Sea default without
changing their saved geography. Classification of land around lakes is outside this change.

## Checks

- `node --import tsx --test --test-isolation=none test/*.test.ts`
- `node_modules/.bin/tsc -b tsconfig.json tsconfig.server.json`
- `node_modules/.bin/vite build`
- `test/sharedShorelines.test.ts`: matching sea/lake geometry, water-side shares, open sea,
  mixed shores, islands/holes, page edges, fully filled lakes, saved settings and cached/fresh
  agreement after edits and undo.
- Existing lake coverage/irregularity, strait widths, river endpoints, realm bands and drawing
  regression tests remain enabled. Tests tied to the former lake silhouette now compare
  against the actual final body rather than a fixed historical point or clip count.

## Performance evidence

Local Node samples, not browser latency guarantees. Baseline is the checkout's HEAD before
this change; both versions used identical seeds and settings. Two runs per case are too few
for percentile claims.

The existing 20×20 mixed-feature benchmark (`scripts/coast-feature-benchmark.ts --size 20
--runs 2`) measured cold builds at 1,047–1,471 ms before and 1,156–1,523 ms after, and one-hex
edits at 1,147–1,219 ms before and 1,232–1,237 ms after. The maximum sampled coastal land error
(fill only, excluding ink) fell from 11.3–12.0 percentage points to 3.8–4.1.

A deliberately dense 20×20 map with 36 one-hex lakes, Coastal Land elsewhere and default
shares took 184–291 ms cold before and approximately 1.8–2.0 seconds after. Shared final-area
fitting dominates the new cost. Removing inland hexes without any shore from the fitting
targets reduced pointless work but did not eliminate the cost. Cached cloned redraws measured
58–86 ms before and 5–14 ms after; approximate serialized scenes grew from 1.05 MB to 2.49 MB.
Further optimisation should preserve the shared solver and geometry constraints.

## Browser pixel validation before the rebase

`work/shared-shorelines/` contains paired Classic, Parchment and Atlas SVGs and PNGs plus the
dense-map timing records. PNGs were rendered with the installed librsvg/Cairo libraries.
Lake silhouettes are intentionally different.

The browser gates have now run successfully in Chromium 151.0.7922.173 using the installed
Playwright driver and Chromium executable, with the additional sandbox network permission
required for Chromium's socket setup. Fixtures, checks and thresholds were not weakened.

- Coastal paint: all 18 layouts/irregularity/mode combinations passed in Canvas and SVG,
  with zero band gaps and zero tint seams.
- Finished drawing: all 21 fixtures passed, including lakes, lake islands, lake labels,
  glacier shelves, straits and river mouths. No land-test/pixel disagreements, wet symbol
  or shelf probes, river-name water collisions or water-name land collisions were detected.
- Coverage: all 150 cases passed the existing one-percentage-point area tolerance. Maximum
  errors were 0.789 points for Classic, 0.470 for Parchment and 0.440 for Atlas.
- All 200 island cases, 600 enclosed-water topology cases and 400 river seeds passed.

Commands and per-case results are preserved in
[`shared-shorelines-browser-results.json`](shared-shorelines-browser-results.json).
Full browser reports and screenshots are under `work/shared-shorelines/browser-coast-paint/`,
`browser-drawing/` and `browser-sweeps/`. All three test processes exited successfully.

## Lake outline correction and rebase (22 October 2026)

Rebased onto `origin/main` at `a903a60`. The area fitter now limits cumulative
stretch and turn against its starting outline; its previous per-pass limit let
repeated fitting stretch small coastal details into long spikes. The same guard
applies to sea and lake shores. `test/coastFitDistortion.test.ts` checks that bound
across sixteen fitting passes. Natural irregularity remains; the fix does not
force lakes into ellipses.

The rebase retains upstream concentration and lake-passage controls. Passage
fields operate locally on a stable shore built by the shared engine, then feed
back into the common final geometry, masks and area measurements. Explicit
adjacent lake shares receive a final fit with passage widths protected. Small
concentrated water bodies are retained even when their centres shift away from
the source hex centre.

The browser results above describe the pre-rebase implementation, not this
revision. Browser launch retries for this revision returned `aborted by user`
from the tool; a sandboxed launch failed. No new browser pass is claimed.
The corrected lake SVG was rendered locally and visually reviewed.

Validation after the rebase: TypeScript and the production build pass. The full
554-test run passed 553 tests and exposed a 100%-land water-hex edge case;
restoring the exact full-hex branch fixed it. All shared-shoreline tests and the
new cumulative-distortion regression pass in the subsequent targeted run.
Corrected visual evidence is `work/shared-shorelines/lake-corrected.svg` and `.png`.
