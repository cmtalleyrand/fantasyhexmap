import { createMapState } from '../shared/layers.ts';
import { neighbourOf, inBounds } from '../shared/hex.ts';
import type { MapState, BaseGeo } from '../shared/types.ts';

export function coastGallery() {
const W = 9, H = 8, id = (c: number, r: number) => r * W + c;
const block = (c0: number, c1: number, r0: number, r1: number) => { const a: Array<[number, number]> = []; for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) a.push([c, r]); return a; };
const fx: Array<{ name: string; land: Array<[number, number]>; set?: Record<string, object>; types?: Record<string, BaseGeo>; specs?: MapState['islandSpecs'] }> = [
  { name: 'peninsula', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]] },
  { name: 'coast-30', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]], set: { [id(4, 3)]: { land: 30 }, [id(5, 3)]: { land: 30 }, [id(5, 4)]: { land: 30 }, [id(6, 4)]: { land: 30 } } },
  { name: 'coast-conc', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]], set: { [id(4, 3)]: { land: 50, concentrationSide: 1, concentration: 70 }, [id(5, 3)]: { land: 50, concentrationSide: 4, concentration: 70 }, [id(5, 4)]: { land: 40, concentrationSide: 0, concentration: 60 } } },
  { name: 'straight-coast-shares', land: block(0, 3, 0, 7), set: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(r => [id(3, r), { land: 35 + r * 7 }])) },
  { name: 'strait-share', land: [...block(0, 8, 0, 2), ...block(0, 8, 5, 7)], types: { [id(4, 3)]: 'Strait', [id(4, 4)]: 'Strait' }, set: { [id(4, 3)]: { land: 45 }, [id(4, 4)]: { land: 45 } } },
  { name: 'isthmus', land: [...block(0, 2, 0, 7), ...block(6, 8, 0, 7), [3, 3], [4, 3], [5, 3]], types: { [id(4, 3)]: 'Isthmus', [id(3, 3)]: 'Isthmus', [id(5, 3)]: 'Isthmus' } },
  { name: 'mainland-shares', land: [...block(0, 2, 0, 7), [3, 6], [4, 6]], types: { [id(3, 1)]: 'Mainland and islands', [id(3, 3)]: 'Mainland and islands', [id(4, 5)]: 'Mainland and islands' }, specs: { [id(3, 1)]: { large: 0, small: 1 }, [id(3, 3)]: { large: 0, small: 2 }, [id(4, 5)]: { large: 0, small: 1 } }, set: { [id(3, 1)]: { land: 60 }, [id(3, 3)]: { land: 40 }, [id(4, 5)]: { land: 70, concentrationSide: 3, concentration: 60 } } },
];
const out: Array<{name: string; map: MapState}> = [];
for (const level of ['Smooth', 'Wavy', 'Ragged', 'Fractured'] as const) for (const f of fx) {
  const map = createMapState('g', W, H); map.id = `g-${f.name}`;
  const base: BaseGeo[] = Array(W * H).fill('Sea'); for (const [c, r] of f.land) base[id(c, r)] = 'Land';
  for (let i = 0; i < W * H; i++) if (base[i] === 'Land' && ![0, 1, 2, 3, 4, 5].some(e => { const n = neighbourOf(i % W, Math.floor(i / W), e); return inBounds(W, H, n.col, n.row) && base[n.row * W + n.col] === 'Sea'; })) base[i] = 'Land';
  for (const [k, t] of Object.entries(f.types ?? {})) base[Number(k)] = t;
  map.layers.base.data = base; map.hexShapes = Object.fromEntries(Object.entries(f.set ?? {}).map(([k, v]) => [k, { type: base[Number(k)], ...v }])); map.islandSpecs = f.specs ?? {}; map.defaultIrregularity = level;
  out.push({name: `${f.name}-${level}`, map});
}
return out;
}
