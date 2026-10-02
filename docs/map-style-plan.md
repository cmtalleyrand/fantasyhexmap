# Fantasy hex map rendering: assessment and a map-style plan

## Context

The user wants to know how attractive the generated maps are as fantasy maps, and wants a plan to make them more attractive. They prefer giving users a choice of looks over a single template. Three exports were supplied: a political composite with legend, the base and elevation layers alone, and the same political map with names. Everything visible in them comes from `src/render/`. `scene.ts` builds a list of primitives (polygon, polyline, circle, text, city) that `canvas.ts` (the screen and PNG) and `svg.ts` both draw, `palette.ts` holds every colour, `labels.ts` and `featureLabels.ts` place names, and `legend.ts` adds the legend panel. Display preferences (`elevationStyle`, `polityOpacity`, `uniformLand`, `labels`, `riverNames`, `rangeNames`, `polityNames`) are kept in `Prefs` in `src/api/settings.ts`, edited on the Display tab of `SettingsDialog.tsx`, and passed into `ExportPanel.tsx`.

## Assessment

The maps are legible, internally consistent data displays. They do not yet read as fantasy maps; they look like the board of a hex strategy game or a GIS thematic layer. The engineering underneath is better than the result looks. The polity label placer, which searches rotated rectangles scored by how much of each falls inside the territory, is better than most hobby tools. Rivers are named along their straightest stretch, and one scene model guarantees that PNG and SVG match. The weakness is almost entirely in cartographic styling, which is good news, because styling can be layered onto the scene builder without touching the generation pipeline.

Coastlines are where it falls short most. A fantasy map is judged first on its coast, and here the coast is nothing more than the colour changing along a hex zigzag. No coast line is stroked, no ripple or shallow-water halo surrounds the land, and nothing separates land from sea except fill. "Coastal Land" adds a beige ring exactly one hex wide around every landmass (image 2). It is meant as data, but it reads as an artificial beach of constant width that makes the continent look stencilled. Islands are flat tan circles on sea hexes, and they read as UI bullets rather than land. With polities on, those circles become coloured dots inside hex outlines, and the Yrevia islets and the hex south-east of Quetland look like target icons.

The palette is a set of flat, mid-saturation digital colours with no texture. The sea is one navy everywhere, shallows and open ocean alike, so the sea is the largest area on the map and also its least interesting. Land is a single pale green. Nothing suggests paper, ink or relief. The polity palette (`POLITY_PALETTE`) is saturated categorical colour, softened only by global opacity. Neighbours often land on near-identical hues: Rhospia's yellow against Javukia's olive, and the Rangmullian, Ouzartes and Beltanian tans and sages. That happens because `contrastingPolityColours` maximises RGB distance, which does not track perceived difference.

The hex grid is drawn at the same weight on every hex, sea included. It is the strongest texture on the map and it pulls attention away from the geography. The left and right edges show black serrated teeth, the canvas `paper` colour `#0f1418` showing through where odd rows are offset, and the whole map has no frame. It ends like a cropped screenshot. The bottom row of white Ice hexes reads like a UI strip, not a polar margin.

The relief marks (the "contours" style) are small chevrons stacked by level. Every Hills hex carries the same glyph in the same place, so the result reads as a pattern fill rather than terrain. Mountains are not visually distinct enough from hills to read as ranges, and the style's name is wrong because these are hachure-like symbols, not contours. When polities are drawn over them (images 1 and 3), the chevrons sit under a translucent wash and turn into noise.

Rivers keep a uniform width along a run and change width abruptly at the switch to navigable. They pass through each hex centre and edge midpoint with quadratic smoothing, which leaves visible kinks and a stair-stepped course (the Audhon around Kusmaw and the Eskeld are good examples). Sources stop dead in the middle of a hex, mouths do not widen into the sea, and the river blue is a different colour from both the sea and the lakes, so the water bodies do not read as one system. Lakes are flat hex clusters with no shoreline.

