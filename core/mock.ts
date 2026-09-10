/**
 * Offline procedural generator.
 *
 * Set HEXMAP_MOCK=1 to run the whole application - generation, decoding,
 * validation, rendering, export - without an Anthropic API key. It returns the
 * same JSON shapes the model is asked for, so it exercises exactly the same
 * decode-and-validate path rather than a shortcut around it.
 */

import { hexIndex, inBounds, neighbourOf } from '../shared/hex.js';
import { isLandLike, isWater, ELEVATION_FLOW_RANK } from '../shared/derive.js';
import {
  BASE_CHARS,
  ELEVATION_CHARS,
  VEGETATION_CODES,
} from '../shared/codec.js';
import type {
  BaseGeo,
  Climate,
  Elevation,
  LayerId,
  Vegetation,
} from '../shared/types.js';
import type { PromptContext } from './prompts.js';

function makeRng(seed: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

function buildBase(ctx: PromptContext): BaseGeo[] {
  const { cols, rows } = ctx;
  const rng = makeRng(ctx.description + ctx.cols + 'x' + ctx.rows);
  const blobs = Array.from({ length: 3 + Math.floor(rng() * 3) }, () => ({
    x: rng() * cols,
    y: rng() * rows,
    r: (0.18 + rng() * 0.22) * Math.max(cols, rows),
  }));
  const data: BaseGeo[] = new Array(cols * rows).fill('Sea');
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let land = 0;
      for (const b of blobs) {
        const d = Math.hypot(col - b.x, (row - b.y) * 1.15);
        land += Math.max(0, 1 - d / b.r);
      }
      land += (rng() - 0.5) * 0.35;
      const i = hexIndex(cols, col, row);
      if (land > 0.55) data[i] = 'Land';
      else if (land > 0.42) data[i] = rng() < 0.35 ? 'Island' : 'Land';
      else if (land > 0.33 && rng() < 0.25) data[i] = 'Island';
    }
  }
  // Polar ice caps.
  const capRows = Math.max(1, Math.round(rows * 0.06));
  for (let row = 0; row < rows; row++) {
    if (row < capRows || row >= rows - capRows) {
      for (let col = 0; col < cols; col++) {
        if (rng() < 0.75) data[hexIndex(cols, col, row)] = 'Ice';
      }
    }
  }
  // A few inland lakes.
  for (let n = 0; n < Math.max(1, Math.round((cols * rows) / 300)); n++) {
    const col = 1 + Math.floor(rng() * (cols - 2));
    const row = 1 + Math.floor(rng() * (rows - 2));
    const enclosed = [0, 1, 2, 3, 4, 5].every((e) => {
      const nb = neighbourOf(col, row, e);
      return inBounds(cols, rows, nb.col, nb.row) && data[hexIndex(cols, nb.col, nb.row)] === 'Land';
    });
    if (enclosed) data[hexIndex(cols, col, row)] = 'Lake';
  }
  return data;
}

function distanceToWater(base: BaseGeo[], cols: number, rows: number): number[] {
  const dist = new Array(cols * rows).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!isLandLike(base[i])) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (dist[j] === Infinity) {
        dist[j] = dist[i]! + 1;
        queue.push(j);
      }
    }
  }
  return dist;
}

function buildElevation(ctx: PromptContext): (Elevation | null)[] {
  const { cols, rows } = ctx;
  const base = ctx.base!;
  const rng = makeRng('elev' + ctx.description);
  const dist = distanceToWater(base, cols, rows);
  const ridgeCol = cols * (0.3 + rng() * 0.4);
  return base.map((b, i) => {
    if (!isLandLike(b)) return null;
    if (b === 'Island') return 'Lowland';
    const col = i % cols;
    const d = dist[i]!;
    const ridge = Math.max(0, 1 - Math.abs(col - ridgeCol) / (cols * 0.12));
    const score = d * 0.55 + ridge * 4 + rng() * 0.8;
    if (score > 5.5) return 'Mountains';
    if (score > 4.2) return rng() < 0.25 ? 'Plateau' : 'Highland';
    if (score > 2.8) return 'Hills';
    if (score > 1.4) return 'Rolling';
    return 'Lowland';
  });
}

