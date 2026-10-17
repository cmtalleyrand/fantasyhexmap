/**
 * How mirror-symmetric each partly-land hex is drawn: its land as drawn reflected across the
 * hex's six mirror axes, scored by the overlap of its lesser part (water in a mostly-land hex) with
 * its reflection (intersection over union; 1 is a perfect mirror image).
 * Prints the distribution and the most symmetric hexes for the coast feature map, or for a map
 * saved as JSON:  node --import tsx scripts/coast-symmetry.ts [map.json]
 */
import { readFileSync } from 'node:fs';
import { createMapState } from '../shared/layers.ts';
import * as hex from '../shared/hex.ts';
import { featureFixture } from './coastFeatureFixture.ts';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';

const map = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
  : featureFixture({ createMapState, neighbourOf: hex.neighbourOf, inBounds: hex.inBounds, hexIndex: hex.hexIndex }, 30, 'mixed');
if (!process.argv[2]) map.id += '0';
const size = 26;
const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) });
const land = landTestOf(scene)!;
const rows: Array<{ i: number; type: string; share: number; mirror: number }> = [];
for (let i = 0; i < map.cols * map.rows; i++) {
  const c = hex.hexCenter(i % map.cols, Math.floor(i / map.cols), size);
  const pts: Array<{ x: number; y: number; on: boolean }> = [];
  for (let x = -size; x <= size; x += size / 16) for (let y = -size; y <= size; y += size / 16) {
    if (Math.abs(x) > Math.sqrt(3) / 2 * size * 0.999 || Math.abs(y) + Math.abs(x) / Math.sqrt(3) > size * 0.999) continue;
    pts.push({ x, y, on: land({ x: c.x + x, y: c.y + y }) });
  }
  const share = pts.filter(p => p.on).length / pts.length;
  if (share < 0.05 || share > 0.95) continue;
  // Score the hex's lesser part (its water when mostly land, its land when mostly water):
  // that is where a mirror image shows, whatever the share.
  const minority = share > 0.5 ? (q: { x: number; y: number }) => !land(q) : land;
  let mirror = 0;
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 6, ux = Math.cos(a), uy = Math.sin(a);
    let both = 0, either = 0;
    for (const p of pts) {
      const d = p.x * ux + p.y * uy, rx = 2 * d * ux - p.x, ry = 2 * d * uy - p.y;
      const here = share > 0.5 ? !p.on : p.on, there = minority({ x: c.x + rx, y: c.y + ry });
      if (here && there) both++;
      if (here || there) either++;
    }
    mirror = Math.max(mirror, either ? both / either : 0);
  }
  rows.push({ i, type: map.layers.base.data[i], share: +share.toFixed(2), mirror: +mirror.toFixed(3) });
}
rows.sort((a, b) => b.mirror - a.mirror);
const q = (f: number) => rows[Math.floor(f * (rows.length - 1))]!.mirror;
console.log(JSON.stringify({ hexes: rows.length, median: q(0.5), p90: q(0.1), over07: rows.filter(r => r.mirror > 0.7).length }));
console.log(rows.slice(0, 12).map(r => `${r.i} ${r.type} land ${r.share} mirror ${r.mirror}`).join('\n'));
