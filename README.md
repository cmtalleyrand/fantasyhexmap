# fantasyhexmap

A local web application that turns a long-form description of a fantasy world into a layered hex
map. You describe the geography in prose, choose a grid up to 50×50, and then build the map up one
layer at a time — base geography, elevation, climate, vegetation, rivers, cities, polities,
population. Every layer can be edited hex by hex, rewritten wholesale by a free-text instruction to
Claude, undone and redone independently, and exported as PNG or SVG.

Nothing regenerates behind your back. Changing an upstream layer marks the layers below it **stale**
and leaves them exactly as they were; whether to re-run them is your call.

## Quick start

```bash
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm run dev                 # starts the Express API on :8787 and Vite on :5173
```

Open http://localhost:5173.

The API key lives only in `.env` and is read only by the Express server. The browser never sees it
and never calls `api.anthropic.com`; every generation request goes through `/api/generate` on the
local server.

### Running without a key

```bash
HEXMAP_MOCK=1 npm run dev
```

Mock mode swaps Claude for an offline procedural generator that returns the same JSON shapes the
model is asked for, so it flows through the identical decode-validate-render path. It is there to
exercise the application end to end (and to develop the UI) without spending tokens. Generated
layers say so in their notes.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | – | Required unless `HEXMAP_MOCK=1`. |
| `PORT` | `8787` | Express port; the Vite proxy follows it. |
| `HEXMAP_MODEL` | `claude-opus-5` | Model used for every layer. |
| `HEXMAP_EFFORT` | `high` | `low` … `max`. Lower is cheaper and faster; spatial coherence suffers. |
| `HEXMAP_MOCK` | – | `1` to use the offline generator. |

Other scripts: `npm run typecheck` (client and server), `npm run build` (production client bundle),
`npm run dev:server` / `npm run dev:web` to run one half on its own.

## The grid

Hexes are **pointy-top** and addressed with **odd-r offset coordinates**:

- `col` runs `0 … cols-1` west to east, `row` runs `0 … rows-1` north to south. Row 0 is the
  northern edge of the map.
- Odd-numbered rows are shifted half a hex east.
- The flat index of a hex is `row * cols + col`, and every per-hex layer is a flat array of that
  length.

Each hex has six edges, indexed in a fixed order: `0 = E, 1 = SE, 2 = SW, 3 = W, 4 = NW, 5 = NE`.
Edge `e` of a hex is the edge it shares with its neighbour in direction `e`; from the neighbour's
side the same edge is `(e + 3) % 6`. `canonicalEdgeId()` gives a single stable name to a shared edge
regardless of which hex you ask from, which is what makes "this city is coastal on *these* edges"
and "this river leaves through *that* edge" representable rather than approximate.

Grid dimensions are capped at 50×50 (2,500 hexes) in the setup form and again server-side.

## Layers

| Layer | Values | Applies to |
| --- | --- | --- |
| Base Geography | Land, Sea, Lake, Ice, Island | every hex |
| Elevation / Ruggedness | Lowland, Rolling, Hills, Highland, Mountains, Plateau | Land, Island |
| Climate | full Köppen (Af…EF, 21 codes) | Land, Island |
| Vegetation | 19 leaf categories in four groups | Land, Island |
| Rivers | edge-to-edge paths, navigability per segment | Land |
| Cities | name, population, river and coastal-edge references | Land |
| Polities | strict partition: one owner per land hex, or none | Land |
| Population | one integer per hex (rural, excludes city populations) | Land, Island |

Two modelling points worth stating plainly, because they are easy to get wrong:

**`Island` is the only mixed category.** It is a hex that is predominantly sea with a small landmass
inside it — drawn as a land dot on a sea hex. There is no mixed land+lake value. Island hexes take
land-only layer values, and their interior defaults to `Lowland` elevation.

**Elevation is not a single ordered scale.** Lowland → Rolling → Hills → Highland → Mountains rises
in height and ruggedness together, but `Plateau` is high ground with *low* ruggedness and does not
sit at a fixed point in that sequence. The generation prompt says so explicitly, the palette puts
Plateau off the green-to-brown ramp so the map does not imply an ordering that is not there, and the
one place a comparison is unavoidable — the "does this river flow uphill?" check — ranks Plateau
alongside Highland and says so in the warning text.

### Dependencies and staleness

