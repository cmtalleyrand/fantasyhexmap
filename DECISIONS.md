# Design decisions

A record of the choices made while building this, and why. Open drawing work is in
[docs/drawing-work-plan.md](docs/drawing-work-plan.md). Entries describe current behaviour; measurements
belong to the commit they were taken on. These were decisions taken by the AI
that wrote the code, not requirements handed down in the brief: where the brief was specific this
document does not restate it, and where the brief left a choice open, this is what was chosen and
what the alternative would have cost. Several are reversible; a few would be painful to change
later, and those are marked.

---

## Drawing principles

Standing rules, approved by the map's owner, that every part of the drawing keeps. A change that
cannot keep one is a change to these rules, made here first, not an exception made in code.

1. **One answer to "where is the land".** There is a single description of land and water as actually
   drawn: after land shares, concentration, smoothing and roughening, with the islands and the lake
   bodies. Everything that depends on land or water uses that (`landAt` in `scene.ts`, from the outline
   `drawnLand` traces), never the hex grid or a hex's type.
2. **Land things stay on land, water things stay on water.** Relief, vegetation, cities, realm colours,
   borders and land names are drawn only on land; sea colour, ripples, sea ice and water names only on
   water. Nothing crosses the coastline except where that is the point: a river's mouth, the coastline's
   own ink. A small realm's name set beside it lies on open water and touches no land.
3. **Things belong to their own hex's land.** A hex's symbols, its city and its colour sit on that hex's
   own land; they are not moved onto a neighbour's ground to find room.
4. **What is set is what is drawn.** A land share, width or concentration someone sets is drawn as set.
   Decoration bends to fit the land; the land never bends to fit the decoration.
5. **When something will not fit, it gives way in this order:** first drawn smaller, then moved within
   its own hex, then left out. It is never drawn in the wrong place.
6. **Every compromise is reported.** Whenever the map gives something up to keep these rules, it says
   which hexes, what was given up, and which rule won (`Scene.compromises`, shown in the Inspector and on
   hover). Nothing is changed silently.
7. **Each rule is checked independently.** Each rule has a check that reads the finished picture, not the
   code that drew it (`auditScene`), and a test that runs that check, so a change that breaks a rule fails
   a test rather than reaching a map.

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
the model to count. The response schemas now also pin the exact row count and width, so the API
constrains generation to them and counting stops being work the model has to do.

**What it did not solve, and was mistaken for solving.** Row-strings made the *answer* small, and
that was read as making the whole response small — see §14. It did not: reasoning is output too,
and on a hard layer it dwarfs the answer whatever encoding the answer uses.

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

## 12. A user-supplied key is safe; a developer-supplied one in a static build is not

**The ask.** Deploy to GitHub Pages via Actions, with an easy way to supply an API key safely there.

**The distinction that matters.** These are two different questions wearing the same words, and the
first answer given here blurred them by leading with the impossible one.

*Can a web app let a user safely provide an API key?* Yes, and that is what this app does. The key is
typed in at runtime by the person whose key it is, kept in their browser, and sent to one host. It
never touches the repository, the build or anyone else's download. This is an ordinary, sound pattern
— the same trust model as a desktop app holding a credential in its config file — and it is worth
building carefully rather than apologising for. What "carefully" means is decision 14.

*Can a build bake in a key for visitors to use?* No. GitHub Actions secrets are genuinely safe for
the repository and the build — encrypted at rest, masked in logs, withheld from forked pull requests
— but they do not survive contact with a static site. Anything the browser needs at runtime is in the
bundle it downloads, so a key injected at build time under any name is published to every visitor in
plain text. Pages has no server-side execution; there is nowhere else to put it. That is a property
of static hosting, not a setting.

Rejected outright: build-time key injection of any kind. The workflow carries a comment saying so, so
the next person to reach for it finds the reason rather than the temptation. Where a shared key is
genuinely wanted, decision 16 covers it.

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

## 14. Bring-your-own-key, and what makes it actually safe

**Chosen.** In browser mode the page asks for a key and calls Anthropic directly with the SDK's
`dangerouslyAllowBrowser` flag. Five things make that a sound arrangement rather than a shrug, and
they are the substance of the decision — the flag alone would not be:

1. **The key is only ever the user's own.** `dangerouslyAllowBrowser` earns its name in the usual
   case, where a developer ships *their* key to *users*. Here the relationship is inverted: the
   holder and the viewer are the same person.
2. **`connect-src` is locked to Anthropic.** The production build carries a Content-Security-Policy
   allowing connections only to `api.anthropic.com` and a configured proxy. Exfiltration is the
   threat that actually matters for a credential in a browser, and this is what closes it.
3. **No third-party code runs on the origin.** `script-src 'self'`; no analytics, CDN or web fonts.
   An app that pulls in a script from someone else's server cannot honestly claim to protect a
   secret on its own origin, so this app pulls in none.
4. **At-rest encryption is available.** Opting into a passphrase stores AES-GCM ciphertext under a
   PBKDF2-derived key (310,000 iterations, SHA-256, random salt and IV) and unlocks once per
   session; the passphrase is never stored. This defends the real scenario it can defend — someone
   else reading this browser's storage — and is offered rather than forced.
5. **It declines to pretend.** On a non-secure origin the settings dialog says the key cannot be
   protected there instead of quietly accepting it.

**What none of it protects against, stated because encryption invites over-confidence.** Script
running on the page while the key is unlocked can read it from memory, because the page must be able
to use it. That is what (2) and (3) are for; the encryption in (4) is the weaker of the two defences,
not the stronger, and the settings dialog says so where a user will read it.

**Rejected: no persistence at all.** Re-pasting a key on every page load would push people towards
keeping it in a text file, which is worse. The session-only option covers the cautious case.

**Rejected: `frame-ancestors` in the meta CSP.** It is ignored outside a response header, and Pages
cannot set headers. Claiming it in the policy would have been decoration.

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

---

# The in-app decision record

Added when it became clear that "a written summary of key decisions taken by the AI" meant the
decisions the model makes *while generating a map*, not the decisions behind the codebase.

## 17. The model reports its reasoning as structured decisions, not prose

**Chosen.** Every layer's response schema carries a `decisions` array — three to eight entries of
`{title, detail, hexes}` — alongside the one-line summary that already existed. The prompt asks
specifically for choices rather than contents: which cue in the brief was followed, where two parts
of it pulled against each other and how that was resolved, what was invented because the brief was
silent, and anything a reader would otherwise take for a mistake.

**Why structured rather than a paragraph.** A paragraph cannot be filtered by layer, cannot carry hex
references that the UI turns into a selection, and cannot be laid out as a document. Structure also
disciplines the model: a field called `title` gets a claim, where free text drifts into restating the
data. The prompt says so outright, because "the eastern basin is BWk" is the map, not a decision.

**Why it is stored per generation rather than per layer.** Regenerating or rewriting a layer produces
new reasoning without erasing what came before, so the record is the history of the map's making, not
a snapshot of its current state.

## 18. Human edits are logged in the same record

**Chosen.** The journal records manual edits, undos and redos next to the AI entries, with an "AI
decisions only" filter defaulting to on.

**Why.** A record of only the model's choices, kept alongside a map the user has been editing by
hand, quietly misattributes their work to the AI. The value of the record is that a reader can tell
which decisions were whose, and that requires logging both. The filter exists because the AI entries
are usually what someone came to read.

## 19. The record is part of the map

**Chosen.** The journal lives in the map state: autosaved to IndexedDB, included in the JSON export,
restored on import (and tolerated as absent in files written before this existed).

**Why.** Reasoning that vanishes when you export the map is reasoning you cannot use. A generated
world is defensible only if the account of why it looks like this travels with it — hence also the
Markdown export, which is a document rather than a data dump, grouped by layer and opening with the
brief that started it.

## 20. The offline generator reports what it actually did

**Chosen.** The procedural generator emits decision entries too, but they describe its arithmetic —
"landmasses from overlapping blobs", "flood fill from random seeds, ignoring rivers, ranges and
coasts" — rather than imitating the model's reasoning.

**Why.** Generated prose about the design intent behind a random blob would be a fabrication, and it
would sit in an exported document indistinguishable from the real thing. Saying plainly that the
climate is latitude bands with no rain shadow is both honest and more useful: it tells you exactly
what a mock map is not.

---

# Scoping the work on large maps

Added when it became clear that running all eight layers is too much on a large grid.

## 21. The user chooses the layer plan; there is still no "generate everything" button

**Chosen.** A map records which layers it is meant to have, chosen at creation from presets or
individually, and changeable afterwards. Layers left out are not generated, not shown, and not
exported.

**Why this rather than a batch run.** The complaint is that the full pipeline is too much work on a
large grid, and there are two possible answers: make the whole run one click, or make the run
smaller. A batch button would multiply the cost of the thing that is already too expensive, and it
would trample the review-and-edit step between layers that the design is built around — the point of
generating in stages is that you can correct stage three before stage four reads it. Choosing fewer
layers attacks the actual quantity. Eight generations become three, and the three are the ones that
were wanted.

**Consequence for cost.** The picker states the arithmetic rather than hiding it: how many layers are
selected, and that each is one pass over every hex on the grid. Grid size and layer count multiply,
and the person choosing both should see that in one place.

## 22. "Not yet" and "never" are different things to say to the model

**Chosen.** The prompt context carries the excluded layers, and every place a prompt describes an
absent dependency has two wordings.

**Why.** This is the part that would have been easy to skip and would have quietly degraded output.
The existing prompts said things like "no rivers layer exists yet - they can be revised after rivers
are generated", which is true when rivers are pending and actively misleading when the map will never
have them: it invites the model to leave the question half-answered for a pass that is not coming. So
vegetation without a climate layer is now told to work the climate out itself and commit; cities
without rivers are told to judge water access from the coast and terrain and to say when they have
sited a town on a river they inferred; population without vegetation or cities is told what it is
missing and to record its assumptions.

## 23. Removing a layer from the plan is not destructive

**Chosen.** A layer dropped from the plan keeps its data, hidden. Re-adding it brings the data back.

**Why.** The alternative - clearing the data - makes the plan a trap: one mis-click discards a
generation that cost real money and minutes, and undo would have to reach across a layer boundary to
recover it. Hiding costs nothing but a retained array, and the picker says plainly what will happen,
so nobody has to guess whether removing a layer is safe.

---

# The output budget

Added after generating polities for a 30×30 map failed with "the response hit the output token
limit", on a layer whose answer is about three thousand tokens.

## 24. `max_tokens` was sized against the answer, and the answer was never the problem

**Chosen.** Raise the hard cap to the model's real maximum, and put an advisory task budget behind
it that the model can actually see.

**What went wrong.** `MAX_TOKENS` was 64,000, with the comment "a 50×50 layer is well under this."
That was true and irrelevant. `max_tokens` bounds everything the model emits, and this model thinks
by default: reasoning tokens are output tokens. A 30×30 polity response is roughly 3,000 tokens of
rows, roster, notes and decisions — under 5% of the cap — and the generation still failed, because
the other 61,000 went on working out where the borders should run. §2 made the answer small and was
read as making the response small.

**Why a task budget rather than just a bigger cap.** A bigger cap postpones the failure; it does not
change its shape, because `max_tokens` is a ceiling the model cannot see and is simply cut off by.
A task budget is advisory and visible: the model is told how much is left while it works, so it
winds up and answers instead of running off the end. The cap becomes headroom behind it rather than
the thing being enforced.

**What it costs.** A beta flag, and a number the user can now get wrong. The default effort also
drops from `high` to `medium`, which is a real quality trade on large maps — `high` is one setting
away for anyone who wants it, and now has a budget to spend it against.

## 25. A truncated response is retried, not surrendered

**Chosen.** On `max_tokens`, retry once at one effort level lower — and for a layer that can be
split, as two passes instead of one. Only then does the error reach the user, and it reports the
token split rather than guessing at a cause.

**Why.** The old behaviour threw away the whole generation and told the user to try a smaller grid.
That advice was wrong in a way that mattered: shrinking a 30×30 map to 20×20 removes about 1,500
tokens from a 64,000-token overrun, so anyone following it paid twice and still failed. Meanwhile
64,000 billed output tokens — around $1.60 — were discarded per attempt, repeatably.

**What it costs.** A failed generation can now cost two requests rather than one. That is worth it:
the second is at lower effort and usually succeeds, and the alternative was two *user-initiated*
attempts anyway, the first of which taught them nothing.

## 26. Polities and rivers are two problems, not one

**Chosen.** Both layers can run as a roster pass (who or what exists) followed by a geometry pass
(where it goes), selectable per generation, with the roster importable or reusable from the layer as
it stands.

**Why.** These are the two layers that invent a vocabulary and apply it to the grid in the same
request, and the halves constrain each other — you cannot size the territories until you know the
roster, or finalise the roster without a feel for the ground. That mutual constraint is most of what
the model was spending its budget on. Given a fixed, closed set of keys, painting the map is ordinary
constraint satisfaction. Polities is also the only layer with a global structural requirement
(contiguity), and with base geography alone all three of its soft dependencies are missing, so it was
inventing an elevation map, a river network and a set of cities purely to satisfy its own border
rules and then discarding them unwritten.

**Why a roster is a first-class thing.** Once the geometry pass takes a roster as input, that roster
need not come from a model at all. Someone who already knows their world's nations can supply the
list and ask only for borders; someone who wants different borders for the same powers can repaint
against the roster the map already has, and because ids are matched back by name, the polities keep
their identity across the repaint.

**What it costs.** Two round trips where there was one, and a recombination step. The halves are
folded back into exactly the single-request shape before decoding, so there is still one decoder and
one validator; and notes and decisions from both passes are kept, because the reasoning about who
exists and the reasoning about where the border runs are different and the record needs both.

## 27. The same prompt, carried by hand

**Chosen.** Any layer or pass can be compiled into one self-contained block of text to paste into a
chat window, and the reply pasted back and imported.

**Why.** The in-app path is not always the right tool: there may be no key configured, or the user
may prefer to argue with the model about the borders before committing them. The prompt is already a
complete string, and the decoder is already a pure function, so the missing piece was only a
description of the response shape — a webchat has no structured outputs to constrain it.

**Why the shape is derived, not written.** The JSON Schema comes from the same Zod schema the API is
given, and the worked example from the offline generator that already has to satisfy it. A
hand-written copy of either would drift the first time a layer changed, and would drift silently,
because nothing would be checking it against the real contract.

**What it costs.** A looser parser on the way back in — the reply may be fenced, or wrapped in
prose — and a validator that has to name the field that was wrong rather than just rejecting, since
the fix is for the user to relay it. And the decision record has to record these as imported: it
already refuses to credit the AI with a choice the user made, and crediting this app's model with a
choice made somewhere else would be the same lie.

---

# Holding the model to the grid and to the brief

Added after every layer past the base one failed as "malformed data", and then, once that was fixed,
after the layers that did arrive came back with rows a cell or two short and with sizes the brief
stated plainly ignored.

## 28. A grid is returned cell by cell, because a model cannot count characters

**Chosen.** Over the API, every grid is a keyed object - `{"r0": {"c0": ..., "c1": ...}, ...}` - in
which every row and every cell is a required property with an enumerated value. The pipeline flattens
it back into row strings straight after parsing, so the decoders are unchanged. The webchat path keeps
row strings.

**Why.** §2's row strings were chosen to keep output small, and they did, but nothing enforced their
length: the API's constrained decoding does not support string lengths or item counts above one, and
the SDK silently moves those constraints into the field descriptions. The model was therefore relying
on counting, and it cannot count characters it does not see: "tttt" and "mmmmmm" arrive as single
tokens of lengths it has to infer. Rows came back short in bands wherever the terrain had long uniform
runs, and every short row shifted a band of the map sideways. Required properties are something the
grammar does enforce, so the size is now guaranteed rather than requested. Naming each cell also tells
the model which column it is writing.

**What it costs.** Output tokens: about five per cell, so roughly 6,500 for a 36×36 layer and 12,500
for a 50×50 one, against a few hundred before. The row definition is shared through `$ref`, so the
schema itself stays a few kilobytes whatever the grid size. If the API ever refuses the schema, the
layer is generated as row strings instead and the user is told the size was not enforced.

## 29. Context grids carry anchors and measured totals

**Chosen.** Every grid shown to the model has row labels, a `[n]` column anchor every five cells, and
the hex counts per value computed by code.

**Why.** The same tokenisation problem applies on the way in: working out what sits at column 23 of a
36-character string is a count. With anchors it is a lookup. The totals matter for the brief: "a third
of the continent is desert" or "the kingdom covers 250,000 km²" can only be honoured against a known
number of land hexes, and that is a number code gets right and a model does not.

## 30. The brief outranks the prompt, and its sizes are converted, not admired

**Chosen.** Every prompt says that the brief overrides every default in it (typical counts, sizes and
placements), and spells out the arithmetic for turning stated sizes into hexes. Every response opens
with a `brief` object - the scale, and each requirement bearing on the layer as a concrete target -
which constrained decoding writes before the grid and which is shown to the user in the decision
record. Polity rosters carry a target hex count to the paint pass, and a polity drawn more than a fifth
off its target is reported.

