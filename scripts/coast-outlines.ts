/**
 * Coastline polylines of a set of coast fixtures (and the 30x30 feature map) built by the checkout at
 * <root>, for scripts/coast-outline-compare.mjs: node --import tsx scripts/coast-outlines.ts <root> <out.json>
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(process.argv[2]!);
const load = (f: string) => import(pathToFileURL(resolve(root, f)).href);
const { createMapState } = await load('shared/layers.ts');
const { buildScene, defaultVisibility } = await load('src/render/scene.ts');
const { resolveStyle } = await load('src/render/styles.ts');
const { pathPolylines } = await load('src/render/ice.ts');
const { neighbourOf, inBounds, hexIndex } = await load('shared/hex.ts');
const { featureFixture } = await import(pathToFileURL(resolve(new URL('./coastFeatureFixture.ts', import.meta.url).pathname)).href);
const style = resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } });
const W = 9, H = 8, id = (c: number, r: number) => r * W + c;
const block = (c0: number, c1: number, r0: number, r1: number) => { const a: Array<[number, number]> = []; for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) a.push([c, r]); return a; };
const fx: Array<{ name: string; land: Array<[number, number]>; set?: any; types?: any; specs?: any }> = [
  { name: 'peninsula', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]] },
  { name: 'coast-30', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]], set: { [id(4, 3)]: { land: 30 }, [id(5, 3)]: { land: 30 }, [id(5, 4)]: { land: 30 }, [id(6, 4)]: { land: 30 } } },
  { name: 'coast-conc', land: [...block(0, 3, 0, 7), [4, 3], [5, 3], [5, 4], [6, 4]], set: { [id(4, 3)]: { land: 50, concentrationSide: 1, concentration: 70 }, [id(5, 3)]: { land: 50, concentrationSide: 4, concentration: 70 }, [id(5, 4)]: { land: 40, concentrationSide: 0, concentration: 60 } } },
  { name: 'straight-coast-shares', land: block(0, 3, 0, 7), set: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(r => [id(3, r), { land: 35 + r * 7 }])) },
  { name: 'strait-share', land: [...block(0, 8, 0, 2), ...block(0, 8, 5, 7)], types: { [id(4, 3)]: 'Strait', [id(4, 4)]: 'Strait' }, set: { [id(4, 3)]: { land: 45 }, [id(4, 4)]: { land: 45 } } },
  { name: 'isthmus', land: [...block(0, 2, 0, 7), ...block(6, 8, 0, 7), [3, 3], [4, 3], [5, 3]], types: { [id(4, 3)]: 'Isthmus', [id(3, 3)]: 'Isthmus', [id(5, 3)]: 'Isthmus' } },
  { name: 'mainland-shares', land: [...block(0, 2, 0, 7), [3, 6], [4, 6]], types: { [id(3, 1)]: 'Mainland and islands', [id(3, 3)]: 'Mainland and islands', [id(4, 5)]: 'Mainland and islands' }, specs: { [id(3, 1)]: { count: 1 }, [id(3, 3)]: { count: 2 }, [id(4, 5)]: { count: 1 } }, set: { [id(3, 1)]: { land: 60 }, [id(3, 3)]: { land: 40 }, [id(4, 5)]: { land: 70, concentrationSide: 3, concentration: 60 } } },
];
const out: Record<string, { width: number; height: number; lines: { x: number; y: number }[][] }> = {};
const strokes = (scene: any) => { const lines: any[] = []; const g = (ps: any[]) => { for (const p of ps) { if (p.kind === 'group') g(p.prims); if (p.kind === 'path' && p.stroke === style.palette.coast) lines.push(...pathPolylines(p.d, 8)); } }; g(scene.prims); return lines; };
for (const level of ['Wavy', 'Ragged']) for (const f of fx) {
  const map = createMapState('g', W, H); map.id = `g-${f.name}`;
  const base = Array(W * H).fill('Sea'); for (const [c, r] of f.land) base[id(c, r)] = 'Coastal Land';
  for (let i = 0; i < W * H; i++) if (base[i] === 'Coastal Land' && ![0, 1, 2, 3, 4, 5].some(e => { const n = neighbourOf(i % W, Math.floor(i / W), e); return inBounds(W, H, n.col, n.row) && base[n.row * W + n.col] === 'Sea'; })) base[i] = 'Land';
  for (const [k, t] of Object.entries(f.types ?? {})) base[Number(k)] = t;
  map.layers.base.data = base; map.hexShapes = Object.fromEntries(Object.entries(f.set ?? {}).map(([k, v]: any) => [k, { type: base[Number(k)], ...v }])); map.islandSpecs = f.specs ?? {}; map.defaultIrregularity = level;
  const scene = buildScene(map, { size: 40, visible: defaultVisibility(), labels: false, style });
  out[`${f.name}-${level}`] = { width: scene.width, height: scene.height, lines: strokes(scene) };
}
const big = featureFixture({ createMapState, neighbourOf, inBounds, hexIndex }, 30, 'mixed'); big.id += '0';
const scene = buildScene(big, { size: 26, visible: defaultVisibility(), labels: false, style });
out['feature-30'] = { width: scene.width, height: scene.height, lines: strokes(scene) };
writeFileSync(process.argv[3]!, JSON.stringify(out));
