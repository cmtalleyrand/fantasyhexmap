# Lake strait review

The two galleries use the same diagnostic map, seed, scale, style and sixteen inputs. They show several surrounding hexes, so the passage's mainland connections and the adjoining lake shore remain visible. This is not the user's original saved map.

[Original renderer](lake-straits-original-renderer.png) uses main at `117971211707f7b782cb3ad66b940c145a07cae8`.

[Revised renderer](lake-straits-review-in-progress.png) uses this branch. The PR remains a draft for visual review; passing geometry checks does not establish that a coastline looks natural.

The gallery lists the complete controls: four widths (5%, 15%, 30%, 50%); middle or any of six sides; Smooth, Wavy, Ragged or Fractured shores; Natural land or 0–100% in steps of 5%. Sixteen representative combinations cover every width, junction position and irregularity, with selected explicit land shares. The 80% gallery entries have been replaced with Natural or 50%, following the requested focus on short straits rather than forcing high land coverage. An 80% regression separately checks that it leaves the Natural headland shape intact and reports the actual coverage.

Regenerate the revised gallery with:

```sh
node --import tsx scripts/render-lake-strait-review.ts
```

The HTML is written to `work/lake-strait-review/gallery.html`. The cases and map layout are shared with the tests in `test/fixtures/lakeStrait.ts`.

The previous attempts corrected topology but constructed each bank separately, then joined those shapes back to the lake. That produced conspicuous shoulders, hooks and matching curves. The numerical checks did not judge those visual defects, and the earlier four-case comparison was inadequate.

Two-bank lake straits now use a local signed distance field: a gently curving water corridor widens away from the chosen throat, each bank has independent seeded variation, and the field blends into the existing shore. The local transition retains mainland connections. Each bank has a rounded nose and retreats rapidly away from it, keeping the constriction short. Explicit land shares vary headland depth within that shape; high requests such as 80% are left unfitted rather than extending the banks into a canal. The edit is joined locally so distant shores keep their original shapes. Isthmuses and more complex junctions retain the coastal solver.

The gallery uses the normal parchment rendering, including texture, at a fixed wider view for both versions.

[Four irregularity settings on the same strait](lake-straits-irregularity.png) holds the surrounding lake Smooth while changing only the selected strait. Wavy adds broad undulations, Ragged combines several scales of coves and projections, and Fractured uses angular variations. Shore detail is a bounded distance displacement along the flanks, fading out around the rounded noses. Its amplitude is independent of headland depth so it neither disappears nor grows into exaggerated spurs as the landforms change.

Regenerate that comparison with:

```sh
node --import tsx scripts/render-lake-strait-review.ts work/lake-irregularity 'Four settings' --irregularity
```

The 27 lake rendering checks measure the final outline and coastline ink: water continuity, short throats that open into wider water on both sides, opposing-bank separation, requested width in all sixteen cases, west/east throat positions, whole-outline crossings, visible irregularity with the surrounding lake held Smooth, land coverage, adjoining lake controls, map-edge closure, undo/cache stability, and preservation of distant shores. Two additional tests exercise the local shore join with one edit and overlapping edits. These are numerical regressions, not an automated judgement of natural appearance.

Explicit land shares the renderer does not reach are annotated with the percentage actually painted. Such annotations describe a renderer limit, not proof that the requested geometry is impossible.