function buildClimate(ctx: PromptContext): (Climate | null)[] {
  const { cols, rows } = ctx;
  const base = ctx.base!;
  const elev = ctx.elevation;
  return base.map((b, i) => {
    if (!isLandLike(b)) return null;
    const row = Math.floor(i / cols);
    const lat = Math.abs(row / Math.max(1, rows - 1) - 0.5) * 2; // 0 equator, 1 pole
    const e = elev?.[i] ?? null;
    let bump = 0;
    if (e === 'Mountains') bump = 0.3;
    else if (e === 'Highland' || e === 'Plateau') bump = 0.18;
    const l = Math.min(1, lat + bump);
    if (l > 0.92) return 'EF';
    if (l > 0.82) return 'ET';
    if (l > 0.68) return 'Dfc';
    if (l > 0.55) return 'Dfb';
    if (l > 0.42) return 'Cfb';
    if (l > 0.3) return 'Cfa';
    if (l > 0.22) return 'BSh';
    if (l > 0.14) return 'BWh';
    if (l > 0.07) return 'Aw';
    return 'Af';
  });
}

const VEG_BY_CLIMATE: Record<string, Vegetation> = {
  Af: 'Tropical Rainforest',
  Am: 'Subtropical Rainforest',
  Aw: 'Savanna',
  BWh: 'Barren Desert',
  BWk: 'Barren Desert',
  BSh: 'Savanna',
  BSk: 'Steppe',
  Csa: 'Scrubland',
  Csb: 'Scrubland',
  Cfa: 'Deciduous Forest',
  Cfb: 'Prairie',
  Cwa: 'Subtropical Rainforest',
  Dfa: 'Prairie',
  Dfb: 'Deciduous Forest',
  Dfc: 'Boreal Forest',
  Dsa: 'Steppe',
  Dsb: 'Steppe',
  Dwa: 'Prairie',
  Dwb: 'Coniferous Forest',
  ET: 'Tundra',
  EF: 'Tundra',
};

function buildVegetation(ctx: PromptContext): (Vegetation | null)[] {
  const { cols } = ctx;
  const base = ctx.base!;
  const rng = makeRng('veg' + ctx.description);
  const riverHexes = new Set(
    (ctx.rivers?.rivers ?? []).flatMap((r) => r.segments.map((s) => `${s.col},${s.row}`)),
  );
  return base.map((b, i) => {
    if (!isLandLike(b)) return null;
    const c = ctx.climate?.[i] ?? null;
    const e = ctx.elevation?.[i] ?? null;
    const col = i % cols;
    const row = Math.floor(i / cols);
    if (riverHexes.has(`${col},${row}`) && rng() < 0.5) return 'Flood Plain';
    if (e === 'Mountains') return 'Tundra';
    if (!c) return 'Scrubland';
    const natural = VEG_BY_CLIMATE[c] ?? 'Scrubland';
    if ((c.startsWith('C') || c.startsWith('D')) && (e === 'Lowland' || e === 'Rolling') && rng() < 0.28) {
      return rng() < 0.5 ? 'Breadbasket' : 'Black Earth';
    }
    return natural;
  });
}