Political borders are drawn as half-borders: each side strokes its own edge, inset by 10% in its own colour. On a translucent fill this looks like a slightly darker rim. It is weak where neighbours share a hue, and because each edge is a separate line with round caps, the outline beads at every hex corner. Image 1 has an extra dashed light-blue outline from `coastMark` around every coastal city hex and island polity. It is data annotation, but on the map it reads as a third border style. Nothing in the hierarchy says this line is a national frontier and that line is a coast.

The typography has the most to gain. Realm names are upright Palatino capitals in solid black, with no letter-spacing and no halo, and their size scales with the square root of area. Big realms get very heavy, blocky type ("RANGMULLIAN CONFEDERATION" in image 3 dominates the south and runs over the inlet) while small ones fall to 7px. Classic fantasy and atlas lettering does the reverse: widely tracked capitals, lighter weight, and often a gentle curve along the territory. Text is also not tied to the landform: the Rangmullian name crosses water, and it can because the 78% coverage fallback allows it. City names are set in the UI sans-serif (`FONT_STACK`), which clashes with the serif region names. Palatino is a system font, so SVG exports render in whatever the viewer has installed.

The city markers (black disc, ringed disc, diamond and crenellated block, each with a white ring and a blue centre dot when on a river) are clear, but they look like map pins in an app. Their visual weight is close to the realm names, so the political map reads as a field of black dots.

Cartographic furniture is missing entirely: there is no title cartouche, compass rose, scale bar or decorative border. The legend is a cream panel bolted onto a dark map (image 1). The two surfaces do not agree, and the legend lists every base category even when polity fills paint over all of them.

In short, the content is strong and the presentation is generic. The highest-leverage fixes, in order, are coastline treatment, an unframed and unclipped edge, grid weight, typography, relief symbology and water unity. Most of these are rendering decisions, not data changes.

## Approach: a map-style system with presets plus per-element overrides

Introduce a `MapStyle` object that controls every aesthetic decision the scene builder makes. Ship several presets, and let users pick a preset and then override individual elements. The existing look becomes the "Classic hex" preset, so nothing changes for current users until they choose otherwise, and the existing prefs (`elevationStyle`, `polityOpacity`, `uniformLand`) become overrides inside the new style rather than separate settings.

### Presets (first set)

Classic hex is the current look with three fixes: no black edge teeth, a lighter grid, and a coast line. It suits players who want the data precise.

Parchment is a sepia paper ground with grain, ink-brown linework, smoothed coasts with stippled ripple lines, an illustrated relief of mountain and hill sketches plus tree clusters, polities as coloured edge washes over terrain, tracked serif lettering in iron-gall brown, and a decorative frame with a compass and a cartouche. This is the default "fantasy novel" look.

Political atlas has a pale blue sea that shades with depth, pastel polity fills from a perceptually spaced palette, crisp dark frontier lines with a wide inner colour band, relief shown as hillshading, and widely tracked small capitals. It is the 19th-century atlas look and the one closest to what images 1 and 3 are trying to be.

Night / campaign is a dark ground with luminous coast and river lines and a muted terrain tint. It suits a VTT background and is close to the current dark sea, but finished properly.

Print is greyscale with hatched relief and patterned polity fills. It is for printing and photocopying at the table.

Each preset is a complete `MapStyle` value. Overrides are a partial style merged over the preset, so a user can take Parchment with hex grid on and coast smoothing off, for example.

### Style dimensions (what users can override)

Water can be flat, depth-shaded or ripple-lined. Depth shading uses BFS distance from land in hexes. Ripples are concentric strokes of the coastline. Lakes and rivers take their colours from the water palette so that all water reads as one system.

The coastline has a mode of hex-edge (faithful to the data) or smoothed (Chaikin-smoothed loops traced from land/water edges), a line weight and colour, and a ripple count.

The grid can be all hexes, land only, or none, with its own weight and opacity, drawn as an overlay pass so its weight is the same everywhere.

