import assert from 'node:assert/strict';
import test from 'node:test';
import { coastEdges, coastGeometryOf } from '../src/render/coast.ts';
import { fitCoastAreas } from '../src/render/coastArea.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { gridPixelSize } from '../shared/hex.ts';
import type { BaseGeo } from '../shared/types.ts';

test('repeated coast fitting cannot compound a small feature into a spike', () => {
  const size = 26, cols = 11, rows = 9;
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  for (const i of [25, 26, 36, 37, 48, 60, 61, 71, 72]) base[i] = 'Lake';
  const geometry = coastGeometryOf(coastEdges(base, cols, rows, size), true,
    { size, amplitude: () => .12, noise: () => .4 });
  const targets = new Map(base.map((v, i) => [i, { share: v === 'Lake' ? .1 : .8 }]));
  const page = gridPixelSize(cols, rows, size);
  const fit = (rounds: number) => fitCoastAreas(geometry, targets, cols, rows, size, page, .4, [], rounds)
    .paths.map(d => pathPolylines(d, 8)[0]!);
  const initial = fit(0), final = fit(16);
  for (let k = 0; k < initial.length; k++) {
    const a = initial[k]!, b = final[k]!;
    assert.equal(b.length, a.length);
    // Over stretches of at least a fifth of a hex: a spike shows at that scale, while the
    // roughening's smallest teeth turn a chord of a few samples whenever they move at all.
    for (let j = 0, e = 0; j < a.length; j += 2) {
      let arc = 0;
      for (e = j; e + 1 < a.length && arc < size * 0.2; e++) arc += Math.hypot(a[e + 1]!.x - a[e]!.x, a[e + 1]!.y - a[e]!.y);
      if (arc < size * 0.2) break;
      const ux = a[e]!.x - a[j]!.x, uy = a[e]!.y - a[j]!.y;
      const vx = b[e]!.x - b[j]!.x, vy = b[e]!.y - b[j]!.y;
      const before = Math.hypot(ux, uy), after = Math.hypot(vx, vy);
      if (before < size * 0.05) continue;
      assert.ok(after <= before * 2 + 1e-8, 'total stretch stays bounded across all fitting passes');
      assert.ok(ux * vx + uy * vy >= before * after * .64 - 1e-8, 'total turn stays bounded');
    }
  }
});
