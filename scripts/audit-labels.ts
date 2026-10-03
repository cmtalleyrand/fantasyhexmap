/**
 * Report overlaps among a saved map's names and map furniture.
 *
 *   npx tsx scripts/audit-labels.ts path/to/map.json [--size 32] [--no-furniture]
 *
 * The file is a map export (`{ format: 'fantasyhexmap/v1', map }`) or a bare map.
 * Every layer and every kind of name is drawn, as in a full export, with the
 * frame, title, scale bar and compass added unless `--no-furniture` is given.
 * The exit status is 1 when anything overlaps.
 */

import { readFileSync } from 'node:fs';
import { formatAudit, auditScene } from '../src/render/audit.ts';
import { buildExportScene } from '../src/render/export.ts';
import { DEFAULT_MARGINALIA } from '../src/render/marginalia.ts';
import { defaultVisibility } from '../src/render/scene.ts';
import type { MapState } from '../shared/types.ts';

const args = process.argv.slice(2);
const sizeAt = args.indexOf('--size');
const file = args.find((a, i) => !a.startsWith('--') && !(sizeAt >= 0 && i === sizeAt + 1));
if (!file) {
  console.error('usage: audit-labels.ts <map.json> [--size 32] [--no-furniture]');
  process.exit(2);
}
const size = sizeAt >= 0 ? Number(args[sizeAt + 1]) : 32;
const parsed = JSON.parse(readFileSync(file, 'utf8'));
const map = (parsed.map ?? parsed) as MapState;

const visible = defaultVisibility();
for (const id of Object.keys(visible) as Array<keyof typeof visible>) visible[id] = map.layers[id]?.data != null;
visible.base = true;

const scene = buildExportScene(map, visible, {
  format: 'png',
  labels: true,
  riverNames: true,
  rangeNames: true,
  seaNames: true,
  landNames: true,
  polityNames: 0,
  size,
  marginalia: args.includes('--no-furniture') ? null : DEFAULT_MARGINALIA,
});
const issues = auditScene(map, scene, size);
console.log(`${map.name}: ${map.cols} x ${map.rows} hexes, size ${size}`);
for (const f of scene.furniture ?? []) console.log(`  ${f.kind}: ${f.where}`);
console.log(formatAudit(issues));
process.exit(issues.length > 0 ? 1 : 0);
