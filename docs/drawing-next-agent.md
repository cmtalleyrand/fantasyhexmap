# Prompt for the next agent

Continue work in `cmtalleyrand/fantasyhexmap` on `codex/coast-redraw-followup`. Read `DECISIONS.md`,
`docs/drawing-followup.md` and `docs/drawing-investigation.md` first. Inspect current main before assuming
any diagnosis still holds. Preserve other merged work, including river measurements and prompt alignment.

The owner wants natural-looking geography, faithful land-share/concentration/passage/island controls,
useful reports, and responsive editing. The visible finished coastline is the single land/water boundary
for all layers. Never change owner data or reshape land to accommodate decoration. Symbols give way by
shrinking, moving within their own hex, then omission with a useful report. Do not report routine city
placement onto dry ground or escarpments kept inside land. Keep the approved 50% symbol floor. The seven
drawing principles are binding; never skip, disable or loosen checks to pass. Ask with before/after images
before changing correctly drawn maps. Explain any conflict between natural roughness and precise control.

## Work efficiently

**Do not render every version of every map in full whenever a setting changes.** That takes too long.
During iteration, use the smallest pinned fixture reproducing the failure, the affected layer/hex or a
cropped view, and a representative before/after image only when needed. Use fast numerical/topology tests
for large seed sweeps; reserve raster sweeps for properties requiring painted pixels. Add fixture/region
filters to diagnostic scripts if needed, without changing assertions or silently omitting final coverage.

Do not repeatedly run full galleries, the entire edit matrix, every zoom/DPR/export combination, or the
full benchmark while experimenting. Run relevant targeted tests after each change. Run the broader suite
and representative benchmark once a connected implementation is stable, preferably in CI. Repeat only
for a new change, failure or unresolved concern. Never overlap performance measurements with heavy tests,
renders or sweeps. Report the scope and limits of every measurement. Do not claim an earlier green run
validates a later head. The owner explicitly asked to stop rerunning and publish the current PR.

## Start with these concrete failures

1. **Finish the land-share/topology repair.** Main `e40c473` changed default coastal land 90→80%, lake
   land 0→10%, large islands 20→15%, mainland 30→40%. The existing 150-case area check now fails its
   unchanged 1 percentage point limit. Classic `coverage-1`, 20% requested, paints 21.275%; Parchment
   `coverage-2`, 5% requested, paints 3.695%. Both have small fixtures named `coast-fit-classic` and
   `coast-fit-parchment` with surrounding coastal land explicitly set to 80%.
   The last code change extends `untangle` in `coastArea.ts` to open chains. Its targeted regression
   removes five self-crossings and the Parchment share-loss notice, but the resulting painted area and
   timing have not been rechecked. Validate that fixture alone first. The Classic case still needs a
   fix: it has no coupled smooth fit and stops after three initial fitting passes. An experimental
   fourth pass removed its notice, but that experiment was reverted and cost was not established.
   Extra smooth fitting rounds/line-search scales did not solve the knot and were also reverted.

2. **Diagnose the exact Canvas replay difference.** After rebase, scene JSON is identical, but
   `components/shore` and `components/undo` differ in two pixels by one colour-channel level at export,
   fit zoom, DPR 1. This reproduces on unchanged main using `--only components/`; it is not established
   as a regression from the new caches. `willReadFrequently` did not fix it and was reverted. Keep exact
   pixel assertions intact. Explain and correct the test only if evidence establishes a test defect.

3. **Complete validation and performance for the final implementation.** Before the latest rebase and
   open-loop change, a 100-run comparison against `6786d4a` passed: median warm 84.5→57.1 ms, ownership
   81.3→55.7, shore 118.4→87.6; all p95 values improved; cold median +0.7%. These are historical scene-
   construction figures, not final-head or end-to-end proof. Warm/edit redraws must not regress, and
   added cold cost must stay below 10% unless the owner agrees otherwise. Record a current baseline.

## Already implemented; preserve and review

PR #146 supplies pinned Playwright, the browser-install command, documentation and CI. Installation and
the pixel suite work; its rebased sweep exposes the real area failures above. The rendering follow-up
corrects enclosed-sea orientation and erroneous island-area fitting (400/600 baseline topology cases
failed; zero failed before rebase), adds bounded exact glacier/pack-ice reuse, and remembers up to four
validated land revisions for symbol fits. New ice cache capacity is 16 MB estimated combined, not a
measured heap bound. Before the last loop change, the rebased Node suite passed 477 tests.

After the connected failures are resolved, update the PR and DECISIONS with evidence and costs. Then
prioritize land-derived realm-name anchors and small-realm association, independent painted checks for
borders/ripples/sea ice/complete markers, broader land-share and legend-area fidelity, and the 50×50
ownership/name-placement and worker-memory study. Remaining hypotheses and limitations are listed
individually in the reports. Do not claim all 17 are complete.
