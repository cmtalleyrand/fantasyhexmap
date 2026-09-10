# Design decisions

A record of the choices made while building this, and why. These were decisions taken by the AI
that wrote the code, not requirements handed down in the brief: where the brief was specific this
document does not restate it, and where the brief left a choice open, this is what was chosen and
what the alternative would have cost. Several are reversible; a few would be painful to change
later, and those are marked.

---

## 1. Grid: pointy-top hexes, odd-r offset coordinates

**Chosen.** Pointy-top hexes addressed as `(col, row)` with odd rows shifted half a hex east; flat
index `row * cols + col`; edges numbered `0=E, 1=SE, 2=SW, 3=W, 4=NW, 5=NE`.

**Why.** The brief asked for a rectangular N×M grid and left the orientation and coordinate scheme
to the implementer. Offset coordinates make a rectangular grid trivially a rectangular array, which
is what every layer wants to be; axial coordinates would have made a rectangle ragged and forced a
sparse map or a translation layer at every access. The cost of offset coordinates is that neighbour
arithmetic depends on row parity, which is a genuine source of bugs — so it is implemented once in
`shared/hex.ts`, tested for reciprocity and pixel round-tripping, and never open-coded elsewhere.
Edge indices are shared with the direction order, so "the neighbour across edge *e*" and "edge *e*"
are the same number, and the same edge seen from the other side is always `(e + 3) % 6`.

**Hard to change later.** Every layer, every export and every saved map depends on this.

## 2. Talk to the model in row-strings, not JSON objects

**Chosen.** Per-hex layers travel to and from the model as one string per grid row — `~~~LLLoo~~~`
for geography, space-separated Köppen codes for climate, and so on — decoded on arrival.

**Why.** This is the decision with the largest practical effect. A 50×50 layer as an array of 2,500
JSON objects is tens of thousands of output tokens: slow, expensive, and close enough to the output
limit that a large map would sometimes truncate halfway and lose a band of the world. Row-strings
put the same layer in a few hundred tokens. The second reason matters as much as the first: the
model sees the map as an ASCII picture while it reasons, and coastlines, mountain chains and climate
belts are spatial judgements. Asking for a list of objects asks it to think about hexes one at a
time; asking for rows asks it to think about the map.

**What it costs.** A miscounted row silently shifts an entire band of the map sideways, so the
decoder checks every row's length and reports a warning rather than trusting it, and the prompt tells
the model to count.

## 3. Structured outputs and streaming, together

**Chosen.** Every generation call uses `output_config.format` with a Zod schema, and is streamed.

**Why.** Constraining the response shape at the API is strictly better than parsing hopefully and
retrying; the schema is also the documentation the model reads, so field descriptions do double duty
as prompt. Streaming is not for showing tokens — nobody wants to watch a hex map arrive — but because
a 50×50 layer at high effort is minutes of thinking, and a non-streamed request that long invites a
timeout somewhere in the stack. It also gives the progress indicator something true to report.

## 4. Derive facts from the map; ask the model only what it alone can decide

**Chosen.** River entry and exit edges are computed from consecutive hexes in a path, not taken from
the model. City `coastal`, `coastalEdges`, `onRiver` and `riverId` are computed from the base and
river layers, not taken from the model, and are recomputed whenever those layers change.

**Why.** The brief requires edge-specific coastal data, which means the model would otherwise have to
keep two representations consistent — a hex path and a set of edge indices — and any drift between
them is a silent corruption. The shared edge between two adjacent hexes is uniquely determined, so
there is nothing to guess: the model is asked for the path, which requires judgement, and the edges
follow. The same logic applies to coastlines. This also means a hand-edited coastline cannot leave a
city claiming a harbour it no longer has.

## 5. Repair structural errors; only flag judgement errors

**Chosen.** Two different responses to bad generated data, kept deliberately apart. Data that cannot
be represented is repaired and reported: elevation on a sea hex is dropped, a river path that jumps
between non-adjacent hexes is truncated there, two polities claiming one hex is resolved to one.
Data that is merely questionable is flagged and left alone: a river that appears to run uphill, a
rainforest in a desert climate, a breadbasket on a mountain, a paddy field nowhere near water.

**Why.** The first category is a broken invariant — no user ever wants it, and leaving it in the data
breaks later layers. The second is a matter of taste, and the user may have asked for exactly that;
silently "correcting" a deliberate choice is worse than a warning they can ignore. The warnings
appear in the inspector attached to the layer that produced them.

