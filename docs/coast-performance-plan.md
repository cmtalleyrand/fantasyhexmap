# Coastline performance and fidelity: investigation and plan

Investigated on 17 October 2026 against `c6bced3` (main after PR #137). This document records
why scene construction has become slow, what the recent coastline PRs did to land shares,
special features and islands, and a phased plan to recover speed without regressing the
coastline drawing. Nothing in the renderer is changed by the commit that adds this document;
it adds only `scripts/coast-feature-benchmark.ts`, used for every measurement below.

## 1. Measurements

The existing performance fixtures (`scripts/render-performance.ts`, the all-layer fixture) contain
no explicit land shares, no concentration, no straits, isthmuses or island hexes. They therefore
never exercised the code that the recent PRs added, which is why earlier performance write-ups
reported improvements while the app got slower for real maps. The new benchmark builds a 30×30
continent whose coast hexes carry explicit shares (30–90%), concentration on about half of those,
straits, isthmuses, mainland-and-island hexes, offshore island hexes and inland lakes, with the
parchment style and smooth coasts. It times a cold build, then a rebuild after a one-hex edit.
It also measures each explicit-share coastal hex's land from the finished scene (`landTestOf`,
fill only: the coastline's ink, which the app counts as land, is excluded, so every revision reads
a point or two low; the comparison between revisions is still like for like).

Runs were sequential on this container (two-core quota), one run each, same fixture for every
revision (`git archive` of each commit with `node_modules` linked):

