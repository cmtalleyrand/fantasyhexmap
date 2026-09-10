/**
 * Prompt construction, one builder per layer.
 *
 * Two conventions run through all of them:
 *  - Grid state travels as one string per row, so the model reads the map as a
 *    picture instead of a wall of JSON objects, and a 50x50 layer costs a few
 *    hundred output tokens instead of tens of thousands.
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
import { VEGETATION_GROUPS, type LayerId, type VegetationGroup } from '../shared/types.js';
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

function gridRules(cols: number, rows: number): string {
  return `THE GRID
The map is a rectangular grid of pointy-top hexes, ${cols} columns wide and ${rows} rows tall (${cols * rows} hexes).
- Columns are numbered 0 to ${cols - 1}, west to east. Rows are numbered 0 to ${rows - 1}, north to south.
- Row 0 is the northern edge of the map; row ${rows - 1} is the southern edge.
- Odd-numbered rows are offset half a hex east of even-numbered rows.
- Neighbours of hex (c, r) depend on the parity of r:
    even r:  E=(c+1,r)  SE=(c,r+1)    SW=(c-1,r+1)  W=(c-1,r)  NW=(c-1,r-1)  NE=(c,r-1)
    odd  r:  E=(c+1,r)  SE=(c+1,r+1)  SW=(c,r+1)    W=(c-1,r)  NW=(c,r-1)    NE=(c+1,r-1)
- Nothing exists beyond the grid: the map edge is either open ocean continuing off-map, or land continuing off-map. Do not treat it as a wall.

SPATIAL SCALE
Use a physical scale only when the map description states or clearly entails one. Otherwise, do not assume a distance, area, or kilometres-per-hex value; reason from relative positions and terrain patterns. A hex represents one map region, at the description’s scale.`;
}

function rowFormatRules(cols: number, rows: number, kind: 'char' | 'token'): string {
  return kind === 'char'
    ? `OUTPUT FORMAT
Return exactly ${rows} strings in "rows", one per grid row from north (row 0) to south (row ${rows - 1}).
Each string is exactly ${cols} characters long, one character per hex from west (col 0) to east (col ${cols - 1}).
No spaces, no separators, no row numbers, no commentary inside the strings.`
    : `OUTPUT FORMAT
Return exactly ${rows} strings in "rows", one per grid row from north (row 0) to south (row ${rows - 1}).
Each string holds exactly ${cols} space-separated tokens, one per hex from west (col 0) to east (col ${cols - 1}).
No row numbers and no commentary inside the strings.`;
}

function descriptionBlock(description: string): string {
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

const RECORD_YOUR_DECISIONS = `RECORD YOUR DECISIONS
Along with the layer, return the 3 to 8 decisions that most shaped it, in "decisions". This is read
by the person whose world this is, and it is the only record of why the map looks the way it does.

- Write about choices, not contents. "The eastern basin is BWk" is data the map already shows.
  "The eastern basin is arid because the Spine takes the westerly rain out of the air before it gets
  there, which is what the brief's rain-shadow desert asks for" is a decision.
- Say what you did with the brief: which cue you followed, where two parts of it pulled against each
  other and how you resolved that, and what you invented because the brief was silent.
- Include anything a reader would otherwise think was a mistake - a desert at a temperate latitude,
  a great city on a frontier, an empty quarter no polity claims.
- Name places and give hex coordinates where they help. Use the "hexes" field for the hexes a
  decision is actually about; leave it empty for decisions about the map as a whole.
- Be specific and be brief. Three good sentences beat a paragraph of hedging.`;

const HOUSE_STYLE = `HOW TO WORK
- Think about the map as a whole before writing any row. Geography is continuous: coastlines, ranges, climate belts and borders are large connected shapes, not per-hex noise.
- Never produce speckle - isolated single hexes of one value scattered through a field of another - unless the brief explicitly calls for it (an archipelago, an oasis chain).
- Count your cells. Every row must have exactly the required number of entries; a row that is one cell short silently shifts an entire band of the map.
- Follow the brief where it is specific; where it is silent, make a decision that is plausible and interesting rather than uniform.`;

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
      'Sea    - open salt water, connected (directly or through other Sea hexes) to the edge of the map.',
      'Lake   - fresh water fully enclosed by land; a lake never touches a Sea hex.',
      'Ice    - permanent ice sheet or shelf. Use only where the brief implies polar or glacial conditions.',
      'Island - a hex that is mostly sea but holds a small landmass. This is the only mixed category;',
      '         there is no mixed land+lake value. Use it for archipelagos, skerries and lone islets,',
      '         not for large islands (a large island is Land hexes surrounded by Sea).',
    ]),
    '',
    section('GEOGRAPHIC SENSE', [
      '- Coastlines are continuous and irregular: bays, peninsulas, headlands. Not a rectangle of land in a rectangle of sea.',
      '- Seas connect to the map edge. An enclosed body of water surrounded by land is a Lake, however large.',
      '- Lakes sit inland, usually in lowlands or between highlands, and are small - one to a few hexes.',
      '- Ice belongs at the northern or southern edge of the map, or on high ground if the brief says so.',
      '- Islands cluster: chains, arcs off a coast, scatterings in a strait. A lone Island hex in mid-ocean is rare.',
      '- If the brief gives no land/water balance, aim for roughly half the map as land.',
    ]),
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'char'),
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [descriptionBlock(ctx.description)];
  if (ctx.instruction && ctx.base) {
    parts.push(
      '',
      section('CURRENT BASE GEOGRAPHY', encodeBase(ctx.base, ctx.cols, ctx.rows)),
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
    rowFormatRules(ctx.cols, ctx.rows, 'char'),
    '',
    'A hex that is not Land or Island MUST be "." in your output.',
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY (one character per hex)', [
      BASE_LEGEND,
      ...encodeBase(ctx.base!, ctx.cols, ctx.rows),
    ]),
  ];
  if (ctx.instruction && ctx.elevation) {
    parts.push(
      '',
      section('CURRENT ELEVATION', encodeElevation(ctx.elevation, ctx.cols, ctx.rows)),
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
    rowFormatRules(ctx.cols, ctx.rows, 'token'),
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push(
      '',
      section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]),
    );
  }
  if (ctx.instruction && ctx.climate) {
    parts.push(
      '',
      section('CURRENT CLIMATE', encodeClimate(ctx.climate, ctx.cols, ctx.rows)),
      '',
      editBlock(ctx.instruction, 'climate'),
    );
  } else {
    parts.push('', 'Generate the climate layer for this map.');
  }
  return { system, user: parts.join('\n') };
}

const CLIMATE_EMPTY_NOTE = 'Use -- for any hex that is not Land or Island (Sea, Lake and Ice hexes get no climate).';

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
    rowFormatRules(ctx.cols, ctx.rows, 'token'),
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push('', section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]));
  }
  if (ctx.climate) {
    parts.push('', section('CLIMATE', encodeClimate(ctx.climate, ctx.cols, ctx.rows)));
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
      section('CURRENT VEGETATION', encodeVegetation(ctx.vegetation, ctx.cols, ctx.rows)),
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

function riversPrompt(ctx: PromptContext): BuiltPrompt {
  const suggested = Math.max(2, Math.round((ctx.cols * ctx.rows) / 110));
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
      'Apart from that final mouth hex, every hex in the path must be Land or Island.',
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
      `- Aim for about ${suggested} named rivers on a map this size, of varied length. Quality over quantity.`,
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
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push('', section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]));
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
      '- On Land or Island hexes only. Never on Sea, Lake or Ice.',
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
      '  sparse world, and say so in your notes.',
      '- This is the city population only. The surrounding rural population is a separate layer.',
    ]),
    '',
    `Place between ${lo} and ${hi} settlements on a map this size. Name them in a style consistent with the brief,`,
    'and keep the naming of nearby cities culturally consistent with each other.',
    '',
    'Do not report whether a city is coastal or on a river: that is derived from the map itself.',
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push('', section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]));
  }
  if (ctx.climate) parts.push('', section('CLIMATE', encodeClimate(ctx.climate, ctx.cols, ctx.rows)));
  if (ctx.vegetation) {
    parts.push('', section('VEGETATION (two-letter codes)', encodeVegetation(ctx.vegetation, ctx.cols, ctx.rows)));
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
  const suggested = Math.max(3, Math.min(12, Math.round((ctx.cols * ctx.rows) / 200) + 3));
  const system = [
    'You are a political geographer drawing the borders of a fantasy hex map.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    section('THE PARTITION RULE', [
      'Every Land and Island hex belongs to exactly one polity, or to none (unclaimed wilderness). There are no',
      'overlapping claims, no condominiums and no disputed hexes in this model - pick an owner or leave it unclaimed.',
      `Sea, Lake and Ice hexes are always "${POLITY_UNCLAIMED}".`,
    ]),
    '',
    section('DRAWING BORDERS', [
      '- Territory is contiguous. A polity is a connected block of hexes, plus at most an exclave or two if the brief',
      '  suggests one. Never a checkerboard, never scattered singletons.',
      '- Borders follow features people can see and defend: rivers, mountain crests, the far side of a desert, a coast.',
      '- Polities are shaped by their cities: a capital sits inside its own territory, usually well within it.',
      '- Leave genuinely hostile or remote country unclaimed - deep desert, high mountains, ice, far wilderness.',
      '  A map where every hex is owned looks like a modern state system, not a pre-modern one.',
      `- Aim for around ${suggested} polities, of clearly different sizes: one or two large powers, several middling`,
      '  realms, a few small ones.',
    ]),
    '',
    section('OUTPUT', [
      'Declare each polity with a single-character key (A, B, C, ...), a name and a hex colour.',
      'Choose colours that are clearly distinguishable from each other and readable against a map: mid-saturation,',
      'not near-black and not near-white, and not two similar hues side by side on the map.',
      `Then return ${ctx.rows} row strings of exactly ${ctx.cols} characters, one key per hex, "${POLITY_UNCLAIMED}" for unclaimed.`,
      'No spaces, no separators.',
    ]),
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push('', section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]));
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
    const keyOf = new Map(
      ctx.polities.polities.map((p, i) => [p.id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] ?? '?']),
    );
    parts.push(
      '',
      section('CURRENT POLITIES', [
        ...ctx.polities.polities.map(
          (p, i) => `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] ?? '?'} = ${p.name} (${p.colour})`,
        ),
        ...encodePolityRows(ctx.polities.owner, keyOf, ctx.cols, ctx.rows),
      ]),
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
      'One integer per Land or Island hex: the ordinary rural and small-village population living in that hex.',
      'This EXCLUDES the population of any city in the hex - those are counted separately. A hex containing a great',
      'city still gets a rural figure for the farms and villages around it (usually a high one, because a city feeds',
      'itself from its own hinterland).',
      'Sea, Lake and Ice hexes get "-".',
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
      'Infer absolute per-hex figures only from a physical scale supplied or clearly entailed by the brief.',
      'If no physical scale is available, keep figures internally consistent with the relative carrying capacity',
      'of the terrain and state in your notes that the totals use an unspecified regional scale; do not invent a',
      'distance or area for each hex.',
    ]),
    '',
    '- Population is a smooth field: neighbouring hexes of similar land should hold similar numbers. Do not produce',
    '  wild hex-to-hex swings, and do not repeat one round number across a whole region.',
    '',
    rowFormatRules(ctx.cols, ctx.rows, 'token'),
    '',
    HOUSE_STYLE,
    '',
    RECORD_YOUR_DECISIONS,
  ].join('\n');

  const parts = [
    descriptionBlock(ctx.description),
    '',
    section('BASE GEOGRAPHY', [BASE_LEGEND, ...encodeBase(ctx.base!, ctx.cols, ctx.rows)]),
  ];
  if (ctx.elevation) {
    parts.push('', section('ELEVATION', [ELEVATION_LEGEND, ...encodeElevation(ctx.elevation, ctx.cols, ctx.rows)]));
  }
  if (ctx.climate) parts.push('', section('CLIMATE', encodeClimate(ctx.climate, ctx.cols, ctx.rows)));
  if (ctx.vegetation) {
    parts.push('', section('VEGETATION', encodeVegetation(ctx.vegetation, ctx.cols, ctx.rows)));
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
    const keyOf = new Map(
      ctx.polities.polities.map((p, i) => [p.id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] ?? '?']),
    );
    parts.push(
      '',
      section('POLITIES', [
        ...ctx.polities.polities.map((p, i) => `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] ?? '?'} = ${p.name}`),
        ...encodePolityRows(ctx.polities.owner, keyOf, ctx.cols, ctx.rows),
      ]),
    );
  }
  if (ctx.instruction && ctx.population) {
    parts.push(
      '',
      section('CURRENT POPULATION', encodePopulation(ctx.population, ctx.cols, ctx.rows)),
      '',
      editBlock(ctx.instruction, 'population'),
    );
  } else {
    parts.push('', 'Estimate the rural population for this map.');
  }
  return { system, user: parts.join('\n') };
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

export function buildPrompt(layer: LayerId, ctx: PromptContext): BuiltPrompt {
  return BUILDERS[layer](ctx);
}