Land tint has three choices. Uniform keeps today's `uniformLand`. Coastal band keeps today's default. Elevation tint is a hypsometric ramp.

Relief can be none, chevrons (today's marks, renamed from "contours" to "symbols"), illustrated, or hillshade. Illustrated relief draws peaks and hills with deterministic jitter, sorted by y so they overlap correctly. Hillshade shades each hex from the elevation gradient to its neighbours, lit from the north-west. Illustrated vegetation icons (conifers, deciduous trees, marsh tufts, dunes) are an option when the Vegetation layer is visible.

Polities can be shown as a fill (today's, with the opacity override), an edge wash (a wide translucent inner band plus a thin frontier line), or an outline only. The frontier can be solid, dashed or dash-dot, and is traced as continuous chained loops instead of separate per-edge segments. The palette can be vivid (today's), pastel or muted, and is assigned by CIELAB distance instead of RGB.

Typography is chosen by font pairing (realm, water and city faces), tracking, case, halo, and whether realm names are straight or curved along the territory axis. Region name ink can be dark or a darkened polity colour.

Cities are drawn with today's markers ("Symbols"), "Classic" (dot sizes, ringed dot, star-in-circle for the largest), or "Illustrated" (small building and castle silhouettes). The coastal-edge dashes become a separate toggle, off in the fantasy presets.

Ice can be flat or glacier, where glacier means white-blue shading with crevasse strokes and its own coast.

Furniture controls the frame (none, simple rule or ornamental), the compass rose, the scale bar (from `hexDimensions` in `shared/surfaceArea.ts`), a title cartouche, the margin, and paper grain. A legend panel themed to the style replaces the fixed cream panel.

### Implementation phases

There are three phases, and each ends at a review checkpoint. Every phase delivers working code on the branch plus a review gallery: a published page that renders the same maps in every option the phase added. The maps are a fixed mock map and, if you supply one, your own map's JSON export. That lets you compare options side by side rather than through screenshots in chat. Each checkpoint lists the decisions your feedback settles. Those answers become the defaults, remove options or add options in the next phase, so later work builds on choices you have already made rather than on my guesses. The UI controls for each phase's options ship in that same phase, so you can also try them in the app.

#### Phase 1: Foundation and water. Coast, sea, islands, lakes, rivers, edge and grid

Phase 1 delivers the style system, the rendering infrastructure every later phase needs, and the biggest single visual gain, which is how land meets water.

Style plumbing comes first. Create `src/render/styles.ts` with the `MapStyle` type, `resolveStyle(presetId, overrides)` and a parser that rejects invalid stored values (modelled on `parsePolityNameMin`). In `src/api/settings.ts`, add `mapStyle: { preset, overrides }` to `Prefs`. Bump `DEFAULTS_VERSION` and migrate `elevationStyle`, `polityOpacity` and `uniformLand` into overrides on the Classic hex preset, so saved preferences produce an identical picture. `scene.ts` and `legend.ts` read colours from `style.*` instead of from `MAP_COLOURS`, `BASE_COLOURS` and `ELEVATION_COLOURS` directly, and `palette.ts` remains the source of the Classic values. `buildScene` is restructured into explicit passes (water, coast effects, land fills, relief, polity fills, grid overlay, frontiers, rivers, cities, labels, furniture, screen decoration) in place of the single per-hex loop.

The primitives extend in the same phase. A `path` primitive (M/L/Q/C/Z, fill, stroke, dash, opacity) and a `group` primitive with an optional clip and opacity go into both `canvas.ts` and `svg.ts`. A `texture` primitive adds paper grain from a deterministic noise tile, drawn as a canvas pattern and embedded in SVG as a data-URI `<pattern>`, so PNG and SVG stay identical. The hard-coded city colours in `svg.ts` move into primitive fields. A seeded hash in `src/render/seed.ts` provides the determinism rule below.

Performance work lands now, because the heavier passes start here. The scene is split into static prims and screen decoration, the static prims are cached by data identities and style key (extending the WeakMap pattern of `cachedPolityLabels`), and `MapView.tsx` draws the static layer once to an offscreen canvas and composites hover and selection over it.

The visible changes are these. The background is painted in the sea colour (or clipped when framed), which removes the black edge teeth. The grid becomes an overlay pass with weight and scope options (all, land only, none). A new `src/render/coast.ts` traces closed land/water loops with optional Chaikin smoothing, bounded so the coast never strays more than about a quarter hex from the data. It produces a coast stroke, ripple strokes, and sea depth shading from a BFS distance field. Islands become seeded irregular blobs with a coast, lakes get shorelines, and ice can be glacier-styled. Rivers become a centripetal Catmull-Rom spline through jittered centres, drawn as a tapered filled outline, with wider navigable reaches, mouths that flare into the sea, and the style's water colour. `featureLabels.riverPath` samples the same spline. A paper ground with grain is offered.

Two presets ship at the end of Phase 1: Classic hex (today's look with the edge, grid and coast fixes) and a first draft of Parchment, limited to the water, coast and paper options built so far.

Checkpoint 1 asks you to decide the following. Should the default coast be hex-edge or smoothed, and is the smoothing tolerance acceptable for hex-accurate play? Which water treatment should each preset use: flat, depth-shaded or ripple, and how many ripples? Is the river taper and jitter right, or too wandering? Is the default grid all hexes, land only or none? Is Coastal Land shown as a band, merged, or replaced by the coast line? And is the overall colour direction of the Parchment draft right? Those answers fix the water and ground that Phase 2's relief and polity colours must sit on.

#### Phase 2: Land and politics. Relief, vegetation, polities, and the full preset set

Phase 2 delivers the land content and the political layer, styled against the water and ground settled at Checkpoint 1.

For relief and vegetation, a new `src/render/symbols.ts` provides seeded generators for mountain peaks with a shaded flank, hills, plateau mesas, conifers, deciduous trees, marsh and dunes. Each returns `path` primitives placed with jitter and y-sorting. Relief modes are none, symbols (today's chevrons, renamed from "contours" with the stored value kept backward-compatible), illustrated, and hillshade (a per-hex alpha overlay from neighbour elevation differences, lit from the north-west). Land tint offers uniform, coastal band or a hypsometric elevation ramp.

For polities, each region is traced into chained boundary loops using the edge chaining in `coast.ts`, so frontiers become continuous paths with clean joins. The modes are fill (today's, with opacity), edge wash (a wide stroke clipped to the territory with `group` and its clip, plus a thin frontier), and outline only. Frontiers can be solid, dashed or dash-dot. Palettes are vivid, pastel or muted, and `contrastingPolityColours` assigns them by CIELAB distance with an injectable palette. Island polities fill their blob, and the coastal-edge dashes become a toggle that is off in the fantasy presets.

The preset set is completed to Classic hex, Parchment, Political atlas, Night / campaign and Print, with the defaults from Checkpoint 1 applied. The Display tab gets the full preset picker with live thumbnails of the current map (`buildScene` plus `renderToCanvas` at a small size) and a Customise disclosure grouped by element, with a "reset to preset" control on each group.

Checkpoint 2 asks you to decide the following. Which presets should stay, merge or go, and which is the default for new users? Is illustrated relief dense enough (symbols per hex), and are the symbols themselves right in shape and weight? Which polity mode and palette should each preset use? Do frontiers and fills still read clearly with relief under them? Is anything in the Customise panel unnecessary, or missing? Those answers fix the visual weight of the map body, which sets how heavy the lettering, markers and frame in Phase 3 must be to sit above it.

#### Phase 3: Lettering, cities, furniture and legend

Phase 3 delivers the typography and finishing that make the map read as a finished artefact, sized against the map body settled at Checkpoint 2.

Typography comes first. OFL fonts are bundled as local woff2 files under `public/fonts/` (IM Fell English or Cinzel for realms, EB Garamond for cities and italic water names), loaded via `document.fonts.load` before rendering and exporting, and embedded as base64 `@font-face` subsets in SVG exports. `fonts.ts` measures per style face and weight, and the label cache key includes the font. Tracked and curved text is expanded into per-glyph `text` primitives, so neither back end depends on `ctx.letterSpacing`. In `labels.ts`, the size curve is compressed from sqrt-of-area (a cap, plus a lighter weight at large sizes). An optional curved baseline follows the territory's principal axis, a stricter coverage floor keeps names off water in fantasy presets, and region ink can be dark or a darkened polity colour. City names move to the style serif with a halo, and river names become italic and tracked.

Cities can use marker sets of Symbols (today's), Classic (dot sizes, ringed dot, star-in-circle), or Illustrated (building and castle silhouettes), at a lighter visual weight relative to realm names.

Furniture goes in a new `src/render/furniture.ts`. It covers the frame (none, simple or ornamental, drawn in an added margin), the compass rose (in the corner with the most sea), the scale bar from `hexDimensions`, and the title cartouche. `legend.ts` takes its panel colours, fonts and swatch shapes from the style and hides base-geography entries that polity fills cover. `ExportPanel.tsx` starts from the display style and can change the preset and furniture for a single export.

Checkpoint 3 asks you to decide the following. Which font pairings should stay? Are the tracking, size range and curved names right? Which city marker set should each preset use? Is the furniture placement and ornament level right, including whether the frame and compass should show on screen or only in exports? After this checkpoint the remaining work is polish from your feedback.

### Determinism rule

Every jitter, blob shape, icon placement and noise tile comes from a seeded hash of (`map.id`, hex index, purpose). A map then looks the same every time it renders, PNG and SVG agree, and an edit to one hex does not reshuffle the symbols on the others.

## Critical files

`src/render/scene.ts` (restructure into passes, style-driven), `src/render/palette.ts` (Classic values, new palettes, LAB assignment), `src/render/canvas.ts` and `src/render/svg.ts` (new primitives), `src/render/labels.ts`, `src/render/featureLabels.ts` and `src/render/fonts.ts` (typography), `src/render/legend.ts`, `src/render/export.ts`, `src/api/settings.ts` (prefs and migration), `src/components/SettingsDialog.tsx`, `src/components/ExportPanel.tsx`, `src/components/MapView.tsx` (caching). New files are `src/render/styles.ts`, `coast.ts`, `symbols.ts`, `furniture.ts`, `seed.ts` and `public/fonts/*`.

## Verification

Run `npm run typecheck` and `npm test` before every push. Each phase's tests land with that phase. The existing `test/mapPresentation.test.ts`, `legend.test.ts` and `export.test.ts` must keep passing under the Classic hex preset, which proves the migration preserved behaviour. Add tests for each of the following. The coast tracer: every land/water edge lies on exactly one closed loop, and smoothing stays within its tolerance of the hex-edge loop. Style resolution and pref migration: old prefs give identical Classic scenes. Determinism: two `buildScene` calls on the same map give identical prims, and editing one hex changes symbols only in and next to it. Each preset builds a scene for the mock map without throwing, and its SVG parses. Glyph-run layout: per-glyph advances sum to the measured width.

For the visual check at each checkpoint, run `HEXMAP_MOCK=1 npm run dev`, generate a 30×30 mock map through all layers (plus your own map's JSON export if supplied), and use Playwright with the preinstalled Chromium at `/opt/pw-browsers` to screenshot each preset on screen and export each as PNG and SVG. Rasterise the SVG in Chromium and diff it against the PNG to confirm the two back ends match. Compare the screenshots against the issues in the assessment: coast present, no edge teeth, names not crossing water, frontiers continuous, and fonts present in the SVG. The renders from each checkpoint are collected into that phase's review gallery.