**What went wrong.** The scale rule told the model not to assume a scale unless the brief "states or
clearly entails one", and gave it no method when it did, so stated areas had nowhere to go. The
defaults ("aim for about 8 rivers", "place between 10 and 30 settlements", "lakes are one to a few
hexes") were stated as flatly as the brief and read as equally binding. And the roster pass was asked
to "give a sense of how big each polity is" in its decisions, which the paint pass never received.

## 31. Effort back to high

**Chosen.** Default effort `high` and a 96,000-token task budget, reversing the cut in §24. Saved
settings that still hold the old defaults exactly are refreshed; anything else a user set is kept.

**Why.** §24 was right that a long think could run off the end of the response, and §25's retry at
lower effort was the safety net. That net never caught anything: the SDK's structured-output parser
turned every truncated response into a JSON syntax error before the truncation check could see it.
With that fixed, a `high` run that overruns is retried at `medium` automatically, and the depth a
whole-map spatial problem needs no longer has to be given up to avoid a failure that is now recovered.
The keyed grids of §28 also make the answer itself far larger, which the old 40,000 budget could not
absorb.

**What it costs.** More tokens per layer, and a slower first attempt. `medium` is one setting away.


## 32. A compact webchat reply: data as JSON, reasoning as chat

**Chosen.** Alongside the full form, the webchat prompt can ask for the layer data alone as JSON, with
the plan written before it and the decisions after it, in prose. The prompt lists the data fields in
place of the JSON Schema. On import, the prose around the JSON is kept as the layer's notes.

**Why.** A chat model explains itself better in chat than inside a string field of a JSON object, and
a shorter prompt leaves more of the conversation for the work. Keeping the prose as notes means the
explanation still reaches the map. The import reads a fenced `json` block first, so a brace in the
prose cannot be mistaken for the start of the answer.

**What it costs.** Decisions arrive as one block of prose rather than structured entries with hex
references, so the decision log cannot link them to hexes.

## 33. Several layers in one webchat reply

**Chosen.** The webchat dialog can ask for any set of layers in one prompt and import them from one
reply: the shared rules and brief once, each layer's rules in pipeline order, one JSON key per layer.
Import checks every layer before applying any, and decodes them in order against a context that
already holds the ones before - so the elevation is validated against the base in the same reply.

**Why.** In a chat window, one long reply in which the model can keep the whole map in view is often
better and cheaper than a round trip per layer, and it keeps the layers consistent with each other by
construction.

**What it costs.** Each layer runs as a single pass, so polities and rivers lose the roster/paint
split; and a long multi-layer reply is the kind most likely to be cut off by a chat interface's own
output limit.

## 34. Base geography letters

**Chosen.** `t` Land, `c` Coastal Land, `m` Sea, `l` Lake, `g` Ice, `i` Island, replacing
`L C ~ o # i`. Stored maps are unaffected: layers store values, not codes.

## 35. One instruction, several layers

**Chosen.** Tick layers in the Layers list, type one instruction, and "Rewrite N selected layers with
AI" applies it to each ticked layer that has data, one request per layer, in pipeline order. Each
request carries the user's instruction plus a short note saying which layers are in the run, which
have already been rewritten (and are shown as they now stand) and which come after; a layer the
instruction does not concern is told to return itself unchanged. The journal records the user's own
words, not the added note.

**Why sequential.** A layer is rewritten against the layers before it, so an upstream change (a new
island chain) reaches elevation, climate and the rest within the same run instead of leaving them
stale. That makes the "at once" setting irrelevant here. It also means a failure or cancel stops the
run: what follows would be built on a layer that did not change. Layers already rewritten keep their
result and their own undo entry.

**What it costs.** One request per layer, each over the whole grid, so the cost is the sum. Layers
without data, or left out of the plan, are skipped and named. Undo stays per layer.

**Webchat.** The same instruction works through "Prompt for webchat…". With two or more layers ticked
the dialog opens in several-layer mode, and with an instruction present the prompt becomes an edit:
every layer shown as it stands, the instruction stated once, and the reply asked to return each layer
complete, in pipeline order, later layers consistent with the earlier ones as just changed. Each
layer must already have data (the dialog says which do not). One reply is one round trip, so unlike
the in-app run it is all-or-nothing on import, and each layer runs as a single pass. The journal
records the instruction against each imported layer.

## 36. Ice is a kind of land and a kind of sea

**Chosen.** The single `Ice` base type is replaced by `Glacier` (code `g`) and `Sea Ice` (code `f`).
A Glacier is land: it carries elevation, climate, vegetation and population like any other land hex,
can hold cities and be claimed, and is named as a land feature. Sea Ice is water: it carries no land
values, rivers end in it, and it belongs to the sea it freezes. Maps saved with `Ice` load it as Sea
Ice (migrated alongside the old island types, see `migrateLegacyIslands`): those hexes had no land
values, so Sea Ice is the one reading that needs no invented data.

**Drawing.** A Glacier is the ice colour, darkened toward the ice shade on low ground and left bright
on high ground, and takes the relief the style shows (marks, hill shading, drawn symbols); the
"Textured" ice setting adds crevasses only where the ground is flat. Sea Ice is a frozen-sea colour
with seeded floes of paler ice cracked apart by the ice shade, drawn over the water and clear of the
sea's depth or ripple bands.

**What it costs.** An old map's polar strip becomes Sea Ice even where it was meant as a land cap; the
user repaints those hexes as Glacier and fills their land layers.

## 37. Land share and irregularity are per hex, and only for hexes with an edge

**Chosen.** Coastal Land, Islands, Mainland and islands, Isthmus, Strait, Glacier and Sea Ice hexes
carry two settings: a land share (not Sea Ice, which is all water) and an irregularity (Smooth, Wavy,
Ragged, Fractured). They live beside the layers, in `MapState.hexShapes`, keyed by hex index and
holding only what a person has set, with the base type they were set for.

**Land share.** The map-wide defaults are 90% for Coastal Land, 30% for an Isthmus, 40% for a Strait,
100% for a Glacier, 10% for each small island, 20% for each large one and 30% for any mainland, and
all of them can be changed in Settings. An island hex is the sum of its islands (a mainland hex adds
the mainland's 30%), so a hex's share follows its island counts until someone sets it. A hex's own
share replaces the computed one. It feeds the polity areas in the legend, and an island hex draws its
islands larger or smaller to match (relative to the share they would have had, so unedited maps look as
they did). The old `islandLandPercent` is gone; maps saved with the old 60%/40% defaults take the new
ones, and a share someone had chosen keeps its ratio of small to large islands.

**Why settings carry their type.** A hex repainted from Coastal Land to Strait should not keep a 90%
that was chosen for a coast. Rather than hunt every place the base layer changes, the settings are
ignored once the hex is no longer of the type they were made for; this also makes undo of a repaint
harmless.

**Why "irregularity".** The elevation layer already uses "ruggedness" for terrain (Plateau is high
but not rugged), and two meanings in one sidebar would have been confusing. The default for each type
reproduces how it was drawn before (coasts Smooth, islands Wavy), so no existing map changes.

**What irregularity does, and does not.** On a smoothed coast it lets the shore stray from its
smoothed line by up to about a third of a hex (Fractured), with the fill corrected on both sides of the new line (the
same sliver mechanism the smoothing already used, so realm bands, lake masks and the water's surface
follow it). The coast always passes through the middle of each hex edge, where rivers and cities meet
it. On islands it widens the wobble and adds skerries; on ice it breaks the edge and sheds floes and
icebergs. In a hex-edged coast style it has no effect on a coast, by design: that style promises exact
hex geometry. The land share does not move a coast: a coast hex is drawn as a whole hex and its share
is bookkeeping for area.

**A map-wide default.** Settings → Map has a "Default irregularity". When set, it is the irregularity
of every shaped hex with none of its own, replacing the per-type defaults (coasts Smooth, islands
Wavy); only hexes set by hand keep theirs, so changing it redraws exactly the hexes that follow the
default. It is stored as `MapState.defaultIrregularity` and cleared by choosing "Each type's own".

**Lake shores.** A lake's shore is roughened the same way, so a lake is not a smooth blob beside a
ragged sea. It has its own map-wide default, `MapState.defaultLakeIrregularity`, separate from the sea
coast's and Ragged when absent (this redraws existing lakes: they were smooth). The shore takes the
setting of the land hex beside it when that hex is a shaped type set by hand (Coastal Land, say), else
the lake default; the amplitude is eased between hexes and held back where a narrow strip of land
separates two arms of water, as the lake's outward reach already is.

**What it does not cover.** Sea Ice has irregularity but no land share. The AI layers do not set
either value; they are hand edits, logged in the journal.

## 38. Sea ice is one body; a glacier gets a shelf and calves

**Chosen.** Sea Ice hexes are drawn as ordinary sea, with the frozen area's outline traced as a single
shape over them: smoothed and roughened instead of following the hex grid, closed along the map edge
where ice runs off it, with a frosted rim, broad overlapping plates and a few cracks inside it, and
floes breaking away along its open edge. A glacier keeps its hex fill; its coast gets a sloping shelf
and a bright cliff line, and bergs calve off it. The textured ice setting turns on the cracks, the
fringe and the shelf; flat ice keeps the body, the rim and some plates.

**Why.** Pale hexes with white blobs read as a grid of tiles, and the hexagonal staircase edge was the
loudest thing about the polar strip. The pack is clipped to the sea's own clip region, so ice runs up
to a shore exactly and never over land, and the water's bands carry on underneath it.

**Why only the open edge is roughened.** Ice against land follows the coast the rest of the map uses;
if it had its own line the two would leave gaps and overlaps along every shore.

## 39. A land share is the share of the hex that is drawn as land

**Chosen.** Decision 37 left a coast hex drawn whole and called its share bookkeeping for area. It is
now drawn: a Coastal Land or Glacier hex whose share is under 100% has its water-facing edges moved in
from the hex's own edge, by one depth for all of them, chosen so that the land left is exactly the
share (the depth is found by cutting the hex with its moved edges and bisecting on the area left, not
estimated from edge lengths). The strip between the old edge and the new one is water, drawn through
the same list as the corners a smoothed coast cuts off, so realm bands, the water's surface and the
ice follow it with no further change. Rivers are clipped at the new shore, so they end in the sea
rather than at the hex's old edge.

**Where two hexes meet.** Where a moved edge meets a neighbouring hex's coast, the coast runs out to
the border the two land hexes share and steps along it to where the neighbour's coast begins, so a bay
cut into one hex has the neighbour's land standing as its wall. Only edges of the hex itself move: a
neighbour that is at its full share, or an Isthmus, a Strait or a Land hex, is not pulled in with it.

**Islands.** Each island is drawn at its own share of the hex: a large island takes the large-island
percentage of the hex's area and a small one the small-island percentage. The layout still decides
where each lies and how stretched it is. A hex that sets its own share scales its islands, in the
same proportions, to fill it (less the mainland's share in a mainland hex). Islands that would then
run over the hex's edge are drawn nearer its centre, so a crowded hex draws its islands touching
rather than spilling into the neighbours. This makes the default islands smaller than before: a lone
large island is 20% of its hex where it was drawn at over half of it, and a small island is 10%
where it was 3%. The percentages are what changed, in Settings, not a hidden size.

**What is exact and what is approximate.** The share is exact for a coast drawn along hex edges (the
Hex coast style) and within a few percent for the smooth styles, whose rounding trims convex corners
and fills concave ones by up to an eighth of a hex, and whose irregularity then roughens the line. It
is not corrected for.

**What it does not cover.** An Isthmus, a Strait and the mainland of a Mainland-and-islands hex are
cut from fixed pieces of the hex (a neck or channel a third of a hex wide, banks, a half) and still
draw that much whatever their share; the share counts in their area only. Their defaults (30% and 40%)
sit close to what those pieces already show (superseded by decision 42, which draws them at their shares).

**Lakes.** A lake has a body of its own, so a coast hex beside one used to be drawn whole, its share
ignored. The depth worked out for the hex now counts its lake-facing edges as well as its sea-facing
ones, and the lake's shore beside that hex lies that far in from the hex's edge, in place of the lake's
usual outward reach of about a sixth of a hex. The lake is drawn over the hex, so no water strip is
needed. The shore is still smoothed and roughened like any lake shore, so the share is approximate there.

**Cities stand on the drawn land.** A city's site (a port's shore, a bank, the centre) is a fixed
point in its hex, which the inset coast and the split hexes (isthmus, strait, mainland-and-islands) can
leave in water. `citySite` now asks `landTest` (the same pieces and insets the coast is drawn from) and,
when the site is not land with a little room round it, takes the nearest point that is: first back along
the way to the hex centre, so a port keeps to its shore side, then anywhere in the hex. Island hexes
keep their own island centre. The test ignores the coast's smoothing and roughening, hence the room.

## 40. Ice follows the ground it lies on, and every edge resolves to a neighbour

**Chosen.** Three changes to how ice is drawn, all in the textured ice setting unless stated.

*The map's rim.* A hex grid cut to a rectangle leaves half-hex notches down the sides and small
triangles along the top and bottom; they used to show the page colour, so a band of pack ice ended in
teal teeth. Each notch now belongs to the border hex beside it: that hex's edge facing off the map is
extruded to the rim (`rim.ts`), and the piece is painted as the hex is (its fill and overlays for land,
the sea's colour for water, and into the sea's clip, so the water's surface and the ice reach the page
edge). A coast that runs off the map is carried on to the rim the same way. This applies to every
style, not only ice.

*Glacier against land.* A glacier's edge on dry land is traced as a line of its own (glacier hexes
against land hexes; the water beside a glacier counts as part of it, since its coast is the sea's to
draw), smoothed and roughened like a coast, and repaints the slivers it moves across: ice gained over
the neighbouring land in the glacier's colours, land regained in the neighbour's. Height sets its
character through the roughening's new `lean`: ice pushes out onto ground higher than its own (up to
about a quarter of a hex) and ends in a more broken edge there, and holds back in rounded lobes against
lower ground. A frosted band and a fine line mark the margin, and the grid line along it is dropped.
Where elevation is not shown there is no height to follow, so the margin is plain roughening.

*The ice sheet.* Height is shaded over the sheet as stacks of soft discs rather than hex by hex: dull
on low ground, bright over high. Ice flows downhill: on a slope, strokes lead toward the lowest
neighbouring ground, and level ice is cracked with crevasses instead, with relief marks over the rest
as before. Glacier hexes no longer take hill shading, which shows through ice as hexagonal blotches.
Where a glacier meets pack ice the coast's ink gives way to a pale seam (ice on ice, no shore).

*Pack ice.* The overlapping blobs are replaced by plates, the Voronoi cells of a jittered scatter on a
fixed grid (so they do not shift when the map is edited or zoomed), with the leads between them as
cracks that open up where the pack meets open water. A pack that meets the map edge all the way
round used to draw nothing (it had no edge to close); it now fills the page, with any open water in
it as a hole.

**What it costs.** About twice the scene-building time on a very large icy map (120×100 hexes: a
quarter to half a second). The glacier shading discs and flow strokes are many small primitives.

## 41. Names keep their true footprint, their clearance, and the middle of what they name

**Chosen.** A realm name claims the rotated rectangle it occupies, not the axis-aligned box that
encloses it, and later names are tested against it exactly (separating axes). Each name keeps a
clearance of a quarter of its type size either side and a tenth above and below, so two tracked names
read as two words; the last placement attempt gives up three quarters of that rather than leave a
realm unnamed. A realm's "middle" is the ground furthest from its border and its lakes, with some pull
towards the mean of its hexes (which is what centres a name along a strip where every hex is as deep
as any other); a name may graze a lake in its realm, one sample in ten, but not run across it. A
small realm whose name is wider than the realm at its natural size is named beside it, not shrunk
onto it. Relief symbols under a realm name are drawn at 40% opacity.

Water names are set in type that grows with the body's depth (0.85 hex for a shallow body up to 1.2
for one eight or more hexes deep), centred on the body's middle rather than on its deepest hex (which,
for a body that meets the map's edge, is the edge itself). A winding body (a gulf, a bay with a
corridor) takes a name along the ridge of its deepest water, with every letter and the room beside it
over open water, when that carries type at least a quarter larger than the straight fit. A name of
two or more words in an ocean cut by an island group is split: the words stand on one baseline, each
in its own stretch of open water, as close together as the obstruction allows, when that carries type
at least a quarter larger and the stretches lie within three word-lengths of each other (further
apart, the words would read as two names).

**Why.** The first two are what had realm names touching ("AHNVER" and "RANGMULS" read as one word),
children pushed to the margin of a diagonal parent's bounding box, and a ring-shaped realm named from
its hole. The water changes are what had every ocean named in a pond's type, at the top edge of its
body, and a gulf named in small steeply tilted type in its narrowest corridor.

**What it costs.** Clearance can shrink the later of two crowded names or, for a one- or two-hex realm,
leave it to the legend. A fade is subtler than clearing the relief but leaves the symbols faintly
under the letters. A larger ocean name competes harder with realm names (it is capped at 80% of the
largest realm type). The simple relief marks (not the drawn relief) are not faded, because they are
drawn inside the hex fill loop.

**Not changed, and why.** Names on thin steep coastal strips still use the ±30° rotation limit and
may spill; this was judged not worth steeper type. Child realms keep their flat 0.62 scale and
lighter weight.

## 42. Every land share is enforced, in the shape it is set for

**Chosen.** Decision 39 enforced the share only for Coastal Land and Glacier, and for the size of islands.
An Isthmus, a Strait and the mainland of a Mainland and islands hex ignored theirs: the pieces they were
cut into (decision 37) drew the same at 10% as at 90%. `src/render/footprint.ts` now reshapes every hex
with a share until the land drawn is exactly that share, and the coast is traced again round the result
(the boundary of the union of every hex's land, so a neighbour's coast steps along a border where a
reshaped hex no longer reaches all of it).

- Coast hexes (and a mainland, isthmus or strait with no neighbour to join) are cut back from their sea edges, as before.
- An Isthmus is a neck of uniform width running from the middle to each land neighbour; a Strait is the hex
  less a channel of uniform width to each sea neighbour. Both stay whole at any share. With three or more
  such neighbours (which would leave pockets), and for a mainland, land is laid along the edges shared with
  land, deeper as the share grows, so it stays joined to them.
- A split hex (isthmus, strait, mainland) beside a lake has the lake's shore moved by one distance, found so the land left is its share (into the land, or out into the lake when it has too little); the lake is drawn over the hex, so nothing else changes. Lake shores are smoothed and roughened heavily, so this is approximate (30% drew 35%, 70% drew 64% in a test). A coast hex beside a lake counts its lake edges towards its depth (the lake is drawn over it, as in decision 39), and is cut only from the sea.
- Smoothed and roughened coasts move some land; the cut is repeated, up to twice, to the share less what the coast moved.
  The Hex coast style is exact; smooth styles are within about a point, a few at the thinnest necks.

**Islands.** Their size is found so the land they actually cover (not the ellipse they start from, which the
outline falls ~10% short of) is the share. They are kept apart from each other and clear of the mainland,
inside the hex and near the place the layout gave them. Where a hex cannot hold its full share without the
islands merging, they are drawn as large as they can be and no larger, and never smaller than before.

**What it costs.** Default straits, isthmuses and mainlands look different (they now match their shares (an isthmus now defaults to 70%, close to what it was drawn at before: 30% drew as a thin line)).
First draw of a 50 x 50 map is slower (~0.7 s against ~0.15 s); later edits reuse what was cut.

**Irregularity defaults.** Every shaped type (coasts, islands, isthmuses, straits, mainlands, ice) now defaults to Ragged, and Settings lists each type's default.

## 43. Map furniture is searched for, and the audit checks it independently

The frame grows the page by a margin instead of covering the map's edge, so the margin band is guaranteed empty and is where a piece goes when open sea has no room. The scene is wrapped in a translated group (`group.translate`) rather than rewritten. Pieces are placed on a coarse occupancy grid (non-sea hexes, name boxes, city markers, the legend panel, placed pieces); `audit.ts` re-tests the result rectangle against rectangle and against land as drawn (`landTestOf`, kept beside the scene so scenes stay plain data). Known gap, found by the audit: realm names are placed on hex ownership, so a realm whose land is a few small islands can have its name printed across them.

## 44. A lake hex can hold land: the land share the other way round

**Chosen.** A Lake hex takes a land share like Coastal Land does, in Settings (`lakeLandPercent`, default
0%) and per hex in the sidebar (`MapState.hexShapes`, land only: a lake has no irregularity of its own,
its shore takes the land beside it, decision 37). Where a coast hex is cut back from its water-facing
edges until the land left is its share, a lake hex has its land-facing edges moved in, by one depth for
all of them, until the land those strips take is the share. The depth is found with the same bisection as
a coast hex (`landInsetDepth`, asked for the water left, one minus the share).

