/**
 * Prompt construction, one builder per layer.
 *
 * Conventions that run through all of them:
 *  - Context grids travel as one line per row, so the model reads the map as a
 *    picture, with row labels and a column anchor every five cells so that
 *    position is read rather than counted (see `gridView` in core/grid.ts), and
 *    with the hex counts measured by code rather than left to the model.
 *  - Output grids are described in whichever form the caller asked for: keyed
 *    cell by cell for the API, which enforces it, or row strings for webchat.
 *  - The brief outranks every default in the prompt, and every response opens
 *    with the model's reading of it - the scale, and each requirement as a
 *    concrete target - before any of the layer is written.
 *  - The stable rules (grid geometry, scale, house style) live in the system
 *    prompt so they cache; only the varying map state goes in the user turn.
 */

import {
  BASE_LEGEND,
  ELEVATION_LEGEND,
  POLITY_UNCLAIMED,
  VEGETATION_CODES,
  encodeBase,
  encodeClimate,
  encodeElevation,
  encodePolityRows,
  encodePopulation,
  encodeVegetation,
} from '../shared/codec.js';
import { LAYER_META } from '../shared/layers.js';
import { keyAt, type PassId, type Roster } from './rosters.js';
import { gridView, tally } from './grid.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  VEGETATION_GROUPS,
  VEGETATION_VALUES,
  type BaseGeo,
  type LayerId,
  type VegetationGroup,
} from '../shared/types.js';
import type {
  BaseData,
  CitiesData,
  ClimateData,
  ElevationData,
  PolitiesData,
  PopulationData,
  RiversData,
  VegetationData,
} from '../shared/types.js';

export interface PromptContext {
  description: string;
  cols: number;
  rows: number;
  base: BaseData | null;
  elevation: ElevationData | null;
  climate: ClimateData | null;
  vegetation: VegetationData | null;
  rivers: RiversData | null;
  cities: CitiesData | null;
  polities: PolitiesData | null;
  population: PopulationData | null;
  /** Free-text edit instruction; when present the layer is being revised, not generated fresh. */
  instruction?: string | null;
  /**
   * Layers this map has chosen not to have at all. The distinction from "not
   * generated yet" matters to the model: a layer that is merely pending can be
   * deferred to, while one that is excluded never arrives, so anything that
   * would have depended on it has to be settled now.
   */
  excluded?: LayerId[];
  /** Cities may stand on, and polities own, Sea and Lake hexes on this map. */
  allowUnderwater?: boolean;
  /**
   * How grids are to be returned: 'keyed' (cell by cell, enforced by the API's
   * grammar) or 'rows' (one string per row, for the webchat path). Only changes
   * the output instructions; context grids are shown the same way either way.
   */
  gridFormat?: 'rows' | 'keyed';
  /**
   * Webchat's compact style: the reply carries only the layer data as JSON, and
   * the plan and the decisions are written in the chat around it.
   */
  decisionsInChat?: boolean;
}

const isExcluded = (ctx: PromptContext, layer: LayerId) =>
  (ctx.excluded ?? []).includes(layer);

/**
 * What to tell the model about a layer it would normally read but cannot see.
 * `pending` is used when the layer is simply not generated yet; `never` when the
 * map will not have one.
 */
