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
  for (let k = 0; k < 6; k++) {
    const c = Math.floor(N * 0.4 + random() * N * 0.2) * N + Math.floor(N * 0.35 + random() * N * 0.3);
    if (base[c] === 'Land') base[c] = 'Lake';
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
      else if (r < 0.16) { base[i] = 'Mainland and islands'; islandSpecs[i] = { count: 2 }; }
      else {
        base[i] = 'Land';
        if (r < 0.7) shapes[i] = { type: 'Land', land: 30 + Math.round(random() * 60),
          ...(r < 0.4 ? { concentrationSide: Math.floor(random() * 6), concentration: 60 } : {}) };
      }
    } else if (original[i] === 'Sea' && around.some(j => j >= 0 && original[j] === 'Land') && random() < 0.08 && layout !== 'plain') {
      base[i] = 'Islands';
      islandSpecs[i] = { count: 1 + Math.floor(random() * 3) };
    }
  }
  map.layers.base.data = base;
  map.hexShapes = shapes;
  map.islandSpecs = islandSpecs;
  return map;
}
