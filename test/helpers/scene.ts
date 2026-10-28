import type { Prim } from '../../src/render/prims.ts';

/** Paths in paint order, including nested groups. This does not apply group clips or transforms. */
export function scenePaths(prims: readonly Prim[]): Extract<Prim, { kind: 'path' }>[] {
  return prims.flatMap(prim => {
    if (prim.kind === 'group') return scenePaths(prim.prims);
    return prim.kind === 'path' ? [prim] : [];
  });
}
