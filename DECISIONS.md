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

**Bends.** After the course is fitted through the edge crossings it is smoothed by arc length (a Gaussian about
0.4 of a hex across), kept inside the river's own hexes (with a little give at the corners) and held fixed at
both ends so confluences and forks still land on their host. A turn that is already close to a hairpin is
smoothed less, and if smoothing would leave any turn sharper than the line began with, it is applied at a
smaller strength or not at all: a bend is widened, never pinched.

**Coast.** A river into the sea is cut where the coast is drawn, found from the coast lines themselves (land is
on the right of each line, so the side a point falls on says whether it is land, however the coast has been
reshaped, smoothed or roughened), and flares there; where the coast bulges past the hex's edge the river is
carried on to it. Points of the course that would swing off the land are pulled back. This replaces the clip
over the water strips, which cut the mouth off flat at the hex's old edge.

**Lakes.** A river may run through a lake: validation no longer warns about a lake hex in the middle of a path,
merging two rivers bridges a lake, and the prompts say rivers may link lakes. Where it crosses the water it is
hidden (the river is the lake there), so it shows on either side. Rivers that begin or end at a lake still stop
at its shore.

**Cities.** A city on a river is no longer ringed in a disc of water. The river keeps its course and the marker is
placed against it by size, in every marker set: villages and towns stand on the bank, a city on the bank with the
river grazing its edge, and only a metropolis stands on the river, which runs across it as a band and splits
the marker. The offset is taken from the river's drawn width at that point, on whichever bank is land. The legend
says "Beside a river". Label placement allows for the band only on a metropolis.