function buildRivers(ctx: PromptContext) {
  const { cols, rows } = ctx;
  const base = ctx.base!;
  const elev = ctx.elevation;
  const rng = makeRng('riv' + ctx.description);
  const target = Math.max(2, Math.round((cols * rows) / 110));
  const rivers: { name: string; path: { col: number; row: number }[]; navigable: boolean[] }[] = [];
  const used = new Set<string>();
  let attempts = 0;
  while (rivers.length < target && attempts < target * 40) {
    attempts++;
    const col = Math.floor(rng() * cols);
    const row = Math.floor(rng() * rows);
    const i = hexIndex(cols, col, row);
    if (!isLandLike(base[i])) continue;
    const startRank = elev ? ELEVATION_FLOW_RANK[elev[i] ?? 'Lowland'] : 2;
    if (startRank < 2) continue;
    const path: { col: number; row: number }[] = [{ col, row }];
    const seen = new Set([`${col},${row}`]);
    let cur = { col, row };
    let reached = false;
    for (let step = 0; step < cols + rows; step++) {
      let best: { col: number; row: number } | null = null;
      let bestRank = Infinity;
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(cur.col, cur.row, e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        if (seen.has(`${n.col},${n.row}`)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (isWater(base[j])) {
          best = n;
          bestRank = -1;
          break;
        }
        if (!isLandLike(base[j])) continue;
        const rank = elev ? ELEVATION_FLOW_RANK[elev[j] ?? 'Lowland'] : 0;
        if (rank + rng() * 0.4 < bestRank) {
          bestRank = rank;
          best = n;
        }
      }
      if (!best) break;
      path.push(best);
      seen.add(`${best.col},${best.row}`);
      if (isWater(base[hexIndex(cols, best.col, best.row)])) {
        reached = true;
        break;
      }
      cur = best;
    }
    if (!reached || path.length < 4) continue;
    if (path.some((p) => used.has(`${p.col},${p.row}`))) continue;
    for (const p of path) used.add(`${p.col},${p.row}`);
    const navigable = path.map((_, k) => k > path.length * 0.5);
    rivers.push({ name: `River ${rivers.length + 1}`, path, navigable });
  }
  return rivers;
}

function buildCities(ctx: PromptContext) {
  const { cols, rows } = ctx;
  const base = ctx.base!;
  const rng = makeRng('city' + ctx.description);
  const riverHexes = new Set(
    (ctx.rivers?.rivers ?? []).flatMap((r) => r.segments.map((s) => `${s.col},${s.row}`)),
  );
  const target = Math.max(4, Math.round((cols * rows) / 55));
  const chosen: { name: string; col: number; row: number; population: number; reason: string }[] = [];
  let attempts = 0;
  while (chosen.length < target && attempts < target * 60) {
    attempts++;
    const col = Math.floor(rng() * cols);
    const row = Math.floor(rng() * rows);
    if (!isLandLike(base[hexIndex(cols, col, row)])) continue;
    if (chosen.some((c) => Math.hypot(c.col - col, c.row - row) < 3)) continue;
    const onRiver = riverHexes.has(`${col},${row}`);
    const coastal = [0, 1, 2, 3, 4, 5].some((e) => {
      const n = neighbourOf(col, row, e);
      return inBounds(cols, rows, n.col, n.row) && isWater(base[hexIndex(cols, n.col, n.row)]);
    });
    if (!onRiver && !coastal && rng() < 0.6) continue;
    const rank = chosen.length;
    const population =
      rank === 0 ? 120000 + Math.floor(rng() * 80000)
      : rank < 3 ? 25000 + Math.floor(rng() * 25000)
      : 2000 + Math.floor(rng() * 9000);
    chosen.push({
      name: `Mocktown ${chosen.length + 1}`,
      col,
      row,
      population,
      reason: onRiver ? 'river crossing' : coastal ? 'sheltered harbour' : 'inland market',
    });
  }
  return chosen;
}

function buildPolities(ctx: PromptContext) {
  const { cols, rows } = ctx;
  const base = ctx.base!;
  const rng = makeRng('pol' + ctx.description);
  const count = Math.max(3, Math.min(10, Math.round((cols * rows) / 200) + 3));
  const keys = 'ABCDEFGHIJ'.slice(0, count).split('');
  const colours = ['#b5533c', '#3f7a8c', '#7a6cae', '#5c8a4a', '#c08a2e', '#8c4f6d', '#4a6f9c', '#9c7b4a', '#5e8f7e', '#a2493f'];
  const seeds: number[] = [];
  while (seeds.length < count) {
    const i = Math.floor(rng() * cols * rows);
    if (isLandLike(base[i]) && !seeds.includes(i)) seeds.push(i);
  }
  const owner: (string | null)[] = new Array(cols * rows).fill(null);
  const queue: number[] = [];
  seeds.forEach((i, k) => {
    owner[i] = keys[k]!;
    queue.push(i);
  });
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head]!;
    const col = i % cols;
    const row = Math.floor(i / cols);
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (owner[j] || !isLandLike(base[j])) continue;
      if (rng() < 0.06) continue; // leave some wilderness unclaimed
      owner[j] = owner[i]!;
      queue.push(j);
    }
  }
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) line += owner[hexIndex(cols, col, row)] ?? '.';
    lines.push(line);
  }
  return {
    polities: keys.map((k, i) => ({ key: k, name: `Realm of ${k}`, colour: colours[i]! })),
    rows: lines,
  };
}