Each layer declares hard dependencies (`requires`, which gate whether it can be generated at all)
and soft ones (`uses`, which are sent as context and drive staleness). Every layer carries a version
that is bumped by any committed change, and records the versions of its dependencies at the moment
it was generated. A layer is stale when a recorded version no longer matches — including the case
where a dependency did not exist at generation time and does now. That last case is how
"vegetation was generated before the rivers existed, so its flood plains and paddy fields are only
approximate" surfaces in the UI, exactly as the layer model calls for.

Derived facts are a separate matter from generated ones. When base geography or rivers change, city
coastal edges and river membership are recomputed and polity claims on hexes that are no longer land
are dropped. That is bookkeeping to keep the data internally truthful, not a regeneration: it
creates no undo entry and bumps no version, and the affected layer is already flagged stale.

## Editing

Every layer supports both edit paths the same way.

**By hand.** Click a hex, shift-click to add, or drag to sweep a region, then apply a value from the
inspector. Turning on *brush mode* applies the value as you drag; a whole stroke is one undo entry,
not one per hex. Rivers can be drawn by clicking a path of adjacent hexes from source to mouth;
cities and polities have their own add/rename/recolour/delete controls.

**By instruction.** Type something like *"add a chain of volcanic islands along the eastern sea"* and
the whole layer, plus the layers it depends on, is sent to Claude, which returns a complete
replacement. One instruction can therefore change the map anywhere, not just one hex.

Both paths push onto the same per-layer undo stack (40 entries deep, with redo).

## Exports

- **Image.** Any single layer on its own, or a composite of whichever layers are currently toggled
  visible, as **PNG** or **SVG**, with a toggle for city and polity name labels. Single-layer
  exports keep base geography as a substrate — a land-only layer is unreadable without knowing where
  the land is — and drop labels unless the layer is cities or polities.
- **JSON.** The full map state, with or without undo history, and a matching import.

## Persistence

The current map is autosaved to IndexedDB on every committed change, so a refresh loses nothing. The
JSON export is the portable copy.

## How it is put together

```
shared/     types, hex geometry, wire codec, validation - imported by BOTH client and server
server/     Express app, prompt builders, response schemas, generation pipeline, mock generator
src/        React app: render (scene/canvas/svg/export), state (reducer/persistence), components
```

`shared/` is the reason the two halves cannot disagree. The encoding the model is asked for, the
adjacency rules the prompts describe, and the validation applied afterwards are all one
implementation used from both sides.

**Row-string encoding.** Per-hex layers travel to and from the model as one string per grid row
rather than as arrays of objects. A 50×50 layer costs a few hundred output tokens instead of tens of
thousands, which keeps it well clear of the output limit — and it lets the model see the map as an
ASCII picture while it reasons about coastlines, ranges and climate belts, which is worth more than
the token saving. Requests use structured outputs, so the response shape is constrained at the API
rather than parsed hopefully, and they are streamed so a long generation reports progress instead of
sitting on an open request.

**Derive rather than trust.** Where a fact can be computed from the map, it is: river entry and exit
edges come from consecutive hexes in the path, not from the model's own edge indices; a city's
coastal edges and river membership come from the base and river layers. The model is asked for the
things only it can decide.

**Repair versus flag.** After generation, structurally invalid data is repaired and reported —
elevation on a sea hex is dropped, two polities claiming one hex is resolved, a river path that
jumps is truncated. Judgement calls are only flagged, never changed: a river that runs uphill, a
rainforest in a desert climate, a breadbasket on a mountain, a paddy field nowhere near water. Those
warnings appear in the inspector, because you may have meant them.

**One scene, three outputs.** The interactive canvas, the PNG export and the SVG export all consume
the same list of drawing primitives. None of them knows how to draw a hex map — only how to draw a
polygon, a polyline, a circle and a label — so the vector file, the bitmap and the screen cannot
drift apart.

## Limitations

- Generation quality on a large grid depends heavily on the description. A vague brief gives a
  generic map; naming ranges, seas, prevailing winds and peoples gives a much better one.
- Rivers are modelled as independent paths. A tributary is a separate river that happens to join a
  trunk and follow it; there is no explicit confluence object.
- Undo is per layer by design, not one global stack across the whole map.
- There is no cloud sync, no accounts and no deployment configuration. It runs locally.
