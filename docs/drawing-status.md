# Drawing status and evidence

Reviewed 21 October 2026 on `codex/default-coast-comparisons`, against code at
`12a33d7e8472d193d8c37939941ceeea5ca8ebc8` (merged PR #156), after rebasing the initial
review of `849f12f` (#148). This consolidation changes
documentation only. Read this record, [the work plan](drawing-work-plan.md), and
[DECISIONS](../DECISIONS.md) before further drawing work.

The shared finished coastline, rounded cape/rim repair, exact redraw reuse, coastal seam fixes
and exact realm-colour boundaries are present, together with lake-strait, concentration and limited
generated-island controls from PRs #149/#154–156. Editing latency, land-derived realm-name anchors,
complete independent paint coverage, and broader control fidelity remain unfinished. No current-head
performance pass is established by this review.

## What was stale

| Superseded document | Assessment after source/history review |
|---|---|
| `drawing-followup-connected.md` | Its 20 October rebase qualification was correct. The measurements belong to runtime `be084b1` versus `6f3d5c7`, before the rebase onto `fd8d2f6`. The body still names retained geometry in `coastPaint.ts`; that helper is now `coastPaintGeometry.ts`. Its remaining-work list needed the newer realm-boundary coverage distinguished from missing border-ink containment coverage. |
| `drawing-next-agent.md` | Wrong working branch, several obsolete milestones and test totals, and unqualified “current-main” benchmark claims. It prioritised anchors before diagnosing the larger feature-name/paint costs. |
| `drawing-investigation.md` | Useful first-investigation evidence, but its active merge blocker, missing worker study and inflated enclosed-sea defect were superseded. Its original 17 findings needed reconciliation with later fixes. |
| `drawing-followup.md` | Also superseded: mixed historical and “current” sections, draft/merge-blocker language, earlier sea/coast results and already completed worker-study tasks. |

These four narrative documents have been removed after consolidation. Their original text is available
through Git (for example, `git show 849f12f:docs/drawing-followup-connected.md`). Raw results, failed
measurements, compressed records and renderer images remain in place. Filenames containing “current”
are historical artifact names, not statements about today's head. The initial local `origin/main`
was stale at `c40f4f1` (#126). It has now been fetched to `12a33d7`; the consolidation rebases cleanly
onto that main. Earlier measurements have not been relabelled as measurements of the new code.

## Applied solutions and whether they succeeded

| Work present in source | Evidence of success and remaining limit |
|---|---|
| Painted island/lake paths and river mouths share `landAt`; glacier shelf gets the coast clip; lake-donated shore ground is painted correctly. `scene.ts`, `rivers.ts`, DECISIONS §§52–54. | Original failing-before checks caught four wet symbol points, 2,283 wet shelf pixels and 13 lake predicate/paint disagreements. Retained after results remove these reproduced failures. This does not inventory every drawing branch. |
| Gentle river wander retracts locally only where it creates a ≥60° kink. | Original 80/400 failures became zero; the 320 already-valid courses stayed identical. Further retained runs covered 4,000 cases across two gentle levels. Other route families are not proved safe. |
| Names fit their drawn surface or are omitted; reports distinguish adaptations/losses. Symbol floor is 50%. | Long water-name failures were repaired; requested omissions are reported. The 200 tiny fractured-island examples retained 10 mountain symbols versus 187 at the old 30% floor: an approved readability cost. Duplicate-name omission reporting still uses text rather than feature identity. |
| Enclosed-water orientation distinguishes sea holes from land islands. `coast.ts`/`scene.ts`, §60. | 400/600 baseline topology failures became zero. The sweep checks intended land/water at cell centres, including nested islands; predicate agreement alone could not catch this defect. Do not reopen the inflated Sea loop as an unfixed diagnosis. |
| Open fold-back loops removed; one conditional fourth unsmoothed fitting candidate; post-skew loop-join rounding and tangent page continuation. `coastCorners.ts`, `rim.ts`, §§61–62, 67. | Retained full area sweep: 150 cases within the unchanged one-percentage-point gate (maximum errors Classic 0.789, Parchment 0.470, Atlas 0.440 pp); 200 island and 600 enclosed-sea cases pass at the recorded continuation version. Pinned rounded 5% cape paints 4.6726%. This is finite fixture evidence, not a universal geometry guarantee. |
| Border-notch fills clipped to final land; all preset land-colour defaults uniform. §§65–66. | Recorded Canvas comparison removes detached rim fragments. Explicit coastal-band choices remain supported. Classic retirement is only a direction, not a completed migration. |
| Exact ice, symbol, island and coast-paint reuse. `ice.ts`, `islandDrawingCache.ts`, `coastPaintGeometry.ts`, `scene.ts`. | Node reconstruction checks and retained exact replay support reuse. Ice budgets total 16 MB estimated, island scale/drawing budget 4 MB estimated; these are not allocation measurements. The coast-paint derivatives share the existing 20 MB coast budget. Placement caching already exists; see the work plan before adding another cache. |
| Equal painter histories in replay; independent JavaScript heaps in comparison benchmarks. §63, §69. | Identical scene objects could differ by 2–3 pixels with unequal Path2D histories; fresh clones eliminated this control defect without changing production painting or exact assertions. Separate benchmark isolates remove cross-version GC attribution, not production GC pauses. |
| PR #152: resolve opaque ground colours, group translucent donor paint, fit donor envelopes to final coast. `coastPaint.ts`. | Retained 18-case Canvas/SVG seam/band sweep passes. Earlier child-count compositor selection caused a paint regression and was rejected. See [seam investigation](coast-paint-fix.md). |
| PR #153: exact shared realm boundaries, preserve holes, exclude neighbouring and unowned regions from donor extensions. `realmBoundary.ts`, `scene.ts`. | Retained 18-case Canvas/SVG sweep checks 15,225 probes per renderer with zero realm-colour errors. It excludes ink pixels and uses land predicates to select probes; it does not independently prove all border ink stays on painted land. See [boundary investigation](realm-boundary-fix.md). |
| PR #149: short lake straits between independently varied headlands, local shore-field joins and visible flank irregularity. `lakePassage.ts`, `lakeShoreField.ts`, `scene.ts`. | Merged numerical regressions cover continuity after ink, widths, junction side, crossings, local editing and cache/undo. High land targets such as 80% retain the natural shape and report the actual share instead of forcing a canal. [Retained review](lake-straits-review.md) is historical visual-review text; the PR is now merged. Natural appearance is not proved by geometry checks. |
| PR #154: independent endpoint depths on a single-edge coastal cut, solving mean depth to preserve area. PR #155: lake concentration direction and measured-ink fitting. | [Concentration evidence](coast-concentration.md): 24 default-style coastal scenes, maximum outlined-coast error 0.271 pp; 54 plain-Land-neighbour lake scenes, maximum 0.500 pp. These are retained outline/ink measurements, not a fresh independent finished-pixel area sweep. Zero concentration preserves the control path. |
| PR #155: isolate each comparison SVG in its own image document. | Cross-panel clip/pattern ID collisions caused apparent painted spill; 42 gallery panels match standalone screenshots after isolation. This comparison defect was repaired without changing the standalone coastline. The Coastal Land-neighbour experiment separately retains 29 area failures and 3 direction failures across 54 scenes; that coupled fitting problem remains open. |
| PR #156: source-faithful prompts and limited generated island settings. `generatedIslands.ts`, generation/import/reducer paths. | Optional island counts, arrangement, orientation and irregularity now reach map state across API/chat paths; manual land shares/layout controls are preserved, incompatible old terrain settings dropped, and undo/redo covered. Generated arbitrary land shares are not introduced. [Automatic coasts and terrain families](automatic-coasts-next-steps.md) remain a separate planned migration, not an implemented fix. |

## Visible evidence retained

These are actual Canvas renders of the same synthetic pinned map, with the full grid including water.
They are historical comparisons, not fresh renders of this head or captures of the owner's saved map.

| Rejected cape/page join | Rounded production proposal |
|---|---|
| ![Before, full grid](drawing-followup/parchment-grid-review.png) | ![After, full grid](drawing-followup/parchment-after-skew-proposal.png) |

Other original before/after images remain under `drawing-investigation/` and `drawing-followup/`.
They document the initial island, shelf, lake, water-name, symbol-floor and enclosed-sea repairs.
Do not use their grid-free views as the sole evidence for a new geography or anchor change.

## Performance: version boundaries matter

All figures in the following two tables are **pre-rebase** evidence for runtime
`be084b1a4b054acfd7b48c357ccc654019ff33ea` versus main
`6f3d5c755d8666731f21e62d9073e939cbd68a66`, Chromium 151.0.7922.173.
They are not measurements of `fd8d2f6`, rebased PR #148, `849f12f` or current main `12a33d7`.

The final independent-heap 40×40 construction gate passed: five cold builds and 100 per steady-state
scenario, first two steady-state samples excluded, alternating order, no concurrent heavy work.

| Construction ms | Baseline median / p95 | Candidate median / p95 |
|---|---:|---:|
| Cold | 2667.3 / 3347.1 | 2688.7 / 3267.0 |
| Warm | 92.6 / 199.3 | 46.7 / 80.1 |
| Ownership | 92.7 / 205.9 | 45.7 / 77.1 |
| Shore | 126.9 / 269.2 | 76.3 / 157.7 |

The separate 50×50 production-worker harness used 32 cumulative unique ownership edits, sequential
version lifetimes, all layers/names, bitmap transfer and two animation frames. It bypassed React input
and Inspector scheduling. Its measured viewport was 1400×900 at DPR 1.

| Unique-edit ms | Baseline median / p95 | Candidate median / p95 |
|---|---:|---:|
| Build roundtrip | 615.1 / 782.4 | 482.3 / 593.9 |
| Displayed sharp frame | 1086.4 / 1614.4 | 937.7 / 1341.7 |
| Worker viewport paint | 466.5 / 861.4 | 437.3 / 845.9 |
| Realm-name placement | 14.8 / 20.3 | 9.1 / 20.4 |

Candidate construction averaged 493.5 ms: 403.7 ms feature-name placement versus 11.6 ms realm names.
Source still keys the whole river-label family on all ordered realm/city obstacles. A moved realm
name can therefore repeat river searches even when courses are unchanged. This supports a focused
diagnostic, not a claim that 404 ms remains the measured current cost or that realm anchors dominate.
Painting retains a substantial historical tail and needs its own causal profile.

The separate forced-GC pass retained 76.91 MiB after cold, 74.05 after warm, and
84.44/86.17/86.67/86.74 MiB after 8/16/24/32 edits; baseline ended at 88.73 MiB.
Embedder heap was about 12.96 MiB for both after editing. These observations exclude Canvas/GPU/native
memory and do not prove a lifetime bound or attribute memory to individual caches. Memory-pass timings
are diagnostic, not benchmark samples.

Failed runs remain material evidence:

- Initial #145 final comparison: ownership and shore p95 regressed 10.5%/23.5%.
- Glacier-only reuse failed shore p95; adding revision reuse still failed warm p95.
- `f67ca94` versus `1179712`: warm p95 169.1→209.8 ms, ownership 185.0→187.2 ms.
- Shared-heap `a7d9b03` versus `6f3d5c7`: shore p95 249.6→278.2 ms despite a faster median.
- Classic's separate tiny-fixture cold cost was +0.9 ms / +29%; large-map gains do not erase it.

Raw artifacts are unchanged: [initial results](drawing-investigation-results.json),
[early follow-up](drawing-followup-results.json), [later failed run](drawing-followup-current-results.json)
and its [records](drawing-followup-current-records.json.gz), plus
[connected results](drawing-followup-connected-results.json) and [complete connected records](drawing-followup-connected-records.json.gz).
The connected JSON identifies sweep/replay runtime `3471968` separately from final timing runtime
`be084b1`; do not flatten those into one validation claim. Rebase commit `1abc064` reports 502 Node
tests, typecheck/build, focused seam checks and all 18 boundary cases passing after integration.
The pre-rebase 944-image replay was not rerun on that rebased head.

## Checks performed for this consolidation

At the initial `849f12f` review, source, Git history, scripts, retained experiments and result metadata
were inspected. Five focused
Node files pass: `drawingInvestigation`, `incrementalRender`, `labelPlacement`, `realmBoundary`,
and `coastPaint`. This includes exact cached/full scene checks; it is not a new full-suite result.

An eight-edit 50×50 worker diagnostic was attempted but produced **no samples**. The checkout's
default Playwright import failed; using the installed alternate driver reached Chromium, which
terminated on sandbox-denied `setsockopt`. A request to run with added permissions was cancelled.
No browser sweep, new renderer image, timing comparison or memory result is claimed for this head.
[Review records](drawing-status-review-records.json.gz) retain the command outcomes and test log.

The subsequent rebase review reads all intervening PRs through #156 and their source/retained evidence.
Eleven focused Node files pass: the original five plus `coastConcentration`, `lakeConcentration`,
`lakeStraitRendering`, `generatedIslands`, `promptAlignment` and `webchatImport`. Client/server
typechecking also passes. No browser or performance measurement was repeated for the rebase.
These checks are recorded separately in that archive, preserving the initial results and failed launches.

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