function absentLayerNote(
  ctx: PromptContext,
  layer: LayerId,
  pending: string,
  never: string,
): string {
  return isExcluded(ctx, layer) ? never : pending;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/* ----------------------------------------------------------------- shared */

export function gridRules(cols: number, rows: number): string {
  return `THE GRID
The map is a rectangular grid of pointy-top hexes, ${cols} columns wide and ${rows} rows tall (${cols * rows} hexes).
- Columns are numbered 0 to ${cols - 1}, west to east. Rows are numbered 0 to ${rows - 1}, north to south.
- Row 0 is the northern edge of the map; row ${rows - 1} is the southern edge.
- Odd-numbered rows are offset half a hex east of even-numbered rows.
- Neighbours of hex (c, r) depend on the parity of r:
    even r:  E=(c+1,r)  SE=(c,r+1)    SW=(c-1,r+1)  W=(c-1,r)  NW=(c-1,r-1)  NE=(c,r-1)
    odd  r:  E=(c+1,r)  SE=(c+1,r+1)  SW=(c,r+1)    W=(c-1,r)  NW=(c,r-1)    NE=(c+1,r-1)
- Nothing exists beyond the grid: the map edge is either open ocean continuing off-map, or land continuing off-map. Do not treat it as a wall.

${scaleRules(cols, rows)}`;
}

/**
 * How to turn the brief's sizes into hexes.
 *
 * This used to tell the model not to assume a scale unless the brief "states or
 * clearly entails one" - and gave it no way to act on one when it did. A brief
 * that gave areas got maps that ignored them, because nothing converted
 * "100,000 km2" into a number of hexes. The arithmetic is spelled out here so it
 * is done, and done the same way in every layer.
 */
function scaleRules(cols: number, rows: number): string {
  return `SPATIAL SCALE - work it out first, then use it
- If the brief gives ANY size - the extent of the world, a continent, a sea or a realm; an area; a distance; a length;
  a travel time - derive the hex width w (km between the centres of neighbouring hexes) from it and state it in
  "brief.scale". At width w the map spans about ${cols}w km west to east and ${(rows * 0.866).toFixed(1)}w km north to south.
- One hex covers about 0.866 x w^2 km^2 (w = 50 km: ~2,165 km^2 per hex; w = 100 km: ~8,660 km^2).
- Convert every stated area into a hex count with that figure, and build to it: a realm the brief puts at 100,000 km^2
  is ~46 hexes at w = 50 km - not 20, not 90. Convert lengths and distances the same way (600 km at w = 50 km is ~12 hexes).
- If a base geography already exists, the scale is already fixed by it: use its measured hex counts to find the w
  that makes the brief's stated sizes match what is drawn, rather than choosing a new one.
- If the brief's sizes cannot all be met at one scale, honour the most specific and important ones and say in
  "brief" which you bent and by how much.
- If the brief gives no size of any kind, do not invent one: reason from proportions and relative positions, and
  write "No scale given".`;
}

function rowFormatRules(cols: number, rows: number, kind: 'char' | 'token', format: PromptContext['gridFormat']): string {
  if (format === 'keyed') {
    return `OUTPUT FORMAT
"rows" is an object with one key per grid row: "r0" (northern edge) to "r${rows - 1}" (southern edge). Each row is an
object with one key per hex: "c0" (western edge) to "c${cols - 1}" (eastern edge), holding that hex's ${kind === 'char' ? 'single character' : 'single code'}.
Cell cN of row rM is the hex at column N, row M - the same hex that sits at column N of row M in every context
grid, where the "[n]" anchors show you the column. Keep every feature at its true position.`;
  }
  return kind === 'char'
    ? `OUTPUT FORMAT
Return exactly ${rows} strings in "rows", one per grid row from north (row 0) to south (row ${rows - 1}).
Each string is exactly ${cols} characters long, one character per hex from west (col 0) to east (col ${cols - 1}).
No spaces, no separators, no row labels, no "[n]" anchors, no commentary inside the strings.`
    : `OUTPUT FORMAT
Return exactly ${rows} strings in "rows", one per grid row from north (row 0) to south (row ${rows - 1}).
Each string holds exactly ${cols} space-separated tokens, one per hex from west (col 0) to east (col ${cols - 1}).
No row labels, no "[n]" anchors and no commentary inside the strings.`;
}

function polityGridOutput(ctx: PromptContext): string {
  if (ctx.gridFormat === 'keyed') {
    return [
      `"rows" is an object with keys "r0" (north) to "r${ctx.rows - 1}" (south); each row has keys "c0" (west) to "c${ctx.cols - 1}" (east),`,
      `holding the polity key that owns that hex, or "${POLITY_UNCLAIMED}" for unclaimed. Cell cN of row rM is the hex at`,
      'column N, row M in the context grids - use their "[n]" anchors to keep every border at its true position.',
    ].join('\n');
  }
  return [
    `Return ${ctx.rows} row strings of exactly ${ctx.cols} characters, one polity key per hex, "${POLITY_UNCLAIMED}" for unclaimed.`,
    'No spaces, no separators, no row labels, no "[n]" anchors.',
  ].join('\n');
}

export function descriptionBlock(description: string): string {
  return `THE BRIEF (the user's description of this world - it is the authority on everything it mentions)
<description>
${description.trim() || '(no description given - invent something coherent and interesting)'}
</description>`;
}

function editBlock(instruction: string, layer: LayerId): string {
  return `EDIT INSTRUCTION
The ${LAYER_META[layer].label} layer already exists and is shown above. The user asks for this change:
<instruction>
${instruction.trim()}
</instruction>

Apply it to the whole layer and return the COMPLETE updated layer, not only the hexes you changed.
Everything the instruction does not touch must come back unchanged. Where the instruction implies knock-on
effects within this layer (a new mountain range changes the coastline around it, a new polity takes hexes from
its neighbours), make them - but stay inside this layer.`;
}

function section(title: string, lines: string[]): string {
  return `${title}\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------ context grids */

/**
 * Context grids are shown with row labels and column anchors (see `gridView`),
 * plus the totals measured from the data. Counting a grid is exactly what a
 * model is bad at and code is perfect at, and those totals are what a stated
 * area has to be checked against - "the brief says a third of the continent is
 * desert" means nothing without knowing how many land hexes there are.
 */
function measured<T extends string>(values: (T | null | undefined)[], order: readonly T[], label = (v: T) => v as string): string {
  const counts = tally(values);
  const parts = order.filter((v) => counts.has(v)).map((v) => `${label(v)} ${counts.get(v)}`);
  return `Measured hex counts: ${parts.join(', ') || 'none'}.`;
}

const LAND_VALUES: BaseGeo[] = ['Land', 'Coastal Land', 'Island'];

function baseGrid(ctx: PromptContext, title = 'BASE GEOGRAPHY'): string {
  const base = ctx.base!;
  const land = base.filter((v) => LAND_VALUES.includes(v)).length;
  return section(title, [
    BASE_LEGEND,
    `${measured(base, BASE_GEO_VALUES)} Land-type hexes (Land + Coastal Land + Island): ${land} of ${base.length}.`,
    ...gridView(encodeBase(base, ctx.cols, ctx.rows), 'char'),
  ]);
}

function elevationGrid(ctx: PromptContext, title = 'ELEVATION'): string {
  return section(title, [
    ELEVATION_LEGEND,
    measured(ctx.elevation!, ELEVATION_VALUES),
    ...gridView(encodeElevation(ctx.elevation!, ctx.cols, ctx.rows), 'char'),
  ]);
}

function climateGrid(ctx: PromptContext, title = 'CLIMATE'): string {
  return section(title, [
    measured(ctx.climate!, CLIMATE_VALUES),
    ...gridView(encodeClimate(ctx.climate!, ctx.cols, ctx.rows), 'token'),
  ]);
}

function vegetationGrid(ctx: PromptContext, title = 'VEGETATION (two-letter codes)'): string {
  return section(title, [
    measured(ctx.vegetation!, VEGETATION_VALUES, (v) => `${VEGETATION_CODES[v]} (${v})`),
    ...gridView(encodeVegetation(ctx.vegetation!, ctx.cols, ctx.rows), 'token'),
  ]);
}

function populationGrid(ctx: PromptContext, title = 'POPULATION'): string {
  const total = ctx.population!.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return section(title, [
    `Measured rural total: ${total.toLocaleString('en-US')}.`,
    ...gridView(encodePopulation(ctx.population!, ctx.cols, ctx.rows), 'token'),
  ]);
}

function polityGrid(ctx: PromptContext, title: string, withColours: boolean): string {
  const polities = ctx.polities!;
  const keyOf = new Map(polities.polities.map((p, i) => [p.id, keyAt(i)]));
  const counts = tally(polities.owner);
  return section(title, [
    ...polities.polities.map(
      (p, i) =>
        `${keyAt(i)} = ${p.name}${withColours ? ` (${p.colour})` : ''} - ${counts.get(p.id) ?? 0} hexes`,
    ),
    `${POLITY_UNCLAIMED} = unclaimed`,
    ...gridView(encodePolityRows(polities.owner, keyOf, ctx.cols, ctx.rows), 'char'),
  ]);
}

const DECISION_GUIDANCE = `- Write about choices, not contents. "The eastern basin is BWk" is data the map already shows.
  "The eastern basin is arid because the Spine takes the westerly rain out of the air before it gets
  there, which is what the brief's rain-shadow desert asks for" is a decision.
- Say what you did with the brief: which cue you followed, where two parts of it pulled against each
  other and how you resolved that, and what you invented because the brief was silent.
- Include anything a reader would otherwise think was a mistake - a desert at a temperate latitude,
  a great city on a frontier, an empty quarter no polity claims.
- Be specific and be brief. Three good sentences beat a paragraph of hedging.`;

export function recordDecisions(ctx: PromptContext): string {
  if (ctx.decisionsInChat) {
    return `EXPLAIN YOUR DECISIONS IN THE CHAT
After the JSON, explain in ordinary prose the 3 to 8 decisions that most shaped this layer. Do not put
notes or decisions inside the JSON. This is read by the person whose world this is.

${DECISION_GUIDANCE}
- Name places and give hex coordinates as (column,row) where they help.`;
  }
  return `RECORD YOUR DECISIONS
Along with the layer, return the 3 to 8 decisions that most shaped it, in "decisions". This is read
by the person whose world this is, and it is the only record of why the map looks the way it does.

${DECISION_GUIDANCE}
- Name places and give hex coordinates where they help. Use the "hexes" field for the hexes a
  decision is actually about; leave it empty for decisions about the map as a whole.`;
}

function planInstruction(ctx: PromptContext): string {
  const where = ctx.decisionsInChat
    ? 'write in the chat, before the JSON,'
    : 'fill in "brief":';
  return `Before writing any of the layer, ${where} the scale, and every statement in the brief that bears on this
layer, each turned into a concrete target on this grid - a hex count, a place given by rows and columns, a relative
size. Then build the layer to meet those targets, and check it against them before you finish.`;
}

export function houseStyle(ctx: PromptContext): string {
  return `THE BRIEF COMES FIRST
The brief is the user's specification, not a source of inspiration. Everything else in this prompt - typical sizes,
usual placements, suggested counts, default proportions, "usually" and "rarely" - is a default for where the brief is
silent. Where the brief is specific (a size, an area, a distance, a position, a count, a named feature, something
that must not exist), it overrides those defaults every time. A layer that contradicts a specific statement in the
brief is wrong, however plausible it looks.

${planInstruction(ctx)}

HOW TO WORK
- Think about the map as a whole before writing any of it. Geography is continuous: coastlines, ranges, climate belts and borders are large connected shapes, not per-hex noise.
- Never produce speckle - isolated single hexes of one value scattered through a field of another - unless the brief explicitly calls for it (an archipelago, an oasis chain).
- Keep positions exact. Read where things are from the row labels and "[n]" column anchors in the context grids, not by counting characters, and put each value at the same row and column as the hex it describes.
- Where the brief is silent, make a decision that is plausible and interesting rather than uniform.`;
}

/* -------------------------------------------------------------------- base */

function basePrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a cartographer generating the base geography layer of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('THE LEGEND', [
      BASE_LEGEND,
      '',
      'Land   - ordinary dry land.',
      'Coastal Land - predominantly dry land containing a shoreline; use where the coast crosses a hex rather than following its edge.',
      'Sea    - open salt water, connected (directly or through other Sea hexes) to the edge of the map.',
      'Lake   - fresh water fully enclosed by land; a lake never touches a Sea hex.',
      'Ice    - permanent ice sheet or shelf. Use only where the brief implies polar or glacial conditions.',
      'Island - a hex that is mostly sea but holds a small landmass;',
      '         there is no mixed land+lake value. Use it for archipelagos, skerries and lone islets,',
      '         not for large islands (a large island is Land hexes surrounded by Sea).',
    ]),
    '',
    section('GEOGRAPHIC SENSE', [
      '- Coastlines are continuous and irregular: bays, peninsulas, headlands. Not a rectangle of land in a rectangle of sea.',
      '- Seas connect to the map edge. An enclosed body of water surrounded by land is a Lake, however large.',
      '- Lakes sit inland, usually in lowlands or between highlands, and are small - one to a few hexes - unless the brief makes one larger.',
      '- Ice belongs at the northern or southern edge of the map, or on high ground if the brief says so.',
      '- Islands cluster: chains, arcs off a coast, scatterings in a strait. A lone Island hex in mid-ocean is rare.',
      '- If the brief gives no land/water balance, aim for roughly half the map as land.',
    ]),
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'char', ctx.gridFormat),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [descriptionBlock(ctx.description)];
  if (ctx.instruction && ctx.base) {
    parts.push(
      '',
      baseGrid(ctx, 'CURRENT BASE GEOGRAPHY'),
      '',
      editBlock(ctx.instruction, 'base'),
    );
  } else {
    parts.push(
      '',
      `Generate the base geography for this world as a ${ctx.cols} x ${ctx.rows} hex grid.`,
    );
  }
  return { system, user: parts.join('\n') };
}

/* --------------------------------------------------------------- elevation */

function elevationPrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a cartographer generating the elevation and ruggedness layer of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('THE LEGEND', [
      ELEVATION_LEGEND,
      '',
      'Lowland   - plains and coastal flats near sea level.',
      'Rolling   - gentle undulating country.',
      'Hills     - broken, hilly ground.',
      'Highland  - high ground, rugged, below the treeline.',
      'Mountains - high and severely rugged; passes are few.',
      'Plateau   - HIGH elevation with LOW ruggedness: a tableland. This is the important one to get right.',
    ]),
    '',
    section('ELEVATION AND RUGGEDNESS ARE TWO PROPERTIES, NOT ONE SCALE', [
      'These values are not a single ordered ladder. Lowland -> Rolling -> Hills -> Highland -> Mountains does rise',
      'in both height and roughness together, but Plateau does not sit at a fixed point in that sequence: it is',
      'high like Highland and smooth like Lowland. Do not treat Plateau as "between Hills and Mountains", do not',
      'use it as a transition step, and do not assume it is comparable to Hills or Mountains in a single ordering.',
      'Place a Plateau where a raised tableland belongs - above an escarpment, walled by ranges, an uplifted basin -',
      'and let it cover a broad, coherent block of hexes, because that is what tablelands look like.',
    ]),
    '',
    section('WHERE THINGS GO', [
      '- Mountains form connected chains and arcs, usually along one flank of a landmass or between two of them. Never scatter lone Mountain hexes.',
      '- A range grades outward: Mountains at the spine, Highland or Hills on the flanks, Rolling then Lowland beyond.',
      '- Hexes adjacent to Sea trend Lowland; a coast that rises straight to Mountains needs a reason in the brief.',
      '- Ice and Lake hexes get no value. Sea hexes get no value.',
      '- Island hexes: use Lowland unless the brief describes those islands as mountainous.',
    ]),
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'char', ctx.gridFormat),
    '',
    'A hex that is not Land, Coastal Land or Island MUST be "." in your output.',
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.instruction && ctx.elevation) {
    parts.push(
      '',
      elevationGrid(ctx, 'CURRENT ELEVATION'),
      '',
      editBlock(ctx.instruction, 'elevation'),
    );
  } else {
    parts.push('', 'Generate the elevation layer for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* ----------------------------------------------------------------- climate */

function climatePrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a climatologist assigning full Köppen climate classifications to a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('PERMITTED VALUES (full Köppen - use these exact codes, nothing else)', [
      'A tropical:     Af (rainforest)  Am (monsoon)  Aw (savanna)',
      'B arid:         BWh (hot desert)  BWk (cold desert)  BSh (hot steppe)  BSk (cold steppe)',
      'C temperate:    Csa Csb (mediterranean)  Cfa (humid subtropical)  Cfb (oceanic)  Cwa (dry-winter subtropical)',
      'D continental:  Dfa Dfb (humid continental)  Dfc (subarctic)  Dsa Dsb (dry-summer continental)  Dwa Dwb (dry-winter continental)',
      'E polar:        ET (tundra)  EF (ice cap)',
      '',
      CLIMATE_EMPTY_NOTE,
    ]),
    '',
    section('HOW TO DECIDE', [
      '1. LATITUDE FIRST. Decide from the brief what latitude band this map covers, state it in "latitudeBand",',
      '   and map row 0 to the northern end of that band and the last row to the southern end. If the brief gives',
      '   no clue, choose a band that suits what it does describe (a frozen north and a desert south needs a wide',
      '   band; a single kingdom needs a narrow one). Latitude sets the baseline belt for each row.',
      '2. ELEVATION SECOND. Alpine cooling is real: Highland and Mountains hexes shift one or two steps colder than',
      '   their latitude (a Cfa lowland becomes Cfb or Dfb on Highland, ET on Mountains). Plateaus are cool and,',
      '   being inland tablelands, usually drier - often BSk or Dwb.',
      '3. CONTINENTALITY THIRD. Hexes far from any Sea swing to continental (D) or arid (B); hexes on the coast',
      '   stay maritime (Cfb, Csb, Cfa) with milder ranges.',
      '4. RAIN SHADOW FOURTH. Air rises and drops its rain on the windward flank of a range and descends dry on the',
      '   lee. Assume prevailing westerlies in the temperate bands and easterlies in the tropics unless the brief',
      '   says otherwise. The lee of a north-south range is a B-group belt, often BWk or BSk - this is where',
      '   deserts come from, not from latitude alone.',
      '5. THE BRIEF OVERRIDES ALL OF THE ABOVE. If it names a rain-shadow desert, a monsoon coast or an eternal',
      '   winter, produce it, even where latitude alone would not.',
    ]),
    '',
    section('COHERENCE', [
      '- Climate belts are bands and blobs, not stripes of alternating codes. Neighbouring hexes should usually share',
      '  a code or a closely related one; a single BWh hex inside Cfb country is an error unless something causes it.',
      '- Do not use E-group codes away from the polar edges or high mountains.',
      '- Sea, Lake and Ice hexes get no value.',
    ]),
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'token', ctx.gridFormat),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push(
      '',
      elevationGrid(ctx),
    );
  }
  if (ctx.instruction && ctx.climate) {
    parts.push(
      '',
      climateGrid(ctx, 'CURRENT CLIMATE'),
      '',
      editBlock(ctx.instruction, 'climate'),
    );
  } else {
    parts.push('', 'Generate the climate layer for this map.');
  }
  return { system, user: parts.join('\n') };
}

const CLIMATE_EMPTY_NOTE = 'Use -- for any hex that is not Land, Coastal Land or Island (Sea, Lake and Ice hexes get no climate).';

/* -------------------------------------------------------------- vegetation */

function vegetationLegend(): string[] {
  const lines: string[] = [];
  for (const group of Object.keys(VEGETATION_GROUPS) as VegetationGroup[]) {
    const items = VEGETATION_GROUPS[group]
      .map((v) => `${VEGETATION_CODES[v]} = ${v}`)
      .join(', ');
    lines.push(`${group}: ${items}`);
  }
  lines.push('-- = no value (Sea, Lake or Ice hex)');
  return lines;
}

function vegetationPrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a biogeographer assigning land cover to a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('PERMITTED VALUES (two-letter codes; the four groups are for your reasoning, you output the leaf value)', vegetationLegend()),
    '',
    section('WHAT THE GROUPS MEAN', [
      'Ungrazed   - natural cover that will not meaningfully support grazing or cultivation.',
      'Grassland  - open country that supports herds: Steppe (cold, dry), Prairie (temperate, tall grass),',
      '             Savanna (tropical, with a dry season), Veld (subtropical upland grass).',
      'Forest     - Tropical Rainforest is equatorial with NO meaningful dry season; Subtropical Rainforest is warm',
      '             and wet but seasonal; Boreal is subarctic; Coniferous and Deciduous are temperate.',
      'Cultivated - land worked by people. Use it where the brief implies settled agriculture, and keep it to the',
      '             fertile parts of the map; most hexes on most maps are not cultivated.',
    ]),
    '',
    section('COHERENCE WITH CLIMATE AND ELEVATION - these are hard rules', [
      '- An Af hex must never be Barren Desert. An ET or EF hex trends to Tundra.',
      '- Breadbasket and Black Earth belong in temperate or continental climates (C or D group) at Lowland to Rolling',
      '  elevation. Never in Af tropics, never on Mountains.',
      '- Assart (woodland cleared for farming) requires a climate that would otherwise support Deciduous Forest.',
      '- Paddy Fields require a wet climate and should sit on or beside a river, or in a place of very high rainfall.',
      '- Desert Oasis requires a B-group arid climate, and should be rare - a handful of hexes at most.',
      '- Flood Plain belongs on or beside a river.',
      '- Barren Desert belongs in BW climates; Scrubland suits BS and Cs margins; Wetland suits deltas, lake shores',
      '  and cold flatlands.',
      '- Boreal Forest goes with Dfc/Dfb; Tropical Rainforest with Af/Am; Savanna with Aw/BSh; Steppe with BSk/Dsb.',
      '- Mountains carry little: Tundra, Scrubland, Coniferous Forest on the flanks. Never a Breadbasket.',
    ]),
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'token', ctx.gridFormat),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.climate) {
    parts.push('', climateGrid(ctx));
  } else {
    parts.push(
      '',
      absentLayerNote(
        ctx,
        'climate',
        'No climate layer exists yet - infer climate from latitude and elevation as you go.',
        'This map will have no climate layer at all. Work out the climate for yourself from latitude, elevation, distance from the sea and rain shadow, commit to it, and say in your notes what you assumed - nothing later will correct it.',
      ),
    );
  }
  if (ctx.rivers && ctx.rivers.rivers.length > 0) {
    parts.push('', section('RIVERS (hexes each river runs through, source to mouth)', riverSummary(ctx.rivers)));
    parts.push('Flood Plain and Paddy Fields should correlate with these river hexes and their neighbours.');
  } else {
    parts.push(
      '',
      absentLayerNote(
        ctx,
        'rivers',
        'No rivers layer exists yet. Place Flood Plain and Paddy Fields only where a major river is strongly implied by the terrain; they can be revised after rivers are generated.',
        'This map will have no rivers layer. Decide where the major watercourses must run from the terrain alone, and place Flood Plain and Paddy Fields accordingly - there will be no later pass to correct them.',
      ),
    );
  }
  if (ctx.instruction && ctx.vegetation) {
    parts.push(
      '',
      vegetationGrid(ctx, 'CURRENT VEGETATION'),
      '',
      editBlock(ctx.instruction, 'vegetation'),
    );
  } else {
    parts.push('', 'Generate the vegetation layer for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* ------------------------------------------------------------------ rivers */

function riverSummary(rivers: RiversData): string[] {
  return rivers.rivers.map(
    (r) =>
      `${r.name}: ${r.segments.map((s) => `(${s.col},${s.row})`).join(' -> ')} [${r.terminus}]` +
      ` navigable: ${r.segments.map((s) => (s.navigable ? 'Y' : 'n')).join('')}`,
  );
}

function suggestedRiverCount(ctx: PromptContext): number {
  return Math.max(2, Math.round((ctx.cols * ctx.rows) / 110));
}

function riversPrompt(ctx: PromptContext): BuiltPrompt {
  const suggested = suggestedRiverCount(ctx);
  const system = [
    'You are a hydrologist laying out the river systems of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('HOW A RIVER IS DESCRIBED', [
      'Each river is an ordered list of hexes from source to mouth. Every consecutive pair in the list MUST be',
      'neighbours by the adjacency table above - a river cannot jump. Use the neighbour rules carefully; the',
      'parity of the row changes which diagonals are adjacent.',
      '',
      'The list starts at the source hex (high ground) and ends either:',
      '  - with the Sea or Lake hex the river empties into (include that water hex as the final entry), or',
      '  - with the land hex on the map border through which the river leaves the map.',
      'Apart from that final mouth hex, every hex in the path must be Land, Coastal Land or Island.',
      '',
      'The "navigable" array has one entry per hex in the path, in the same order.',
    ]),
    '',
    section('HYDROLOGY', [
      '- Rivers rise in Mountains, Highland or Hills and run downhill. Elevation must never increase along a path;',
      '  where it must stay level, that is fine, but it must not climb.',
      '- Every river ends at a Sea, a Lake, or the edge of the map. A river that just stops inland is wrong.',
      '- Longer rivers gather in valleys and lowlands; short torrents run straight off coastal ranges.',
      '- Do not run two rivers along the same hexes for their whole length. Tributaries may join a trunk river:',
      '  model a tributary as its own river whose path meets the trunk and then follows it to the sea.',
      `- Unless the brief says how many rivers there are, aim for about ${suggested} named rivers on a map this size, of varied`,
      '  length. Every river the brief names must appear, running where the brief says and at the length it gives.',
    ]),
    '',
    section('NAVIGABILITY', [
      '- Navigability is per hex, not per river. The lower course of a large river is navigable; the upper course is not.',
      '- A river is not navigable through Mountains or Highland hexes.',
      '- Small or steep rivers may be navigable nowhere at all. Say so with all-false entries.',
    ]),
    '',
    'Name rivers in a style consistent with the brief.',
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.instruction && ctx.rivers) {
    parts.push(
      '',
      section('CURRENT RIVERS', riverSummary(ctx.rivers)),
      '',
      editBlock(ctx.instruction, 'rivers'),
    );
  } else {
    parts.push('', 'Generate the river systems for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* ------------------------------------------------------------------ cities */

function citiesPrompt(ctx: PromptContext): BuiltPrompt {
  const lo = Math.max(3, Math.round((ctx.cols * ctx.rows) / 90));
  const hi = Math.max(6, Math.round((ctx.cols * ctx.rows) / 35));
  const system = [
    'You are a historical geographer siting the cities of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('WHERE CITIES GO', [
      ...(ctx.allowUnderwater
        ? [
            '- On Land, Coastal Land or Island hexes, or - since this world has submerged settlements - on Sea or Lake hexes',
            '  where the brief or the setting supports one (a drowned city, a merfolk reef-city, a pile-built lake town).',
            '  Never on Ice. Keep underwater cities rare and say why each exists in its "reason" field.',
          ]
        : ['- On Land, Coastal Land or Island hexes only. Never on Sea, Lake or Ice.']),
      '- Cities want water and traffic: river mouths, the lowest bridging point of a river, confluences, sheltered',
      '  bays, the neck of a peninsula, the pass through a range, the edge of a fertile plain.',
      '- Cities want food: cultivated or fertile hexes nearby. A great city in the middle of a desert needs a reason',
      '  (an oasis, a caravan road, a holy site) - give that reason in the "reason" field.',
      '- Cities avoid Mountains and polar hexes except as mining or frontier towns, which stay small.',
      '- Spread them out: a hinterland is part of a city. Do not put two large cities in adjacent hexes.',
    ]),
    '',
    section('POPULATION', [
      '- Use a plausible pre-modern settlement hierarchy: one or two primate cities well clear of the rest, a handful',
      '  of regional centres, and a larger number of small towns.',
      '- Typical ranges: great capital 60,000-250,000; regional centre 15,000-60,000; market town 3,000-15,000;',
      '  frontier or mining town 800-3,000. Shift the whole scale if the brief describes an unusually rich or',
      '  sparse world, and say so in your notes. A population the brief states is used as given.',
      '- This is the city population only. The surrounding rural population is a separate layer.',
    ]),
    '',
    `Unless the brief says how many settlements there are, place between ${lo} and ${hi} on a map this size. Every city`,
    'the brief names must appear, where the brief puts it and at any population it gives. Name the rest in a style',
    'consistent with the brief, and keep the naming of nearby cities culturally consistent with each other.',
    '',
    'Do not report whether a city is coastal or on a river: that is derived from the map itself.',
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.climate) parts.push('', climateGrid(ctx));
  if (ctx.vegetation) {
    parts.push('', vegetationGrid(ctx));
  }
  if (ctx.rivers && ctx.rivers.rivers.length > 0) {
    parts.push('', section('RIVERS', riverSummary(ctx.rivers)));
  } else if (isExcluded(ctx, 'rivers')) {
    parts.push(
      '',
      'This map has no rivers layer. Judge water access from the coastline, the lakes and the shape of the land, and where you site a city on an implied river, say so in its reason.',
    );
  }
  if (ctx.instruction && ctx.cities) {
    parts.push(
      '',
      section(
        'CURRENT CITIES',
        ctx.cities.cities.map(
          (c) =>
            `${c.name} at (${c.col},${c.row}) pop ${c.population}${c.coastal ? ' coastal' : ''}${c.onRiver ? ' on river' : ''}`,
        ),
      ),
      '',
      editBlock(ctx.instruction, 'cities'),
    );
  } else {
    parts.push('', 'Place the cities for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* ---------------------------------------------------------------- polities */

function politiesPrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a political geographer drawing the borders of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('THE PARTITION RULE', [
      'Every Land, Coastal Land and Island hex belongs to exactly one polity, or to none (unclaimed wilderness). There are no',
      'overlapping claims, no condominiums and no disputed hexes in this model - pick an owner or leave it unclaimed.',
      ...(ctx.allowUnderwater
        ? [
            `Ice hexes are always "${POLITY_UNCLAIMED}". This world has submerged realms, so a polity may also own Sea or Lake`,
            'hexes - territorial waters, a reef kingdom, a drowned empire - but only where the brief or the setting supports it;',
            `open water is otherwise "${POLITY_UNCLAIMED}".`,
          ]
        : [`Sea, Lake and Ice hexes are always "${POLITY_UNCLAIMED}".`]),
    ]),
    '',
    section('DRAWING BORDERS', [
      '- Territory is contiguous. A polity is a connected block of hexes, plus at most an exclave or two if the brief',
      '  suggests one. Never a checkerboard, never scattered singletons.',
      '- Borders follow features people can see and defend: rivers, mountain crests, the far side of a desert, a coast.',
      '- Polities are shaped by their cities: a capital sits inside its own territory, usually well within it.',
      '- Leave genuinely hostile or remote country unclaimed - deep desert, high mountains, ice, far wilderness.',
      '  A map where every hex is owned looks like a modern state system, not a pre-modern one.',
      '- Let the brief, geography, settlement pattern and plausible political fragmentation determine how many',
      '  polities exist. Do not default to eight or any other fixed target. Give them clearly different sizes, including',
      '  major powers and smaller realms where the map supports them.',
    ]),
    '',
    section('OUTPUT', [
      'Declare each polity with a single-character key (A, B, C, ...), a name, a shortName and a hex colour.',
      'shortName is the compact label printed on the map. Remove generic polity types when the proper name identifies it',
      '("the Republic of Fantasia" becomes "Fantasia"). Keep a distinctive type by itself when it uniquely identifies',
      'the polity ("the Commonwealth of the Free Peoples" can become "Commonwealth").',
      'Choose colours that are clearly distinguishable from each other and readable against a map: mid-saturation,',
      'not near-black and not near-white, and not two similar hues side by side on the map.',
      'Give each polity "hexes": how many land hexes it should hold - converted from its area with the scale where the',
      'brief gives one, otherwise your judgement of its size against the measured land total. Then draw it to that size.',
      '',
      polityGridOutput(ctx),
    ]),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.rivers && ctx.rivers.rivers.length > 0) {
    parts.push('', section('RIVERS', riverSummary(ctx.rivers)));
  }
  if (ctx.cities && ctx.cities.cities.length > 0) {
    parts.push(
      '',
      section(
        'CITIES',
        ctx.cities.cities.map((c) => `${c.name} at (${c.col},${c.row}) pop ${c.population}`),
      ),
    );
  }
  if (ctx.instruction && ctx.polities) {
    parts.push(
      '',
      polityGrid(ctx, 'CURRENT POLITIES', true),
      '',
      editBlock(ctx.instruction, 'polities'),
    );
  } else {
    parts.push('', 'Draw the polities for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* -------------------------------------------------------------- population */

function populationPrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a demographer estimating rural population for a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('WHAT YOU ARE COUNTING', [
      'One integer per Land, Coastal Land or Island hex: the ordinary rural and small-village population living in that hex.',
      'This EXCLUDES the population of any city in the hex - those are counted separately. A hex containing a great',
      'city still gets a rural figure for the farms and villages around it (usually a high one, because a city feeds',
      'itself from its own hinterland).',
      ctx.gridFormat === 'keyed' ? 'Sea, Lake and Ice hexes get 0.' : 'Sea, Lake and Ice hexes get "-".',
    ]),
    '',
    section('WHAT DRIVES IT', [
      '- Land cover first: Breadbasket, Black Earth, Flood Plain and Paddy Fields carry the most people;',
      '  Prairie, Assart and Deciduous Forest a good deal; Steppe, Savanna and Scrubland far fewer;',
      '  Barren Desert, Tundra, Wetland and high Mountains almost none.',
      '- Then water and access: river hexes and coastal hexes support more people than inland hexes of the same cover.',
      '- Then climate: temperate and subtropical hexes support more than arid or polar ones.',
      '- Then rule: settled polities are more densely populated than unclaimed wilderness.',
      '',
      'Size the figures to the scale: a hex of ~2,000 km^2 of good farmland holds far more people than one of',
      '~200 km^2. If the brief states a population (for the world, a region or a realm), the hexes it covers must add',
      'up to it, less the city populations listed. If there is no scale, keep figures consistent with the relative',
      'carrying capacity of the terrain and say in your notes that the totals use an unspecified regional scale.',
    ]),
    '',
    '- Population is a smooth field: neighbouring hexes of similar land should hold similar numbers. Do not produce',
    '  wild hex-to-hex swings, and do not repeat one round number across a whole region.',
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'token', ctx.gridFormat),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    baseGrid(ctx),
  ];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.climate) parts.push('', climateGrid(ctx));
  if (ctx.vegetation) {
    parts.push('', vegetationGrid(ctx));
  }
  if (ctx.rivers && ctx.rivers.rivers.length > 0) {
    parts.push('', section('RIVERS', riverSummary(ctx.rivers)));
  }
  if (ctx.cities && ctx.cities.cities.length > 0) {
    parts.push(
      '',
      section(
        'CITIES (their populations are NOT part of your figures)',
        ctx.cities.cities.map((c) => `${c.name} at (${c.col},${c.row}) pop ${c.population}`),
      ),
    );
  }
  const missingForPopulation = (['vegetation', 'climate', 'rivers', 'cities'] as LayerId[]).filter(
    (id) => isExcluded(ctx, id),
  );
  if (missingForPopulation.length > 0) {
    parts.push(
      '',
      `This map has no ${missingForPopulation.map((id) => LAYER_META[id].label).join(' or ')} layer. Base your figures on what you can see - the land, the coast and the latitude - and say in your notes what you had to assume.`,
    );
  }
  if (ctx.polities && ctx.polities.polities.length > 0) {
    parts.push('', polityGrid(ctx, 'POLITIES', false));
  }
  if (ctx.instruction && ctx.population) {
    parts.push(
      '',
      populationGrid(ctx, 'CURRENT POPULATION'),
      '',
      editBlock(ctx.instruction, 'population'),
    );
  } else {
    parts.push('', 'Estimate the rural population for this map.');
  }
  return { system, user: parts.join('\n') };
}

/* ------------------------------------------------- two-pass prompt builders */

/**
 * Polities and rivers each invent a cast and place it on the grid at the same
 * time. Those two halves constrain each other, which is why doing them in one
 * request is expensive - the model has to hold an unsettled roster and an
 * unsettled geography in mind together. These builders do one half at a time.
 */

function politiesRosterPrompt(ctx: PromptContext): BuiltPrompt {
  const system = [
    'You are a political geographer naming the powers of a fantasy hex map.',
    '',
    section('WHAT YOU ARE DOING', [
      'This is the first of two passes. Decide WHO exists on this map - the roster of polities - and nothing else.',
      'You are not drawing any borders yet and you must not return a grid. A later pass will partition the land',
      'between the polities you name here, so name them with that in mind: give a sense of where each one sits and',
      'how big it is in your decisions, and the border pass will follow it.',
      'Let the brief, geography, settlement pattern and plausible political fragmentation determine how many',
      'polities exist. Do not default to eight or any other fixed target. Every polity the brief names must be on the',
      'roster. Give them clearly different sizes, including major powers and smaller realms where the map supports',
      'them. Leave room for unclaimed wilderness - a map where every hex is owned looks like a modern state system,',
      'not a pre-modern one.',
    ]),
    '',
    scaleRules(ctx.cols, ctx.rows),
    '',
    section('OUTPUT', [
      'Declare each polity with a single-character key (A, B, C, ... in order), a name, a shortName, a hex colour, and "hexes": the',
      'shortName is its compact map label: remove generic polity types when the proper name identifies it, but retain a',
      'distinctive type alone when that word uniquely identifies the polity (for example, "Commonwealth").',
      'number of land hexes it should hold. Where the brief gives its area, convert it with the scale; where the brief',
      'gives a relative size ("the largest kingdom", "a third of the continent"), work it out from the measured land',
      'total. The border pass draws each polity to this number, and the map is checked against it, so it is binding.',
      'Choose colours that are clearly distinguishable from each other and readable against a map: mid-saturation,',
      'not near-black and not near-white, and not two similar hues side by side.',
    ]),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [descriptionBlock(ctx.description), '', ...geographyContext(ctx)];
  if (ctx.instruction) {
    parts.push('', editBlock(ctx.instruction, 'polities'));
  }
  parts.push('', 'Name the polities of this map.');
  return { system, user: parts.join('\n') };
}

function politiesPaintPrompt(ctx: PromptContext, roster: Roster | null): BuiltPrompt {
  const entries = roster?.kind === 'polities' ? roster.entries : [];
  const system = [
    'You are a political geographer drawing the borders of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('WHAT YOU ARE DOING', [
      'The polities are already decided and are listed below. Your only job is to partition the land between them.',
      'Do not invent, rename, merge or drop a polity. Use exactly the keys given, and no others.',
    ]),
    '',
    section('THE PARTITION RULE', [
      'Every Land, Coastal Land and Island hex belongs to exactly one polity, or to none (unclaimed wilderness). There are no',
      'overlapping claims, no condominiums and no disputed hexes in this model - pick an owner or leave it unclaimed.',
      ...(ctx.allowUnderwater
        ? [
            `Ice hexes are always "${POLITY_UNCLAIMED}". This world has submerged realms, so a polity may also own Sea or Lake`,
            'hexes - territorial waters, a reef kingdom, a drowned empire - but only where the brief or the setting supports it;',
            `open water is otherwise "${POLITY_UNCLAIMED}".`,
          ]
        : [`Sea, Lake and Ice hexes are always "${POLITY_UNCLAIMED}".`]),
    ]),
    '',
    section('DRAWING BORDERS', [
      '- Territory is contiguous. A polity is a connected block of hexes, plus at most an exclave or two if the brief',
      '  suggests one. Never a checkerboard, never scattered singletons.',
      '- Borders follow features people can see and defend: rivers, mountain crests, the far side of a desert, a coast.',
      '- Polities are shaped by their cities: a capital sits inside its own territory, usually well within it.',
      '- Leave genuinely hostile or remote country unclaimed - deep desert, high mountains, ice, far wilderness.',
      '- Draw each polity to the number of hexes the roster gives it, within about a fifth, unless an edit instruction',
      '  below asks for a change of size. The result is measured against those numbers and every polity that misses is',
      '  reported to the user. Where the roster gives no number,',
      '  respect the relative sizes it implies: a great power covers visibly more ground than a minor realm.',
    ]),
    '',
    section('OUTPUT', [polityGridOutput(ctx)]),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section(
      'THE POLITIES (fixed - use exactly these keys)',
      entries.length > 0
        ? entries.map(
            (e) =>
              `${e.key} = ${e.name}${e.colour ? ` (${e.colour})` : ''}${e.hexes ? ` - draw to about ${e.hexes} hexes` : ''}`,
          )
        : ['(none supplied)'],
    ),
    '',
    ...geographyContext(ctx),
  ];
  if (ctx.instruction) {
    parts.push('', editBlock(ctx.instruction, 'polities'));
  }
  parts.push('', 'Draw the borders for these polities.');
  return { system, user: parts.join('\n') };
}

function riversRosterPrompt(ctx: PromptContext): BuiltPrompt {
  const suggested = suggestedRiverCount(ctx);
  const system = [
    'You are a hydrologist planning the river systems of a fantasy hex map.',
    '',
    section('WHAT YOU ARE DOING', [
      'This is the first of two passes. Decide WHAT rivers this map has - their names and roughly where each one',
      'runs - and nothing else. Do not return any hex coordinates; a later pass traces the actual paths.',
      `Unless the brief says how many rivers there are, aim for about ${suggested} named rivers on a map this size, of varied`,
      'length. Every river the brief names must appear, running where the brief says and at the length it gives.',
      'Every river must rise in high ground and end at a Sea, a Lake, or the edge of the map. Say which, for each.',
      'Longer rivers gather in valleys and lowlands; short torrents run straight off coastal ranges.',
      'Name rivers in a style consistent with the brief.',
    ]),
    '',
    scaleRules(ctx.cols, ctx.rows),
    '',
    section('OUTPUT', [
      'For each river give a name and a "course": one clause saying where it rises, roughly which way it runs, and',
      'what it empties into. For example: "rises on the eastern Spine, runs south-east across the lowlands into the',
      'Bay of Kelder". No hex coordinates.',
    ]),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [descriptionBlock(ctx.description), '', ...geographyContext(ctx)];
  if (ctx.instruction) {
    parts.push('', editBlock(ctx.instruction, 'rivers'));
  }
  parts.push('', 'Plan the river systems for this map.');
  return { system, user: parts.join('\n') };
}

function riversPathsPrompt(ctx: PromptContext, roster: Roster | null): BuiltPrompt {
  const entries = roster?.kind === 'rivers' ? roster.entries : [];
  const system = [
    'You are a hydrologist tracing the courses of already-named rivers across a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('WHAT YOU ARE DOING', [
      'The rivers are already decided and are listed below with the course each one is meant to take. Your only job',
      'is to trace each one hex by hex. Return every river in the list, under exactly the name given, and no others.',
    ]),
    '',
    section('HOW A RIVER IS DESCRIBED', [
      'Each river is an ordered list of hexes from source to mouth. Every consecutive pair in the list MUST be',
      'neighbours by the adjacency table above - a river cannot jump. Use the neighbour rules carefully; the',
      'parity of the row changes which diagonals are adjacent.',
      '',
      'The list starts at the source hex (high ground) and ends either:',
      '  - with the Sea or Lake hex the river empties into (include that water hex as the final entry), or',
      '  - with the land hex on the map border through which the river leaves the map.',
      'Apart from that final mouth hex, every hex in the path must be Land, Coastal Land or Island.',
      '',
      'The "navigable" array has one entry per hex in the path, in the same order.',
    ]),
    '',
    section('HYDROLOGY', [
      '- Elevation must never increase along a path; where it must stay level, that is fine, but it must not climb.',
      '- Every river ends at a Sea, a Lake, or the edge of the map. A river that just stops inland is wrong.',
      '- Do not run two rivers along the same hexes for their whole length. A tributary may meet a trunk river and',
      '  then follow it to the sea.',
    ]),
    '',
    section('NAVIGABILITY', [
      '- Navigability is per hex, not per river. The lower course of a large river is navigable; the upper course is not.',
      '- A river is not navigable through Mountains or Highland hexes.',
      '- Small or steep rivers may be navigable nowhere at all. Say so with all-false entries.',
    ]),
    '',
    houseStyle(ctx),
    '',
    recordDecisions(ctx),
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section(
      'THE RIVERS (fixed - trace exactly these)',
      entries.length > 0
        ? entries.map((e) => `${e.name}${e.course ? `: ${e.course}` : ''}`)
        : ['(none supplied)'],
    ),
    '',
    ...geographyContext(ctx),
  ];
  if (ctx.instruction) {
    parts.push('', editBlock(ctx.instruction, 'rivers'));
  }
  parts.push('', 'Trace each of these rivers hex by hex.');
  return { system, user: parts.join('\n') };
}

/** Base geography, plus whatever else the map has, as the pass prompts show it. */
function geographyContext(ctx: PromptContext): string[] {
  const parts = [baseGrid(ctx)];
  if (ctx.elevation) {
    parts.push('', elevationGrid(ctx));
  }
  if (ctx.rivers && ctx.rivers.rivers.length > 0) {
    parts.push('', section('RIVERS', riverSummary(ctx.rivers)));
  }
  if (ctx.cities && ctx.cities.cities.length > 0) {
    parts.push(
      '',
      section(
        'CITIES',
        ctx.cities.cities.map((c) => `${c.name} at (${c.col},${c.row}) pop ${c.population}`),
      ),
    );
  }
  return parts;
}

/* ------------------------------------------------------------------ export */

const BUILDERS: Record<LayerId, (ctx: PromptContext) => BuiltPrompt> = {
  base: basePrompt,
  elevation: elevationPrompt,
  climate: climatePrompt,
  vegetation: vegetationPrompt,
  rivers: riversPrompt,
  cities: citiesPrompt,
  polities: politiesPrompt,
  population: populationPrompt,
};

/**
 * Build the prompt for one pass of one layer.
 *
 * `full` is the single-request form every layer supports. Polities and rivers
 * additionally support `roster` and `paint`; `paint` needs the roster the first
 * pass produced (or one the user supplied) to have something to work against.
 */
export function buildPrompt(
  layer: LayerId,
  ctx: PromptContext,
  pass: PassId = 'full',
  roster: Roster | null = null,
): BuiltPrompt {
  if (pass === 'roster') {
    if (layer === 'polities') return politiesRosterPrompt(ctx);
    if (layer === 'rivers') return riversRosterPrompt(ctx);
    throw new Error(`Layer "${layer}" has no roster pass.`);
  }
  if (pass === 'paint') {
    if (layer === 'polities') return politiesPaintPrompt(ctx, roster);
    if (layer === 'rivers') return riversPathsPrompt(ctx, roster);
    throw new Error(`Layer "${layer}" has no paint pass.`);
  }
  return BUILDERS[layer](ctx);
}

/* ----------------------------------------------- several layers in one go */

/**
 * The rules for one layer with the parts every layer shares taken out, so a
 * prompt that asks for several layers at once can state those parts once.
 *
 * Builders produce system and user text together, and the user half reads the
 * layers it depends on - which, in a multi-layer prompt, may be produced earlier
 * in the same reply and so not exist yet. The system half never depends on
 * layer data, so it is built against a stand-in base and the user half dropped.
 */
export function layerRules(layer: LayerId, ctx: PromptContext): string {
  const stand: PromptContext = {
    ...ctx,
    base: ctx.base ?? new Array(ctx.cols * ctx.rows).fill('Sea'),
    instruction: null,
  };
  let system = buildPrompt(layer, stand).system;
  for (const shared of [gridRules(ctx.cols, ctx.rows), houseStyle(ctx), recordDecisions(ctx)]) {
    system = system.replace(shared, '');
  }
  return system.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Every layer the map already has, apart from those about to be regenerated,
 * shown the way the single-layer prompts show them.
 */
export function existingContext(ctx: PromptContext, regenerating: LayerId[]): string[] {
  const keep = (id: LayerId) => !regenerating.includes(id);
  const parts: string[] = [];
  const add = (text: string) => parts.push('', text);
  if (ctx.base && keep('base')) add(baseGrid(ctx));
  if (ctx.elevation && keep('elevation')) add(elevationGrid(ctx));
  if (ctx.climate && keep('climate')) add(climateGrid(ctx));
  if (ctx.vegetation && keep('vegetation')) add(vegetationGrid(ctx));
  if (ctx.rivers && ctx.rivers.rivers.length > 0 && keep('rivers')) add(section('RIVERS', riverSummary(ctx.rivers)));
  if (ctx.cities && ctx.cities.cities.length > 0 && keep('cities')) {
    add(section('CITIES', ctx.cities.cities.map((c) => `${c.name} at (${c.col},${c.row}) pop ${c.population}`)));
  }
  if (ctx.polities && ctx.polities.polities.length > 0 && keep('polities')) add(polityGrid(ctx, 'POLITIES', false));
  if (ctx.population && keep('population')) add(populationGrid(ctx));
  return parts.slice(1);
}