**Drawing.** The lake's shore (`lakeBodyPath`) lies that far into the lake hex instead of its usual
outward reach into the land. Where the land hex beside it is itself cut back (a Coastal Land hex under
100% against the lake), the two meet: the shore lies at the difference of the two depths. The ground
revealed is the ground the lake hex already had drawn under its body, so realm bands, rivers and the lake's
depth bands follow the new shore as they follow any other.

**Why 0% by default.** A lake hex is counted as all water in areas, as before, and a lake with no share
set is drawn as it always was; nothing in an existing map changes. Only edges against whole land hexes
move: an edge against a sea, another lake or a split hex (isthmus, strait, mainland) stays at the hex
edge, so the share is exact only for a lake hex whose land edges are those. The shore is smoothed and
roughened like any lake shore, so the drawn land is approximate.

**In areas.** A lake's share counts as land in a polity's area when the hex is owned.

## 45. Islands: share includes the outline, arrangements, and ripples off by default

**Problem.** Islands read larger than their land share, and clusters looked arbitrary. Three causes.
(1) The size fit (`islandScale`) measured the island's fill only, but the coast's ink is centred on the
edge, so the outer half of the stroke added to what shows: roughly a third more area on a 5% islet.
(2) Every islet took a random axis, so a group read as pebbles. (3) With ripple lines on, the rings round
neighbouring islands merge into one halo that makes a group look like a single large landmass.

**Chosen.** (1) The fit counts the land plus the outer half of the coastline's stroke (`inkReach`; none with
`coast: none`), so a share is what is visible. (2) Islets in a group share one grain, set by the new
orientation (parallel to the coast, across it, or by chance). Spacing between islets now uses each one's
reach along the line joining them, since elongated islets overlapped end to end under the old circle test.
(3) `ripples` takes 0 (the new default in Classic, Parchment, Atlas and Night) and the new All frills preset
keeps three. At 0 a lake has no ring either.

**Arrangements** (`IslandSpec.arrangement`, `orientation`; absent means scattered/free, so saved maps are
unchanged apart from the shared grain): chain (hotspot trail, largest at one end), arc (volcanic island arc,
bowed away from the land), barrier (a staggered row of long narrow islands off a coast) and ring (atoll).
They replace the coastal-group checkboxes, which apply to scattered islands only. A crowded arrangement is
drawn smaller than its share rather than run together, as before.

## 46. Slimmer rivers that keep to the land, run through lakes and mark their cities

**Problem.** Tapered rivers read heavy, hooked where the hex walk turned tightly, were cut square by a clip at
the old hex edge where a coast hex had been reshaped to its land share, and could run past the shore into the
sea. A river could not cross a lake, and a city on a river was shown by a blue dot too small to see (and by
nothing at all in the classic and illustrated marker sets).

**Width.** A river's width is a multiple of one normal width (0.045 of a hex). It leaves its source hex at half
that (a thread at the spring) and reaches the normal width over the next hex. Each tributary adds a twentieth of
the normal width below its confluence, distance from the source adds up to a fifth (the longest river on the map
reaches it; a shorter river adds in proportion to its distance, so every river is measured against the same
yardstick), and navigable water is a tenth wider, eased in over about a hex. Together these make rivers about
half as heavy as before; the bank stroke is thinner to match.

**Bends.** A bendy river looked like a drawn curve because its wander was one regular wave on top of a smooth
spline. The wander is now irregular, as a real river's is: value noise along the river at three scales (about
two, one and under half a hex) under a slowly changing envelope, so some reaches run nearly straight and others
wander, with no one wavelength. Its swing still shrinks as the river widens and dies away at both ends, so
confluences and forks land on their host, and it stays inside the river's hexes and clear of folding.

**Coast.** A river into the sea is cut where the coast is drawn, found from the coast lines themselves (land is
on the right of each line, so the side a point falls on says whether it is land, however the coast has been
reshaped, smoothed or roughened), and flares there; where the coast bulges past the hex's edge the river is
carried on to it. Points of the course that would swing off the land are pulled back. As a guarantee, everything a river
draws is clipped to the page less the sea and the lake bodies, so no river shows over open water whatever its
course does (this replaces the clip over the water strips, which cut the mouth off flat at the hex's old edge).

**Lakes.** A river may run through a lake: validation no longer warns about a lake hex in the middle of a path,
merging two rivers bridges a lake, and the prompts say rivers may link lakes. Where it crosses the water it is
hidden (the river is the lake there), so it shows on either side. Rivers that begin or end at a lake still stop
at its shore.

**Cities.** A city on a river is no longer ringed in a disc of water, and the river and the icon shape each other
(`riverCity.ts`). The icon is always drawn whole and on top of the water: never cut, squashed or parted (the earlier
treatment pressed every point of the icon that lay in the water onto the bank, which turned small icons into
slivers and notched a metropolis). How it sits with the river is the style knob `cityRiver` ("Cities on rivers"):
`beside` (default: the icon is set so its edge just touches the bank and the river bows round all of it), `overlay`
(set a third into the bank, the river not bowed and running behind the icon), and two that show the river through
the two larger icons (city, metropolis; smaller icons stand beside the river as in `beside`): `outline` and `wash`.
In both the larger icon stands on the river's own line (the river is left as it is, and the icon is dropped so the
middle of the drawn icon, not its site, is on the river: `iconDrop`) and the river's course through it is drawn over
the icon, clipped to the icon's silhouette so the icon stays whole: its two banks as faint lines (`outline`), or a
translucent band of water (`wash`), in a water colour lightened toward the paper on the dark-bodied marker sets so it
shows (`riverThroughIcon`). The placing is `riverStance`. The river keeps clear of the icon's whole drawn extent
(`iconClearance`, from `markerExtent`), not just its body. The legend swatch follows the mode (a city, not a town,
for the two see-through modes). `pressIcon`, which no renderer used, has since been deleted.
Tried and dropped: a straight band over the icon, a clip cutting the icon along the river, icons rebuilt as parts laid
along the bank, sliding points radially to the nearest bank point (it folded tips into stalks and flaps), pressing
the icon against the bank (distorts small icons), and, among the placements offered and dropped, a bridge deck
across the river and an islet the river splits round.

**River irregularity is a setting.** Style knob `riverWander` (Very gentle, Gentle, Normal, Irregular, Wild; Normal by
default) sets the swing of the wander, how many passes pull the hex-edge crossings taut (fewer leaves the hex walk's
own corners), and how often a river that bends within a hex swings
into it towards its centre instead of just clipping the corner between its two edges, and how far (past the centre
at the top two levels). That last is what allows sharper, deeper bends. The first scale (gentle to wild) proved
too timid about entering the hexes a river bends into, so it was shifted two places down: the old Wild is Normal,
the old Irregular is Gentle and the old Natural is Very gentle, and two new levels go further than the old Wild.
Saved maps keep any value that still exists, so a stored `irregular` or `wild` is now the stronger one.
Each level also sets how far a crossing may slide along its edge, so the stronger levels let rivers leave a hex nearer
its corners: no closer than 0.125 of an edge to a corner at Normal, 0.05 at Wild (0.2, 0.16 and 0.085 for Very gentle,
Gentle and Irregular). The wander
falls to zero at each crossing. Irregularity therefore winds between crossings instead of moving a river through
a corner where three hexes meet.

**River reach is a per-hex manual adjustment.** A river segment can guide how near the centre of its own hex the
underlying course comes, as a percentage of the way from the centre (0) to an edge (100). The guide concerns the
closest approach, not "any point of the river": every river that crosses a hex reaches
out to its edges, so a lower bound on the farthest point would never bite. Only hexes the river runs right through
(an entry and an exit edge) are guided: a spring, a mouth or a confluence hex sits where its own end puts it.
`holdToReach` adjusts the sampled underlying course before the style's seeded meander is applied. Its displacement
dies away at the hex edges, so crossings shared with neighbouring hexes do not move, while `riverWander` still
sets the final course's large and small winding. A displacement is refused where it would leave the land (or the
water the river runs into). If the bounds cross, the upper one wins.

## 47. Lakes carry their own irregularity; shores vary in strength; coast ink follows line weight

**Lake irregularity.** A lake hex may carry an irregularity for its own shore (`HexShape.irregular` on a Lake
hex). It beats the land hex beside the shore, which beats the map's lake default. Before this a lake shore
could take it only from a "shaped" land hex (plain Land beside a lake could not carry one) and the sidebar
offered nothing on a lake. The lake's reach into narrow land (a strip a hex wide between two waters) is still
held back, but its roughness is not: the same limiter had been scaling irregularity to almost nothing there,
so a hex between two lakes looked the same at Smooth and Fractured. Roughness keeps at least 55% of its size.

**Less regular roughness.** A lake shore was three cosines of fixed wavelength at constant strength, and each
sea-coast piece was normalised to the same peak. The lake's bands now drift in wavelength under a slowly
varying strength, and each coast piece takes a seeded gain (some nearly calm, a few bold), so shores have calm
and bold stretches rather than one repeating wobble.

**Ink.** The coastline's stroke width is `size * coastWidth * lineWeight`; the half of it outside the land is
counted in land shares (decision 45) with that width.

**Lake shores count too (addendum to 47).** A hex whose land share a lake shore sets (a Coastal Land hex with
less than 100% on a lake, or a lake hex given land) is now measured the way a sea-coast hex is. The lake body
is drawn, its area in the hex and the length of shore in it are measured, the water is taken as that area less
the outer half of the outline's ink, and the shore depth is moved until the hex shows its share (up to six
passes, `lakeAim`, `landFix` and `lakeFix` in `scene.ts`). Before this the lake shore only started from the
analytic depth and was then smoothed and roughened, which left hexes 14 to 70 points off their share. Not covered:
a hex with both sea and lake edges (the sea correction decides it), and a hex at 100% (or a plain Land hex)
beside a lake, where the lake still reaches a little way into it as part of its drawn shape.

## 48. More city sites, and land between two lakes

**Chosen.** `CitySite` gains `'landward'` (back from the shore, on the side away from the water),
`{ corner }` (toward a hex corner), `{ offset: { x, y } }` (a free point, in hex sizes from the centre, capped
at 0.8 so it stays in the hex) and `'neck'`. Every site still goes through `onLandNear`, so none can leave a
city in water.

*Land between two lakes.* A hex with lake on two edges that are not neighbours (`isLakeNeck`: opposite, or two
apart) is a strip of land between lakes, not a shore. The old coast logic summed the edge directions, which
cancel for opposite lakes (leaving the centre by accident) and lean toward one lake for the rest. `'neck'`
stands at the mean of the lake edges' midpoints: the centre for opposite lakes, shifted toward the pass for
lakes two apart. `'auto'` picks it when there is no river (a river city keeps its river or port site) and the
Inspector offers it only where it applies; an explicit `'neck'` on a hex that is not one falls back to the
ordinary resolution. Lakes on neighbouring edges are one bay and stay a coast. The lake edges are found from
the base layer in `citySite` (`lakeEdgesOf`), so `City` needs no new field and nothing is marked stale.
Only lake-lake necks are recognised; a strip between a lake and the sea is still a coast.

## 49. Isthmuses and straits are drawn at a width, and a land share tunes them

**Chosen.** An Isthmus and a Strait are set by how narrow they are at their thinnest, as a share of the
hex's flat-to-flat width: Very narrow 5%, Narrow 15%, Normal 30%, Wide 50% (`ChannelWidth`,
`CHANNEL_WIDTH_PERCENT`). The map-wide defaults are `HexDimensions.isthmusWidth` and `straitWidth` (Normal
both) and a hex overrides them with `HexShape.width`. The land share of decision 42 stays, as an
optional second setting (`HexShape.land`; map-wide `isthmusPercent` and `straitPercent`, absent by default):
the width fixes the shape, and a share set beside it tunes how much land the hex has, since the natural shape
for a width does not always look right. Unset, a hex's share for polity areas was that of a straight neck or
channel of its width (`channelAreaFraction`: 2/sqrt(3) of the width fraction; an isthmus counted that as land,
a strait counted the rest as its banks); decision 101 replaces it with the share the natural shape is drawn with. Old saves' 70%/30% isthmus and 40% strait defaults were never chosen
and load as unset.

**Tuning** (`fill` in `fixedLand`, solved by `fillFor` to the share). An isthmus cannot go below the land its width gives (cutting its flare back left pockets of water, a second
coast loop, and spilled land colour on some seeds); for a strait, less land cuts the banks back from the land-facing edges, so below the
land its width gives the channel is wider than set (the share asked for wins). More land deepens the land from
the land-facing edges. The share is exact within about a fifth of a percent in the range the width allows.

