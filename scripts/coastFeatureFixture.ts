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
  const passage = (i: number) => {
    const ring = neighbours(i).map(j => j >= 0 ? ['Land', 'Glacier', 'Mainland and islands', 'Isthmus', 'Strait'].includes(base[j]!) ? 'land' : 'water' : null);
    const groups = (side: string) => ring.filter((v, e) => v === side && ring[(e + 5) % 6] !== side).length;
    return groups('land') >= 2 && groups('water') >= 2;
  };
  const shapes: Record<string, object> = {}, islandSpecs: Record<string, object> = {};
  const original = [...base];
  for (let i = 0; i < N * N; i++) {
    const around = neighbours(i);
    if (original[i] === 'Land' && around.some(j => j >= 0 && original[j] === 'Sea')) {
      const r = random();
      if (layout === 'plain') { base[i] = 'Land'; continue; }
      const landCount = around.filter(j => j >= 0 && ['Land', 'Glacier', 'Mainland and islands', 'Isthmus', 'Strait'].includes(base[j]!)).length;
      const waterCount = around.filter(j => j >= 0 && ['Sea', 'Lake', 'Sea Ice', 'Islands'].includes(base[j]!)).length;
      if (r < 0.06 && landCount >= 2 && waterCount >= 2 && waterCount <= 4 && passage(i)) { base[i] = 'Strait'; shapes[i] = { type: 'Strait', land: 40 }; }
      else if (r < 0.10 && landCount >= 2 && waterCount >= 2 && waterCount <= 4 && passage(i)) { base[i] = 'Isthmus'; shapes[i] = { type: 'Isthmus', land: 50 }; }
      else if (r < 0.16 && landCount > 0 && waterCount > 0) { base[i] = 'Mainland and islands'; islandSpecs[i] = { large: 0, small: 2 }; }
      else {
        base[i] = 'Land';
        if (r < 0.7) shapes[i] = { type: 'Land', land: 30 + Math.round(random() * 60),
          ...(r < 0.4 ? { concentrationSide: Math.floor(random() * 6), concentration: 60 } : {}) };
      }
    } else if (original[i] === 'Sea' && around.some(j => j >= 0 && original[j] === 'Land') && random() < 0.08 && layout !== 'plain') {
      base[i] = 'Islands';
      islandSpecs[i] = { large: 0, small: 1 + Math.floor(random() * 3) };
    }
  }
  // A round continent's coast seldom offers the two separate land groups and two separate water
  // groups a passage needs, so the random choice above rarely fires. Give each passage type two
  // hexes by tying a one-hex islet to the coast: the passage hex has the mainland on one side, the
  // islet opposite, and open sea on both flanks (two hexes each), so the requested share is one
  // the passage can be drawn at. Only plain Land with no share of its own is tied, so no passage or
  // mixed hex loses the neighbours it needs and the root does not starve the neck of land.
  const tiedIslet = (c: number, e: number) => {
    const s = neighbours(c)[e]!, t = s >= 0 ? neighbours(s)[e]! : -1;
    if (base[c] !== 'Land' || shapes[c] || s < 0 || t < 0 || base[s] !== 'Sea' || base[t] !== 'Sea') return null;
    if (!neighbours(t).every(j => j === s || (j >= 0 && base[j] === 'Sea'))) return null;
    if (!neighbours(s).every(j => j === t || j === c || (j >= 0 && base[j] === 'Sea'))) return null;
    return { s, t };
  };
  if (layout !== 'plain') for (const [k, type] of ['Strait', 'Isthmus', 'Strait', 'Isthmus'].entries()) {
    const candidates = base.flatMap((_, c) => [0, 1, 2, 3, 4, 5].flatMap(e => tiedIslet(c, e) ?? []));
    // Spread the four along the coast rather than taking the first four in scan order.
    const pick = candidates[Math.floor(candidates.length * (2 * k + 1) / 8)];
    if (!pick) continue;
    base[pick.s] = type; base[pick.t] = 'Land';
    // At Normal width such a passage cannot be drawn at every share its category allows: an isthmus
    // needs about 54–59% land or more, and a strait holds at most about a third. Ask for shares it
    // can reach, so the benchmark measures fitting rather than a reported miss.
    shapes[pick.s] = { type, land: type === 'Strait' ? 30 : 60 };
  }
  map.layers.base.data = base;
  map.hexShapes = shapes;
  map.islandSpecs = islandSpecs;
  return map;
}
