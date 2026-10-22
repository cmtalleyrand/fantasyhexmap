# Drawing work plan

Use [drawing-status.md](drawing-status.md) for implementation state, versioned results and evidence
locations. This plan is ordered by the owner's current priorities. It proposes work; it does not
claim that the fixes or new measurements below have been performed.

Rebased onto main `12a33d7` (#156). Preserve #149's lake-strait path, #154/#155's concentration fixes
and comparison controls, and #156's generated island/import behaviour. The first priority remains
editing latency; the newly retained lake/coastal-neighbour failures give priority 4 a concrete fixture.

## Constraints for every step

The finished coastline is the single land/water boundary for every layer. Never change owner data or
reshape geography for decoration. Symbols shrink, move inside their own hex, then are omitted with
a useful report; retain the approved 50% floor. Keep ownership, obstacle order, font readiness and
exact cached/full reconstruction. Do not add routine notices for dry-ground city placement or
escarpments kept inside land. City names may legitimately sit over water.

Coastal and inland land colours are equal by default; saved explicit band choices remain supported.
Classic is unused by the owner. Retain its compatibility tests and explicit saved choices while
planning deliberate retirement; do not spend this work on Classic styling. It is still in
`PRESET_ORDER`, `DEFAULT_STYLE_CHOICE`, resolver fallbacks and legacy normalisation in `styles.ts`.
`NEW_USER_STYLE_CHOICE` is already Parchment; check how creation/restoration uses each constant
before any migration.

Use small pinned fixtures during iteration. Show actual before/after renderer images with a visible
full hex grid, including water cells, before changing correctly drawn maps. An optional beauty view
does not replace that evidence. Explain a naturalness/control conflict rather than silently moving
the coast or relaxing a test. No new geography/anchor images were produced during consolidation.

## 1. Establish current editing costs, then remove dominant avoidable work

Start with `render-worker-study.mjs`, one 50×50 lifetime and eight cumulative unique ownership edits.
The review attempt was blocked before measurement; resolve the browser execution environment first.
Record code hash, browser/driver, viewport, profile settings and raw failures. This small run is a
diagnostic, not a reliable p95 study or a matched performance gate. Do not compare machine-specific
absolute times with the historical 32-edit run as if they were paired samples.

Inspect `scene.featureLabels`, `scene.polityLabels`, worker paint and cache counters per edit.
`scene.ts` caches the complete river-label family with every ordered realm/city obstacle, course,
width profile, lake shore, font measurement epoch and land revision. `placementCache.ts` already has
a 96-entry/8 MB estimated content cache. `featureLabels.ts:placeRiverLabels` can first run the legacy
search, validate the result's land footprint, then rerun with land constraints if needed.

Instrument a diagnostic bundle narrowly enough to distinguish river preparation, candidate scoring,
surface fallback and cache serialization from other feature-name families. Count repeated course
smoothing, heading/profile preparation, searches, changed obstacles and candidate probes. Confirm
whether the historical river-search cost still dominates before implementing a fix.

Potential solutions, conditional on that evidence:

- Reuse immutable river-course preparation across obstacle changes: smoothed points, cumulative
  distances, headings, rescaled widths and nearby-course indexes. This differs from the existing
  whole-result cache: realm movement still recomputes every obstacle-dependent score and placement
  in the original order. Key every preparation dependency, bound storage, include measurement inputs
  wherever relevant, and prove byte-identical full reconstruction.
- If scoring dominates, use conservative obstacle bounds to skip exact checks only when disjointness
  is proved. Preserve scoring, sample order and tie-breaking. Reusing only a previous winning position
  is unsafe: removing an obstacle can make an earlier or better candidate available.
- If the two-pass surface fallback is material, investigate sharing its preparation rather than
  deleting the compatibility pass. It intentionally preserves already-valid placements.

For painting, first profile the dominant paths/groups and compositor allocations on one pinned edit.
Distinguish scene construction, viewport paint, overview and bitmap transfer. Review `canvas.ts`,
`scenePainter.ts` and the PR #152 compositor experiment before changing replay/cache policy.
Do not replace a measured paint problem with more land-query caching by assumption.

After a connected fix, run focused equality checks, then one appropriately sized paired comparison
with independent JavaScript heaps and retained failures. Keep the existing strict gate: no steady-state
median/p95 regression; cold median/p95 no more than 10% above baseline. A small diagnostic alone cannot
establish that gate. Do not overlap timing with validation, rendering sweeps or memory instrumentation.

## 2. Land-derived realm anchors and reliable beside-name association

Review `labels.ts:placePolityLabels`, `scripts/drawing-investigation.mjs --proposal labels`,
`54d9109`, `c935d70`, and `dfb07fc` first. Production still builds candidates from owned hex centres
and neighbour midpoints; its mean/depth priority and beside-name extent remain tied to that grid.
The land predicate filters placements but does not itself supply better anchors.

Start with `realm-illustrated` from `drawing-investigation-fixtures.ts`: 5×4 map, seed
`drawing-investigation`, 20%-land target hex 12, Ahnver versus Hillmark, shared ownership and a city.
Keep those obstacles and ownership rules. The old proposal shifted the small name from `(266,160)`
to `(90,140)` in its recorded run; that is historical output, not a desired position for this head.

The proposal samples own-hex dry ground only when a hex centre is wet, retains artificial centre±size
bounds when the centre is dry, and falls back to a wet centre if sampling finds nothing. It therefore
does not finish land-derived bounds, archipelago association or cost validation. Its source-string
replacement also needs an explicit match check before trusting it on a newer source version.

Generate current/proposal Canvas images with a full grid first. The existing fixture options specify
`grid: 'none'`; the current diagnostic's normal PNG is a screenshot of exported SVG. Add a diagnostic
full-grid Canvas path instead of calling either output the requested Canvas comparison.

A distinct candidate is to sample actual own-hex land even when the centre is already dry, derive
component extents/anchors from those samples, then validate every final label footprint with exact
land/ownership predicates. Samples propose anchors; they cannot certify clearance or replace exact
land. For beside names, score distance/association to the realm's actual component, keep all lettering
on open water, preserve city/name obstacles, and report a meaningful omission when association cannot
be made clear. Do not move labels onto a neighbour's land or alter the realm to make room.

Measure placement cost separately, compare the pinned fixture, then a few small-realm/archipelago
cases and already-correct maps. Present before/after evidence for approval before adopting a visual
change to correctly drawn maps. Faster anchor placement alone will not resolve the historical
feature-name and paint costs.

## 3. Independent finished-paint coverage

PR #153 already checks realm colour on both sides of frontiers and at three-way junctions. Preserve
that work; do not recreate it as an unimplemented idea. Its probes exclude ink and use the land
predicate, leaving independent border-ink versus painted-coast coverage unfinished.

For each missing rule, build the smallest pinned case, render independent black/white geography,
then inspect actual layer pixels against it. Check intended dry/wet locations as well as
predicate agreement so two branches cannot agree on the same wrong geography. Require nonempty
layer coverage so a hidden layer cannot pass vacuously.

| Layer | First fixture/check | Conditional repair if a defect reproduces |
|---|---|---|
| Realm border ink | Two realms meeting a low-share rough coast; include the final stroke footprint, not only its centreline or neighbouring colour. | Correct the missing finished-land clip or stroke construction, preserving the exact shared frontier. |
| Ripples | One island and a neighbouring mainland/lake with ripples explicitly enabled (ordinary presets default to zero). | Correct the water clip/paint ordering, not the shoreline to which ripples refer. |
| Sea ice | Pack ice against a rough mainland shore and a small enclosed water hole. | Apply the final water boundary to the actual plates, fringe and strokes. |
| Entire city marker | Low-share coastal/island city with a capital or tall illustrated marker; include halo/strokes and river modes. | Fit the entire marker extent, shrink/move inside its own hex then omit/report if necessary. Never press/distort the icon or grow the island. |

These are possible repairs, not newly established defects. `auditScene` currently checks city centres;
that cannot certify the whole marker. Keep assertions exact where already exact. Any necessary
antialias classification must be specified independently, not widened until a failure disappears.
Show the reproducer and visible correction; expand coverage only after the connected fix is stable.

## 4. Broaden control fidelity and answer specific worker uncertainties

Keep the ordinary-coast one-percentage-point painted-area gate. The existing 200-island sweep checks
symbol probes, not a broad island area distribution; the 600 enclosed-sea sweep checks topology at
centres, not lake/sea area fidelity. Neither completes this task.

Use a few pinned shares/concentrations on islands, lake-donated land, channels and mixed lake/sea
coasts. Measure both fill and visible ink, width at the passage throat, own-hex containment and any
reported shortfall. Keep topological/passage guards; explain infeasible requests. Reproduce old
isthmus (~74% versus 10%), spur and lake-ink observations on this head before calling them current bugs.

Start lake work with PR #155's already-retained counterexample, not another broad search:
`lake-concentration-validation.mjs --surrounding 'Coastal Land'` has 29 area and 3 direction failures
across 54 scenes, while its plain-Land control passes. Read `coast-concentration.md` and
`lake-coastal-neighbours-results.json`; pin one failed case and compare the competing central-lake
and neighbouring 80%-land targets through fitting stages. More lake passes and ink-aware coverage
are already implemented for the plain-neighbour fix. A new solution needs evidence of the coupled
constraint failure; do not repeat the signed-inset direction correction or blindly raise iteration caps.
Treat a reported shortfall as an observed renderer limit, not proof that the request is impossible.

PR #149 already uses local shore fields for short lake straits, retains throat width and flank detail,
and reports unfitted high land shares. Check its history and fixtures before proposing new passage
smoothing. PR #155 also fixed SVG contact-sheet ID collisions by separate image documents; use
`scene-image-comparison.mjs` and standalone equivalence when constructing new galleries so apparent
fill spill is not misdiagnosed as a production geometry defect.

PR #156's bounded island-generation settings now affect these inputs: exercise API and single/multi-layer
chat import plus undo when measuring generated islands, preserving manual shares and layout seeds.
Do not repeat that transport implementation. Automatic coastal derivation and the Mainland/Water/Special
palette remain a separate [planned follow-up](automatic-coasts-next-steps.md); #156 is merged, so its
first-PR checkpoint has been met, but that does not authorise silently migrating saved terrain here.

Compare actual painted realm areas with `legend.ts` / `shared/surfaceArea.ts:politySurfaceAreas`, whose
totals derive from data shares, including split ownership, strait banks and hierarchy. Isolate realm
colours from labels/relief; account explicitly for ink and partial pixels. Do not change ownership or
legend totals merely to conceal a drawing mismatch.

Extend the worker study only for a stated uncertainty: a longer lifetime for cache-growth/eviction,
a real React input path for input-to-display scheduling, or process/native/Canvas instrumentation
for memory outside V8. Existing `render-app-build-responsiveness.mjs` and app-performance runners
are starting points. Forced-GC memory runs stay separate from natural timing samples. Preserve raw
records and do not infer cache allocation sizes from configured accounting budgets.

## Prior attempts to check before any fix

| Earlier work | Avoid repeating / what would make a new approach distinct |
|---|---|
| Broad smoothing/extra solve rounds and line-search scales; pre-skew loop fillets | Failed to remove the pinned tip or knot. Stage tracing found post-loop skew sharpened it; post-skew targeted fillets succeeded and are already production. See [retained attempt review](coast-performance-plan.md#2026-10-20-prior-attempt-review-before-further-fixes). |
| Ink caches, scalar/interval pools and scanline reuse variants | Overhead erased savings or did not remove tiny Classic cold overhead. A new proposal needs a newly measured allocation/cost cause. |
| Scalar island scale reuse / within-build coast outline reuse | Already implemented before final drawing reuse. Exact final island and cross-redraw coast-paint derivatives were the distinct missing work; both are now present. |
| Placement caches / symbol validation | Ordered obstacles and measurement epoch already keyed; symbol queries retain failed candidates and up to four validated terrain revisions. Do not propose “make caches survive edits” without identifying an actual miss and its necessary dependencies. |
| Approximate land grid | Not adopted; `evenOddTest` already has an exact lazy 2D edge index. Any acceleration must keep exact correctness guards. |
| Shared-page benchmark / uncontrolled Path2D histories | Produced attribution or replay-control confounds. Keep separate version heaps and equal painter histories; never loosen the gate or pixel equality. |
| Coast donor grouping by child count | PR #152 found dense compound paths bypassed the fast compositor. Preserve explicit compositor intent; profile actual paint before changing it. |

## Reproduction and completion record

From the repository root, normal setup is `npm ci` then `npm run test:browser:install` (Linux system
dependencies: append `-- --with-deps`). Browser scripts accept `--chromium` and `--driver`. This
review found `/usr/bin/chromium` and `/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs`,
but sandbox launch failed; overrides alone do not resolve that execution restriction.

```sh
# Focused source checks; choose files relevant to the proposed change.
node --import tsx --test test/drawingInvestigation.test.ts test/incrementalRender.test.ts test/labelPlacement.test.ts test/realmBoundary.test.ts test/coastPaint.test.ts
# Small current-cost diagnostic, after browser execution works.
node scripts/render-worker-study.mjs --span 50 --edits 8 --output work/worker-diagnostic
# Pinned current/proposal label inspection; add full-grid Canvas evidence as described above.
node scripts/drawing-investigation.mjs --only realm-illustrated --output work/realm-current --check
node scripts/drawing-investigation.mjs --only realm-illustrated --proposal labels --output work/realm-proposal --check
# Focused unchanged area gate.
node scripts/drawing-investigation-extended.mjs --only coverage --preset parchment --seed coverage-2 --share 5 --check
```

After a connected implementation is stable, run relevant browser checks, `npm test`, typecheck/build,
the full drawing sweeps and exact incremental replay as appropriate; then run performance separately.
Use an archived explicit baseline with dependencies linked for comparisons; fetch main before
choosing a baseline. `drawing-investigation-performance.mjs` verifies distinct isolate IDs.

Update these two documents instead of creating another overlapping handoff. For every attempted fix,
record the hypothesis, prior work checked, what is distinct, exact source/baseline versions, pinned
fixture, renderer images, raw measurement path, correctness/cost result, and retained or reverted
disposition. Keep failed measurements. Say which checks were not run and why; a historical green run
does not validate a later head. Prioritise visible corrections and editing performance over test volume.
