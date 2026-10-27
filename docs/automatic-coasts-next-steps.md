# Next steps: automatic coasts and base terrain families

Status: planned, not started. Its prerequisite, PR #156 (source fidelity, bounded contours, climate
inference and limited island configuration), is merged. Implement this as one PR against `main`,
with migration and before/after images.

## User-facing model

Group the base palette and legend into three families:

| Family | Selectable types | Meaning |
| --- | --- | --- |
| Water | Sea, Sea Ice, Lake | Water surfaces; no land-only layer values. |
| Land | Mainland, Glacier | Dry land or land under permanent ice; the app derives whether it has a shore. |
| Special | Islands, Mainland and islands, Isthmus, Strait | Retain existing island and narrow-passage capabilities. Islands and Mainland and islands contain land and are coastal by definition. |

Use **Mainland** as the ordinary land label, also for the interior of a large island. Keep the stored `Land` value initially to avoid an unnecessary save-format rename. Remove Coastal Land as a selectable or AI-generated category. Glacier stays Glacier at a shore: coastal status must not erase its ice identity.

Isthmus and Strait are retained under Special rather than silently discarded. They keep their existing land/channel rules; Strait remains ineligible for elevation, climate, vegetation and rural population even though it has banks.

## Shared coastal derivation

Introduce one pure, shared function that derives shore edges and coastal status from canonical base geography, grid dimensions and the boundary policy. Reuse the existing odd-r neighbour helper. Do not store a second, independently editable coastal terrain grid.

- Ordinary land adjacent across a shared edge to Sea, Lake or Sea Ice is coastal. Include both even- and odd-row diagonals; corner contact alone does not count.
- Island-bearing hexes are coastal by definition. When deciding whether a neighbouring land edge faces their water, respect which sectors actually contain water; do the same for Strait and other split terrain. Move reusable edge-surface logic into shared code rather than approximating it separately in UI, measurement and renderer code.
- Classify sea and lake shore edges separately where the lake renderer needs freshwater shoreline rules.
- Keep Glacier as an ice-covered land surface with derived shore edges. Never turn it into Sea Ice merely because it is coastal.
- Respect actual off-grid boundary water/rim policy. The present prompt assumes a Sea/Sea Ice ring unless the brief says otherwise; establish an explicit shared boundary setting if this exception is to affect drawing. Do not ask the renderer to interpret prose. A map edge alone must not force a coast when it represents continuing land.

Recompute the derived result after generation, pasted chat imports, manual painting, loading, resizing/growing, undo and redo. Prefer deriving on read with caching by immutable base/boundary inputs; no new journal entry or undo step is needed for derived state.

## Land fractions and rendering

For a coastal Mainland hex, use the current map-wide Coastal Land land-share default unless that hex has a valid explicit saved override. In an inland Mainland hex use a full land share. Inherit the map setting rather than copying a literal percentage into each newly coastal hex; changing the default should update all inheriting coasts.

Coastal Glacier must retain its ice overlay and land-layer eligibility. Derive its shoreline land coverage using the coast default unless a valid explicit per-hex land override applies; keep the glacier's ice coverage concept distinct from shoreline land coverage. Inland Glacier keeps its normal full-land behaviour. Verify this rule visually and against surface-area accounting before removing the legacy coastal category.

Keep island types' existing mainland/island land-share defaults and user overrides. Their coastal status does not replace their own land-share model with the Mainland coast default.

Use the same derived surface information for the renderer, effective land fractions, polity areas, population capacity, city coast edges, labels, picking, exports, inspectors and AI prompt context. This requires making area helpers base/grid-aware rather than attempting to infer coast status from a single terrain enum.

An internal adapter may temporarily provide the existing renderer with an effective Coastal Land view of Mainland hexes. It must remain derived and must never leak into canonical saves, editable terrain or the new AI legend. Glacier needs a shore-aware path retaining its own identity.

## Compatibility and migration

- Read old `Coastal Land` saves and the legacy `c` response code; normalise to canonical `Land` plus compatible shape metadata. New prompts emit ordinary land, with the app deriving shore status.
- Carry forward existing land-share and irregularity overrides, remapping their terrain applicability so legacy coastal settings still apply to the corresponding Mainland shore.
- Keep dormant coast overrides when a shore becomes inland, but exclude them from inland area/drawing. Restore them if the same land hex becomes coastal again; remove incompatible overrides when its underlying terrain changes.
- Migrate whole-map history and per-layer undo/redo snapshots, as well as currently visible base data. Old saves must remain loadable and new exports must reopen consistently.
- Preserve geo names, island configurations, settlements and polity identities. Mark downstream generated layers stale through the existing base-version rules; do not regenerate them silently.

## Prompt and external-chat changes

Replace the base legend with the three families and remove all instructions to label individual shore hexes Coastal Land. Agents choose Mainland, Glacier and special terrain; the app computes coastal status on import.

Continue supplying saved scale, effective fractions, island configurations and existing-map measurements. Copied prompts remain self-contained: explain the coast derivation and land-area arithmetic so an out-of-app model can independently check the geography it proposes. Changed geography needs its own recalculated counts and areas, not the old map's totals.

Do not add a requirement for an API key, live app measurements or a pre-generation approval gate. A chat agent can ask for essential missing information in the external conversation and then return supported JSON.

## Acceptance checks

- Shared-edge adjacency on even and odd rows; Lake, Sea and Sea Ice shores; water rings and continuing-land boundaries.
- Adding/removing water updates coastal status, default land fractions and drawing automatically in both directions.
- Glacier stays Glacier; lake shores use lake contours; special terrain retains working island/neck/channel shapes and eligibility.
- Default and per-hex overrides agree across drawing, areas, city coast facts, prompt context and PNG/SVG/JSON export.
- Existing saves, legacy pasted replies, new API replies and new compact/full single/multi-layer chat replies converge on the same state.
- Undo/redo and growth preserve both canonical terrain and manual coast overrides without duplicate history entries.
- Regression fixtures show a mainland coast, lake island, multi-hex island, coastal glacier, adjacent island-bearing hexes, and narrow lake/sea passages. Include before/after images.
