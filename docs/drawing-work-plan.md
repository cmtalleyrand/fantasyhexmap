# Drawing work plan

Open drawing work, in the owner's priority order. The reasons behind current behaviour are in
[DECISIONS](../DECISIONS.md). This plan proposes work; nothing below has been done.

Preserve #149's lake-strait path, #154/#155's concentration fixes and comparison controls, and #156's
generated island/import behaviour. Editing latency was addressed in #160; the retained
lake/coastal-neighbour failures give priority 4 a concrete fixture.

## Constraints for every step

The finished coastline is the single land/water boundary for every layer. Never change owner data or
reshape geography for decoration. Symbols shrink, move inside their own hex, then are omitted with
a useful report; retain the approved 50% floor. Keep ownership, obstacle order, font readiness and
exact cached/full reconstruction. Do not add routine notices for dry-ground city placement or
escarpments kept inside land. City names may legitimately sit over water.

Coastal and inland land colours are equal by default; saved explicit band choices remain supported.
Classic is unused by the owner and is to be retired outright, without preserving its look
(`simplification-next-steps.md` §4.5). Do not spend drawing work on Classic styling. It is still in
`PRESET_ORDER`, `DEFAULT_STYLE_CHOICE`, resolver fallbacks and legacy normalisation in `styles.ts`;
`NEW_USER_STYLE_CHOICE` is already Parchment.

Use small pinned fixtures during iteration. Show actual before/after renderer images with a visible
full hex grid, including water cells, before changing correctly drawn maps. An optional beauty view
does not replace that evidence. Explain a naturalness/control conflict rather than silently moving
the coast or relaxing a test. No new geography/anchor images were produced during consolidation.

## 1. Remaining waits: map opening and preset changes

PR #160 (DECISIONS §70–75) cut a one-hex edit to a sharp frame on the 50×50 all-layer fixture from
about 1,020 ms to 383–434 ms. It reuses each river name while nothing within reach changed, paints
the overview in yielding bands, draws see-through realm bands as one composed stroke and reuses
unchanged long paths. `npm run perf:interaction` measures edit and pan latency through the
production worker.

Still slow:

- **Map opening:** about 9 s in Node on 50×50, 80% of it the coastline area fit.
- **First switch to a preset with a different coastline width:** about 5 s, because coast ink counts
  as land in the fit.
- **Fast repeated edits:** edits arriving faster than one build (about every 0.4 s) show nothing until
  they stop, because each edit discards the build in progress.

Two next steps:

- **Fewer coverage lines in the fit.** `measureAll` (`coastArea.ts`) runs about 9 times per cold
  build, each measuring about 466 hexes with 128 scanlines, about 2.7–3.0 s in total. Lift `128` into
  a named constant, then measure cost (including the round count) and per-hex area error at 128, 96
  and 64 lines. Adopt it only if every coast check passes unchanged and full-grid before/after
  images show no visible change. Sorting crossings once per row and removing allocations were tried
  in #160: exact but no faster.
- **A stand-in picture while the exact coast fits:** the previous coastline in the new colours on a
  preset change, or a quick unfitted coast on opening. The finished image is unchanged.

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

Keep the ordinary-coast painted-area gate (5 percentage points, the owner's tolerance).

Start with the red check. `npm run test:drawing-sweeps` fails on four coverage cases at a 90% share:
`coverage-8` draws 77.3–77.4% and `coverage-2` 81.4% under Parchment and Atlas. On `coverage-8` the
hex juts into the sea on three sides. The global share passes in `scene.ts` aim it at 0.98, but the
traced coast starts with about 0.40 land. `fitCoastAreas` then gains about 12 points a round until the
cumulative distortion bound (DECISIONS, shared sea and lake coast geometry) blocks it at 0.77. The
owner must choose between: fixing the starting shape so a jutting high-share hex starts near its
target (recommended; both rules then hold); scaling the cumulative bound to the remaining shortfall
(re-specifying `test/coastFitDistortion.test.ts`); or accepting the four reported shortfalls as known
exceptions in the sweep. Do not change the gate or the bound without that choice. The existing 200-island sweep checks
symbol probes, not a broad island area distribution; the 600 enclosed-sea sweep checks topology at
centres, not lake/sea area fidelity. Neither completes this task.

Use a few pinned shares/concentrations on islands, lake-donated land, channels and mixed lake/sea
coasts. Measure both fill and visible ink, width at the passage throat, own-hex containment and any
reported shortfall. Keep topological/passage guards; explain infeasible requests. Reproduce old
isthmus (~74% versus 10%), spur and lake-ink observations on this head before calling them current bugs.

Start lake work with PR #155's already-retained counterexample, not another broad search:
`lake-concentration-validation.mjs --surrounding 'Coastal Land'` has 29 area and 3 direction failures
across 54 scenes, while its plain-Land control passes. Read `docs/coast-concentration.md` and
`docs/lake-coastal-neighbours-results.json` at `8bf42c7`; pin one failed case and compare the competing central-lake
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

Other open items: omission reports associate results by name text, so features with duplicate names
need identity-based reporting (DECISIONS §54); small-realm association remains open with item 2.

## Prior attempts to check before any fix

| Earlier work | Avoid repeating / what would make a new approach distinct |
|---|---|
| Broad smoothing/extra solve rounds and line-search scales; pre-skew loop fillets | Failed to remove the pinned tip or knot. Stage tracing found post-loop skew sharpened it; post-skew targeted fillets succeeded and are already production. See the prior-attempt review in `docs/coast-performance-plan.md` at `8bf42c7`. |
| Ink caches, scalar/interval pools and scanline reuse variants | Overhead erased savings or did not remove tiny Classic cold overhead. A new proposal needs a newly measured allocation/cost cause. |
| Scalar island scale reuse / within-build coast outline reuse | Already implemented before final drawing reuse. Exact final island and cross-redraw coast-paint derivatives were the distinct missing work; both are now present. |
| Placement caches / symbol validation | Ordered obstacles and measurement epoch already keyed; symbol queries retain failed candidates and up to four validated terrain revisions. Do not propose “make caches survive edits” without identifying an actual miss and its necessary dependencies. |
| Approximate land grid | Not adopted; `evenOddTest` already has an exact lazy 2D edge index. Any acceleration must keep exact correctness guards. |
| Shared-page benchmark / uncontrolled Path2D histories | Produced attribution or replay-control confounds. Keep separate version heaps and equal painter histories; never loosen the gate or pixel equality. |
| Coast donor grouping by child count | PR #152 found dense compound paths bypassed the fast compositor. Preserve explicit compositor intent; profile actual paint before changing it. |

## Commands

```sh
npm ci && npm run test:browser:install      # Linux system libraries: append -- --with-deps
npm test && npm run typecheck && npm run build
npm run test:drawing-pixels                 # finished-picture checks, 400-river sweep
npm run test:drawing-sweeps                 # 200 islands, 600 enclosed seas, 150 area cases
npm run perf:interaction                    # edit and pan latency through the production worker
npm run perf:opening                        # opening latency
# Realm-name proposal on the pinned fixture.
node scripts/drawing-investigation.mjs --only realm-illustrated --proposal labels --output work/realm-proposal --check
```

Browser scripts accept `--chromium <path>` for a preinstalled browser (for example
`/opt/pw-browsers/chromium`). Keep raw output under `work/` (not committed). Record each attempted fix
in DECISIONS: the hypothesis, what is distinct from prior attempts, baseline commit, fixture, images,
result and whether it was kept. Say which checks were not run.
