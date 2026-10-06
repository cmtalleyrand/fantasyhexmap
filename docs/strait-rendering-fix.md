# Strait geometry and rendered land coverage

The strait now has connected mainland banks around a passage instead of land
bands cut by a separate water arm to every sea-facing edge. Adjacent sea-facing
edges form one opening. Banks grow independently in their own connected
territories; land cannot grow across the passage into detached fragments.

![Actual before/after renders](strait-rendering-fix.png)

These are actual scene/SVG renders at commit `7fd124e` and the revised renderer.
Inputs are held fixed: seed `investigation`, 30-pixel hex radius, Ragged
irregularity, Normal strait width, two non-opposite mainland neighbours. The
strait and its two coastal neighbours request 30%, 60% or 90% land in each row.
The white border identifies the strait. This is a controlled reproduction of
the reported arrangement, rather than the original screenshot's unavailable
saved map.

## What failed and why earlier changes missed it

- `fixedLand` subtracted water arms to *every* sea-facing edge from growing
  sectors/bands. At Normal width, the non-opposite-bank reproduction drew
  42.72% land for requests of 50%, 60% and 90%, including two detached islands
  **before smoothing**. The code's attachment guarantee was therefore false.
- The width revision (`e6ec53b`) introduced that construction. The selectable
  junction revision (`9a202e1`) moved its common junction without replacing the
  bank/subtraction mechanism. Shared parameters retained paired edge-hugging
  shores; outline noise did not remove the underlying arrangement.
- Whole-component area fitting (`050892a`) excludes split geography, explicit
  local shares and components touching split geography. Its improvements did
  not reach these straits or their neighbouring coastal components.
- The local area correction used requested intermediate area plus correction
  patches and perimeter-times-ink. A clamped shape did not necessarily have
  that intermediate area, and overlapping patches/strokes were miscounted.
  Explicitly fitted straits were excluded from convergence error. Seven passes
  could oscillate and return an inaccurate estimate without reporting it.
- Feature randomness depended on the moving contour centroid. Fitting changed
  the seed input, reshaping bays/capes between passes. Coarse component identities
  now keep features stable during fitting, including temporary source fragments.
- Repeated rounding of polygon intersections and coarse coastline keys could
  leave dangling shore ends. Very small fragments also failed a one-direction
  collinearity check. Intersections now retain precision; matching endpoints
  are canonicalised before tracing, and anchors use the same finer keys.
- Independent coastal inset cuts could detach a strait's donor mainland at low
  coverage. Coastal hexes adjoining straits now retain their land-facing joins
  while their combined core/bridge area is fitted.

The old “stays joined” test checked contact at mainland-facing edge midpoints,
not attachment of every land component. Its area test checked only targets
inside the old construction's feasible range. Both could pass with these bugs.

## Final coverage and topology

The fitter measures the final filled outline and the union of its round
coastline stroke inside each exact hex. It counts holes with even-odd fill and
counts overlapping ink once. Explicit passage targets participate in fitting;
their attainable range is measured with neighbours held fixed.

Residual local shares are fitted on the final silhouette while keeping hex
crossings fixed. Small positive local scales preserve detailed capes; passage
adjustments preserve the central junction and are bounded by shore clearance
and width. Candidate fold-backs/crossings are rejected. Existing small loops
at roughened caps are removed before the final fit. Ground, water and coast
corrections share the final land/water clips, and border anchors follow the
adjusted shore.

A requested share above the chosen width's attainable maximum is reported in
the inspector's existing drawing-compromise notes, with the achieved coverage
and advice to change the width or percentage. It is not silently treated as a
successful fit. Lower shares can widen a passage, retaining the existing rule
that reduced land takes priority over its natural width.

Raster measurements include coastline ink, with texture/grid/water effects
switched off for measurement. Geometry, seed and normal coastline width remain
unchanged. The inspected colour gallery above retains the parchment effects.

| Requested land | Strait (Ragged) | Left coastal hex | Lower-right coastal hex |
| --- | ---: | ---: | ---: |
| 30% | 30.08% | 30.17% | 30.07% |
| 60% | 60.14% | 59.90% | 59.63% |
| 90% | 67.30%; width limit reported | 90.22% | 89.88% |

## Regression coverage

`test/straitRendering.test.ts` covers the reported two-island case, all 62 mixed
land/sea neighbour masks at four widths and three shares (744 cases), all six
selected junctions at four widths and three shares (72 cases), independent bank
profiles, final rendered shares over three fixed seeds, simple/disjoint shores,
water at the junction, unattainable-share reporting, holes and overlapping ink.
Final achievable shares must be within one percentage point, with exactly two
mainland contours in the reported layout.

Two pre-existing river tests used random map IDs as geometry seeds and failed
intermittently in unrelated curvature/lake-shore assertions during verification.
They now use fixed named seeds; their assertions are unchanged.

The sandbox blocks the `tsx` CLI's IPC socket. The full suite is run through
`node --import tsx` directly, once per test file, avoiding that socket while
running every test. Build and client/server typechecking use the usual scripts.

Validation: all 417 tests passed after integrating main at `63a9a58`; production
build and client/server typechecking passed. The same-scale raster measurements
above were repeated after the geometry changes, before the upstream integration.
Existing build warnings concern bundle size and font imports.
