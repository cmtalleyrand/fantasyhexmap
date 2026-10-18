# Rebased rendering implementation and current estimates

Baseline: `4ed7acd397a21e54b72af6c1db68ed78894b1a3c`, the current `main`
used for the rebase. These measurements supersede the original PR figures.

## Rebase resolution

`main` now contains a newer coupled coastline solver, pocket/topology fixes,
and a separate scene-construction worker. The rebase preserves its coastline
solver and all new upstream tests and UI changes. The old local-fitting
optimization from this PR is superseded and has been dropped; no coast solver
code is changed relative to this baseline. The old 4.94×/1.51× construction gains
against `c6bced3` are not gains attributable to the rebased PR.

The remaining change consolidates construction and painting into one persistent
worker. It avoids returning the full primitive tree to the main thread and then
copying it into another worker. The main thread receives metadata and images.
The pipeline retains the previous image during builds, coalesces requests,
releases stale bitmaps, and delivers the sharp viewport before the overview.
Worker input snapshots omit undo/generation history and restore immutable
layer identities across cloning and undo/redo. Coast caching retains up to three
policy variants per base array. There is only one active construction path in
MapView; the separate upstream SceneBuilder API remains available to its callers.

## Updated construction measurements

Node 24.19.0, two-core CPU quota, same machine and dependencies, 26-pixel hex
radius, Parchment style, smooth coasts. Medians of three fixed-seed runs.
Baseline batch ran first, followed by the rebased PR; the populated fixture
alternated execution order across seeds. No other benchmarks ran concurrently.
These are construction times, excluding browser fonts, canvas painting,
worker copying, and presentation.

| 50×50 base-only fixture | Current main | Rebased PR | Base edit main → PR |
| --- | ---: | ---: | ---: |
| Continent | 2.198 s | 2.039 s | 2.251 → 2.159 s |
| Archipelago | 6.511 s | 6.360 s | 6.451 → 6.669 s |
| Lakes | 0.431 s | 0.425 s | 0.362 → 0.398 s |

For the representative **40×40 populated all-layer map**, median construction
was **3.754 s baseline and 3.358 s rebased PR**.

The coastline construction code is unchanged from current main. Small timing
differences in this batch should be treated as variability, not a repeatable
construction speedup. The worker-consolidation benefit is a reduction in
serialization by design; browser opening-time, input-latency and memory
improvements have not been measured. No numerical estimate for those gains is
justified yet. The one-second populated cold-render goal remains unmet.

Raw evidence:

* [50×50 main-versus-PR timings](render-performance-implementation-results.json)
* [Populated all-layer timings](render-all-layers-construction-results.json)
* [Coast fidelity against current main](render-coast-fidelity-results.json)

## Verification

All **439 tests** pass in the sequential in-process suite. Type checking and
production build pass. Complete scene hashes match current main for initial,
display and edited versions of all nine seed/layout combinations, for all three
populated seeds, and for 56 coastline policy fixtures before/after edits and undo.
The fixtures cover all four irregularity settings; straits, isthmuses, coastal
land, lakes, glaciers, sea ice and islands; low/high shares and narrow/wide
passages. The newer upstream topology tests also pass.

Browser verification remains pending because the sandbox blocks Chromium IPC
and its permission requests did not complete. No new pixel comparison,
first-image timing, navigation-latency or browser-memory result is claimed.
The comparison scripts and their worker observers support the consolidated
pipeline. The PR remains a draft pending end-to-end browser verification.

## Reproduce

```sh
mkdir -p work/latest-main
# Only source and fixture files are needed for Node construction checks.
git archive 4ed7acd src shared core scripts package.json tsconfig.json | tar -x -C work/latest-main
ln -s "$PWD/node_modules" work/latest-main/node_modules
node --import tsx scripts/render-performance.ts --baseline-dir work/latest-main --size 50 --runs 3
node --import tsx scripts/render-all-layers-construction.ts work/latest-main 4ed7acd
node --import tsx scripts/render-coast-fidelity.ts work/latest-main 4ed7acd
npm run typecheck
npm run build
node --import tsx --input-type=module -e 'import {readdirSync} from "node:fs"; for (const file of readdirSync("test").filter(f=>f.endsWith(".test.ts")).sort()) await import("./test/"+file);'
```

With Chromium IPC permitted and Python Playwright installed:

```sh
node scripts/render-comparison-bundle.mjs work/latest-main
python scripts/render-comparison.py 4ed7acd
```
