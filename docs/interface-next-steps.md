# Interface: next steps

Phases 1–3 of the October 2026 interface review are done (generate buttons, empty-map guidance, layer
rows, panning, keyboard shortcuts, dialogs, file menu, undo-all and the rest). The review itself is in
Git at `8bf42c7` (`docs/REVIEW-AND-PLAN.md`). What remains is its phase 4, polish and maintainability:

- **Split the large components.** Move the editors out of `src/components/Inspector.tsx`
  (1,639 lines) into `src/components/editors/{PerHex,Polity,City,River,MountainRange}Editor.tsx`.
  Move generation orchestration out of `src/App.tsx` (1,315 lines) into `src/state/useGeneration.ts`.
  Behaviour must not change; do this as its own PR.
- **Inline checkboxes.** Add a `.check-inline` style and a shared `Check` component, reusing the one
  in `ExportPanel.tsx`.
- **Touch targets.** Raise small buttons to at least 28px hit targets on coarse pointers, using
  `@media (pointer: coarse)`.
- **Legend filter.** Add an "only values on this map" toggle to the Inspector legend, reusing the
  only-used logic in `src/render/legend.ts`.

Check each change with `npm run typecheck`, `npm test` and `npm run build`. For layout changes, also
drive the app in mock mode (`HEXMAP_MOCK=1 npm run dev`) at 1440×900 and 390×844.