## 6. Staleness by recorded dependency versions

**Chosen.** Every layer carries a version bumped by any committed change, and records the versions of
its dependencies at the moment it was generated. A layer is stale when a recorded version no longer
matches — *including* when a dependency did not exist at generation time and exists now.

**Why.** The brief requires staleness flags with no automatic regeneration. A timestamp comparison
would have been simpler and wrong in both directions: undo would make a layer look fresh, and a
regeneration that produced identical data would still count as a change. Versions also handle the
case the brief specifically calls out — vegetation generated before rivers existed, whose flood plains
and paddy fields are therefore only approximate — because "dependency absent then, present now" is
naturally expressible and shows up in the UI with that wording.

Dependencies are split into `requires` (hard: the layer cannot be generated without them) and `uses`
(soft: sent as context, and a source of staleness). This is what makes the pipeline order a
suggestion rather than a cage — rivers can be regenerated after vegetation, and vegetation is told
about it.

## 7. Derived recomputation is not an edit

**Chosen.** When base geography or rivers change, city coastal edges and river membership are
recomputed, and polity claims on hexes that are no longer land are dropped. This creates no undo
entry and bumps no version.

**Why.** These are not decisions, they are bookkeeping: the alternative is data that asserts something
false about the map. Treating them as edits would pollute the undo stack with entries the user did
not make and would mark layers stale in a loop. The affected layer is already flagged stale by the
upstream change, so the user is told to look.

## 8. Per-layer undo, one entry per stroke

**Chosen.** Each layer has its own undo and redo stack of full-layer snapshots, 40 deep. A brush drag
across twelve hexes is one entry, not twelve.

**Why.** Per-layer undo is what the brief asked for. Full snapshots rather than diffs because a layer
is at most 2,500 small values and an AI rewrite changes all of them anyway — a diff representation
would be more code for no benefit at this size. The stroke batching is not in the brief but is the
difference between usable and infuriating: it is implemented by having the map view report the whole
stroke when the drag ends, rather than each hex as it is touched.

## 9. One scene model behind the canvas, the PNG and the SVG

**Chosen.** Rendering builds a list of primitives — polygons, polylines, circles, labels — and three
thin back ends consume it: the interactive canvas, a canvas-to-PNG exporter, and an SVG serializer.
None of them knows what a hex is.

**Why.** The brief requires both PNG and SVG export and an interactive map. Written separately, the
three drift: a legend tweak lands on screen and not in the vector file, and nobody notices for weeks.
With one scene, they cannot disagree, and the check that they agree is a screenshot next to an
export. Canvas was chosen for the interactive view over native SVG because a 2,500-hex map with
per-hex overlays is a lot of DOM nodes to keep responsive during a pan.

## 10. Colour: Köppen convention, and Plateau off the ramp

**Chosen.** Climate uses the conventional Köppen-Geiger map colours. Elevation uses a green-to-brown
ramp — except `Plateau`, which is given an unrelated tan.

**Why.** Köppen has a colour scheme people who know Köppen already recognise; inventing one would
have been a small act of vandalism. The Plateau decision follows from the brief's own insistence that
elevation is not a strict ordinal scale: `Plateau` is high ground with low ruggedness and does not sit
at a fixed point between `Hills` and `Mountains`. A ramp position would assert an ordering the data
model explicitly denies, every time anyone looked at the map. The one place a comparison is
unavoidable — checking whether a river runs uphill — ranks Plateau with Highland and says so in the
warning text, rather than pretending the check is exact.

## 11. An offline procedural generator

**Chosen.** `HEXMAP_MOCK=1` (or a toggle in the deployed page) generates layers procedurally instead
of calling the API, returning the same JSON shapes and flowing through the same decode, validate and
render path.

**Why.** Not in the brief. It was added because the whole application — eight layers, staleness,
undo, exports, persistence — could otherwise not be exercised at all without spending money on every
run, and because a deployed demo that does nothing until you paste a key is a bad first impression.
It is deliberately routed through the identical pipeline rather than short-circuiting it, so testing
against it tests the real code.

**Honest limitation.** It is a crude generator. It produces plausible shapes and deliberately
incoherent details, which is useful for exercising the validator and useless as a map.

---

# Deployment decisions

Added when the brief changed from "runs locally" to "deploys to GitHub Pages via Actions".

## 12. No shared API key in a static build — the request as posed cannot be satisfied

**The ask.** Deploy to GitHub Pages via Actions, with an easy way to supply an API key safely there.

