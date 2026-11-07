import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, options } from '../../scripts/render-profile-input.ts';
import { buildStaticScene } from '../../src/render/scene.ts';
import { beginRenderProfile, endRenderProfile } from '../../src/render/profile.ts';
import { inBounds, neighbourOf } from '../../shared/hex.ts';
import { coastFitGroups } from '../../src/render/coastArea.ts';
import type { CoastGeometry } from '../../src/render/coast.ts';
import type { PathCmd, Prim } from '../../src/render/prims.ts';

/** Each coast subpath of a scene, as its points. */
function coastRings(prims: Prim[], stroke: string): number[][][] {
  const out: number[][][] = [];
  const walk = (list: Prim[]) => {
    for (const p of list) {
      if (p.kind === 'group') walk(p.prims);
      else if (p.kind === 'path' && p.stroke === stroke) {
        let ring: number[][] | null = null;
        for (const c of p.d) {
          if (c[0] === 'M') { ring = []; out.push(ring); }
          if (c.length >= 3) ring!.push([c[c.length - 2] as number, c[c.length - 1] as number]);
        }
      }
    }
  };
  walk(prims);
  return out;
}

test('a coastal edit refits only its own coast group and leaves the others byte-identical', () => {
  const map = fixture('populated'), opts = options(), { cols, rows } = map, size = opts.size;
  const before = coastRings(buildStaticScene(map, opts).prims, opts.style.palette.coast);
  const base = map.layers.base.data!;
  const hex = base.findIndex((v, i) => i > base.length / 2 && v === 'Land' && [0, 1, 2, 3, 4, 5].some(e => {
    const n = neighbourOf(i % cols, Math.floor(i / cols), e);
    return inBounds(cols, rows, n.col, n.row) && base[n.row * cols + n.col] === 'Sea';
  }));
  const editedMap = { ...map, layers: { ...map.layers, base: { ...map.layers.base, data: base.map((v, i) => i === hex ? 'Sea' : v) } } };
  beginRenderProfile();
  const after = coastRings(buildStaticScene(editedMap, opts).prims, opts.style.palette.coast);
  const { counters } = endRenderProfile();
  // The populated map's coast falls into four groups; one edit refits one of them, in both fits.
  assert.equal(counters['coast.fitGroupBuilds'], 2);
  assert.ok((counters['coast.fitGroupHits'] ?? 0) >= 6);
  // Group the coasts as the fit does, and find the group the edit lies in.
  const asPaths = before.map(ring => ring.map(([x, y], j) => [j ? 'L' : 'M', x!, y!] as PathCmd));
  const groups = coastFitGroups({ paths: asPaths } as unknown as CoastGeometry, new Map([[hex, { share: 0 }]]), cols, size);
  const edited = groups.find(g => g.targets.has(hex))!;
  const same = (a: number[][], b: number[][]) => a.length === b.length && a.every((p, j) => p[0] === b[j]![0] && p[1] === b[j]![1]);
  let others = 0;
  before.forEach((ring, k) => {
    if (edited.rings.includes(k)) return;
    others++;
    assert.ok(after.some(now => same(now, ring)), `coast ${k}, in another group, is redrawn exactly as before`);
  });
  assert.ok(others >= 60, `coasts in other groups: ${others}`);
});
