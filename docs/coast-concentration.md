# Single-edge coastal concentration

A coastal hex with one sea-facing edge previously ignored directional concentration: its parallel cut had only one depth, so the area search cancelled the concentration multiplier. The new cut supports independent endpoint depths. It preserves more land at the endpoint towards the selected side, and solves the mean depth to preserve the requested land share.

The endpoint bias is bounded over the whole hex, including projections beyond the edge endpoints, so increasing depth remains a monotone area search. The depth bracket expands when needed for strong concentration and small land targets. Zero concentration retains parallel clipping. Coastal mainland bands use the same directional cut.

## Before and after

Baseline: main immediately before the fix at `937a95cce10e30c5298b089470b9640ad455bec6`. The after renderer is rebased onto `ad0023e`, which includes the merged fix from PR #154. Both renderers receive identical inputs: a 5×5 map, fixed seed, the app’s new-user Parchment preset with no style overrides, inherited Ragged coastal irregularity, and a central coastal hex with exactly one sea-facing edge, to the east. The two selected directions are existing sides 1 (SE) and 5 (NE), which have equal facing relative to that coast. These default-style images replace the earlier forced-Smooth comparisons. No map or hex irregularity is set, and `NEW_USER_STYLE_CHOICE` supplies the preset without overriding textures, water, or grid. The dashed outline marks the edited hex. Each column uses the full scene renderer, spline fitting, and coastline ink.

### 80% land target

![80% land, concentration 0%, 50%, and 100%, before and after towards SE and NE](coast-concentration-comparison-80.png)

### 50% land target

![50% land, concentration 0%, 50%, and 100%, before and after towards SE and NE](coast-concentration-comparison-50.png)

At 100% concentration:

| Land target | Before: SE / NE coast area | After: SE / NE coast area | Before: directional redistribution | After: directional redistribution |
| --- | --- | --- | --- | --- |
| 80% | 79.769% / 79.769% | 79.928% / 79.745% | 0.00 pp | 8.42 pp |
| 50% | 50.271% / 50.271% | 50.139% / 50.103% | 0.00 pp | 10.26 pp |

Redistribution measures the difference in land within the southern half when selecting SE versus NE, expressed as percentage points of the whole hex. It measures where land moves, independently of total land area. Across all 24 before/after scenes, the largest measured coastline-area error is 0.271 percentage points; no scene reports a drawing compromise. Polygon land-share error is below 0.000003 percentage points in these fixtures. Measurements use 256 scanlines of the outlined coastline and include coastline ink. They do not measure every painted pixel.

**Visible remaining issue:** the default-style after images expose a fill/shoreline mismatch at nonzero concentration: coloured patches cross the outlined coast. These are unretouched scene renders, and this comparison update does not fix that painting issue. The renderer does not emit a drawing-compromise warning for it. The outline-area measurements above must not be read as proof that the painted fill matches the outline.

The comparison script checks cancellation on the baseline polygon, preservation of the zero-concentration coast, and movement towards the selected side at both 50% and 100% strength. Ragged fitting can alter local details and need not move each half monotonically with strength. The asymmetric geometry survives the existing downstream fitter, whose cache key already includes the changed paths and anchors; no additional spline constraint is needed for these cases. This change uses the existing six-side selector and does not introduce a separate corner selector. A direction perpendicular to the coastal edge has no tangential skew.

## Validation

- `npm run typecheck`
- The original fix passed all 61 test files before the subsequent lake-strait merge. After rebasing onto `ad0023e`, type checking, the six concentration regressions, all 44 hex-shape tests, and the regenerated browser comparison assertions passed. Tests use `node --import tsx test/<file>.test.ts` because the sandbox prevents the `tsx` CLI IPC listener.
- Six orientation regressions in `test/coastConcentration.test.ts`: opposite directions, zero concentration, multiple land shares including 0%, 1%, and 99%, exact polygon coverage, and redistribution after smoothing and coupled area fitting.
- Browser comparison assertions for both 50% and 80% targets, two directions, three strengths, and both implementations.

Raw measurements: [coast-concentration-results.json](coast-concentration-results.json).

## Reproduce

From the repository root, with dependencies installed:

```sh
mkdir -p work/coast-concentration/baseline
git archive 937a95cce10e30c5298b089470b9640ad455bec6 | tar -x -C work/coast-concentration/baseline
ln -s "$(pwd)/node_modules" work/coast-concentration/baseline/node_modules
node scripts/coast-concentration-comparison.mjs --baseline-ref 937a95cce10e30c5298b089470b9640ad455bec6
```

The browser script uses the repository's Playwright browser helper. Where the runtime supplies an external driver and browser, append `--driver /path/to/playwright-core/index.mjs --chromium /path/to/chromium`. PNG comparisons, HTML contact sheets, and `results.json` are written under `work/coast-concentration/`. No live server or external browser requests are needed.