| Revision | Cold build | One-hex edit | Prims | Path commands | Scene JSON | Share error median / p90 / max (pts) | Hexes off by >5 pts |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| `6e6ab7e` (#121, before the coast series) | 1.74 s | 1.00 s | 3,026 | 17,863 | 1.8 MB | 3.3 / 7.0 / 10.6 | 15 of 64 |
| `24c5927` (#127, asymmetric/irregular coasts) | 1.28 s | 0.84 s | 2,738 | 18,725 | 1.8 MB | 7.6 / 14.4 / 19.4 | 47 of 64 |
| `80a1ca9` (#128, component silhouettes) | 3.62 s | 3.08 s | 9,352 | 74,747 | 4.5 MB | 7.1 / 20.7 / 31.1 | 35 of 64 |
| `63a9a58` (#133, caching follow-ups) | 2.19 s | 1.97 s | 9,352 | 74,747 | 4.5 MB | 7.1 / 20.7 / 31.1 | 35 of 64 |
| `42611d2` (#136, strait banks + measured fitting) | 35.8 s | 26.4 s | 10,576 | 90,560 | 5.3 MB | 5.1 / 15.9 / 24.6 | 33 of 64 |
| `c6bced3` (#137, current main) | 34.9 s | 22.5 s | 10,576 | 90,560 | 5.3 MB | 5.1 / 15.9 / 24.6 | 33 of 64 |

On a plain coast (every coast hex `Coastal Land`, default share, nothing else), a cold build goes
from 0.69 s at `6e6ab7e` to 10.9 s at current main. Construction time also grows faster than the
map: the feature-rich fixture takes about 6 s at 20×20, 28–35 s at 30×30 and 54 s at 40×40 per build.
An edit costs about as much as a cold build, because nothing below the whole-map coast cache is reused.

Three conclusions follow from the table. First, the slowdown is almost entirely one PR: #136 made
construction roughly sixteen times slower, on top of the doubled-to-tripled cost and the three-and-a-half
times heavier scene that #128 introduced. Second, land shares were already broken before #136: #127 more than doubled the
median error and #128 nearly tripled the worst case, while both versions still reported zero compromises, because
neither measured the result. Third, #136's brute-force fitting bought back only part of that (median
5.1, worst 24.6 points, against 3.3 and 10.6 before the series) and now correctly reports 83 hexes as
compromised; the price was 35 seconds.

## 2. Why construction is slow

Instrumenting `cachedCoast` (temporarily; not committed) on the 30×30 fixture apportions over 95%
of a 30 s build to the coast fitting, in three stages that all have the same structural flaw: every
trial re-does work for the whole map in order to learn about one hex.

The global fitting loop (`scene.ts`, the `for (let pass = 0; pass < 16 …)` loop) traces the entire
coast again on every pass (`shapeCoast` for every reshaped hex, then `coastGeometryOf`, which runs
`componentCoast` on every chain), flattens every path with `pathPolylines`, and builds a fresh
whole-map `areaCoverage` to measure each hex. It runs about fifteen passes per build because the
smoothing it is correcting is not local: the component silhouette is a Gaussian with σ up to 1.3 hex
radii, so moving one hex's cut changes its neighbours' areas, and simultaneous bisection on every hex
converges slowly. This stage cost about 7–8 s per build.

The re-bracketing stage that follows does a full-map trace for every sample of every strait or
isthmus with a set share: about fourteen samples each, so nine such hexes cost about thirty whole-map
traces (about 4 s; at 40×40 it is about 85 traces and 20 s).

`fitCoastAreas` (`coastArea.ts`), added in #136, is the largest cost (about 14 s per build at 30×30,
22 s at 40×40). For each of three sweeps, for each of roughly a hundred target hexes, it measures up
to about thirty candidate displacements. Each `measure` call rebuilds `drawnLand` for the whole map
and flattens every ring with `pathPolylines` before restricting the area scan to the one hex, so its
cost is (targets × samples × map size): quadratic in the map's area. Each candidate's `simple` test
is also quadratic in the segments near the hex. Before the sweeps, `untangle` removes fold-back
loops with an all-pairs segment search repeated up to 32 times per ring; a continent's ring has about
twenty samples per hex edge (`componentCoast` samples every `size / 20`), so this alone took about
2.5 s per build. The CPU profile attributes about a fifth of all time to garbage collection, consistent with
these stages allocating fresh point arrays for every trial.

None of this is reused across edits. `coastCache` is keyed on the identity of the base array plus a
key string, so a single painted hex discards everything, and the component-silhouette reuse added in
#130 applies only to closed components and only within one build's passes.

## 3. Why scrolling and zooming are slower

Scrolling and zooming no longer rebuild the scene (the worker painter from #137 handles navigation),
so their slowdown comes from the weight of what is painted and from the main thread being busy.
Since #128 a scene carries three and a half times the primitives and five times the path commands: the coast is
emitted at twenty points per hex edge, `componentCoast` emits a donor sliver polygon for every sample
interval on both sides of the coast (`toLand`/`toWater`), and those slivers are drawn inside clip
groups whose clip is the whole dense coastline (the earlier write-up measured 1,750 overlapping
polygons under a 10,399-command clip taking about 860 ms to paint). The 5 MB scene is also structured-
cloned to the worker on every change. Finally, construction itself runs synchronously in a React
`useMemo` on the main thread, so after any edit the page is frozen for the whole build; input queued
during that time is what makes interaction feel slow even when painting is fast.

## 4. What is wrong with the drawing itself

Land shares. As the table shows, explicit shares stopped being honoured at #127 and #128, silently,
and are only partly recovered now. Two current mechanisms explain the residual misses. The component
smoother redistributes land between neighbouring hexes, and the corrections that fight it are capped
(`fitCoastAreas` limits displacement to 0.35 hex and fades it to zero before the hex boundary so it
cannot disturb neighbours), so a hex whose smoothed coast lies near its edge cannot be corrected at
all. And nothing checks beforehand whether a share is achievable given its neighbours and features, so
an impossible request is pursued through every iteration and reported only afterwards, as a generic
"x% land drawn instead of y%". That is the "flag it" requirement in the brief, but at the wrong time,
with no cause, and mixed in with misses that are the renderer's own fault.

Phantom islets and lakes. The current coast contains small detached land fragments and enclosed water
holes that correspond to no island or lake hex (see `coast-performance-plan-crop.png`: near the `53>2`,
`S40`, `47>2` and `I50` hexes on the right-hand image; the left-hand image is the same map before the
series). They come from tight caps folding back during roughening and from fitting moving points
inside a pinched neck; `untangle` keeps the larger loop of each self-intersection but cannot remove
fragments that never self-intersect. Under the hierarchy below these are feature violations: a hex
showing islands it was not given.

Island overlap. Islands are separated in `layoutAt` using an ellipse approximation inflated by a wobble
factor, but three things escape that check. Skerries are added afterwards in `islandPathFrom` at 1.25–
1.6 times the island's radius and are not part of the separation or the crowding measure. The
mainland that islands are kept clear of is `coast.land`, the reshaped polygon before smoothing and
fitting, not the coast as drawn, which can move by a large fraction of a hex. And in `islandScale`, if
every trial size is crowded, `best` is never updated and the islands are drawn at their full share
(`times = best.t = floor = 1`) despite overlapping. There is no audit check for land overlapping land
(`audit.ts` checks names, markers and furniture only), so none of this is caught by tests.

Symmetry. Several shape generators are symmetric by construction. A coast hex is cut back by the same
depth from every sea edge (`reshapeCoastHex`, `landInsetDepth`), which produces hex-shaped land; with
concentration the depth multiplier is `1 − 0.9·strength·cos θ`, which is mirror-symmetric about the
chosen side's axis. Strait banks are semicircular caps of half-width `0.35 × depth` whose only
variation is a 0.8–1.2 depth factor per edge. Two large islands are placed at `±apart` along one axis.
The component silhouette's seeded features break this up at the component scale, but the hex-scale
geometry that the share fitting operates on remains symmetric, and wherever the silhouette is weak
(narrow features, where displacement is limited to a fraction of the width) the symmetry shows.

## 5. The hierarchy of requirements, as an explicit contract

The renderer currently has no notion of priority: each stage optimises its own goal and the last
stage to run wins. The plan makes the order in the brief a contract that every stage obeys and that
an independent audit checks on the finished scene (drawing principle 7).

Level 1, no overlapping land, is a hard constraint. No two land outlines drawn as separate bodies may
intersect or touch within the ink width: islands with islands, islands and skerries with the mainland
as drawn, lake islands with lake shores. A stage that cannot satisfy it must shrink or move the
offending body (drawing principle 5), and the audit fails any scene that violates it.

Level 2, feature integrity, is also hard. For each hex type there is a topological and shape test on
the drawn result: a strait hex has water connecting its sea-facing openings through the hex, with land
on both banks attached to the mainland edges, and a narrowest water width within tolerance of the set
width; an isthmus has a land connection between its land edges with a narrowest width within tolerance
and water on both sides; an island hex shows exactly its configured count of disjoint island bodies (no
merged islands, no phantom extras); a mainland-and-islands hex shows mainland attached to its land edges
plus its islands; an ordinary coast hex shows no detached fragments of its own. Level 1 outranks Level 2:
an island may be shrunk to keep it apart from another, but it is never omitted while its count is set,
and if it cannot be drawn without overlap at any size that fits the hex, the conflict is reported.

Level 3, land share, is a soft target with a tolerance (proposed: ±2 points of the hex, counting ink as
land, as the app does now). It yields to Levels 1 and 2. Crucially, the yielding is computed before
drawing: each hex gets a feasible interval for its share from its type, width, island count and
neighbours (a strait of width w cannot have more land than the hex minus its channel; an isthmus cannot
have less than its neck; islands that must stay apart at a given count have a maximum total area; a
coastal hex whose neighbours are all water has no mainland to attach to). A requested share outside its
interval is clamped and flagged at once, with the reason ("a Narrow strait leaves at most 71% land in this
hex; 85% was asked"), in the Inspector at the moment the share or width is set, not only after a render.
Misses inside the feasible interval are renderer defects, reported separately, and the plan's targets
are written against them.

Level 4, avoidance of symmetry, is measured rather than asserted. For each shaped hex the audit reflects
the drawn land in the hex across its six mirror axes and its concentration axis and computes the overlap
(intersection over union) with the original; an irregular hex above a threshold (proposed 0.92) is
flagged as near-symmetric. It yields to Levels 1–3.

Level 5 covers everything else: smoothness, colour donor continuity, decoration fit.

## 6. Plan

The phases are ordered so that the large, risk-free gains come first and every phase that changes the
drawing is reviewed visually against the one before it. Each phase is one PR with its own evidence.

### Phase 0: harness, before any behaviour change

Extend `scripts/coast-feature-benchmark.ts` into the regression harness for everything that follows.
It gains a fixture gallery: the existing `coast-evidence.ts` scenarios (chains, bays, a proper isthmus
and a proper strait between two land masses, each at every irregularity level and at several shares), a
gallery of island hexes (one to six islands, coastal and free, with and without a mainland, every
arrangement), concentration at each side, a deliberately infeasible share per feature type, the 30×30
mixed fixture and, if the owner can supply them, two or three real saved maps. It records timings, scene
weight, the audit results for Levels 1–4 (implemented in `audit.ts` as new `AuditKind`s, each with a
test), and per-hex share error measured with ink. Running it on current main gives the baseline every
later phase must not regress against.

The same phase adds the visual comparison tool. For every gallery fixture it renders the baseline
revision and the candidate to PNG through Chromium (the same headless route used for the image in this
document), and writes three images: the two renders side by side at full map scale; zoomed crops (3×)
of every hex whose drawn land differs; and an outline overlay in which the baseline coastline is drawn in
red and the candidate in blue over a neutral ground, so movement of the line is visible independently of
colour changes. Alongside the images it reports, per fixture, the mean and maximum distance between the
two coastlines (a symmetric Hausdorff-style measure on the flattened paths), the count of phantom
fragments, overlaps and near-symmetric hexes, and the share errors. A phase that is meant to leave the
drawing unchanged must show identical scene hashes; a phase that is meant to change it must show every
change in the gallery and justify it. The gallery is published with each PR for the owner's review
before merge; numeric gates catch regressions, but whether a coastline looks right is the owner's call,
and no drawing change merges without that review.

### Phase 1: make the existing algorithm cheap, with identical output

This phase changes no geometry; the gate is identical scene hashes on every gallery fixture. The
measurement function in `fitCoastAreas` stops rebuilding the whole map per call: rings are flattened
once per sweep and only the rings a candidate actually moves are re-flattened, `drawnLand` is assembled
from cached per-ring polylines, and the even-odd area scan uses a spatial index of segments so a hex
query touches only nearby segments plus the ray crossings it needs (the restriction #136 already applied
to strait fitting, generalised). `untangle` uses a segment grid instead of an all-pairs search. The
global loop and the re-bracketing reuse unchanged components' silhouettes across passes and trials (the
cache from #130 extended to open chains, keyed on the chain's own edges and the policy values that reach
it), and re-bracketing a passage retraces only the components within the smoothing reach of that hex.
Allocation in the hot loops is reduced (typed arrays for sample buffers). Expected effect: the quadratic
term disappears and the 30×30 fixture should fall from about 35 s to a few seconds; the phase reports the
measured figure, not this estimate.

### Phase 2: stop freezing the page, and stop rebuilding what did not change

Scene construction moves into a worker, as painting already has. The main thread keeps showing the
previous scene (and its overview raster) until the new one arrives; edits made while a build is running
supersede it rather than queueing. The coast cache becomes incremental: coast components are identified
by their hex sets, and an edit invalidates only the components whose hexes, or hexes within the
smoothing reach of them, changed. Distant coasts, their fitted shares and their island layouts are
reused. Output is again identical (hash gate); the measure is edit latency, targeted below 300 ms for a
one-hex edit on the 30×30 fixture.

### Phase 3: replace iterative share fitting with a local, area-aware correction

This is the phase that changes the drawing, and the one that fixes Level 3 rather than paying for it.
The root problem is that shares are imposed on a hex-cut polygon and then disturbed by a non-local
smoother, after which the code searches for cuts that the smoother will turn into the right areas. The
replacement keeps the current coastline generator as it is (same sampling, silhouette filter, seeded
broad features, cuts and fine detail, so the look is preserved) and adds one final correction that is
designed to be solved directly.

The area of land a hex contains changes, to first order, by the integral of the coast's normal
displacement over the stretch of coast inside that hex. If the correction displacement along the coast
is a sum of smooth bumps, one per target hex, each with compact support centred on that hex's stretch
of coast, then the area change of every hex is a linear function of the bump amplitudes, and the matrix
is sparse and banded along each coast chain (a hex's bump overlaps only its neighbours'). One small
linear solve gives the amplitudes that bring every hex to its feasible target simultaneously; a second
solve on the re-measured result removes the second-order residue. The exact area of land in a hex is
computed by clipping the coast's segments to the hex polygon and applying the shoelace formula to the
clipped boundary (exact, and proportional to the number of segments in the hex, instead of the current
128-line scan). Bump amplitudes are bounded by the local clearance and by the curvature radius (as
`componentCoast` already bounds detail), so the correction cannot fold the line or close a strait; where
a bound binds, that hex's interval from Section 5 is narrowed and the miss is flagged as infeasible, with
the reason, rather than retried. Straits and isthmuses keep their analytic `fillFor` solution, which is
already local; their hexes enter the solve with their crossing points pinned so neighbours cannot pinch
them. The global sixteen-pass loop, the re-bracketing and `fitCoastAreas` are then deleted, along with the
phantom fragments they create; a final pass removes any closed fragment not attributable to an island or
lake hex and the Level 2 audit checks that none remain.

The phase's evidence is the full gallery comparison against Phase 2's output. Its acceptance targets are:
no hex inside its feasible interval off by more than 2 points (counting ink); every infeasible request
flagged with its cause; zero phantom fragments; mean coastline displacement against the Phase 2 baseline
small enough (proposed: under 0.1 hex on fixtures whose shares were already met) that the character of
the coast is unchanged where nothing needed correcting; and construction for the 30×30 fixture under one
second. Where the gallery shows a coast changing visibly, the PR says which hex required it and why.

### Phase 4: islands that never overlap, and features that are what they claim to be

Island layout moves to after the coast is final and keeps islands clear of the mainland as drawn, not
the pre-smoothing polygon. Separation and the crowding measure use the actual outlines that will be
drawn, skerries included (skerries are placed first as part of their island's outline, then the
whole outline is what is kept apart). The `islandScale` fallback that draws crowded islands at full share
is replaced with the Level 1 rule: shrink until clear, and if the count cannot fit at any size, flag it.
The Level 2 checks (strait connectivity and width, isthmus connectivity and width, island count, mainland
attachment, no detached fragments) become audits with tests, run on every gallery fixture. The feasibility
intervals from Section 5 are surfaced in the Inspector when a share, width or island count is edited, so
an impossible combination is flagged as it is chosen.

### Phase 5: asymmetry

The symmetric generators are replaced with seeded asymmetric ones, measured by the Level 4 audit. The
uniform inset becomes a depth profile that varies along each sea edge and between edges (seeded per hex,
with the area constraint still met exactly because Phase 3 corrects whatever area the profile gives).
Concentration keeps its chosen side but uses a seeded skew and offset instead of a pure cosine, so the
land is not a mirror image about the axis. Strait banks get independent widths, depths and skew per bank
rather than identical semicircles. Two-island layouts get independent offsets along and across their axis.
The gallery shows these hexes before and after, and the near-symmetric count must fall to zero on
irregular hexes without new Level 1–3 violations.

### Phase 6: lighter scenes

The coast path is decimated after it is final, with a tolerance set from the maximum zoom (a fraction of a
device pixel at 4× scale), and the per-sample donor slivers are merged per donor hex into one polygon each.
This targets the 3.5× primitive and 5× command growth from #128 that slows painting and the worker hand-off.
The gate is a pixel comparison at the maximum zoom (no differences beyond antialiasing) plus the gallery.

### Order of value

Phases 0–2 recover most of the lost responsiveness without touching the drawing, and can proceed while
Phase 3's design is reviewed. Phase 3 is the substantive fix for land shares and removes most of the cost
for good; Phases 4 and 5 address overlap and symmetry, which are independent of performance but share
the Phase 0 harness; Phase 6 is a smaller, separable gain for painting.

## 7. Reproducing the measurements

```sh
npm ci
node --import tsx scripts/coast-feature-benchmark.ts --size 30
# another revision, on the same fixture:
mkdir -p work/rev && git archive 6e6ab7e | tar -x -C work/rev && ln -s "$PWD/node_modules" work/rev/node_modules
node --import tsx scripts/coast-feature-benchmark.ts --size 30 --root work/rev
```

`--layout plain` gives the plain-coast fixture; `--size` and `--runs` vary the map and repetitions.