const POP_BY_VEG: Partial<Record<Vegetation, number>> = {
  Breadbasket: 42000,
  'Black Earth': 38000,
  'Flood Plain': 30000,
  'Paddy Fields': 34000,
  Assart: 14000,
  Prairie: 9000,
  'Deciduous Forest': 7000,
  'Coniferous Forest': 3000,
  'Subtropical Rainforest': 6000,
  'Tropical Rainforest': 2500,
  'Boreal Forest': 900,
  Savanna: 3500,
  Steppe: 1800,
  Veld: 2200,
  Scrubland: 1200,
  Wetland: 900,
  'Desert Oasis': 4000,
  'Barren Desert': 120,
  Tundra: 90,
};

function buildPopulation(ctx: PromptContext): (number | null)[] {
  const rng = makeRng('pop' + ctx.description);
  const base = ctx.base!;
  return base.map((b, i) => {
    if (!isLandLike(b)) return null;
    const v = ctx.vegetation?.[i] ?? null;
    const e = ctx.elevation?.[i] ?? null;
    let n = v ? POP_BY_VEG[v] ?? 3000 : 3000;
    if (e === 'Mountains') n *= 0.15;
    else if (e === 'Highland') n *= 0.4;
    else if (e === 'Hills') n *= 0.7;
    return Math.round(n * (0.7 + rng() * 0.6));
  });
}

function toRowChars(values: (string | null)[], cols: number, rows: number, empty: string): string[] {
  const out: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) line += values[hexIndex(cols, col, row)] ?? empty;
    out.push(line);
  }
  return out;
}

function toRowTokens(values: (string | null)[], cols: number, rows: number, empty: string): string[] {
  const out: string[] = [];
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let col = 0; col < cols; col++) cells.push(values[hexIndex(cols, col, row)] ?? empty);
    out.push(cells.join(' '));
  }
  return out;
}

const MOCK_NOTE = 'Generated offline by the procedural mock generator (HEXMAP_MOCK=1), not by Claude.';

export function mockLayer(layer: LayerId, ctx: PromptContext): unknown {
  const { cols, rows } = ctx;
  switch (layer) {
    case 'base':
      return {
        rows: toRowChars(buildBase(ctx).map((v) => BASE_CHARS[v]), cols, rows, '~'),
        notes: MOCK_NOTE,
      };
    case 'elevation':
      return {
        rows: toRowChars(
          buildElevation(ctx).map((v) => (v ? ELEVATION_CHARS[v] : null)),
          cols,
          rows,
          '.',
        ),
        notes: MOCK_NOTE,
      };
    case 'climate':
      return {
        latitudeBand: 'mock: pole to pole',
        rows: toRowTokens(buildClimate(ctx), cols, rows, '--'),
        notes: MOCK_NOTE,
      };
    case 'vegetation':
      return {
        rows: toRowTokens(
          buildVegetation(ctx).map((v) => (v ? VEGETATION_CODES[v] : null)),
          cols,
          rows,
          '--',
        ),
        notes: MOCK_NOTE,
      };
    case 'rivers':
      return { rivers: buildRivers(ctx), notes: MOCK_NOTE };
    case 'cities':
      return { cities: buildCities(ctx), notes: MOCK_NOTE };
    case 'polities':
      return { ...buildPolities(ctx), notes: MOCK_NOTE };
    case 'population':
      return {
        rows: toRowTokens(
          buildPopulation(ctx).map((v) => (v === null ? null : String(v))),
          cols,
          rows,
          '-',
        ),
        notes: MOCK_NOTE,
      };
    default:
      throw new Error(`No mock generator for ${layer}`);
  }
}
