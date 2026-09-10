# fantasyhexmap

A local web application that turns a long-form description of a fantasy world into a layered hex
map. You describe the geography in prose, choose a grid up to 50×50, and then build the map up one
layer at a time — base geography, elevation, climate, vegetation, rivers, cities, polities,
population. Every layer can be edited hex by hex, rewritten wholesale by a free-text instruction to
Claude, undone and redone independently, and exported as PNG or SVG.

Nothing regenerates behind your back. Changing an upstream layer marks the layers below it **stale**
and leaves them exactly as they were; whether to re-run them is your call.

It runs in three arrangements from one codebase: locally with a small Express server, as a static
GitHub Pages site where you supply your own key, or as a Pages site pointed at a key-holding proxy.
See [Deployment](#deployment).

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

## Deployment

A GitHub Actions workflow (`.github/workflows/deploy.yml`) typechecks, builds and publishes to
GitHub Pages on every push to `main`. Enable it once, under **Settings → Pages → Build and
deployment → Source: GitHub Actions**. Pull requests build without deploying.

### First, the thing you cannot do

**You cannot safely put a shared Anthropic API key into a GitHub Pages build.** Actions secrets
protect a key in the repository and during the build; they do not protect it afterwards. Anything
the browser needs at runtime is in the bundle the browser downloads, so a key injected at build time
— `VITE_ANTHROPIC_API_KEY` or any other name — is published to every visitor in plain text and takes
about ten seconds to read out of DevTools. Pages is static hosting; there is no server to hide it
behind. No workflow setting changes this.

So the site does not ship a key. Instead:

### Option A — each user supplies their own key (default, nothing to configure)

Push to `main`, and the site is live at `https://<user>.github.io/<repo>/`. It detects that no
backend is answering and asks whoever opens it for an Anthropic key. This is a perfectly safe way to
run a web app on someone's key — it is the same trust model as a desktop app holding a credential in
its config file — provided the app is built so the key is only ever the user's own and never leaves
their machine. Here that means:

- **Nothing secret is in the repository, the workflow or the bundle.** The key is typed in at
  runtime; there is nothing to extract from the published site.
- **It is sent to exactly one place.** The build ships a Content-Security-Policy whose `connect-src`
  allows only `api.anthropic.com` (and a configured proxy). Even script that somehow ran on the page
  could not post the key anywhere else.
- **No third-party code runs on the page.** `script-src 'self'`, and the app loads no analytics, no
  CDN, no web fonts — so there is no supply chain to compromise the origin through.
- **At rest it can be encrypted.** Ticking "protect the stored key with a passphrase" stores AES-GCM
  ciphertext under a PBKDF2-derived key (310k iterations) instead of the key itself, and asks for the
  passphrase once per session. The passphrase is never stored.
- **Or it need not be stored at all.** Unticking "remember" keeps it in `sessionStorage`, gone when
  the tab closes.
- **It refuses to pretend on an insecure origin.** Served over plain HTTP, the settings dialog says
  so rather than accepting a key it cannot protect.

What none of that defends against is script running on the page while the key is in use — it has to
be usable to be used. That is what the CSP and the no-third-party-code rule are for, and it is why
they matter more than the encryption does. Use a key with a spend limit set.

Visitors without a key can still switch on the offline procedural generator from Settings and get a
feel for the tool.

### Option B — a proxy that holds the key (if others will use your page)

Deploy the small Cloudflare Worker in [`worker/`](worker/README.md), which speaks the same `/api`
contract and keeps the key as a platform secret, then add a repository **variable** (not a secret)
named `VITE_API_BASE` pointing at it. The next build points the site at the Worker and stops asking
for a key. The URL in that variable is public, which is fine; the key never leaves Cloudflare.

The Worker restricts origins but does not authenticate callers — anyone who learns its URL can spend
your credit through it. `worker/README.md` says what to do about that.

### Private repositories

GitHub Pages on a private repository requires a paid plan. On a free account the repository has to
be public, which is a reason to be sure no key is in it — with Option A, none is.

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

### Choosing which layers to build

Every layer is one generation pass over the entire grid, so a 50×50 map with the full pipeline is
eight long, expensive generations — and most maps do not need all eight. When you create a map you
choose which layers it will have, from presets or hex by hex:

| Preset | Layers |
| --- | --- |
| Everything | the full pipeline |
| Physical world | base, elevation, climate, vegetation, rivers |
| Terrain only | base, elevation, rivers |
| Land and powers | base, elevation, cities, polities |

Base geography is always included; nothing works without it. The picker keeps the selection coherent
(a layer's hard dependencies come with it) and tells you what a chosen layer will be missing.

The plan is not a commitment. **plan** in the sidebar changes it at any time: add a layer you
skipped, or drop one you decided against. Dropping a layer that already holds data hides it from the
map, the pipeline and the exports but does not delete it — add it back and the data returns.

Leaving a layer out changes how the others are generated. There is a real difference between "the
climate layer does not exist yet" and "this map will never have one", and the prompts say which:
a layer that is merely pending can be deferred to, while an excluded one never arrives, so vegetation
asked to work without climate is told to infer the climate itself, commit to it, and record what it
assumed — because nothing later will correct it.

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

## The decision record

Every generation asks the model for the three to eight choices that most shaped the layer — where a
range runs and why, which cue in the brief a desert answers, why a capital sits at that river mouth,
what it invented because the brief was silent. Those choices are kept, not just the resulting hexes.

- The inspector shows **why the layer being edited looks like this**, inline.
- **decisions** in the top bar opens the whole record: every generation and instruction with the
  model's reasoning, filterable by layer.
- Hand edits, undos and redos are logged alongside, so the record never credits the AI with a
  choice you made. The "AI decisions only" toggle separates them.
- **Export Markdown** writes the record out as a document, grouped by layer, with the brief at the
  top — the reasoning survives outside the app.
- Decisions with hex references have a **select** button that jumps to the hexes they are about.

The record is part of the map: it is autosaved, exported in the JSON, and imported back with it.

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
- **Markdown.** The decision record: what the model chose, why, and what you changed by hand.
- **JSON.** The full map state including the decision record, with or without undo history, and a
  matching import.

## Persistence

The current map is autosaved to IndexedDB on every committed change, so a refresh loses nothing. The
JSON export is the portable copy.

## How it is put together

```
shared/     types, hex geometry, wire codec, validation, derived facts
core/       prompts, response schemas, generation pipeline, request validation, offline generator
server/     Express app: reads the key from .env, calls core
worker/     optional Cloudflare Worker: holds the key as a secret, calls core (same /api contract)
src/        React app: render (scene/canvas/svg/export), state (reducer/persistence), api, components
```

`shared/` and `core/` are why the deployments cannot disagree. `core/` reads no environment variable
and knows nothing about where a credential came from — it is handed a configured client — so the
encoding the model is asked for, the adjacency rules the prompts describe and the validation applied
afterwards are one implementation, whether it runs in Node, in a Worker, or in the browser.

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

## Design decisions

[`DECISIONS.md`](DECISIONS.md) records the choices made while building this and what the
alternatives would have cost — the coordinate system, the row-string wire format, repair-versus-flag
validation, version-based staleness, the single scene model, and the deployment and key-handling
decisions above.

## Limitations

- Generation quality on a large grid depends heavily on the description. A vague brief gives a
  generic map; naming ranges, seas, prevailing winds and peoples gives a much better one.
- Rivers are modelled as independent paths. A tributary is a separate river that happens to join a
  trunk and follow it; there is no explicit confluence object.
- Undo is per layer by design, not one global stack across the whole map.
- There is no cloud sync and no accounts. A map lives in one browser until you export it.
- The optional proxy restricts origins but does not authenticate callers; see `worker/README.md`.
