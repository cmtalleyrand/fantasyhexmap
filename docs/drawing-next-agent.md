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

## Earlier continuation milestone

The original connected failures from the previous handoff were repaired in `f67ca94`, after merging current main
`1179712` and preserving #146/#147. Read the current section of `drawing-followup.md` and
`drawing-followup-current-results.json`, not only the historical pre-rebase results.

- Parchment `coverage-2` paints 4.635% versus 5% requested after open-coast knot removal.
- Classic `coverage-1` paints 19.211% versus 20% requested after one conditional fourth candidate.
  Already faithful unsmoothed coasts keep their geometry. All original fitting guards remain.
- Full 150-case area sweep passes; maximum error 0.789 percentage points. 200 island and 600 enclosed-sea
  pixel checks pass. 489 Node tests, typecheck, build, 21 picture fixtures and 400 river seeds pass.
- Exact scene replay passes all 59 edit cases and 944 images. `canvas-replay-history.mjs` demonstrates
  the original two-pixel difference with identical scene JSON, three pixels for the same scene object
  across unequal painter histories, and zero with fresh clones. The replay now controls both export
  and worker histories; production painting and exact assertions are unchanged.
- Current matched performance against `1179712`, including raw records and limits, is in the follow-up
  report. Never substitute the old `6786d4a` figures for current evidence.

## Owner review: defaults and Classic retirement

The owner confirmed that the small Parchment coastline difference is relevant, but the synthetic
before image's stray land at the map boundary is not representative of their map. Do not describe
those synthetic/SVG screenshots as captures of the owner's before view. A direct Canvas render confirmed
the rim-fill defect: un-clipped land assigned to border notches could cross the final coast. Rim land
fills are now clipped to that coast, removing the detached edge fragments without changing land geometry.
The uniform-default Canvas preview records this visual correction; prior suite results do not validate
this later change. Do not attribute diagnostic artifacts to owner data.

All preset defaults now use `land: 'uniform'`: coastal land has the same colour as inland land.
Explicit `land: 'band'` overrides remain available. This is the owner's requested display default,
not a change to land percentages or coastline geometry.

**Coast review must show hex borders.** The owner rejected the remaining 5%-land Parchment tip as too
pointy and asked for visible hex boundaries in comparison images, including water hexes. Use a clearly
visible full grid for geography review; a grid-free beauty view is optional, not the sole evidence.
The [current gridded Canvas view](drawing-followup/parchment-grid-review.png) leaves geometry unchanged.
Its left horizontal coast is the straight page-rim extension ending at a border junction, rather than
a regular hex edge. The diagonal towards the central tip crosses the target hex rather than following
its edge exactly. The [rounded proposal](drawing-followup/parchment-after-skew-proposal.png) now repairs the pinched
join after seeded skew and curves the rim continuation before shared area fitting. The guarded
production render is byte-identical to that proposal. Requested area and crossing/passage guards
remain; new geography review must still show the same full grid.

**Continue retiring Classic.** Its unsmoothed hex-based coast exposes abrupt joins at low land shares;
it is a legacy compatibility style, not the natural-geography target. New users already start in
Parchment. Inventory the Classic picker entry, fallback styles, legacy preferences and exports, then
retire them deliberately. Preserve saved choices until an approved migration exists; do not silently
restyle existing maps or remove Classic assertions to hide failures. Prefer work on natural coastlines
over further Classic-specific styling. The owner does not use Classic.

## Next priorities

**Latest connected evidence:** read [the continuation report](drawing-followup-connected.md).
The rounded, fully gridded cape/rim proposal is now in the shared production coastline; all 150
coast-area, 200 island and 600 enclosed-sea cases pass. The isolated current-main performance gate
now passes: warm p95 199.3→80.1 ms, ownership 205.9→77.1 ms, shore 269.2→157.7 ms; cold median
adds 0.8%, cold p95 improves 2.4%. The final runner verifies independent JavaScript heaps, so one
version cannot be charged for collecting the other version's temporary objects. The prior failed benchmark remains retained, not overwritten.
Do not rerun it without a change, failure or unresolved measurement concern.

The final 50×50 production-worker study covers 32 unique cumulative ownership edits. Retained V8
heap after edit 32 is 88.73 MiB on main versus 86.74 MiB on the final runtime; native/Canvas memory
is outside that measurement. Displayed-frame
median/p95 improves 1086.4/1614.4→937.7/1341.7 ms, but about 404 ms average still goes to feature-name
placement and roughly 440 ms to viewport painting. Realm-name placement averages 11.6 ms. Those
costs warrant investigation; this is not a claim that interaction is fast. Consult existing
placement-cache history before another cache proposal, and preserve exact geometry/obstacle checks.
Classic's previous tiny-fixture +0.9 ms / +29% cost remains disclosed; the owner does not use it and
asked to continue retiring it rather than prioritising further Classic styling.

1. Develop land-derived realm-name anchors and reliable small-realm association. Start with the pinned
   low-share realm fixture and present before/after images for owner approval before changing correctly
   drawn maps. Measure placement cost; retain own-land/water rules and useful omission reports.
2. Add independent finished-pixel checks for borders, ripples, sea ice and complete city markers.
   Geometry/predicate agreement alone is insufficient. Do not claim all seven principles are covered.
3. Broaden island/lake/channel/concentration share measurements and actual painted realm/legend area
   agreement. Keep the one-percentage-point ordinary-coast gate intact. Other knots/spurs and lake ink
   outside mainland remain separate defects.
4. Extend the 50×50 study beyond the synthetic map and 32 unique edits. The production-worker
   protocol and retained-heap study now exist in `render-worker-study.mjs`; React Inspector/input
   scheduling, longer lifetimes and native/Canvas memory remain outside it. The ice caches' 16 MB
   and island cache's 4 MB budgets are estimated accounting, not measured allocations attributable
   to those caches. Do not introduce approximate land queries without exact correctness guards.

## Already implemented; preserve and review

PR #146 supplies pinned Playwright, the browser-install command, documentation and CI. Installation and
the pixel suite work; its rebased sweep exposes the real area failures above. The rendering follow-up
corrects enclosed-sea orientation and erroneous island-area fitting (400/600 baseline topology cases
failed; zero failed before rebase), adds bounded exact glacier/pack-ice reuse, and remembers up to four
validated land revisions for symbol fits. New ice cache capacity is 16 MB estimated combined, not a
measured heap bound. The pre-continuation rebased Node suite passed 477 tests; the current continuation passes 489.

Keep the PR and DECISIONS aligned with new evidence and costs. Prioritize land-derived realm-name anchors and small-realm association, independent painted checks for
borders/ripples/sea ice/complete markers, broader land-share and legend-area fidelity, and the 50×50
ownership/name-placement and worker-memory study. Remaining hypotheses and limitations are listed
individually in the reports. Do not claim all 17 are complete.