**The finding.** There isn't one, and this is worth being precise about because the intuition behind
the question is reasonable. GitHub Actions secrets are genuinely safe *for the repository and for the
build*: they are encrypted at rest, masked in logs, and unavailable to forked pull requests. What they
do not do is survive contact with a static site. Anything the browser needs at runtime must be in the
bundle the browser downloads, so a key injected at build time — as `VITE_ANTHROPIC_API_KEY` or under
any other name — is published to every visitor in plain text, readable in DevTools in seconds. GitHub
Pages has no server-side execution, so there is nowhere else to put it. This is a property of static
hosting, not a setting that can be configured differently.

Rejected outright: build-time key injection of any kind. The workflow carries a comment saying so, so
that the next person to reach for it finds the reason rather than the temptation.

## 13. Three deployment shapes, one build, chosen at runtime

**Chosen.** The application detects at boot whether a backend answers `/api/health` and behaves
accordingly:

1. **Local development** — the Express server on the same origin holds the key in `.env`. Unchanged
   from before, and still the arrangement the original brief described.
2. **Static hosting, no backend (GitHub Pages)** — there is nowhere to hide a key, so there is no
   shared key: whoever opens the page supplies their own, it is stored in their browser, and the page
   calls Anthropic directly.
3. **Static hosting plus a proxy** — a repository *variable* points the build at a small Cloudflare
   Worker that holds the key as a platform secret. From the browser's side this is identical to (1).

**Why runtime detection rather than a build flag.** One artifact that works in all three places is
easier to reason about than three build configurations, and a failed health probe is an unambiguous
signal that there is no server — it is the same condition the fallback exists for. The cost is one
harmless 404 in the console on a static deploy, which is expected and handled.

## 14. Bring-your-own-key as the default for the static deploy

**Chosen.** In browser mode the page asks for a key, stores it in `localStorage` (or `sessionStorage`
if the user unticks "remember"), and calls Anthropic directly with the SDK's
`dangerouslyAllowBrowser` flag.

**Why this is acceptable here, when it usually is not.** That flag has a deliberately alarming name
because the usual case is a developer shipping *their* key to *users*, which exposes it to everyone.
The relationship is inverted here: the key belongs to the person looking at the page, they typed it in
themselves, it is stored only in their browser, and it is never part of what anyone else downloads.
That is the same trust model as a desktop app holding a credential in its config file.

**What it does not protect against.** Any script running on the page's own origin can read
`localStorage`, so the page loads no third-party code — no analytics, no fonts, no CDN — which is why
that matters more than it might seem. Anyone the user shares a machine with can also read it, hence
the session-only option, and the settings dialog recommends a key with a spend limit.

**Rejected: no persistence at all.** Re-pasting a key on every page load would push people towards
keeping it in a text file, which is worse.

## 15. The pipeline was made isomorphic rather than duplicated

**Chosen.** Prompt construction, response schemas, decoding, validation and the offline generator
moved from `server/` into `core/`, which reads no environment variables and receives a configured
client from whoever calls it. The Express server, the Worker and the browser all call the same
`generateLayer`.

**Why.** The alternative — a browser copy of the prompts — would have been two implementations of the
part of this system where subtle divergence is hardest to notice and most damaging. It also means the
Worker in `worker/` is about eighty lines: transport, CORS and a secret, with no map logic of its own.

**Consequence.** The Anthropic SDK is now reachable from the client bundle, so it is loaded through a
dynamic import and only downloaded when the page is actually the thing calling the API. Server and
proxy deployments never fetch it.

## 16. The proxy is offered, not assumed

**Chosen.** The Cloudflare Worker is included, documented, and off by default: it is deployed
separately and switched on with a repository variable.

**Why.** It is the right answer to exactly one question — "other people will use my deployed page and
they don't have keys" — and the wrong answer to the more common one, where the user is the only user.
For a single user it adds a second deployment target and a hosting account while making the security
posture *worse* in one respect: a personal browser key is stolen only by compromising that browser,
whereas a proxy is a URL that spends your money if anyone finds it. Its README says this plainly
rather than presenting the Worker as the more professional option.

**Known limitation, stated rather than hidden.** The Worker restricts origins but does not
authenticate callers, and an origin header is trivially forged outside a browser. For a genuinely
public deployment it needs a passphrase or Cloudflare Access in front of it, plus a spend limit on the
key. This is documented in `worker/README.md`, not left for someone to discover from a bill.
