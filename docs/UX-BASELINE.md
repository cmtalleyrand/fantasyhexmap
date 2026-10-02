# Interface usability baseline

Baseline date: 2026-10-02. Branch baseline: `c8fe534`.

## Purpose and method

This document is a static interface audit for the work proposed after the original review. Its
action counts are provisional paths inferred from the controls and handlers, not measurements from
a completed multi-device walkthrough in this environment.
An interaction is modelled as a transition between states of

```
(active layer, selection, active tool, generation state, open dialog)
```

and an **action** is one click, tap, key chord, drag, or submitted form. Text entry is counted as one
action because its length depends on the user's content rather than the interface. Waiting for an AI
response is not an action. The count is therefore a lower bound on the number of deliberate user
decisions, not elapsed time.

The current repository was checked in mock mode so that generation follows the production
decode/validate/apply path without making a paid network request. Source inspection was used where
the result is invariant: fixed CSS panel widths, media-query ordering, named button paths, keyboard
handlers, and whether an element can receive keyboard focus. The earlier running-app walkthrough in
`REVIEW-AND-PLAN.md` supplies the already verified generation and editing observations.

## Target environments

| Profile | Viewport | Primary input | Layout selected by current CSS |
| --- | ---: | --- | --- |
| Desktop | 1440×900 | Mouse and keyboard | Fixed left panel, map, fixed right panel |
| Tablet | 1024×768 | Keyboard or coarse pointer | Same three-column layout as desktop |
| Phone | 390×844 | Coarse pointer | Map first, then Layers and Inspector in one page |

The desktop left and right panels consume 300 and 360 pixels respectively. Ignoring one-pixel
borders, the map therefore receives `viewport width - 660` pixels:

| Viewport | Map width | Fraction of viewport width |
| ---: | ---: | ---: |
| 1440 | 780 px | 54.2% |
| 1024 | 364 px | 35.5% |

At 640 pixels and below the layout changes from columns to a vertical stack and gives the map a
height of 62% of the viewport, subject to a 320-pixel minimum. At 390×844 the initial map height is
523 pixels. Layers and the full inspector follow below it rather than occupying task-specific tabs.

## Provisional workflow matrix

“Pointer actions” gives the shortest path inferred from the source under the stated precondition.
“Map retained” is a layout inference, not an executed observation.

| # | Workflow and precondition | Shortest pointer path | Pointer actions | Keyboard-only result | Map retained |
| ---: | --- | --- | ---: | --- | --- |
| 1 | Create a map from the setup screen | Enter description → Create map | 2 | Complete: tab to description, type, tab to Create, Enter | Yes after creation |
| 2 | Generate Base Geography on a new map | Generate Base Geography | 1 | Complete if focus reaches the overlay button | Yes |
| 3 | Generate every remaining planned layer after base | Generate the remaining layers | 1 | Complete if focus reaches the Layers action | Desktop/tablet: partly; phone: map remains above controls |
| 4 | Change several hexes in a generated per-hex layer | Choose layer → choose value → enable brush → drag selection | 4 | Blocked: the canvas has no keyboard focus or cell navigation | Yes on desktop; controls are below map on phone |
| 5 | Rename and recolour a polity | Choose Polities → edit name → change colour | 3 | Complete through ordinary form controls | Yes on desktop; not simultaneously on phone |
| 6 | Create a river | Choose Rivers → Draw new river → click course → Enter | 4 + one click per course hex | Blocked: river course points require canvas pointer input | Yes on desktop; not simultaneously on phone |
| 7 | Find why a layer is stale | Choose stale layer → read expanded stale notice | 1 | Complete: layer row and notice are ordinary controls/content | Yes on desktop; not simultaneously on phone |
| 8 | Export image and JSON | File → Export image → Download; File → Export JSON | 5 | Complete through the File menu and dialogs | Yes |
| 9 | Undo an active-layer edit | Undo button or Ctrl/Cmd+Z | 1 | Complete when no form field or dialog owns focus | Yes |

The counts expose two different classes of cost. Workflows 1–3, 7–9 have short paths; adding more
prominent duplicate controls would not improve them. Workflows 4 and 6 are not mainly too long:
they lack a keyboard-reachable representation of map cells. That is a reachability defect in the
state graph, not a click-count defect.

## State visibility matrix

The following records whether a user can determine the state without opening another dialog or
remembering a previous action.

