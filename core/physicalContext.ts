import { baseSurfaceStatistics, landFraction, normaliseHexDimensions, politySurfaceAreas } from '../shared/surfaceArea.js';
import { BASE_GEO_VALUES, DEFAULT_HEX_DIMENSIONS, DEFAULT_ISLAND_SPECS } from '../shared/types.js';
import { gridView } from './grid.js';
import type { PromptContext } from './prompts.js';

/** Measurements use the same land fractions and ownership rules as the app. */
export function physicalContext(ctx: PromptContext): string {
  const dims = normaliseHexDimensions(ctx.hexDimensions);
  const area = 0.75 * dims.width * dims.height;
  const number = (n: number) => Number(n.toPrecision(9));
  const parts = [
    'PHYSICAL SCALE AND LAND SURFACE AREAS (authoritative app settings)',
    `One whole hex: ${number(area)} ${dims.unit}^2; width ${dims.width} ${dims.unit}, height ${dims.height} ${dims.unit}.`,
    'Whole-hex area = 0.75 * width * height. Land area = whole-hex area * effective land fraction.',
    'Use land area for land/realm sizes and population carrying capacity; water area for seas/lakes.',
    'Measured grids and totals below describe the existing map. If replacing base geography, recompute them',
    'for the new terrain using these settings and applicable overrides; do not treat old totals as new geography.',
    'Factory defaults (current map settings below override these):',
    JSON.stringify(DEFAULT_HEX_DIMENSIONS),
    'Current map settings (land percentages, channel widths and physical dimensions):',
    JSON.stringify(dims),
    `Default island configurations: ${JSON.stringify(DEFAULT_ISLAND_SPECS)}`,
    'Default land percentages by terrain, using the current map settings and default island counts:',
    BASE_GEO_VALUES.map((v) => `${v}: ${number(100 * landFraction(v, undefined, dims))}%`).join('; '),
    'Per-hex island configurations (flat index = row * columns + column):',
    JSON.stringify(ctx.islandSpecs ?? {}),
    'Per-hex shape overrides (type must match the hex; land overrides its default percentage):',
    JSON.stringify(ctx.hexShapes ?? {}),
    'Island land is the sum of its large/small island percentages, plus mainland where applicable, capped at 100%.',
    'Without an explicit land percentage, Isthmus land fraction = min(1, 2/sqrt(3) * channel-width fraction);',
    'Strait land fraction = 1 minus that value. Land-bearing Lake/Strait hexes still have no land-only layer values.',
  ];
  if (ctx.base) {
    const fractions = ctx.base.map((v, i) => landFraction(v, ctx.islandSpecs?.[String(i)], dims, ctx.hexShapes?.[String(i)]));
    const rows = Array.from({ length: ctx.rows }, (_, r) => fractions.slice(r * ctx.cols, (r + 1) * ctx.cols).map((f) => String(number(f * 100))).join(' '));
    parts.push('EFFECTIVE LAND PERCENTAGE OF EACH EXISTING HEX (after all overrides):', ...gridView(rows, 'token'));
    parts.push('Measured surface totals:', ...baseSurfaceStatistics(ctx.base, dims, ctx.islandSpecs, ctx.hexShapes)
      .map((s) => `${s.label}: ${number(s.area)} ${dims.unit}^2`));
    if (ctx.polities) {
      const areas = politySurfaceAreas(ctx.base, ctx.polities, dims, ctx.islandSpecs, ctx.hexShapes, ctx.cols);
      parts.push('Measured polity land areas (parents include descendants; shared hexes are weighted):',
        ...ctx.polities.polities.map((p) => `${p.name}: ${number(areas.get(p.id) ?? 0)} ${dims.unit}^2`));
    }
  }
  if (ctx.geoNames?.length) {
    parts.push('NAMED PLACES (kind "name": row r, columns from-to):', ...ctx.geoNames.map((n) => `${n.kind} "${n.name}": ${runs(n.hexes, ctx.cols)}`));
  }
  if (ctx.mountainRanges?.length) {
    parts.push('NAMED MOUNTAIN RANGES ("name": row r, columns from-to):', ...ctx.mountainRanges.map((n) => `"${n.name}": ${runs(n.hexes, ctx.cols)}`));
  }
  return parts.join('\n');
}

/** Hex indices as runs along rows, the form the model writes names in. */
function runs(hexes: number[], cols: number): string {
  const out: string[] = [];
  let last: { row: number; from: number; to: number } | null = null;
  const flush = () => {
    if (last) out.push(`r${last.row} c${last.from}${last.to > last.from ? `-${last.to}` : ''}`);
  };
  for (const index of [...hexes].sort((a, b) => a - b)) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    if (last && last.row === row && last.to === col - 1) last.to = col;
    else {
      flush();
      last = { row, from: col, to: col };
    }
  }
  flush();
  return out.join('; ');
}