**Why.** A share cannot be drawn well for a hex whose neighbours vary. Solving the width that gave 40% land
for a strait with three sea edges (decision 42's fall-back to land "bands") drew the strait as land with a
bite out of it, or, with banks only on thin rims, as an all-water hex with polity colour stopping at its edge
(the bug that prompted this). A width is the same picture whatever the neighbours.

**Drawing** (`fixedLand` in `footprint.ts`). The hex is cut into six sectors from its middle. An isthmus is the
sectors of its land-facing edges plus a neck of the set width run from the middle to each of them: it narrows
to the width at the middle and opens out to the land at either end. A strait is the sectors of its land-facing
edges (its banks) less a channel of the set width run to every sea-facing edge, so that it narrows to the width
at the middle and opens to the sea; a bank with no bank opposite it is also given the depth that leaves the
width between it and the far edge, so the setting still shows. Nothing is left to pinch off: land is always
attached to a land-facing edge and water to a sea-facing one. The coast is traced round the result as before;
these hexes are no longer corrected towards a share by the ink/smoothing passes. Roughness along a neck or
channel is held to a quarter of its width (`narrowest` in `scene.ts`) so that a Very narrow isthmus is not
cut through nor a Very narrow strait closed. A strait's banks are coloured by the realm each bank grows from,
at the shape drawn rather than at the thin rim they used to cover.

**Also fixed.** Zero-thickness slivers left where cut polygons meet (`strips`, `grown`, smoothing corners)
were stroked in the sea colour and showed as a hairline across land; they are dropped. The water pieces of a
split hex are painted before its land pieces so a sealing stroke never overpaints land.

**What it costs.** Widths are measured between the coast lines, so the ink (about 2 to 3 px) takes up most of
a Very narrow channel or neck at small hex sizes: a 5% strait reads as a single dark line, which is what a
channel that thin is. Saved maps with the old 30% isthmus and 40% strait draw as Normal and differ from before.

## 50. Symbols stand on the land as drawn, and the map says where it gave something up

**Problem.** Drawn relief and vegetation were laid out about the middle of their hex, whatever of the hex
was land. A Coastal Land hex cut back to a small share (decision 39), or one whose land is concentrated
towards an edge, drew its peaks in the open sea beside the little land it had; under a realm's name they
were faded, so the sea showed a ghost of a mountain.

**Chosen.** Every symbol is tested against the land as drawn (the coast as smoothed and roughened, less
the lake bodies: the same outline the realm bands are clipped to). Where the set as laid out does not stand
on land, it is drawn smaller and moved towards the middle of the hex's own land, shrinking preferred to
moving far (`keepToLand`, down to 30% size); if even that will not hold all of it, the most symbols that fit
are kept and the rest left out. A symbol's foot stays in its own hex. Escarpments that would run over water
are left out. A hex that is land throughout draws exactly as before.

**Saying so.** The scene now lists its `compromises`: each hex where the drawing could not do what was asked
(here, symbols drawn smaller or left out), with what was given up and the rule that won. The Inspector shows
them for the selected hexes, or a count with a button to select them, and the hover line marks them.

**Also fixed.** `drawnLand` closed each coast that runs off the map back to its own start round the page.
With more than one such coast the closures overlapped and the even-odd fill swapped land and sea over part
of the page; the corners passed were also visited in list order, not in order round the page, so a closure
past the top-left corner crossed itself. It now joins rings properly: a coast that stops inside the map
(a reshaped hex cuts the coast into pieces) runs on into the piece that starts where it ends, and one that
leaves the map follows the page's edge clockwise to the next coast that comes back onto it. Realm bands,
clipped to this outline, change on maps that had either fault (bands along the map's edge now show
consistently).

**What it costs.** Fitting is searched once per traced coast and remembered with it, so a redraw that
leaves the coast alone costs about what it did. After a change to the coast, a 50 x 50 map with hundreds of
low-share mountainous coast hexes takes about 0.15 s longer to draw.

## 51. The drawing principles applied: names, islands, elevation marks, and the audit

The drawing principles at the head of this record were adopted after decision 50. This brings the rest
of the drawing into line with them.

**One land test.** `landAt` is now the drawn land: inside the sea coast as `drawnLand` traces it, or on an
island, and not in a lake's water. Before, it was the hexes and pieces the coast was traced from
(`traced.onLand`), which ignores smoothing and roughening by up to a third of a hex. City sites, realm
names, relief and the audit all use it, so a city near a roughened coast may sit a little differently.
For searches that test many points, hexes that are plain Land with plain Land all round, or open sea with
open sea all round, are answered without testing.

**Islands and straits.** An island hex's relief was not drawn at all, nor a strait's banks'. Both now are,
fitted to the island or the banks like any other symbols.

**Elevation marks.** The stacked marks of the marks relief style were drawn at the hex's middle and cut off
by the water drawn over a cut-back coast. They are fitted to the land like drawn relief and reported the
same way.

**Realm names.** A realm owns hexes, but its name is placed on the land it actually has: a point of an owned
hex that is drawn as sea is not the realm's ground. A small realm is named on its land only at a readable
size (three quarters of its natural size or more); failing that it is named beside its land, on open water
touching no land at all (before, only no other realm's hexes), and only then on its land in smaller type.
Every realm named other than as asked is reported against its hexes: its name running off its land, over a
city marker, or set closer to another name than usual, or the realm left unnamed (except a small realm in
auto mode, which is named only where its name fits cleanly, by design).

**The audit.** Each scene records the symbols it drew on land (`symbolsOf`), and `auditScene` reports any
point of one over water (`symbol-over-water`). A test runs it over ragged, cut-back coasts in both relief
styles.

**What it costs.** Re-placing realm names (after a change to who owns what) on a 50 x 50 map that is almost
all low-share coast took 0.44 s against 0.24 s; maps with more inland or open sea cost less. Other redraws
are unchanged.

## 52. Painted island outlines, lake bodies and river mouths agree on dry ground

**Problem.** The common land predicate still approximated islands by their layout ellipses. Four recorded
symbol points in a pinned fractured-island example were on painted sea while the old audit passed them.
Inside a lake, the predicate ignored curved island path commands entirely. Rivers retained a separate
nearest-segment side test, which gives the wrong answer just beyond a sharp spit tip.

**Chosen.** Island queries use their actual painted paths, including skerries; lake queries flatten curved
paths and follow the nonzero rule used to paint their bodies, then exclude the painted islands. Rivers
use `landAt`. Island paths are reused within a build, and each island predicate rejects queries outside
its bounds before testing its rings. No land geometry or saved setting is changed for decoration.

**Also fixed.** Glacier shelf shading had a glacier-hex clip but lacked the coastline clip: 2,283 opaque
pixels in the pinned example extended into water. It now has both. Coast patches donated by a lake hex
were painted in lake colour after the lake body, producing water where the shared outline said land.
They now take shore ground and are painted before lakes and islands. The corresponding image check had
13 disagreeing probes before the fix. Escarpments test their stroke width and a clearance from coast ink,
including intermediate points along long strokes; wholly inland hexes retain the existing fast answer.

**Cost.** Outline queries have more work than ellipse queries; path reuse and bounds rejection avoid
repeating island construction. The test-only pixel masks add no app work.

## 53. Gentle rivers retract only wander that introduces a sharp kink

**Problem.** On the pinned winding route, 80 of 400 seeds turn at least 60 degrees between samples after
meander. None leave the route's hexes. Disabling meander in a diagnostic version eliminates every failure:
the individual clearance limits introduce the kinks, not the underlying curve.

**Chosen.** At Gentle and Very gentle, retract wander in the neighbourhood of a failing bend, using a
smooth shoulder. Already valid courses remain byte-for-byte unchanged (320 of the original 400).
The other wander levels retain their deliberately deeper bends. The regression keeps the original
60-degree threshold and checks all 400 seeds; a further 4,000 runs across both gentle levels passed.

**Cost.** A linear scan of gentle courses, with local retries only for failing bends. This is a correction
to meander, not a change to the owner's route or reach settings. The finite sweep does not prove every
possible route and seed safe.

## 54. River and water names cannot escape their feature onto the wrong surface

**Problem.** A long name for a one-hex sea fell back to extending its text spine across surrounding land.
Water-name searches knew hex types but not the fitted coastline; river names avoided lakes but not open
sea. Both could silently lose a requested name.

**Chosen.** Preserve existing placements whose complete lettering boxes fit the correct drawn surface.
Otherwise search with the shared land predicate and reject unsafe final glyph boxes, including their
rotated corners. Reuse cached results while their land dependencies are unchanged. An unplaceable requested
river or water name is left out and reported against its feature's hexes. The audit also checks river names
over water and city marker centres over water. City names may legitimately sit over sea and get no blanket
land-only rule.

**Cost.** Additional land probes when names must be placed; warm placement results remain cached. Omission
reports currently associate results by name text, so features with duplicate names need identity-based
reporting in a follow-up. The image audit remains separate from these placement predicates.

## 55. Readable fitting and useful reports, with the owner's clarification

**Chosen by the owner after viewing before/after images.** Raise the relief fitting floor from 30% to 50%.
Keep fewer readable symbols when the complete set cannot fit. This changes correctly drawn tiny symbols
only with the owner's express approval; it does not enlarge or move the land. Existing shrinking, own-hex
movement and omission behaviour remains, with the higher floor.

**Reporting.** A complete set drawn smaller is an `adaptation`; omitted content and existing unspecified
notices are `loss` by default. The Inspector counts them separately, groups equal selected notices while
retaining all hexes, and puts losses first. It suppresses no losses with a frequency threshold.

**Owner clarification.** Moving cities onto dry ground is routine placement, not a correction or compromise
worth reporting. Escarpments should clearly lie within land; stopping them at water is likewise not a
routine warning. No city-movement or escarpment-omission notices are added. Tests preserve this distinction.

**Cost.** Some tiny relief is omitted sooner; this is the chosen readability trade-off. Grouping is in the
Inspector and leaves every affected location available in scene metadata. On 200 seeded isolated fractured
island examples with 10% land, the old floor retains 187 mountain symbols in total and the new floor 10;
the owner was told of this substantial omission cost. The floor is shared by relief/vegetation fitting
and elevation marks.

## 56. Seeded render fixtures and an independent painted-water check

**Chosen.** Render tests that previously inherited `createMapState`'s random/time-derived ID use a test-only
deterministic factory; explicit per-test seeds still override it. The gentle-river regression sweeps seeds
instead of hiding the failure behind a single passing one. No production seed generation changes.

`test:drawing-pixels` renders small pinned scenes in Chromium and separately renders their geography with
white land and black water. It checks symbol probes and name boxes against these painted pixels, the
glacier shelf's actual painted coverage, and predicate/paint agreement. Its `--source` option demonstrates
that the check fails on the archived baseline. The mask follows the actual painter, without calling the
placement predicate to determine pixel colours.

**Limit.** These checks cover the repaired cases; they are not yet an independent raster check for every
one of the seven drawing principles. Borders, ripples, sea ice, complete city-marker footprints, ownership
proportions and edit-locality still need dedicated finished-picture checks. This work does not claim those
requirements complete.

## 59. Reuse exact ice drawings and validated symbol fits

**Problem.** Warm populated redraws rebuilt nine glacier-margin and sixteen pack-ice components.
Returning to an already checked terrain revision also replayed every land probe for unchanged fits.

**Chosen.** Keep glacier-margin geometry and pack-ice primitives in separate content-keyed caches,
each limited to four entries and an estimated 8 MB including keys. Clear both when the map/size scope
changes; `cache: 'off'` bypasses them. Keys include geometry inputs and, for pack ice, colours and drawing
policy. Symbol fits remember at most four exact terrain revisions on which all probes were validated.
New revisions still replay every probe, including failed placement candidates. No approximate land grid.

**Cost.** Up to 16 MB additional estimated cache capacity; the symbol cache retains its existing 16 MB
limit, accounting for the extra references. Pack weights use four times serialized length on misses;
glacier weights count path commands, slivers and chain edges. These are estimates, not measured heap
bounds. Failing-before tests check repeated work and compare edited scenes with uncached reconstruction.
The historical pre-rebase 100-run comparison against `6786d4a` passed every unchanged performance gate: warm/ownership/shore
medians improve about 32/31/26%, and cold median costs 0.7%.

## 60. Treat enclosed seas as holes in the mainland

**Problem.** With only closed coasts, the even-odd land outline omitted the surrounding page when land
lay outside the outermost shore. Separately, aggregate fitting assigned the surrounding mainland's area
to an enclosed water boundary, inflating a one-hex sea into a map-sized circular coast. Predicate/paint
agreement alone could not catch this shared error.

**Chosen.** Use source-chain signed area (land lies on its right) to distinguish water and land enclosures.
When only closed shores exist and the outermost encloses water, include the page in the even-odd mask.
Only positive land enclosures qualify for island total-area fitting. Coupled fitting uses the same page
outline. No owner's data, intended dimensions or correctly drawn island styling changes.

**Validation and cost.** Two failing-before topology/extent tests pass. An independent painted-pixel sweep
checks mainland, enclosed water and nested land-island hex centres across 200 seeds and three styles:
400/600 baseline cases fail and none fail after correction. Existing 200 island-seed and 150 ordinary-coast
area checks remain unchanged. Added work is a source-chain signed-area sum. This removes a misrendering; it is not an unapproved style change.

## 61. Remove fold-back loops in open coasts as well as closed ones

**Problem.** Main's revised default coastal share exposes a 5%-land Parchment fixture whose open coast
has five self-crossings. The existing loop cleanup only handles closed coasts; fitting then cannot
reach the requested share without making those crossings worse.

**Chosen in the follow-up PR.** Extend the same crossing detection to open chains. Remove their
fold-back detour while retaining both endpoints; never turn that detour into a separate island. Keep
closed-chain behavior and every crossing/distortion guard unchanged. The targeted failing-before test
now passes with zero crossings, and its share-loss notice disappears. No additional fitting rounds or
relaxed movement guards were retained.

**Continuation validation/cost.** The single pinned Parchment fixture paints 4.635% versus 5% requested.
The full unchanged 150-case raster area gate passes after the connected repair in §62; 600 enclosed-sea
and 200 island checks also pass. Open chains incur a bounded crossing-index scan.

## 62. Finish an unsmoothed coast only when it misses the share gate

**Problem.** Classic `coverage-1` at 20% paints 21.275% with the new surrounding coastal default of 80%.
Its initial three cut-fitting candidates stop without a coupled smooth solver to finish the residual.

**Chosen.** Permit one fourth measured candidate only for unsmoothed coasts whose largest measured
share error still exceeds one percentage point after candidate three. Keep the lowest aggregate squared
error, existing movement brackets, all guards and the original three-candidate path for already faithful
coasts. The pinned fixture paints 19.211% and no longer reports a share loss. This changes a misrendering,
not an approved coastline style; no owner data or tolerances change.

**Cost.** At most one additional whole-coast trace/measurement on an affected cold coast. Warm builds
reuse exact coast geometry. Two numerical regressions independently sample final land plus ink; the
full 150-case raster sweep reaches a maximum error of 0.789 percentage points. Roughness, narrow tips,
ink and accurate area can compete; no crossing/passage guard is loosened to force exact convergence.

## 65. Use one land colour by default and continue retiring Classic

**Owner direction.** Coastal land should use the inland land colour by default. All preset defaults
now use `land: 'uniform'`; an explicit coastal-band override remains a supported choice. Land shares,
coast geometry and saved owner data are unchanged.

Classic's unsmoothed hex-based coast exposes abrupt cut joins at low shares. New users already start
in Parchment. The owner does not need Classic's look kept: retire it outright, mapping saved Classic
choices to the default preset (`docs/simplification-next-steps.md` §4.5).
Do not silently restyle saved choices or disable its correctness checks. See the owner-review note
in `docs/drawing-work-plan.md`.

## 66. Clip border-notch land to the finished coast

The owner's visual review rejected detached land fragments at the synthetic fixture's page edge.
A Canvas render confirms the same defect as the SVG image: land fills for rim notches bypass the
finished-coast clip used by ordinary land. Group those fills under the same even-odd land clip for
component coasts. This removes painted spill without moving the coast or changing owner data.
The updated uniform-land Canvas preview shows the correction; the earlier passing suite is not
claimed as validation of this later visual fix.

## 67. Repair loop joins after tangential skew and continue coasts smoothly to the page

**Evidence.** The gridded review exposed a pinched 5%-land cape and an abrupt straight page-rim
projection. History review ruled out repeating broad curvature limits, extra solve rounds and
previously failed smoothing variants. Stage tracing located the cape's sharp join after loop
removal; seeded skew sharpened it further, explaining the failed pre-skew fillet.

**Chosen.** Round only surviving loop-removal joins after skew and before the existing area fit.
Reject fillets crossing retained coast or entering protected passages. Continue open component
coasts tangentially into their existing page endpoint, falling back to the previous projection
when a crossing is detected. Install that extension before fitting so every layer uses it.
No owner data, solve rounds, crossing guards, area threshold or 50% symbol floor changes.

**Evidence/cost.** The guarded gridded render matches the reviewed proposal and paints 4.6726%
for 5% requested. All 150 coast-area, 200 island and 600 enclosed-sea cases pass.

## Shared sea and lake coast geometry; land in shore-adjacent Sea hexes

**Chosen.** Trace land against both sea and lake water, shape those shores with the same
`shapeCoast` / `coastGeometryOf` pipeline, and fit their final land areas together with
`fitCoastAreas`. Remove `lakeBodyPath` and the lake-only correction passes. Water identity
remains available for lake colours, names, islands, masks and realm bands. Lake outlines may
change; their old extra smoothing and outward bulges are deliberately removed. Hex-edge styles
now apply equally to lakes. Lake classification as Coastal Land is handled separately upstream.

**Settings.** Preserve the existing Lake land default (currently 10%), concentration and
irregularity precedence: the lake's explicit override, the adjacent land's explicit override,
then the lake default. Sea gains `hexDimensions.seaLandPercent`, default 0, and per-hex land
and concentration overrides. It grows shore land from a whole-land neighbour, never an isolated
island in open water. Sea irregularity still comes from its land neighbour. Saved maps without
the field load at zero. Surface totals and physical prompt context use grid-aware sea shares.

**Coupling.** A water hex growing land owns its initial boundary; independently cutting its
land neighbour would strand that strip. The shared fitter measures both requests together,
counts coastline ink once, preserves constrained passages, and reports achievable coverage.
A land hex between sea and lake has one target measured against both shores. A lake-specific
curve fix must now be expressed as a shared geometry fix or an explicit input policy; it must
not introduce a second curve builder. The parity tests in `test/sharedShorelines.test.ts` exercise
matching sea/lake policies through scene construction as well as through the geometry routines.

**Validation and cost.** The complete Node suite, TypeScript checks and production build pass.
Standalone SVGs were rendered with librsvg for visual inspection. The subsequent Chromium
checks passed: all 18 Canvas/SVG coastal-paint cases, 21 finished-picture fixtures, 150 area
cases, 200 island cases, 600 enclosed-water cases and 400 river seeds, with unchanged thresholds.
Dense maps containing many small lakes
have higher cold-build cost from fitting all shore shares together; exact cached redraws reuse
those results. This change does not claim to solve that remaining performance cost.


**Cumulative distortion.** Area fitting bounds total distortion from the pre-fit outline (at most 2×
stretch, a turn of about 50°) as well as each step, so repeated fitting cannot stretch small details
into spikes (`test/coastFitDistortion.test.ts`). Local lake-passage controls apply to the shared shore.
Concentrated water holes remain water even when their hex centre lies outside them.

## 70. The whole-map overview never holds up an edit or a view

**Problem.** A new map's first sharp frame kept its worker job open until the whole-map overview
was also rasterized (about 240 ms at a whole-map view, about 600 ms zoomed in at the 4-megapixel
cap). The painter keeps one job in flight, so an edit or a pan made meanwhile waited behind it.

**Chosen.** The sharp frame releases its job. The overview follows in the background, in bands of
about one megapixel, each rasterized on its own canvas and composited, with a yield before each
band so a newer build or view runs first; a newer map abandons it. When the sharp frame already
contains the whole map, the overview is copied from it rather than painted again. The overview
is a navigation stand-in, replaced by a sharp frame once a view settles, so its pixels are not
held to exact equality: banding changes about 0.03% of overview pixels at band edges, and the
copy differs by resampling (mean 2.8/255 on the fixture), being taken from the sharp frame itself.
The sharp frame of the current map is drawn over an overview that is still being replaced.

**Cost.** Banding adds about a third to total overview work (measured 595 → 792 ms at 4 MP in
four bands), spent only when nothing else is waiting; the longest uninterrupted stretch falls
from about 595 to about 225 ms.

**Evidence.** `scripts/render-interaction-study.mjs` drives the production worker and painter
policy (headless software raster, 50×50 all-layer fixture, eight unique ownership edits, two runs
each against `4e0db34`). A pan 50 ms after an edit's frame: median 430–438 → 250–254 ms at a
whole-map view, 514–557 → 153–195 ms at 1×. Edits every 1.2 s: none superseded, against up to
three of eight before (worst 4.8 s). Single-edit latency is unchanged (build and paint dominate).
Edits faster than one build (every 0.4 s) show nothing until they stop, in both versions: every
new edit discards the build in progress. That needs faster builds, not scheduling alone.

## 71. Reuse each river's name while nothing that can reach it has changed

**Problem.** River names were cached as one family whose key held every realm name and city
marker. An ownership edit anywhere moves realm names, so every edit re-searched every river: on
the 50×50 all-layer fixture, about 52 course preparations and 4,400 candidate positions per edit,
the largest part of an edit's build.

**Chosen.** Inside a family search, each river is reused under its own key: its course, width,
profile, text, size and face; a snapshot of what the lake and land predicates and measurements
depend on (measure epoch, lake shores, land revision); and only those obstacles, earlier river
names and other courses that can reach its probes. Every probe lies within the largest type's
lift plus half a line of the course's bounding box, and other courses matter only a little farther
out; anything beyond cannot change a single probe, so the result is identical. Earlier names are
still pushed in order, so a re-searched river that moves its name re-searches any later river
that name can reach. Reusing a previous winner without these inputs remains rejected.

**Cost.** A second bounded memo (1,024 entries, about 8 MB estimated, keys charged) and one key
serialization per river per family miss. The family cache in front of it is unchanged.

**Evidence.** Random obstacle moves, additions and removals equal a fresh search at each of 40
steps; scene rebuilds after ownership edits equal uncached rebuilds. Production worker study
(50×50, eight unique ownership edits, two paired runs against the previous commit): worker build
median 660–675 → 104–107 ms, edit to sharp frame 1017–1033 → 466 ms; 378 river reuses and 38
searches across the eight edits. Land edits still invalidate every river, because the land and
lake predicates are keyed globally.

## 72. Repainting only changed regions: evaluated, not adopted

**Tried.** After an edit at an unchanged view, diff the old and new scenes (64-bit content
hashes, an order-preserving list diff, refinement to changed group children, clip subpaths and
path subpaths, measured text extents) and repaint only the changed device tiles. The patch and its
browser check are kept outside the repository; this records what they showed.

**Chromium's 2D canvas is not bit-stable, so exactness constrains the method.** Measured in headless
software raster: a path rasterizes slightly differently on its first use than on later uses of the
same `Path2D` (tens of bytes, ±1–2); repainting a used canvas differs from a fresh one; and any clip,
even one rectangle, changes antialiasing inside it (up to ±69 at edge pixels), and still by ±2–4
with a 128-pixel margin. Repainting under a clip therefore cannot reproduce a full repaint. A fresh
full-size frame that skips prims reaching no dirty tile, keeping the full frame's clips, and copying
only those tiles does: every byte then equals a full repaint (first-use or later-use value) for all
ownership, terrain, elevation, vegetation, city and name edits on the 50×50 fixture at three views.
Four small edge-fixture cases (up to ±7 near islands) were left unexplained.

**Why it was not adopted.** Prims that span the map (coast clips, sea bands, ripples, realm border
bands) reach every dirty tile, so the skipped work is small: on the 50×50 fixture at a whole-map
view a partial frame cost about 190–250 ms (diff 40–55 ms after hashing optimizations, plus the culled
frame) against 280–330 ms for a full one, and it was slower than a full frame at 1× and 2×. At most
about a fifth of one edit's wait, only when zoomed out, for a diff engine, persistent canvases and
an extra verification harness. The remaining paint cost is the fixed cost of those map-spanning
prims; reducing it changes antialiasing at edge pixels (the clip effect above), so it needs an
explicit tolerance decision rather than a byte-equality gate.

## 73. Paint realm bands once and composite rivers through the water clip

**Problem.** Paint is now most of an edit's wait, and two map-spanning items dominated it. A
see-through realm band was stroked twice along its whole outline: once in the even land colour,
once in the translucent realm colour on top. Rivers were each clipped against the full page-less-
water outline (about 15,000 commands), costing about 33 ms against 3.5 ms unclipped.

**Chosen.** Where a realm has no glacier under its band, the band is one opaque stroke of its
colour already composed on that even ground (`mix(land, colour, alpha)`); a realm with ice keeps
the two strokes, so ice keeps its own shade under a see-through band. Rivers are drawn as one
composited layer and cut by the water outline once (the existing composite path).

**Quality.** Owner's criterion: no visible change, judged against the renderer's own variation
rather than byte equality (Chromium's raster already varies between repaints; see §72). On the
50×50 fixture, against the previous commit through the production worker: at a whole-map view
31,165 of 1,260,000 pixels change, 22,543 of them by one level, 278 by 16–21 and none by more; at
1× 62,277 change, 57,507 by one level and none by more than 22. The larger ones are single
antialiased pixels on band inner edges, where the band meets ground of another shade, and on river
edges. Enlarged side-by-side images show no visible difference. The drawing pixel checks
(`test:drawing-pixels`) pass, including the 400-river sweep.

**Effect.** Production worker study, two paired runs: sharp-frame paint median 471/414 → 366/306 ms,
edit to sharp frame 583/549 → 499/433 ms. SVG output gains the same single band stroke.

## 74. Hand unchanged outlines back to the painter as the same arrays

**Problem.** The painter caches compiled `Path2D`s and bounds by array identity. Each build created
new arrays for outlines whose content had not changed (realm bands and grounds of untouched realms,
the rivers' water clip, concatenated lake and page clips), so after every edit the first paint
recompiled them: on the 50×50 fixture first paints of an edited scene ran about 60–70 ms slower than
repeat paints of the same scene.

**Chosen.** After a cached build, each path or clip of at least 64 commands is looked up among the
previous scene's by a short key (length and three sampled commands) and replaced by the earlier
array only if every command is equal, number for number. Scene content is therefore unchanged; a
scene built with caches off is not touched. Only the previous scene's arrays are kept; a map change
clears them.

**Evidence.** Uncached and cached scenes still compare equal after an edit. After a ten-edit chain
the painted pixels equal the previous code's exactly. Production worker study, two paired runs
against the previous commit: paint median 308/346 → 238/291 ms, edit to sharp frame 466/533 →
383/434 ms; build time unchanged within noise.

**Rejected on measurement.** Batching consecutive same-style fills into one path did not help:
the clipped groups' children already draw onto a composited layer, and drawing merged shapes
straight through a complex clip instead was ten times slower (151 against 15 ms for the
8,583-child land group). Batching on the layer gained nothing with cached paths and cost about
250 ms more on a fresh scene. Compositing every clipped group was also slower.

## 75. Border-band paint: alternatives measured and rejected

Composited layers for realm border groups (outermost, innermost or every clip) made the 50×50
whole-map paint slower: 281–348 against 246 ms. Thinning the band line's near-collinear points
(Douglas–Peucker at 0.006 hex sizes; 69,769 → 24,398 commands) cut that in-page paint to 198 ms,
but two paired production-worker runs showed no reliable gain (paint medians 236 → 237 and
240 → 218 ms; edit to sharp frame 366/367 → 383/381 ms), presumably because unchanged band
outlines are already shared and cached across edits (§74). It also moved inner band edges by up
to 32 levels at 1×, so it was not adopted.

**Paired retest.** Band-line thinning was later adopted under §76 after the paired review in §84.

## 76. Pictures are held to no visible change, not byte identity

**Chosen.** The owner's criterion for pictures is no visible change. `scripts/visible-change.mjs`
measures it: each changed pixel is compared with the colour range its 3×3 neighbourhood spans in the
other image, both ways, so edge antialiasing, first-draw raster variation and moves of up to a pixel
fall below it. A change is visible when more than 0.01% of pixels differ by more than 32 levels on
that measure, or more than 1% by more than 8. `render-coast-validation.mjs` and
`render-incremental-validation.mjs` now fail on visible change instead of any changed pixel. Scene
equality stays required where it is a correctness rule (cached against uncached builds);
`render-coast-validation.mjs` requires equal scenes only with `--exact-scene`.

**It is a screen, not a verdict.** A difference it passes can still matter: the river reshaped round
Mocktown 27 (§77) passed it. When a change moves any drawn element by more than the geometry the change
itself moves, find out why before accepting it; it is usually a discontinuity in the drawing, and the
fix belongs there.

## 77. Fit coasts with 64 measuring lines per hex, and keep rivers and frontiers stable when the coast moves

**Chosen.** `fitCoastAreas` measures each hex with 64 scanlines (`FIT_COVERAGE_LINES`), not 128. The
scene's reported land shares are measured at 96 lines, as before.

**Effect.** Pilot (Node, cold, geography only, 40×40 `populated`): build 8.2 → 7.3 s, `fit.measure`
2.3–2.6 → 1.7 s, with the same 8 solver rounds and about 887 iterations. Most of the remaining
measuring cost is per-call setup, so fewer lines save little more (32 lines: 1.3 s). The fitted coast
moves by at most 0.0068 hex sizes; land shares change by at most 0.19 points.

**What it exposed.** The first comparison against 128 lines showed visible changes far larger than the
coast's own movement, in two places where the drawing turned an imperceptible coast change into a
large one. Neither came from the line count itself; both happen on any coast refit (an edit, a preset).
- **Frontiers.** A border between realms that ends on the coast starts from the point where the coast
  passes the hex corner, and its wander was seeded by that point's exact coordinates. Any refit moved
  the point by a hair and redrew the whole wander, up to 5 units at the frontier and colour spilling
  into the neighbouring hex. On `main`, changing one hex's land share moved frontier points 5 hexes
  away. The wander is now seeded by the edge's grid corners, which never move. (Fading the wander out
  towards the coast was tried and dropped: it drew straight borders, which the owner rejected.)
- **Rivers past cities.** A city icon beside a river is set so its edge just touches the bank at the
  nearest river sample, so that sample lies on the icon's clearance to within rounding. Whether the
  river was then smoothed into a bow round the icon (and the smoothing reaches about 16 samples either
  side) was decided by that rounding: on the populated fixture two of three such rivers bowed and one
  did not, and a refit could flip it (2.7 units along the whole river, the icon then hugging the bank).
  Only an intrusion deeper than a millionth of a hex now bows the river.

**Pictures.** With both fixes, no drawn element moves by more than a quarter of a unit between 128 and 64
lines on the populated fixture, labels by less than 0.003. Against `main`, the fixes themselves change
the picture once: frontiers that end on the coast take a different, stable wander (see also §79), and the two rivers
whose bows were set off by rounding (Mocktown 13 and 29) keep their own course instead of being
smoothed past the icon; the owner prefers them so. Their own course has sharp bends (sharpest turn 35° → 62° and 46° → 68°), as
most rivers on `main` already do (9 of 13 on the populated fixture turn by 58–81° somewhere, none near a
city); the rounding-triggered smoothing had hidden them on these two. Those bends are a separate
weakness of the meander, not of this change.

## 78. A stand-in picture while the coast fits: rejected as a workaround

**Tried.** While a build's exact coast was not yet cached, the worker first built and painted a
stand-in (the coast traced and roughened, without the global share passes or the fit), then built and
painted the exact scene. Through the production worker on the 50×50 fixture the first picture came
after 2.6–2.9 s instead of 8.4–9.1 s on opening and 1.5–2.1 s instead of 6.9–7.7 s after a land edit;
the exact picture came 0.5–0.9 s later than before. The stand-in's land shares were off by about 10
points on average (up to about 33), so coasts visibly changed shape when the exact picture replaced it.

**Rejected.** The owner regards it as an undesirable workaround: it hides the cost of the coast fit
behind a wrong picture instead of reducing it, and makes the exact picture later. It was built and
removed (see the history of this entry's PR). Making opening and coast edits fast means making the fit
itself cheaper (the solver, the global share passes and each measurement's fixed setup), not showing
something else while it runs.

## 79. A thin coastal strip of a mainland-with-islands hex is drawn as the realm it lies along

**Problem.** A mainland-with-islands hex keeps land in the sectors facing land. Where that land faces
another realm's hex and the coast has cut it down to a strip along their shared edge, the strip took its
own hex's realm colour and the frontier ran along the edge beside the coast: it read as an enclave of
one realm inside the other. On `main` this showed or not by chance (the frontier's random wander
sometimes bulged over the strip); with a stable wander (§77) it showed at hex 87 of the populated
fixture, a yellow wedge in pink.

**Chosen (owner's decision).** The owner's rule is general: there are never enclaves or exclaves within
a hex. Land of a mainland-with-islands hex facing another realm's land is drawn as that realm's where
colouring it as its own would leave an enclave: where it does not reach its own realm's land over drawn
land, or is only a thin strip (under a quarter of its sector drawn as land), which reads as an enclave
even where it touches its realm at a point. The border between the two hexes then runs through the split
hex's centre instead of along their edge, so the realm across takes that land and the frontier meets the
coast. The same decision sets the colour of the split hex's pieces in the fill and tint styles, so
grounds, bands, fills and the frontier agree. Ownership in the map data is unchanged.

**Checked.** Sampling the drawn realm colours on the populated fixture in seven styles (classic,
parchment, atlas, night, frills, and parchment and atlas with hex coasts): `main` leaves 27 patches of a
realm's colour cut off against another realm; this change leaves none, apart from two whole hexes their
realms own apart from the rest in the map data.

**Effect.** On the populated fixture it applies at hexes 87, 282, 392 (three edges) and 917; hex 794,
whose land facing realm A is a whole sector, is unchanged.


## 80. The coast fit made cheaper without changing what it computes

**Problem.** With the stand-in rejected (§78), the only route to a faster opening is a cheaper coast
fit. A CPU profile of a cold build of the populated fixture put most of the fit's own time in four
places: the per-scanline union of land and coastline ink (a comparator sort of every run on a whole map
row, then each hex walking that row from its left end), the nearest-edge clearance of each silhouette
point (a `Set` per spatial cell and a `Math.hypot` per candidate), the solver's new-crossing check
(string grid keys and a tuple per segment), and the spline support (four tuples per coast point per
round), with about 0.8 s of garbage collection behind the allocations.

**Chosen.** Each is replaced by an equivalent that computes the same numbers. The scanline union sorts
run starts and run ends separately in native typed arrays and sweeps them (a start equal to an end comes
first, so touching runs still join), is stored flat, and a hex finds its first run by bisection;
skipped runs end left of the hex and added nothing. Clearance compares squared distances and takes one
root of the nearest; candidate lists keep first occurrences in bin order, as the `Set` did. The
crossing grid uses numeric keys and flat (ring, index) pairs in the same order; even-odd point tests
sort with a typed array; spline support is two typed arrays per ring.

**Checked.** The serialised scene is byte-identical (SHA-256) to the parent commit on the populated and
mixed fixtures; typecheck, the fast suite (581 tests), the slow suite and `test:drawing-pixels` pass.
In a rotating five-pair cold-build comparison of the populated fixture (Node, separate processes) the
parent took 4,609–5,047 ms (mean 4,834) and this change 4,239–4,502 ms (mean 4,354). Per pair the
reduction ranged from 4% to 16% (median 11%). Absolute times are not comparable with other entries;
see §82.

**Still open.** The fit's arithmetic is unchanged, so its remaining cost is real work: the global share
passes' traces, ten solver rounds and their measurements, and the clearance queries. Further gains need
fewer rounds or measurements, which can change the coast and must be judged by §76.

**Per-change review.** See §84 for the independent clearance-mark and spline-support ablations.

## 81. The coast fit's setup and checks made cheaper, results unchanged

**Problem.** After §80 a cold build still spent time on work that does not affect its result. Each trace
re-flattened every other coast path for every open coast it extended to the page rim, whether or not
the curve's crossing check ran, and that check tested every segment of every coast. Each coverage
measurement built a tuple per edge per band and nested point objects per ink segment, and each scanline
copied its runs into new typed arrays to sort them. Every solver trial recomputed the segment lengths of
the unchanged rings it compares against, and the solver kept its bends as tuples.

**Chosen.** Each is replaced by an equivalent computing the same numbers. Rim extension flattens the
other coasts only when a curve is checked, once per path array (a `WeakMap`), and skips obstacle
segments whose bounding box misses the curve's step, which cannot cross it. Coverage bands store edges
as flat point pairs and ink quadrilaterals as flat coordinates; scanlines collect runs in reused
growing `Float64Array` buffers sorted in place. `distorts` reads segment lengths cached per ring; bends
are a flat `Int32Array` and the solver's dot product a plain loop in the same order.

**Checked.** The serialised scene is byte-identical (SHA-256) to `main` on the populated and mixed
fixtures; typecheck, the fast suite (581 tests), the slow suite (14) and `test:drawing-pixels` pass.
Cold builds in rotating pairs against `main` (Node, separate processes): populated, ten pairs, mean
4,913 ms before and 4,139 ms after, every pair faster, the per-pair reduction ranging from 6% to 23%
(median 16%); mixed, five pairs, 3,238 ms and 2,932 ms (about 9% less). These figures are for the six
changes together: intermediate batches did not resolve their separate effects (§82).

**Per-change review.** See §84 for the scanline-buffer and flat-bin ablations and bend-list cleanup.

## 82. How rendering performance is measured and reported

**Problem.** Cold builds of the same code on the same container varied between sessions by over a
third (the populated fixture took about 4.4 s on one day and 6.0 s the next) and within one batch by
about 10% (4.5–5.0 s). Absolute timings in this file and in `docs/render-performance-next-steps.md`
therefore describe the machine's state as much as the code: figures taken on different days, or one run
per variant, cannot be compared with each other.

**Chosen.** A performance claim is a paired comparison: the before and after builds run alternately, in
separate processes, in one session, and the claim reports per-pair ratios (range and median), not only
means. Absolute milliseconds are given only as context for that session. With five pairs, differences
under about 3–4% are not resolved; a change claimed below that needs many more pairs or a
machine-independent measure of work. Earlier figures recorded from single runs (the 27 October pilot
in the performance plan, including its line-count table) are indicative only.

**Tool.** T1 is implemented by `npm run perf:compare -- --base /path/to/base --root .`.
It uses alternating fresh-process pairs and reports a 95% bootstrap confidence interval of the
median new/base ratio for wall and process CPU time. See §83 for calibration and precision limits.

## 83. Paired construction comparisons with bootstrap confidence intervals (T1)

**Chosen.** `npm run perf:compare -- --base /path/to/base --root .` compares two source trees using
one fresh Node process per sample, through the current construction runner. It checks scene hashes
before warm-up, discards two warm-ups per tree, and runs 30 measured pairs by default (`--pairs`
changes that). Odd pairs run base first; even pairs run new first. `--kind mixed` selects the smaller
fixture. `--allow-different` permits intentional differences between trees; a changing hash within
either tree still fails. Failed samples stop the run and preserve the samples and error collected so far.

The table reports the median new/base ratio, a 95% percentile bootstrap interval from 10,000 resamples
of the pair ratios, their minimum and maximum, context-only base/new millisecond medians, and
`faster`, `slower` or `unresolved`. The bootstrap seed is fixed at 131 so saved samples reproduce the
statistics. Reports retain preflight, warm-up and measured samples, chronological order and measured
pair ratios in `work/perf-compare/<timestamp>.json`.

The construction runner also records `cpuMs` from user plus system `process.cpuUsage()` around the
build, excluding serialization, beside wall `ms`. Both measures receive the same statistical analysis.
The npm command uses `node --import tsx`; subprocess output uses temporary files, since this sandbox
blocks the sockets used by the tsx CLI and child-process pipes.

**Calibration, 2 November 2026.** Node v24.19.0, populated fixture, the construction runner's default
options, workspace renderer at `04388cc`, no concurrent tests or profiling. Each batch ran serially in
one session, with fresh processes and the prescribed preflight, warm-ups and alternating order.

| Comparison | Pairs | Measure | Median ratio | 95% interval | Full interval width / half-width | Verdict |
|---|---:|---|---:|---|---|---|
| Working tree against itself | 30 | Wall | 1.0037 | 0.9831–1.0182 | 3.511% / 1.756% | unresolved |
| Working tree against itself | 30 | CPU | 1.0068 | 0.9902–1.0234 | 3.319% / 1.660% | unresolved |
| Working tree against itself | 100 | Wall | 1.0020 | 0.9942–1.0112 | 1.692% / 0.846% | unresolved |
| Working tree against itself | 100 | CPU | 0.9985 | 0.9899–1.0090 | 1.909% / 0.954% | unresolved |
| Scratch copy with busy loop | 100 | Wall | 1.0206 | 1.0094–1.0341 | 2.469% / 1.235% | slower |
| Scratch copy with busy loop | 100 | CPU | 1.0278 | 1.0175–1.0401 | 2.265% / 1.132% | slower |

Both self-comparison intervals contain 1.00. Thirty pairs did not reach even the suggested ±1.5%
width, so the pair count was raised directly to the brief's limit of 100. That gave the narrowest
self-comparison interval tested, but **100 pairs did not establish precision sufficient for 0.5%
changes**. No pair count up to that limit is claimed to resolve them here. CPU time was slightly
steadier at 30 pairs, but wall time was steadier at 100; CPU did not consistently reduce noise.
These interval half-widths describe width, not symmetric bounds around 1.00.

For the positive control, only a scratch copy of `buildStaticScene` received a busy loop at its start,
lasting 31.903 ms (1% of the 100-pair self-comparison's 3190.3 ms base median). The measured wall
slowdown was 2.06%; its interval includes the intended 1.01 ratio and excludes 1.00, so the tool detects
the slowdown. CPU also reports slower. All scene hashes matched throughout all three batches. The
loop and scratch copy were removed; no renderer change is part of T1. This calibration supports the
direction verdict, not a claim that the injected loop's cost was estimated exactly.

**Raw samples** (local, ignored by git, as the brief specifies):
- 30-pair self-comparison: `work/perf-compare/2026-11-02T12-01-30-173Z.json`.
- 100-pair self-comparison: `work/perf-compare/2026-11-02T12-05-35-078Z.json`.
- 100-pair slowdown: `work/perf-compare/2026-11-02T12-18-18-286Z.json`.

**Checked.** Client/server typecheck and explicit script/test typecheck pass. All 585 Node tests pass
with `--test-isolation=none` so the restricted subprocess pipes do not hide the individual results.
Tests cover statistics, argument validation, actual subprocess ordering and discarded phases, hash
mismatches, intentional differences, nondeterministic scenes and child failures.

## 84. Review the complexity added to the coast fit (T2)

**B0.** Use the plain numeric `bendList` directly in the solver, removing its conversion to an
`Int32Array`. This is the cleanup prescribed by the performance plan; no timing gain is claimed.
Client/server typecheck, the Node suite (74 files) and slow suite (3 files) pass. A one-pair
`perf:compare` against `120cba6` confirms equal populated scene hashes; a separate cold sample confirms
equal mixed scene hashes. The one-pair timing is deliberately not used as evidence of performance.
Samples: `work/perf-compare/2026-11-03T02-38-03-038Z.json`.

**B1.** Each ablation compares one undo against a fresh worktree of the preceding commit.
Both fixtures use 100 alternating fresh-process pairs with two discarded warm-ups per tree; scene
hashes agree. Wall time decides retention under the plan’s rule: keep an optimization only if its
undo is `slower` on populated with median ratio ≥1.005. CPU time is reported separately. Ratios
below are undo / optimized; neither absolute times nor different ablations are compared.

| Change undone | Fixture | Wall median | Wall 95% interval | CPU median | CPU 95% interval | Outcome |
|---|---|---:|---|---:|---|---|
| NumberBuffer scratch buffers | populated | 1.0181 | 1.0102–1.0272 (slower) | 1.0064 | 0.9962–1.0256 (unresolved) | Retain optimization |
| NumberBuffer scratch buffers | mixed | 1.0318 | 1.0128–1.0392 (slower) | 1.0339 | 1.0140–1.0415 (slower) | Retain optimization |
| Flat band bins and stroke quadrilaterals | populated | 1.0564 | 1.0455–1.0750 (slower) | 1.0537 | 1.0396–1.0643 (slower) | Retain optimization |
| Flat band bins and stroke quadrilaterals | mixed | 1.0332 | 1.0168–1.0417 (slower) | 1.0399 | 1.0165–1.0505 (slower) | Retain optimization |
| Clearance candidate marks | populated | 1.0240 | 1.0101–1.0359 (slower) | 1.0183 | 1.0069–1.0266 (slower) | Retain optimization |
| Clearance candidate marks | mixed | 1.0127 | 1.0022–1.0267 (slower) | 1.0087 | 0.9971–1.0246 (unresolved) | Retain optimization |
| Typed-array spline support | populated | 1.0225 | 1.0136–1.0306 (slower) | 1.0185 | 1.0108–1.0273 (slower) | Retain optimization |
| Typed-array spline support | mixed | 1.0396 | 1.0211–1.0483 (slower) | 1.0406 | 1.0228–1.0488 (slower) | Retain optimization |

**B2: adopted.** Realm band strokes use Douglas–Peucker at 0.006 hex sizes when compiled for
canvas paint. `bandLines.ts` marks only band primitives in a `WeakMap`; their original commands stay
in the scene. This matters because command arrays are shared with earlier scenes and can have other
uses. A clip, fill or unmarked stroke sharing an array stays unchanged. The thinned commands are
cached by original array and tolerance; curves, subpath ends and closures are retained. Serialized
scenes and SVG export retain the original commands.

`npm run perf:paint-compare -- --base /path/to/base --root .` uses the production worker through a
common `ScenePainter` harness on the 50×50 interaction fixture. Both sides start with a cold build,
then discard two warm-up ownership edits. Thirty edit pairs alternate base-first/new-first. The
worker reports paint time; the harness records input-to-sharp-bitmap time, excluding React. It waits
for the previous overview before the next edit, so two workers do not paint concurrently. The same
T1 statistics give the median new/base ratio and 10,000-resample 95% bootstrap interval.

| Comparison | Measure | Median ratio | 95% interval | Verdict |
|---|---|---:|---|---|
| Review-only trial, 30 pairs | Paint | 0.9189 | 0.8513–0.9472 | faster |
| Review-only trial, 30 pairs | Edit to sharp frame | 0.9375 | 0.8768–0.9823 | faster |
| Production implementation against `c08e241`, 30 pairs | Paint | 0.9510 | 0.9235–0.9858 | faster |
| Production implementation against `c08e241`, 30 pairs | Edit to sharp frame | 0.9773 | 0.9283–1.0392 | unresolved |

The production comparison supports a **4.9% paint saving**, clearing the 0.5% threshold. It does not
establish an improvement in the complete edit wait. Absolute production paint medians were 246.2
and 236.3 ms, context only; the gain is the median of paired ratios, not their quotient. The two
batches are independent comparisons, not a pooled estimate. The one-pair small-fixture self-check
is functional evidence only: it produced identical pictures at all three zooms.

**Pictures.** Reviewed before/after images at fit, 1× and 2× show no visible change. The production
closeups focus a realm boundary (hex 706), rather than the empty sea at the scene centre. All pass
§76 unchanged: fit/1×/2× have 0 strong pixels, and 5/1/0 weak pixels out of 1,260,000. Raw changed
pixel counts are 4,259/2,089/2,642. The command geometry remains in the serialized scene; no coast
fit or share tolerance changes.

**B2 samples and images:** `work/t2-review/paint-thin/results.json` and
`work/t2-review/paint-production/results.json`; PNG pairs are in those directories. The trial can be
repeated with `--root` pointing to the pre-B2 tree and `--thin`. Launches fail normally on sandbox
socket restrictions; no automatic escalation or permission retry is built into the tool.

**Interrupted runs.** A host connection loss discarded an unfinished flat-bin batch. Its timings
were not used; that comparison was restarted with fresh pairs. `perf:compare` now checkpoints each
completed sample outside the construction timer, so a host loss leaves diagnostic samples even
when its finalizer cannot run. Saved progress is not a license to combine sessions into one batch.

**NumberBuffer scratch buffers samples:** `work/perf-compare/2026-11-03T10-57-36-164Z.json`, `work/perf-compare/2026-11-03T11-09-15-994Z.json`.

**Flat band bins and stroke quadrilaterals samples:** `work/perf-compare/2026-11-03T12-04-26-199Z.json`, `work/perf-compare/2026-11-03T12-16-29-022Z.json`.

**Clearance candidate marks samples:** `work/perf-compare/2026-11-03T12-26-41-971Z.json`, `work/perf-compare/2026-11-03T12-38-21-145Z.json`.

**Typed-array spline support samples:** `work/perf-compare/2026-11-03T12-48-36-854Z.json`, `work/perf-compare/2026-11-03T13-00-44-859Z.json`.

**Final checks.** Client/server typecheck, all 589 Node tests (including four band-path tests),
all 14 slow tests, the production build and `test:drawing-pixels` pass. The Node suites were also
run with `--test-isolation=none` to expose every assertion in this environment. The populated and
mixed scene hashes match the original `120cba6` output:
`c8fc4d6ecc57aa05ff877637c5c98a90e8e14ee2cdfd4961079de7cbda7b9ae5` and
`4ba1a9a25d5ceff9ee599d164f8218d6001f78731f9b7b53513920029589285f`, respectively.
Tests cover keeping original serialized commands, retaining curves and subpath boundaries, marking
primitives when command arrays are shared, cache reuse after edits, and distinct size tolerances.
No check or threshold was weakened. T2 is complete; Group 1's solver redesign remains the next step.

## 85. The performance maps are checked for sense before they are timed

**Problem.** The maps every timing is taken on had drifted from the hex definitions of #180, and
from ordinary sense, in ways the existing check did not see:

| Map | Used by | What was wrong |
|---|---|---|
| `mixed` (`scripts/coastFeatureFixture.ts`, 30×30) | `perf:compare --kind mixed`, `perf:coast` | No Strait or Isthmus at all, although the map exists to measure them. A round continent's coast rarely has two separate land groups and two separate water groups around one hex, and the fallback search added in #180 found no candidate. |
| `interaction-study` (`render-all-layers-fixture.ts`, 50×50, generated by `core/mock.ts`) | `perf:paint-compare`, `perf:interaction` | 9 Mainland-and-islands hexes without both a land and a water neighbour (invalid under #180). 13 Islands hexes, which are open sea with islets, had no water neighbour, so each was a round hole of sea inside the land. 7 cities on glaciers, and 36 river segments over glaciers or over the open water of Islands hexes. |
| `populated` (`test/fixtures/populated-40.json`) | `perf:compare`, `perf:opening`, `perf:coast` | Valid after #180's hand edits, but with the same generator faults: 10 enclosed Islands holes, a city on a glacier, and 15 river segments over glaciers or Islands hexes. Its other layers no longer matched what the generator produces for the same seed. |

The 33 coast-gallery maps were valid and are unchanged.

**Chosen.** The generator is corrected, not the frozen file alone. In `core/mock.ts`, an Islands hex
with no water neighbour becomes Land; then a Mainland-and-islands hex with no water neighbour
becomes Land and one with no land neighbour becomes Islands, repeated until no hex changes (one
change can take another hex's only land neighbour). Rivers run only over open ground, not over
Glacier or Islands hexes. Cities are not founded on glaciers. `populated-40.json` is regenerated
from the corrected generator with the same seed and metadata; its base layer is unchanged apart
from those corrections, and its other layers are what the generator now produces. Its scene hash
therefore changes, which §82 already allows: only paired ratios from one session are compared.

The mixed map now ties a one-hex islet to the coast through two Straits and two Isthmuses, spread
along the coast. The passage hex has the mainland on one side, the islet opposite and two hexes of
open sea on each flank, and its mainland root is plain Land with no share of its own. An earlier
version allowed the mainland to wrap around the passage hex; there a 50% isthmus was drawn at
69–71%, because a neck with only two water neighbours cannot be that thin.

**Reachable shares.** An isolated test on a 9×9 map, mainland block behind one side and a one-hex
islet opposite, at Normal width, in all three orientations and both row parities:

| Passage | Requested | Drawn |
|---|---|---|
| Isthmus | 40% | 51–59% in all six cases |
| Isthmus | 50% | 54–57% in five of six cases |
| Isthmus | 60% | reached in all six |
| Strait | 40% | reached in five of six (one at 37%) |
| Strait | 50% | reached in five of six (one at 47%) |

In the mixed map one strait cannot hold more than 34% whatever is asked. The benchmark therefore
asks 60% of isthmuses and 30% of straits, so it measures fitting, not a reported miss. The mixed map
now builds with no compromises. The gap between what these categories allow (Isthmus 15–80%,
Strait 10–70%) and what the renderer can draw for this simple geometry is a drawing limit, recorded
here and not fixed here.

**Remaining misses.** The populated map still reports `100% land drawn instead of 90%` at hex 1532,
a Land hex in the southern ice rows. The renderer misses that hex on `main` too, so it is a drawing
limit, not a fixture fault.

**Checks.** `test/hexDefinitions.test.ts` now validates the 50×50 interaction map as well, requires
the mixed map to contain at least two of each of Strait, Isthmus, Mainland and islands, Islands and
Lake, and requires both all-layer maps to keep cities off glaciers and rivers off Glacier and
Islands hexes. Client/server typecheck, the render-fixture typecheck, 604 Node tests, 14 slow tests
and `test:drawing-pixels` pass. The renderer is unchanged by this entry.

**Baseline for Group 1, step 1.1.** These are cold-build work counts from the corrected maps. Times
are single runs, context only (§82).

| Map | Cold build | Global passes | Measurements (hexes) | Rounds | Solver iterations | Trials |
|---|---:|---:|---:|---:|---:|---:|
| populated | 2.66 s | 3 (489 ms) | 8 (2,578) | 7 | 480 | 7 |
| mixed | 1.38 s | 3 (327 ms) | 8 (1,408) | 7 | 480 | 6 |

## 86. One initial solve in place of the global share passes: tested, not adopted (Group 1, step 1.1)

**Tried.** In smooth styles, the three global share passes in `cachedCoast` were dropped. The
coupled least-squares fit (`fitCoastAreas`), which already treats every share as a target, then
started directly from the initial trace. Unsmooth styles have no coupled fit and were not changed.
Variants gave the first fit 4, 6 or 8 rounds, and kept two passes instead of three. Single runs on
the corrected maps of §85; the counts, not the times, decide:

| Variant | populated misses | mixed misses | populated traces | mixed traces |
|---|---:|---:|---:|---:|
| 3 passes, 4 rounds (current) | 1 | 0 | 3 | 3 |
| no passes, 4 rounds | 15 | 1 | 1 | 5 |
| no passes, 6 rounds | 14 | 1 | 1 | 5 |
| no passes, 8 rounds | 13 | 1 | 1 | 5 |
| 2 passes, 4 rounds | 2 | 0 | 2 | 4 |

**Why it fails.** Most new misses are coastal hexes asked for 90% and drawn at 100%. On the initial
trace each of them shows exactly 100% although 89% is aimed at: the smoothing has carried the coast
out of the hex entirely. A hex with no coast in it has no controls in the fit's system, so no
number of rounds, and no single solve over the controls, can reach it. The passes work by lowering
the aim until the coast re-enters (hex 362: 100%, then 99.9%, then 92%), after which the fit can
finish. The share shown is flat in the aim until that happens, so a solve that starts from the
trace's sensitivities cannot replace the passes. With two passes one more hex misses, and on mixed
the passage bracketing then needs an extra trace, so nothing is saved.

The passes also converge less than their comment suggests. On populated, 121 of 219 targets are
still outside the 2.5-point tolerance after the third pass (rms error 0.107, largest 0.41), and the
coupled fit does the rest. Their job is mainly to put coast into every coastal hex, not to reach
the shares.

**Consequence for the plan.** Step 1.1 as written is withdrawn. A replacement would have to make
the first trace leave coast in every hex with a share below 100%, for example by cutting dry
coastal hexes harder in the first aim. That is a change to how coasts are shaped, judged by
pictures, and is not attempted here. The fit's own field (step 1.2) is the largest remaining part
of the fit and is taken next (§87).

## 87. Reusing the fit's clearance across rounds: built, measured, removed (Group 1, step 1.2)

**Where the field's time goes.** Profiled cold builds on the §85 maps, single runs: the field phase
(`fit.field`) was the largest part of the fit (454 of 1,089 ms on populated, 306 of 746 on mixed).
Within it, building the per-point samples took 269 ms on populated. Timers wrapped round each
clearance query put those queries at 142 ms (18,264 queries) on populated and 76 ms (12,580) on
mixed. Those timers proved to inflate the figure (below).

**Built.** Clearance was measured exactly in each fit call's first round, then kept as a lower
bound: a point that has moved d, while no point has moved more than D from the reference rings,
has no coast nearer than c − d − D − D'. The reach made from that bound is never above the exact
reach, because easing and smoothing are monotone, and it is zero exactly where the exact reach is.
In the fit the reach is used only as a zero test when building the matrix and as the clamp on a
point's movement. So the matrix and the solve were unchanged. Wherever some point's movement
exceeded its bounded reach, the clearance points that reach could depend on were measured exactly
before the ring moved. Those were the points within three hex sizes of smoothing length, plus the
four either side that ease them. Populated and mixed scene hashes were unchanged
(`f0c2a680…`, `6264b1b2…`). Exact queries fell from 18,264 to 6,465 on populated and from 12,580
to 4,542 on mixed. A first version re-measured whole rings and walked every bounded sample per
clamped point; 36 pairs of it showed no gain, and it was replaced by a binary search before this
measurement.

**Measured.** 60 alternating fresh-process pairs per map against `49ed871`, one session:

| Map | Measure | Median ratio | 95% interval | Verdict |
|---|---|---:|---|---|
| populated | Wall | 1.0058 | 0.9888–1.0179 | unresolved |
| populated | CPU | 1.0472 | 1.0320–1.0578 | slower |
| mixed | Wall | 1.0011 | 0.9958–1.0173 | unresolved |
| mixed | CPU | 1.0333 | 1.0156–1.0477 | slower |

Samples: `work/perf-compare/2026-11-06T15-27-42-348Z.json` and
`work/perf-compare/2026-11-06T15-34-43-858Z.json`.

**Removed.** It is not faster, and CPU time is 3–5% higher: the bookkeeping (a record per measured
point, sets of bounded points, rebuilt reach) costs more garbage collection than the queries save.
The clearance index is still built in almost every round, because some points need measuring each
round. The profile figure that motivated the change was inflated by a pair of `performance.now()`
calls around each of the 18,264 queries. The code is reverted to `49ed871`; the commits that added
it remain in the history.

**Consequence for the plan.** Step 1.2's premise, that rebuilding the field each round is mostly
waste, holds for clearance, but its cost there is too small to repay reuse in plain JavaScript
objects. What remains in the field is per-point arithmetic and allocation (normals from prefix
sums laid out three laps, a `Sample` object per point, `Map` rows for the matrix), which is the
typed-array rewrite of step 2, not reuse. Step 2 is next. Any further reuse should be attempted
only after it, measured by CPU time as well as wall time.

## 88. Flat arrays for the fit's per-point samples: measured, not adopted (Group 1, step 2)

**Built.** The per-point sample build in `fitCoastAreas` was rewritten on typed arrays, keeping the
same arithmetic in the same order. It covers prefix sums of normals and arc length over three laps
of a closed ring, each point's sea direction, reach and length, and the clearance points. It
replaced a pair of `{x, y}` objects per prefix entry and an object per point. Populated and mixed
scene hashes were unchanged and the Node suite passed. The field phase had been the largest part of
the fit (§87).

**Measured.** 60 alternating pairs per map against `ff6718b`, one session:

| Map | Measure | Median ratio | 95% interval | Verdict |
|---|---|---:|---|---|
| populated | Wall | 0.9952 | 0.9888–1.0198 | unresolved |
| populated | CPU | 1.0189 | 1.0098–1.0409 | slower |
| mixed | Wall | 0.9845 | 0.9747–1.0003 | unresolved |
| mixed | CPU | 0.9962 | 0.9859–1.0128 | unresolved |

Samples: `work/perf-compare/2026-11-06T16-10-02-321Z.json` and
`work/perf-compare/2026-11-06T16-17-17-301Z.json`.

**Not adopted.** It is not faster on populated, where the plan's rule decides, and the code is
reverted to `ff6718b`. With §87, this suggests that what remains in the field phase is mostly
neither allocation nor the clearance query. The plan's 20–35% estimate for step 2 is not supported
for the field kernel.

**Function-level profile.** `node --cpu-prof` on an esbuild bundle of one populated cold build
(kept names and lines; 3.08 s sampled). Self time, top entries:

| Self time | Share | Where |
|---:|---:|---|
| 486 ms | 15.8% | garbage collector |
| 177 ms | 5.8% | `fitCoastAreas` body (solver loops, matrix rows) |
| 177 ms | 5.8% | `areaCoverage`'s per-hex measure (`footprint.ts`) |
| 121 ms | 3.9% | `coastClearance` query (`componentCoast.ts`) |
| 88 ms | 2.9% | `areaCoverage` scanline union |
| 83 ms | 2.7% | `evenOddTest` lookup (`coast.ts`) |
| 70 ms | 2.3% | `cachedCoastFit` itself |
| 68 ms | 2.2% | the fit's per-point samples |

No function other than the two at 5.8% reaches 5%. The rest of the time is spread thinly over
many functions. The clearance query's 3.9% caps what §87 could ever save, which is why it did not
show. `cachedCoastFit`'s own cost is mostly its JSON cache key: timed directly, it is 15 ms per
cold build (strings of 1.2 and 0.57 million characters), about 0.5%, so it is left alone.

**What would pay.** No single kernel rewrite is likely to reach the plan's estimates: the two
largest functions together are 11.6% of the build. Garbage collection, at 15.8%, is the largest
single cost, but it is spread across the coast pipeline, so reducing it means changing how coast
geometry is represented (points as objects, paths as command arrays) across tracing, fitting
and measuring. That is a design change, not a kernel rewrite. The other remaining routes are
steps 3 (refit only the coast an edit changes) and 4 (fit independent coast groups in parallel),
which cut work rather than speed it up.

## 89. What an edit waits for, and how far a coast edit reaches (Group 1, steps 3.1 and 3.2)

**3.1, the wait.** `npm run perf:edit-wait` (`scripts/render-edit-wait.mjs`, new) drives the production worker through
`ScenePainter` on the 50×50 all-layer map (§85). It makes one cold build, then ten edits in
sequence, each waited out to its sharp frame and overview before the next. The phases come from the
build's profile. The rest is the sharp-frame time less build and paint: transfer both ways,
scheduling and the bitmap hand-back. Medians of 3 fresh-worker runs at fit zoom, headless software
raster, one session (§82):

| Edit | To sharp frame | Build | Coast | Coast fit | Paint | Rest |
|---|---:|---:|---:|---:|---:|---:|
| cold build | 2,839 | 2,519 | 1,657 | 858 | 263 | 58 |
| coast: land to sea | 2,387 | 2,040 | 1,465 | 774 | 334 | 13 |
| coast: sea to land | 2,362 | 1,927 | 1,382 | 763 | 422 | 12 |
| coast: land share 60% | 2,585 | 2,135 | 1,553 | 649 | 290 | 159 |
| inland: vegetation | 311 | 78 | 0 | 0 | 223 | 10 |
| inland: elevation | 319 | 82 | 0 | 0 | 238 | −1 |
| inland: land to lake | 2,203 | 1,701 | 1,160 | 591 | 278 | 225 |
| ownership | 407 | 102 | 0 | 0 | 227 | 78 |
| ownership | 320 | 93 | 0 | 0 | 222 | 6 |
| city: add | 342 | 110 | 0 | 0 | 218 | 14 |
| city: remove | 308 | 90 | 0 | 0 | 210 | 8 |

All times in ms. Any edit that changes land or water, coastal or a new lake, costs 78–91% of a cold
build, and the coast is 57–72% of its wait. Every other edit takes about 0.3–0.4 s, of which paint
is about 220 ms, and the coast is reused. The earlier figure of 70–120 ms for an edit is the build
alone for edits that leave the coast alone. The coast fit is not the largest part of a coast
edit's wait: the rest of the coast phase (traces, global passes, coverage and lakes) costs about
as much. Step 3 should therefore cover the whole coast phase, not only the fit.

**3.2, the reach.** One edit on the populated map, a coastal Land hex (31,21) to Sea, built in
Node after a cold build:

| | Cold | After the edit |
|---|---:|---:|
| Coast components built | 88 | 85 |
| Traces / global passes | 3 / 3 | 3 / 3 |
| Fit groups built | 2 | 2 |
| Hexes measured by the fit | 2,578 | 2,551 |
| Coast subpaths unchanged byte for byte | — | 118 of 154 |

The 36 changed subpaths are the edited coast (1.9 hexes away; it moves up to 0.039 hex) and 35
others between 7.1 and 57.1 hexes away, on coasts the edit does not touch. Those 35 move by at most
0.0026 px (1e-4 hex), which cannot be seen, but they are rebuilt and refitted. The whole map's
coast is one fit group. In plan terms, unconnected groups are refitted and moved, so step 3.2's fix
comes before 3.3.

**Why every coast is coupled.** From reading the code:
- The global share passes in `cachedCoast` measure every hex against one scanline union spanning
  the whole map (`reuseScanlines`), so a change anywhere can alter another hex's measured share in
  its last bits. That changes its aim, which misses the per-component trace caches.
- The passes' stopping tests (largest movement, largest error) are taken over the whole map.
- `fitCoastAreas` solves all rings in one system. Conjugate gradients use two scalars per iteration
  (the step size and the direction weight) computed over all controls, so even a block-diagonal
  system couples every ring's solution.
- The fit accepts or stops a round on whole-map error, and `cachedCoastFit` keys one cache entry on
  every path.

**Next (the 3.2 fix).** Partition the coast into independent groups: rings linked through hexes the
coast runs through, or within the clearance reach of three hex sizes. Then run the passes and the
fit per group, with every other ring held fixed while measuring, so that even-odd fill and page-rim
joins still see the whole outline. Cache each group's result on its own inputs. The test the plan
asks for comes with it: an edit leaves unconnected coast groups byte-identical. The same partition
is step 4's unit of parallel work. Cold-build pictures may move by float-level amounts (CG
scalars, measurement unions), so it is judged by §76 and the share gates, not by hash.

## 90. Coastal edits reuse what they do not touch: a cache sized to the map, and coasts fitted by group (Group 1, step 3.2 fix)

**Component cache.** One cold build of the populated map stores 17.7 MB of component traces (88
entries across three traces; each key lists every edge's coordinates). The cache held 16 MB, so the
last traces evicted the first, and a coastal edit reused none (0 hits of 85). At 384 entries and
48 MB it reuses 57 of 85. Hits are exact, and scene hashes are unchanged. In Node, six different
coastal edits in sequence took a median of about 1.65 s before and 1.44 s after.

**Fitting by group.** `coastFitGroups` (in `coastArea.ts`) links rings that occupy cells of half
of four hex sizes at most two cells apart. Any two points within four hex sizes are linked, which is
beyond clearance's reach of three, so no group can see another through clearance, crossings or a
shared hex. Rings up to about twice that apart may also be linked, which only merges groups that
could have stayed apart. Each target goes to the group of the coast nearest its centre.
`cachedCoastFit` fits each group with `fitCoastAreas(…, movable)`. The other rings are held
still: they are measured, but not untangled, moved or returned, and they have no controls. Each
group is measured only over its own region, which is exact, because an outline whose box misses
the region crosses each measuring line an even number of times on either side of any clip inside
it (`areaCoverage`'s new `region`). Each group is cached on its own paths, targets and held-back
detail. Its key also holds the even-odd parity of the drawn land at one of its points (one ray cast)
and, for any drawn ring it shares with other groups' open coasts, where those coasts meet the page
edge. A map with one group (mixed) takes the old path and is byte-identical.

**Reach after an edit.** On populated (4 groups), a coastal edit refits one group, measuring 978
hexes against 2,551 before. Every coast in the other groups is redrawn byte for byte
(`test/slow/coastGroups.test.ts`, which checks 86 coasts). An edit on the page edge also refits the
group whose page-rim joins it changes, as the key intends. The fit cache now holds 32 entries and
48 MB, since four groups make eight entries per build.

**Cold-build pictures.** Grouping changes how a multi-group map is fitted: the conjugate-gradient
scalars and the stopping tests are now per group. On populated's cold build, coastline points move
by at most 0.45 px at 1× (0.017 hex), with a 99th percentile of 0.07 px and a median of 0.0015 px.
`perf:coast` finds no visible change at fit, 1× and 4×, at 1× and 2× pixel ratio, through both
compositors (up to 11,978 changed pixels, all below §76's threshold). The land-share misses are the
same (hex 1532 only). All 33 gallery maps and mixed are byte-identical. `test:drawing-sweeps`
passes with no failures. Node, slow and pixel suites pass.

**Measured.** `npm run perf:edit-wait`, medians of 3 fresh-worker runs, ms to the sharp frame:

| Edit | Before (§89) | Cache fix | Grouped fit |
|---|---:|---:|---:|
| coast: land to sea | 2,387 | 2,074 | 1,755 |
| coast: sea to land | 2,362 | 2,007 | 1,503 |
| coast: land share 60% | 2,585 | 1,966 | 1,568 |
| inland: land to lake | 2,203 | 1,668 | 1,536 |
| cold build | 2,839 | 2,778 | 2,937 |

The §89 column was taken a session earlier and is indicative only. The last two columns were taken
in one session. Coastal edits on the 50×50 map are 26–36% faster than at the start of this work.

**Cost on cold builds.** 40 paired cold builds against the cache-fix commit `8111bca`:

| Map | Wall median | 95% interval | CPU median | 95% interval |
|---|---:|---|---:|---|
| populated (4 groups) | 1.0594 | 1.0221–1.0903 | 1.1433 | 1.1111–1.1778 |
| mixed (1 group) | 1.0162 | 0.9980–1.0372 | 1.0255 | 1.0126–1.0571 |

A multi-group cold build is about 6% slower. Four group fits run 1,678 solver iterations against
480 for one whole-map fit: each group converges in about as many iterations as the whole map did.
The wrapper adds about 70 ms per build (grouping 29 ms, sorting detail into groups 20 ms, keys
15 ms). Two earlier versions were slower still and were improved before this measurement: 16%
(the wrapper repeated whole-map work per group) and then 6% wall with 9% on mixed (distance tests
in the grouping). The trade is accepted: a coastal edit, which the owner waits for repeatedly,
gains far more than a cold build loses. Fitting the groups in parallel (step 4) is the way to turn
grouping into a cold-build gain too.

Samples: `work/perf-compare/2026-11-07T14-16-55-756Z.json` (populated) and
`work/perf-compare/2026-11-07T14-22-00-833Z.json` (mixed).

## 91. Edits may redraw a coast differently from a fresh build, and how local the coast is

**Owner's decision.** The rule that a scene rebuilt after edits equals an uncached build of the same
map is relaxed for the coast. An edit may recompute only the coast near it (Group 1, step 3.3), so
the drawn coast may depend on the map's edit history. The difference from a fresh build must not
be visible (§76) and must keep the land-share gates. Other cached state (symbols, labels, rivers)
keeps exact equality until a step says otherwise. `assertRebuildMatchesUncached` stays as it is
until such a step lands, and that step replaces it, for the coast only, with a visible-change and
share check.

**How local the coast is** (`npx tsx scripts/coast-locality.ts`, populated map). A window can only
replace the coast near an edit if the coast there depends only on nearby input. Two tests:

| Test | Smooth irregularity | Default (rough) |
|---|---|---|
| Crop one column (renumbers hexes, moves page coordinates), coast more than 4 hexes inside | p50 0.68, p95 4.9, max 10.5 px | p50 2.1, p95 7.1, max 15.7 px |
| Mask beyond 9 hexes of a coastal hex to Sea (indices and coordinates kept), coast within 1.5 hexes | p95 0.01–0.37, max 0.01–0.43 px | p95 2.0–5.9, max 6.5–8.0 px |
| The same, margin 6 | p95 0.37–12.1 px | p95 5.6–12.6 px |

Coordinates and hex indices seed the coast's shaping, so any window must keep the map's own (the
mask test, not the crop). With them kept, smooth coasts are local within 9 hexes: the fit, the
share passes and the smoothing agree to well under a pixel. Rough coasts are not, because
`componentCoast` places each bay and cape at a random fraction of the whole ring's perimeter,
measured from the ring's start, and seeds all of a ring's features from one number, the lowest
land-hex index on the ring. Change a ring's length anywhere and every feature on it shifts. Today an
edit moves the far side of a continent by at most about 1 px (§89), but a window of a ring cannot
reproduce the whole ring's features.

**Cost of a window.** Masked builds of the geography alone took 40–130 ms at a 9-hex margin for
smooth coasts and 150–430 ms for rough ones, against 790–1,030 ms for the whole map's geography after
the same edit (single runs, context only).

## 92. Local coast features (R1): built, then withdrawn as unnecessary; folding islands fixed

**Tried.** R1 anchored each bay, cape and cut to the stretch of coast it starts on, seeded locally,
in place of a random fraction of the whole ring's perimeter seeded once per ring. Three versions
were built:
- Features per source edge, in proportion to its length. Locality improved: a 9-hex window
  matched the whole map within 1.2–1.5 px at two of three test points, against 6.5–8 px. But a
  feature appeared or vanished whenever a moving cut took an edge across a length threshold. Lake
  concentration then went the wrong way: at 20% land, concentrating east reduced the east half's
  land from 0.0228 to 0.0168. Eight tests failed.
- A fixed number of features per pair of hexes. Stable, but cuts shorten a side's coast without
  removing the side, so a lake at 80% land carried 1.7 times the intended fine-feature density.
  Its share then missed (0.68 for 0.8).
- Features per pair at strengths rising continuously with the pair's coast length. Density and
  stability were right, and concentration recovered at 40% and 80% land. Six tests still failed,
  including strait width, component separation and a fit's share.

Feature statistics were preserved in every version (coastline length and total turning within
1–3%), but each variant moved a different set of tested behaviours, all tuned to particular
instances of the old features.

**Withdrawn.** R2 does not need R1. The costly part of a coastal edit is the share passes and the
fit, not the trace: the edited coast can still be traced whole (under 0.3 s), with only the passes
and fit restricted to a window and the previous fit reused outside it. With the per-ring features,
an edit shifts the rest of its ring's features by at most about 1 px (§89). The reused part of the
coast therefore moves by at most that, which is invisible and allowed under §91. Keeping R1 would
redraw every existing map's coast, and destabilise several tested behaviours, for no gain. The
roughening is unchanged.

**Kept: folding islands.** A component sized as a whole (an island of plain land) is never
fitted, and its broad bays are limited only by clearance to other coasts. On a narrow island they
can meet the island's own opposite shore. Over 998 seeded cases (two island layouts, 499 seeds,
60% land) 22 outlines crossed themselves. `componentCoast` now checks such an outline and, if it
crosses, reduces the fine detail and then the broad bays (six steps) until it does not: 0 of 998
cross. The populated and mixed scenes are unchanged, since neither had a folding island. A test
covers eight seeds that folded before.

## 93. Local refit by freezing points (R2, first form): built, measured, reverted

**Built.** With a scene option set, a coast group that misses the fit cache was refitted from the
previous fit of the same context. Each point started displaced as its nearest previous point had
been. Points within three hex spacings of the edit moved freely, fading to fixed at four and a half.
Only target hexes the free points ran through were aimed at. More than 40% of a group's coast
changed meant a full fit instead. The edit was found by matching: a point more than 0.1 hex from
its previous match, or a hex whose share changed. 0.03 hex proved too small, because an edit shifts
the rest of its ring's features by up to about 1 px (§89), so every point counted as changed.

**Measured** (populated, five coastal edits in sequence, Node, single runs; probe saved outside the
repository):

| Edit | Local refit: build (fit) | Without: build (fit) | Local against a fresh build, beyond 5 hexes |
|---|---:|---:|---:|
| 871 | 1,261 (202) ms | 1,534 (355) ms | max 0.00 px |
| 553 | 2,252 (1,223) ms | 1,186 (281) ms | max 5.40 px |
| 997 | 932 (167) ms | 1,024 (219) ms | max 5.40 px |
| 650 | 1,486 (589) ms | 1,134 (303) ms | max 5.40 px |
| 1253 | 1,250 (364) ms | 1,021 (218) ms | max 11.48 px |

Two new share misses appeared at the window's edge (87% for 90%, 93% for 90%).

**Why it does not pay.** A frozen point still belongs to a ring the fit processes whole every
round: per-point samples, clearance, spline controls and the stretch and crossing checks all cover
the full ring. Freezing 85% of a continent's points saves only part of the measurement and of the
solve, and a transferred start can take more rounds to settle. The differences also accumulate
over edits, at the window's edge where the kept coast meets the refitted coast.

**What would pay.** Fit only the window: cut each ring's stretch inside the window out as an open
segment with fixed ends (the fit already keeps open ends still), fit those segments with the rest
of the coast fixed for measurement and clearance, and splice them back. The cost per round is then
in proportion to the window. The window must be wide enough that the kept and refitted coast agree
where they meet. That is a rework of `fitCoastAreas` around segments and is the next attempt at R2.

## 94. Local refit after a coastal edit (R2): the previous fit kept outside windows

**Built.** With `SceneOptions.incrementalCoast` set (the editor's paint worker sets it; tests and
other callers do not), each fit of the coast keeps a record of what it took and gave
(`src/render/coastWindow.ts`). A coast group that misses the fit cache is then planned against the
last record of the same coast and fit, and refitted only where it changed:
- A point of the new trace is changed if it lies in or beside a hex whose share or width changed,
  has no old point within a hex, or breaks the old coast's order (consecutive points meeting old
  points far apart along it, as where an edit cuts a neck). The change spreads to every ring
  through the hexes it touches, until no kept coast runs through a newly reached hex.
- Each changed stretch is replaced by the new trace, from an anchor before it to one after,
  moved out by up to two hexes of coast to where the new trace runs within 0.12 hex of the old fit.
  The new trace is bent smoothly to meet the old fit at both anchors. Between stretches the old
  fit's own points are kept exactly.
- The window refitted is each stretch with 2.5 hexes of coast either side. `fitCoastAreas` takes
  the windows, repairs and moves only their points, eases each to still over a hex at its ends (as
  an open coast does) and aims only at the hexes they run through. Samples, spline controls, the
  stretch and crossing checks and the measurement are all limited to the windows.
- A ring changed over most of its length, or one that cannot be spliced, is refitted whole from
  the new trace. Its group is fitted whole only if no record matches. Neither the populated nor
  the 50×50 interaction map's sequences needed that.
- The second fit, on the first fit's output with its detail, counts only exact changes. Outside
  the first fit's windows its input is the same as last time.

**Correction to §89, §92 and §93.** I wrote there that an edit shifts the rest of its ring's
features by at most about 1 px. That held for the edit §89 measured, not in general. On the
populated map, turning hex 553 to sea moved 1,131 of the continent's 3,696 traced points by more than
0.1 hex and 173 by more than half a hex, all round the ring, because each feature sits at a fraction
of the whole ring's length (§91). A plain build therefore redraws the far coast of an edited ring
differently on every edit: up to 10.7 px beyond five hexes of the edit, in the probe below. The
windowed refit keeps that coast as it was drawn, so its edits show less movement, not more.

**Measured, Node** (populated map, five coastal hexes turned to sea in sequence, windowed against
plain builds of the same sequence, single runs):

| | Windowed | Plain |
|---|---:|---:|
| Coast fit, per edit | 108–277 ms | 240–350 ms |
| Far coast (beyond 5 hexes) moved from the previous frame | at most 2.1 px | up to 10.7 px |
| Far coast from a fresh build of the same map | up to 12.5 px | 0 |
| Share misses not in a fresh build | none | none |

The difference from a fresh build is the feature slides a fresh build would make, and it shows only
when the map is reopened. The coast then moves as a plain build's does on every edit today.
**Owner's decision (8 November 2026):** shown side-by-side renders of an incremental and a fresh
build after four edits (largest far differences 9–11 px, visible as reshaped bays), the owner does
not mind the differences. Incremental refits stay on in the editor. A test (`test/slow/coastWindow.test.ts`) holds
the shares, the still far coast (at most 0.12 hex) and a bound on the distance from a fresh build
(0.6 hex) over four edits.

**Measured, browser** (`npm run perf:edit-wait -- --runs 5`, production worker, medians, against
the previous commit in the same session):

| Edit | Before: sharp frame (fit) | After: sharp frame (fit) |
|---|---:|---:|
| coast: land to sea | 1,584 (433) ms | 1,484 (302) ms |
| coast: sea to land | 1,483 (394) ms | 1,305 (206) ms |
| coast: land share 60% | 1,442 (359) ms | 1,119 (142) ms |
| inland: land to lake | 1,372 (377) ms | 1,290 (154) ms |

The fit falls by 130–220 ms an edit, and a coastal edit by 6–22%. That is near the 20% expected,
because the fit was only about a third of a coastal edit. What remains of the fit's cost is
mostly outside the windows: the group keys, page-rim parity, anchor snapping and the plan (14–50
ms), each map-wide. Cold builds and non-coastal edits are unchanged. Every existing test, the slow
tests and the drawing sweeps pass, with scenes built without the option unchanged.

## 95. Keeping the rest of a coastal edit local (R3, first part): share passes, islets and symbols

A profile of coastal edits after §94 (Node, 50×50 interaction map) showed three map-wide costs
outside the fit:
- The share passes. They pick their best attempt and decide when to stop by a whole-map error,
  so one edit changed the shaped land of hexes all over the map.
- Islet drawings: all 90 redrawn on every land edit, about 105 ms. They were cached by a whole-map
  land revision. Ten of them were also re-sized, about 90 ms, because the passes had reshaped
  their mainland.
- Symbol placements: all 715 re-checked by replaying their land probes, about 200 ms. They were
  also keyed by the whole-map land revision.

**Changes:**
- **Share passes, incremental builds only.** Each coast keeps the target and the settled share of
  every hex. A later build starts each hex whose target is unchanged and lies more than two hexes
  from a changed one at its last settled share. Only the hexes near the change are measured,
  moved and bracketed. The rest of the coast is traced from the component cache as before. A
  coastal edit adjusts about 12 hexes.
- **Islet drawings, all builds.** They are cached by everything they depend on, all local to the
  hex: the key their size search already used, the size, whether the hex has a mainland piece,
  and that mainland's drawn shore exactly. The cache budget rose from 4 MB to 8 MB.
- **Symbol placements, all builds.** A fit records a fingerprint of the land near its hex, if all
  its probes lie within half a hex of it. The fingerprint holds:
  - every sea-coast and lake-shore segment in that box, exactly, hashed;
  - which side of them the hex's centre lies;
  - the kind, lake, split and islet drawing of the hexes within two rings.

  Even-odd land inside the box is decided by those alone, so a fit whose fingerprint is unchanged
  is kept without replaying its probes. Anything else is replayed or searched as before. The
  fingerprint is taken only when a fit is new or must be checked again.

**Measured.** Per coastal edit in Node, about 658 of 715 fits are now kept by fingerprint, and the
symbols phase fell from about 209 to 109 ms. Islet drawings rebuilt fell from 90 to about 5.
Browser, `perf:edit-wait --runs 5`, sharp frame, all three in one session:

| Edit | Before §94 | After §94 | Now |
|---|---:|---:|---:|
| coast: land to sea | 1,711 ms | 1,540 ms | 1,278 ms |
| coast: sea to land | 1,648 ms | 1,287 ms | 1,133 ms |
| coast: land share 60% | 1,705 ms | 1,235 ms | 1,056 ms |
| inland: land to lake | 1,511 ms | 1,285 ms | 1,268 ms |

Coastal edits are now 25–38% faster than before §94. Other edits and cold builds are unchanged:
paired Node cold builds on populated gave 1.018 (interval 0.975–1.055), unresolved.

**Tests.** Scenes built without `incrementalCoast` still equal uncached builds
(`assertRebuildMatchesUncached` throughout). One test counted probe replays after a far edit and
now accepts either a replay or a fingerprint hit. A new test checks the following, each matching
an uncached build:
- a far edit keeps a hex's fit by fingerprint;
- an edit beside the hex replays it or searches again.

**Still map-wide in a coastal edit.** The landmass the edit touches is retraced on each of the three
share passes, because its silhouette is one component (making that local is R1, withdrawn in
§92). After that come coverage and lakes (about 130 ms), the rest of land and fills (about 150 ms)
and paint (about 240 ms in headless software raster).

## 96. Keeping the rest of a coastal edit local (R3, second part): river names, pack ice and measured land

A profile of the edit builds alone after §95 (Node, populated, five coastal and five inland edits)
showed three more map-wide costs:
- River names: about 65 ms of a coastal edit and 100 ms of an inland one. Every river was searched
  again, because each river's reuse key held the whole-map land revision and the lake shores.
- Pack ice: about 37 ms. It was cached by the whole base layer, so any land edit redrew it.
- The land measured in each hex for the coverage report: about 95 ms, every target hex measured
  again by scanline.

**Changes:**
- **River names, all builds.** Each river's reuse key now holds a fingerprint of the land near its
  course instead of the whole-map land:
  - the `landNear` fingerprint (§95) of every hex whose box comes within the placement's reach of
    the course, with islands and lake water;
  - the whole-map revision, as before, for a course near the page's edge, where a probe could fall
    outside every hex's box.

  Placement already relies on every probe lying within that reach.
- **Pack ice, all builds.** It is cached by what it reads: the ice hexes, their irregularity, and
  which hexes within two rings of the ice are land.
- **Measured land, incremental builds only.** Each coast keeps every target hex's measured land and
  a fingerprint of what decides it:
  - the drawn land's and the coastline stroke's segments in the grid cells its box overlaps, the
    box grown by the ink's reach;
  - whether the hex's centre is on land.

  A hex whose fingerprint is unchanged keeps its value, and the rest are measured as before. In
  six edits checked against a fresh measurement of the same geometry, every kept value was equal.
- **`landNear`.** It now hashes each grid cell's segments once, shared by the hexes whose boxes
  overlap the cell. A cell can hold segments beyond a box, which can only add re-checks. This made
  no measurable difference.

**Measured.**
- Per coastal edit in Node: feature labels fell from about 70 to 30 ms, land and fills from about
  105 to 54 ms, and coverage and lakes from about 92 to 48 ms. About 80% of target hexes keep their
  measured land.
- Per inland edit in Node: feature labels fell from about 120 to 20 ms.
- Paired Node edit runs against §95 (30 pairs each): coastal edits 0.843 of the time, inland edits
  0.726.
- Cold builds: 0.989 (interval 0.952–0.999), with scenes identical.

Browser, `perf:edit-wait --runs 5`, both in one session:

| Edit | Build before | Build now | Sharp before | Sharp now |
|---|---:|---:|---:|---:|
| coast: land to sea | 1,153 ms | 1,061 ms | 1,396 ms | 1,396 ms |
| coast: sea to land | 995 ms | 875 ms | 1,264 ms | 1,149 ms |
| coast: land share 60% | 837 ms | 756 ms | 1,208 ms | 1,025 ms |
| inland: land to lake | 860 ms | 693 ms | 1,248 ms | 1,012 ms |

Absolute times in this session ran about 9% above §95's for the same code, so only the pairs
compare.

**Tests.** A slow test edits the populated map away from its rivers and ice and checks:
- the pack ice is kept;
- most river names and most measured land are kept;
- the kept river names equal a fresh search on the same land;
- land beside the ice redraws the pack.

**Still map-wide.** The edited landmass's retrace on each share pass, about 150–190 ms. The rest of
the symbols phase, about 45 ms: re-drawing kept fits and escarpments. And paint.

## 97. Parallel coast fits (R4): built, measured, withdrawn

R4 asked whether fitting a cold build's independent coast groups (§90) at the same time, in a
worker pool, would make cold builds 20–35% faster. On the 50×50 interaction map each of the two
fits has three groups: 432, 343 and 25 ms in Node for the first fit, and 181, 118 and 27 ms for the
second. Fitted one after another they take about 0.9–1.0 s of a 2.6–2.9 s cold build. At best, in
parallel, they would take about 0.6 s.

**What was built** (commit c6dd311, reverted in the next commit):
- The coast stage became a generator that yields its group fits as plain jobs. The synchronous
  build ran them in place, with scenes identical (606 tests).
- The paint worker built the coast ahead of the scene. It fitted the largest group itself while
  helper workers, made by the paint worker, fitted the rest. The build that followed found the coast
  cached.
- Jobs carry only what the fit reads: about a sixth of the copying (19 ms against 114 ms per job),
  with identical results.
- Helpers are made when the paint worker starts. In Chromium a worker made by a worker loads through
  its maker's event loop, so one made at the start of a build did not start until the paint worker
  had finished its own fit. The build waited, for at most 250 ms, for the helpers to start.
- Vite bundles the nested worker.

**Measured**, `perf:edit-wait`, 12 cold builds each, alternating, in one session:

| Variant | Cold build | Fit |
|---|---:|---:|
| Pool, three helpers | 2,716 ms | 1,036 ms |
| No pool | 2,749 ms | 1,001 ms |
| Pool, one helper | 2,700 ms | 983 ms |
| No pool | 2,674 ms | 958 ms |
| Pool, helpers warmed by small fits while idle | 2,787 ms | 932 ms |
| No pool | 2,583 ms | 925 ms |

Once the helpers started promptly, the wait for them after the paint worker's own fit fell to
15–120 ms. But every fit ran about 1.5× slower while others ran beside it: the paint worker's two
largest fits took 750–800 ms in all, against about 520 ms alone. The fits done by the helpers took
about 730–780 ms.

The browser does run workers in parallel. A spin loop and a simple allocation loop scale to three
workers, and in Node two of these fits run together only about 10% slower than alone. Run warm in
the browser, after a second of warm-up fits, two workers together took roughly what each took alone
(noisy: 173–491 ms alone, 287–487 ms together). The loss is in a cold build. Each fresh worker
compiles the fit's code from scratch. Fits warmed while idle compete with the paint worker's trace
on this four-vCPU container, which made the cold build slower.

**Decision.** Withdrawn: this container shows no gain, and the plan requires each step to show its
gain. It may help on machines with more free cores, but that has not been measured. The generator
split is the part worth reusing if R4 is tried again.
- `perf:edit-wait` would need its fit worker passed as a blob URL, as in c6dd311. Playwright's
  routes do not see requests made from inside a worker.
- The cold-JIT cost would need addressing first: fewer, longer-lived helpers, or helpers kept warm
  across builds.

## 98. Paint without a GPU (R5): what rasterizing costs

R5 asked how much of paint a GPU-backed browser would remove before any work on paint. No GPU is
available here, so `npm run perf:paint-split` measures the bound instead. It paints the 50×50
interaction map's scene as the paint worker does, at a 1400×900 view, and times two paints (median
of 7):
- to a real OffscreenCanvas, which headless Chromium rasterizes in software;
- to a stub context that accepts every call and draws nothing. Its composite layers are 1×1, so
  this is the cost of walking the scene, building paths and issuing commands.

| View | dpr | Paint | Commands | Rasterizing |
|---|---:|---:|---:|---:|
| fit | 1 | 203 ms | 24 ms | 179 ms |
| fit | 2 | 361 ms | 26 ms | 335 ms |
| zoom 1 | 1 | 98 ms | 7 ms | 91 ms |
| zoom 1 | 2 | 247 ms | 10 ms | 237 ms |
| zoom 2 | 1 | 62 ms | 3 ms | 59 ms |
| zoom 2 | 2 | 165 ms | 6 ms | 159 ms |

About 88–96% of paint is rasterizing pixels. A GPU-backed 2D canvas, which Chrome uses in workers
where a GPU is available, does that on the GPU. Commands still cost 3–26 ms per frame.

**Decision.** No CPU-side work on paint is planned. The 0.2–0.27 s that `perf:edit-wait` reports
for paint is mostly software rasterizing in this headless container, and overstates paint on GPU
hardware.
- Commands are at most about 26 ms per frame and do not justify work either.
- If paint matters on real devices, measure it there first: a frame's `paintMs` from the editor's
  render profile.
- The only CPU-side lever on rasterizing is drawing fewer or cheaper primitives. That changes the
  picture, and it is a style decision, not a performance one.

## 99. Whole-map work inside the coast stage: rim curves, anchor snapping, component keys

**Context.** After §96–§98 the owner noted the goal is speed, not completing plan steps. A profile
of coastal edits then showed several pieces of whole-map work that run on every trace or fit,
however small the edit. All three changes below are exact: scenes are identical (paired cold builds
check identity).

**Changes:**
- **Anchor snapping.** About 35 ms per coastal edit, 90% of it nearest-point searches; it moves
  each of about 2,300 anchors to the coast.
  - Each ring of grid cells was found by scanning the whole square of cells and skipping the
    interior. It now visits only the ring's border cells, in the same order.
  - Cells are half a hex instead of a whole hex. Each search tested about 120 segments, about
    14 per cell; it now tests far fewer.
  - The visiting order changes, so the first of two segments at exactly the same distance could
    in principle differ. Scenes are unchanged.
- **Rim curves.** For an open coast's end curve to the page edge, the safety check tested every
  segment of every coast. It now skips rings whose box misses the curve's box, which a quadratic
  curve cannot leave.
- **Component cache keys.** Every trace keys each of about 100 coast components by its edges and by
  every edge its clearance queries could inspect. That signature collected each edge's bins
  grown by three (49 bins per edge) and turned the edges found into JSON, about 17 ms per
  coastal edit. Now:
  - each bin's edges are hashed once per index and shared by the components near it;
  - each component's bins are grown separably, three across and then three down, which gives the
    same bins;
  - the bin hashes are combined into four 32-bit lanes.

  An edge's place along its own chain is no longer hashed: it follows from the chain's own
  edges, which the key already holds. `hashNumbers` and `hashText` moved to `hash.ts`.

**Tried and dropped.**
- One trace per incremental edit instead of three, and then two: the passes moved nearby hexes by
  only a few hundredths each, and two traces would save about 85–170 ms.
  - One trace broke the share gate: hex 513 missed its share where a fresh build reaches it.
  - Two traces broke the far-coast gate: 8.25 px of movement.
  - Starting nearby hexes from their settled shares passed both gates but did not save a trace.

**Measured.** Paired Node runs against §98 (30 pairs each): coastal edits 0.928 of the time,
inland edits 0.945. Cold builds 0.983 (interval 0.940–1.020), unresolved, with scenes identical.

**Addendum: fit cache keys.** `cachedCoastFit` keyed each group by its paths and held-back detail
serialized to JSON, the continent's thousands of path commands included, on every fit. Paths are
now keyed by a four-lane hash of their commands and every coordinate's bits, word by word and kept
per path array. Detail is keyed by a hash of its keys and offsets.
- The key phase fell from about 15 to 8 ms per coastal edit.
- Paired Node runs (40 pairs each): coastal edits 0.986, inland edits 0.975, within noise.
- Cold builds 0.990, unresolved, scenes identical.
- A byte-wise version of the hash showed no gain (coastal edits 1.036, inland 0.958); the word-wise
  version replaced it.

## 100. Incremental coasts redraw edits to a hex's shape alone (review of PR #183)

**Bug.** A code review of PR #183 (Codex) found the following. An edit that changes a hex's
irregularity or concentration, or the map's default irregularity, without changing any land share
or passage width, was lost in an incremental build:
- Both incremental stages decided what changed from targets alone: the share passes (§95) and
  the fit's window planner (§94).
- The planner tolerates the new trace's small differences, so it kept the whole previous fit.
- Reproduced on a 12×10 map: the coast was byte-identical before and after the edit, while an
  uncached build showed it.

**Fix.** Each hex has a shape signature: its stored shape, its resolved shape settings (with the
map default), the lake default for lake hexes, and its island spec. In incremental builds:
- the share passes count a hex whose signature changed as changed, so it and the hexes within two
  rings are measured and moved;
- the fit records the signatures, and the window planner counts a hex whose signature changed as
  changed, together with its neighbours.

A map-wide setting changes every hex, so the coast is fitted whole.

**Test.** `test/coastShapeEdits.test.ts`, which fails without the fix, checks two cases:
- A default-irregularity change gives exactly a fresh build's coast.
- One hex's concentration, then its irregularity, each move the coast within 1.2 hexes of that hex
  by more than 0.15 hex. That stretch also stays within 0.2 hex of a fresh build's both ways
  (measured 0.05 and 0.13), as §94 allows.

Edit times are unchanged: paired runs 0.995 coastal and 1.024 inland, within noise.

## 101. A strait or isthmus is a short narrows between two rounded tips, wherever it lies

**Definitions.** A Strait is a water channel joining two waters between two land masses; an Isthmus is a
land neck joining two land masses between two waters. A hex is either only with exactly two separate land
groups and two separate water groups round it (`passageNeighbours`); three of either is not one passage and
fails validation. Up to rotation and reflection that leaves five neighbour patterns: banks opposite, banks
two apart, three land sides (runs of two and one), and four land sides (runs of two and two, or three and
one). A Mainland and islands hex keeps 2.5% for its mainland and each island's minimum (2.5% small, 5% large).

**Chosen.** Sea straits, sea isthmuses and isthmuses in lakes take the local shore field that lake straits
had (decision 47's lake passage work): the coast is traced with the passage hex open (a strait's as sea, an
isthmus's as land), the shore round it is reshaped into two rounded tips a throat of the set width apart,
and the result is joined to that coast on a circle 1.55 to 1.85 radii out, beyond which the field is the
old shore (`passageContour`, `spliceChainPaths`). A join that fails keeps the passage's own cut rather than
the opened background. The set width is the narrowest point; the shores open quickly either side of it.

**Shape.** Narrower throats take sharper tips (radius 0.3 to 0.48 of the hex radius with width), so that a
Very narrow passage is not a thin gap held parallel for half a hex. The flanks recede at a blunt tip's
rate, and where the throat is moved towards one side they return to a blunt tip's from half a hex out, so
that the far banks stay on their roots. A bank of three edges is rooted at the mean of its edges' midpoints
(the chord across them passes through the hex centre and crowded the throat against the opposite bank).
Shore detail is capped at half the local half-width and cannot pinch a passage shut.

**Land share.** Unset, a passage counts the share its natural shape is drawn with (`NATURAL_PASSAGE_LAND`,
the median over the five patterns to 2.5%): straits 55, 47.5, 40 and 25% from Very narrow to Wide,
isthmuses 45, 52.5, 62.5 and 75%. A share that is set is fitted by headland depth, never below the depth at
which the banks part by a quarter hex within 0.4 radii of the tips; a share beyond that is left short and
reported, not drawn as a canal. Measured across the five patterns, a strait can then be drawn with about
21–75% land at Very narrow, 19–64% Narrow, 15–53% Normal and 8–40% Wide; an isthmus with about 33–85%,
43–87%, 54–90% and 72–95%.

**Bounds by width.** Those measurements, to 5%, are the shares a passage may be set to
(`PASSAGE_LAND_RANGE`): a strait 20–75% Very narrow, 20–65% Narrow, 15–55% Normal and 10–40% Wide; an
isthmus 35–85%, 45–85%, 55–90% and 70–95%. They replace the fixed type bounds (Strait 10–70%, Isthmus
15–80%), which allowed shares no width can draw as a narrows (an isthmus at 15%, a Wide strait at 70%) and
ruled out natural ones (a Wide isthmus above 80%). The range follows the width the hex is drawn at, its own
or the map's: the land share settings offer only that range, a share set outside it is held to it, and
changing the width holds a share already set to the new range. A share saved outside it reads as the
nearest one allowed and is flagged by validation; without a width (`landShareRange` called bare) the range
covers every width.

**Old passage defaults cleared once.** Decision 49 has maps saved with the old map-wide defaults (isthmus
70% or 30%, strait 40%) load as unset. That was done on every read of the dimensions, so the same values
chosen later (40% is a Normal strait's, 70% a Normal isthmus's) were dropped too and never took effect. It
is now a load migration that runs once, marked by `chosenPassageShares` (set on new maps), and clears the
current dimensions and the undo history's alike; a map-wide passage share after that is kept whatever it is.

**Why.** A uniform channel or neck through the hex is a canal, not a strait or isthmus, and counting a
strait's share as one (65% land at Normal) described a shape that is never drawn.

