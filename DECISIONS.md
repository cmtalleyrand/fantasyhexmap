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
