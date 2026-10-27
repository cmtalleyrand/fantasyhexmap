# Drawing status

What the drawing code does now, the evidence for it, and what is still open. Read this, [the work
plan](drawing-work-plan.md) and [DECISIONS](../DECISIONS.md) before further drawing work.

The shared finished coastline, rounded cape/rim repair, exact redraw reuse, coastal seam fixes and
exact realm-colour boundaries are present, together with lake-strait, concentration and limited
generated-island controls from PRs #149/#154–156. Editing latency was addressed in PR #160 (DECISIONS
§70–75). Land-derived realm-name anchors, complete independent paint coverage and broader control
fidelity remain unfinished.

Earlier investigation narratives, raw result files and before/after images were removed from `docs/`
after this consolidation. They remain in Git: `git show 8bf42c7:docs/<name>` (for example
`git show 8bf42c7:docs/coast-paint-fix.md`), and `git ls-tree --name-only 8bf42c7 docs/` lists them.

## Applied solutions and whether they succeeded

| Work present in source | Evidence of success and remaining limit |
|---|---|
| Painted island/lake paths and river mouths share `landAt`; glacier shelf gets the coast clip; lake-donated shore ground is painted correctly. `scene.ts`, `rivers.ts`, DECISIONS §§52–54. | Original failing-before checks caught four wet symbol points, 2,283 wet shelf pixels and 13 lake predicate/paint disagreements. Retained after results remove these reproduced failures. This does not inventory every drawing branch. |
| Gentle river wander retracts locally only where it creates a ≥60° kink. | Original 80/400 failures became zero; the 320 already-valid courses stayed identical. Further retained runs covered 4,000 cases across two gentle levels. Other route families are not proved safe. |
| Names fit their drawn surface or are omitted; reports distinguish adaptations/losses. Symbol floor is 50%. | Long water-name failures were repaired; requested omissions are reported. The 200 tiny fractured-island examples retained 10 mountain symbols versus 187 at the old 30% floor: an approved readability cost. Duplicate-name omission reporting still uses text rather than feature identity. |
| Enclosed-water orientation distinguishes sea holes from land islands. `coast.ts`/`scene.ts`, §60. | 400/600 baseline topology failures became zero. The sweep checks intended land/water at cell centres, including nested islands; predicate agreement alone could not catch this defect. Do not reopen the inflated Sea loop as an unfixed diagnosis. |
| Open fold-back loops removed; one conditional fourth unsmoothed fitting candidate; post-skew loop-join rounding and tangent page continuation. `coastCorners.ts`, `rim.ts`, §§61–62, 67. | Retained full area sweep: 150 cases within the then one-percentage-point gate (now 5 points, the owner's tolerance) (maximum errors Classic 0.789, Parchment 0.470, Atlas 0.440 pp); 200 island and 600 enclosed-sea cases pass at the recorded continuation version. Pinned rounded 5% cape paints 4.6726%. This is finite fixture evidence, not a universal geometry guarantee. |
| Border-notch fills clipped to final land; all preset land-colour defaults uniform. §§65–66. | Recorded Canvas comparison removes detached rim fragments. Explicit coastal-band choices remain supported. Classic is to be retired outright; see `simplification-next-steps.md` §4.5. |
| Exact ice, symbol, island and coast-paint reuse. `ice.ts`, `islandDrawingCache.ts`, `coastPaintGeometry.ts`, `scene.ts`. | Node reconstruction checks and retained exact replay support reuse. Ice budgets total 16 MB estimated, island scale/drawing budget 4 MB estimated; these are not allocation measurements. The coast-paint derivatives share the existing 20 MB coast budget. Placement caching already exists; see the work plan before adding another cache. |
| Equal painter histories in replay; independent JavaScript heaps in comparison benchmarks. §63, §69. | Identical scene objects could differ by 2–3 pixels with unequal Path2D histories; fresh clones eliminated this control defect without changing production painting or exact assertions. Separate benchmark isolates remove cross-version GC attribution, not production GC pauses. |
| PR #152: resolve opaque ground colours, group translucent donor paint, fit donor envelopes to final coast. `coastPaint.ts`. | Retained 18-case Canvas/SVG seam/band sweep passes. Earlier child-count compositor selection caused a paint regression and was rejected. See seam investigation (`docs/coast-paint-fix.md` at `8bf42c7`). |
| PR #153: exact shared realm boundaries, preserve holes, exclude neighbouring and unowned regions from donor extensions. `realmBoundary.ts`, `scene.ts`. | Retained 18-case Canvas/SVG sweep checks 15,225 probes per renderer with zero realm-colour errors. It excludes ink pixels and uses land predicates to select probes; it does not independently prove all border ink stays on painted land. See boundary investigation (`docs/realm-boundary-fix.md` at `8bf42c7`). |
| PR #149: short lake straits between independently varied headlands, local shore-field joins and visible flank irregularity. `lakePassage.ts`, `lakeShoreField.ts`, `scene.ts`. | Merged numerical regressions cover continuity after ink, widths, junction side, crossings, local editing and cache/undo. High land targets such as 80% retain the natural shape and report the actual share instead of forcing a canal. Retained review (`docs/lake-straits-review.md` at `8bf42c7`) is historical visual-review text; the PR is now merged. Natural appearance is not proved by geometry checks. |
| PR #154: independent endpoint depths on a single-edge coastal cut, solving mean depth to preserve area. PR #155: lake concentration direction and measured-ink fitting. | Concentration evidence (`docs/coast-concentration.md` at `8bf42c7`): 24 default-style coastal scenes, maximum outlined-coast error 0.271 pp; 54 plain-Land-neighbour lake scenes, maximum 0.500 pp. These are retained outline/ink measurements, not a fresh independent finished-pixel area sweep. Zero concentration preserves the control path. |
| PR #155: isolate each comparison SVG in its own image document. | Cross-panel clip/pattern ID collisions caused apparent painted spill; 42 gallery panels match standalone screenshots after isolation. This comparison defect was repaired without changing the standalone coastline. The Coastal Land-neighbour experiment separately retains 29 area failures and 3 direction failures across 54 scenes; that coupled fitting problem remains open. |
| PR #156: source-faithful prompts and limited generated island settings. `generatedIslands.ts`, generation/import/reducer paths. | Optional island counts, arrangement, orientation and irregularity now reach map state across API/chat paths; manual land shares/layout controls are preserved, incompatible old terrain settings dropped, and undo/redo covered. Generated arbitrary land shares are not introduced. [Automatic coasts and terrain families](automatic-coasts-next-steps.md) remain a separate planned migration, not an implemented fix. |

## Reconciled original investigation items

| Item | Current disposition |
|---|---|
| 1: inconsistent land answers | Reproduced island/lake/mouth/sea-hole cases repaired; complete branch inventory remains open. |
| 2: river-mouth predicate | Shared finished land replaces the failed nearest-segment test. |
| 3: shading/overlays at shore | Shelf/escarpment and later seam repairs present; coverage is finite. |
| 4: realm anchors | Open: candidates and beside bounds still substantially derive from hex centres. |
| 5: wrong-surface names/decorations | Name repairs present; entire markers, ripple/ice/border ink checks incomplete. |
| 6: coast fragments/knots | Open fold-backs, rim spill and pinned cape repaired; other old spur/lake-ink observations need current reproduction before diagnosis. |
| 7: independent checks | Expanded by topology, seam and realm-colour checks; all seven principles are not fully covered. |
| 8: unpinned fixtures | Identified render fixtures pinned; continue pinning new cases. |
| 9: gentle-river kinks | Reproduced route family repaired; broader routes still unproved. |
| 10: control fidelity | Ordinary-coast gate retained. Single-edge coast and plain-neighbour lake concentration repaired in #154/#155; lake-strait controls in #149. Coupled Coastal Land-neighbour lake fitting has retained failures; broader islands and painted realm/legend agreement remain open. |
| 11: small-feature ink/readability | Concern remains; do not change shares or add blanket warnings to hide it. |
| 12: omission reports | River/water reports present; duplicate-name identity, furniture/river loss policy remain open. No routine city/escarpment notices. |
| 13: notice volume | Severity/grouping present, losses retained. |
| 14: symbol size | Approved 50% floor present; omission cost disclosed. |
| 15: small-realm association | Open with item 4; review prototype is not production. |
| 16: cache survival | Existing exact caches survive eligible edits; short worker-heap study exists. Longer/native lifetime evidence remains absent. |
| 17: predicate/edit costs | Exact lazy edge index already exists; no approximate grid introduced. Worker study exists historically; current feature-name and paint costs need diagnosis. |
