import { correctBaseGeography } from '../shared/geography.ts';
import type { BaseGeo } from '../shared/types.ts';

/**
 * The benchmark's map: a continent whose coast hexes carry explicit land shares (about half of
 * them concentrated), straits, isthmuses, mainland-and-island hexes, offshore island hexes and
 * inland lakes. `layout` 'plain' leaves every coast hex plain Land instead. The modules
 * are passed in so the same map can be built against another checkout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function featureFixture(deps: { createMapState: any; neighbourOf: any; inBounds: any; hexIndex: any }, N: number, layout: string) {
  const { createMapState, neighbourOf, inBounds, hexIndex } = deps;

  const map = createMapState('Coast feature benchmark', N, N);
  map.id = `coast-feature-${layout}`;
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base: string[] = Array.from({ length: N * N }, (_, i) => {
    const x = i % N, y = Math.floor(i / N);
    const d = Math.hypot(x - N / 2, (y - N / 2) * 0.9) + Math.sin(y / 2.3) * 3 + Math.cos(x / 1.7) * 2;
    return d < N * 0.33 ? 'Land' : 'Sea';
  });
  for (const [cx, cy] of [[N * .43, N * .4], [N * .63, N * .63]] as const) {
    const radius = Math.max(1.5, N * .065);
    const cells = base.flatMap((v, i) => v === 'Land' && Math.hypot(i % N - cx, (Math.floor(i / N) - cy) * 1.15) <= radius ? [i] : []);
    if (cells.every(i => [0, 1, 2, 3, 4, 5].every(e => {
      const n = neighbourOf(i % N, Math.floor(i / N), e);
      return inBounds(N, N, n.col, n.row) && base[hexIndex(N, n.col, n.row)] === 'Land';
    }))) for (const i of cells) base[i] = 'Lake';
  }
  const neighbours = (i: number) => [0, 1, 2, 3, 4, 5].map(e => {
    const n = neighbourOf(i % N, Math.floor(i / N), e);
    return inBounds(N, N, n.col, n.row) ? hexIndex(N, n.col, n.row) : -1;
  });
  const shapes: Record<string, object> = {}, islandSpecs: Record<string, object> = {};
  const original = [...base];
  for (let i = 0; i < N * N; i++) {
    const around = neighbours(i);
    if (original[i] === 'Land' && around.some(j => j >= 0 && original[j] === 'Sea')) {
      const r = random();
      if (layout === 'plain') { base[i] = 'Land'; continue; }
      if (r < 0.06) { base[i] = 'Strait'; shapes[i] = { type: 'Strait', land: 40 }; }
      else if (r < 0.10) { base[i] = 'Isthmus'; shapes[i] = { type: 'Isthmus', land: 50 }; }
      else if (r < 0.16) { base[i] = 'Mainland and islands'; islandSpecs[i] = { large: 0, small: 2 }; }
      else {
        base[i] = 'Land';
        if (r < 0.7) shapes[i] = { type: 'Land', land: 30 + Math.round(random() * 60),
          ...(r < 0.4 ? { concentrationSide: Math.floor(random() * 6), concentration: 60 } : {}) };
      }
    } else if (original[i] === 'Sea' && around.every(j => j >= 0 && original[j] === 'Sea')
      && around.some(j => neighbours(j).some(k => k >= 0 && original[k] === 'Land')) && random() < 0.08 && layout !== 'plain') {
      base[i] = 'Islands';
      islandSpecs[i] = { large: 1, small: Math.floor(random() * 3) };
    }
  }
  if (layout !== 'plain' && N >= 24) {
    // A real neck joining the continent to a small offshore landmass. The two
    // banks are E/W; four water neighbours leave room on both sides of the neck.
    const col = 3, row = Math.floor(N / 3), neck = row * N + col;
    if (base[neck] === 'Land' && base[neck + 1] === 'Land') {
      for (const i of neighbours(neck)) { base[i] = 'Sea'; delete shapes[i]; delete islandSpecs[i]; }
      base[neck - 1] = base[neck + 1] = 'Land';
      for (let y = row - 1; y <= row + 1; y++) for (let x = 0; x <= 1; x++) {
        const h = y * N + x; base[h] = 'Land'; delete shapes[h]; delete islandSpecs[h];
      }
      base[neck] = 'Isthmus'; shapes[neck] = { type: 'Isthmus', width: 'Normal' };
    }
    // A short lake channel between two separated mainland banks. Do not label
    // an arbitrary three/four-bank coast hex as a strait just to include the type.
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== 'Lake') continue;
      const around = neighbours(i), banks = around.flatMap((h, e) => h >= 0 && (base[h] === 'Land' || base[h] === 'Mainland and islands') ? [e] : []);
      if (around.every(h => h >= 0) && banks.length === 2 && ![1, 5].includes((banks[1]! - banks[0]! + 6) % 6)) {
        base[i] = 'Strait'; shapes[i] = { type: 'Strait', width: 'Narrow', land: 50 }; break;
      }
    }
  }
  const corrected = correctBaseGeography(base as BaseGeo[], N, N);
  map.layers.base.data = corrected;
  map.hexShapes = Object.fromEntries(Object.entries(shapes).map(([h, shape]) => [h, { ...shape, type: corrected[Number(h)] }]));
  map.islandSpecs = Object.fromEntries(Object.entries(islandSpecs).filter(([h]) => corrected[Number(h)] === 'Islands' || corrected[Number(h)] === 'Mainland and islands'));
  return map;
}