| State | Visible now? | Evidence in the interface |
| --- | --- | --- |
| Active layer | Yes | Highlighted layer row and inspector heading |
| Layer readiness | Yes | `empty`, `working`, `ready`, or `stale` badge |
| Layer visibility | Yes | Pressed state of the eye button |
| Active river tool | Yes | Selected segmented tool and adjacent hint |
| General Select versus Pan mode | Partial | Selection is implicit; Pan exists only as Space/right/Alt drag or two-finger gesture |
| Selection size | No | Selected cells are drawn, but no persistent numeric summary is presented |
| Batch membership | Yes | A checkbox is permanently present for every planned layer |
| Generation state | Yes | Layer row, progress text, map overlay, and elapsed time |
| Generation completion | Yes | Map-anchored outcome message |
| Current map-cell values | Pointer only | Hover HUD; there is no keyboard-focused cell |

## Viewport observations

### Desktop, 1440×900

- The map receives about 54% of viewport width before padding and borders.
- Both navigation and editing controls remain visible, so layer switching and inspection do not
  require scrolling the whole page.
- The layer panel permanently spends horizontal and vertical space on batch controls even when the
  user is making a single-layer edit.
- The 360-pixel inspector accommodates forms, but long climate/vegetation legends and river lists
  create substantial internal scrolling.

### Tablet, 1024×768

- The desktop breakpoint still applies, so the map receives only about 35.5% of viewport width.
- This is the most constrained profile: it has neither the desktop's useful map width nor the
  phone layout's full-width map.
- A coarse pointer receives taller tiny buttons, but the two fixed side panels do not adapt.

### Phone, 390×844

- The map is correctly first and occupies about 523 pixels of height.
- Layers and Inspector are sequential sections below it. Editing normally requires scrolling until
  the map and the relevant control cannot be seen together.
- The hover HUD is hidden, removing the only consolidated readout of the hex under the pointer.
- Two-finger pan/pinch remains available; one-finger drag retains its editing/selection meaning.

## Input observations

### Mouse

All nine workflows have a pointer path. Panning is available by Space-drag, right-drag, Alt-drag,
or middle-drag; these alternatives are described in the map HUD.

### Keyboard only

Forms, dialogs, layer rows, file operations, generation actions, and undo/redo are keyboard
reachable. The map canvas itself has no `tabIndex`, accessible name, focused-cell state, or key
handler. Consequently, keyboard users cannot traverse hexes, select map cells, draw a river, or
move a city. The correct later fix is one focused flat hex index with constant-time neighbour moves,
not thousands of DOM buttons.

### Coarse pointer

The interface raises the minimum height of tiny controls to 30 pixels. Touch supports two-pointer
pan and pinch zoom. The current phone layout makes the map usable for viewing, but not efficient for
repeated map/control alternation because relevant controls are below the map.

## Acceptance baseline for subsequent phases

Later interface work is successful only if it preserves all currently complete paths and improves
the blocked or spatially constrained paths. The measurable targets are:

1. At 1024 pixels wide, the map receives at least 50% of workspace width when no panel is being
   deliberately overlaid.
2. On phone, Layers and Inspector are mutually selectable work areas rather than two sequential
   full-length panels.
3. Active layer, active tool, selection count, and generation state are simultaneously visible.
4. Workflows 4 and 6 acquire complete keyboard paths.
5. Existing one-action generation and undo paths do not gain additional required actions.
6. Pointer editing of `k` selected cells remains `O(k)`, with one undo entry for the operation.
7. Keyboard movement between neighbouring cells is `O(1)` per keypress.

## Reproduction checklist

Run the application with:

```bash
HEXMAP_MOCK=1 npm run dev
```

For each target viewport:

1. Clear site storage or choose New map.
2. Create a map from the example description using the default layer plan.
3. Execute workflows 2–9 in table order.
4. Record the initial workspace, generated workspace, and active edit state.
5. Repeat workflows 4, 6, 8, and 9 without a pointer.
6. On a coarse-pointer device, repeat selection, pan, pinch, and river drawing.

The environment used for this baseline contains no browser executable, and its network policy
rejects installation of Playwright. Consequently, repository screenshots cannot be generated in
this run without fabricating them. The viewport dimensions, action paths, accessibility result, and
layout arithmetic above are fully reproducible; image capture remains an explicitly identified
environmental limitation rather than an inferred success.
