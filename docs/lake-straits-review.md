# Lake strait review

The two galleries use the same diagnostic map, seed, scale, style and sixteen inputs. They show several surrounding hexes, so the passage's mainland connections and the adjoining lake shore remain visible. This is not the user's original saved map.

[Original renderer](lake-straits-original-renderer.png) uses main at `117971211707f7b782cb3ad66b940c145a07cae8`.

[Revised renderer](lake-straits-review-in-progress.png) uses this branch. The PR remains a draft for visual review; passing geometry checks does not establish that a coastline looks natural.

The gallery lists the complete controls: four widths (5%, 15%, 30%, 50%); middle or any of six sides; Smooth, Wavy, Ragged or Fractured shores; Natural land or 0–100% in steps of 5%. Sixteen representative combinations cover every width, junction position and irregularity, with selected explicit land shares.

Regenerate the revised gallery with:

```sh
node --import tsx scripts/render-lake-strait-review.ts
```

The HTML is written to `work/lake-strait-review/gallery.html`. The cases and map layout are shared with the tests in `test/fixtures/lakeStrait.ts`.

The 25 lake rendering checks measure the final outline and coastline ink: water continuity, opposing-bank separation, requested width in all sixteen cases, west/east throat positions, whole-outline crossings, land coverage, adjoining lake controls, map-edge closure, undo/cache stability, and preservation of distant shores. Two additional tests exercise the local shore join with one edit and overlapping edits. These are numerical regressions, not an automated judgement of natural appearance.

Explicit land shares the renderer does not reach are annotated with the percentage actually painted. Such annotations describe a renderer limit, not proof that the requested geometry is impossible.
