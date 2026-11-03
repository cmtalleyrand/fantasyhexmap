/** Review-only B2 alternative (§75, §84). Does not change serialized scenes. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Injected into both scene and canvas bundles, so only registered realm band paths
// are thinned. Clips, coast strokes, fills and all serialized commands stay intact.
const helperPath = fileURLToPath(new URL('../src/render/bandLines.ts', import.meta.url));

export function bandThinningTrial() {
  return { name: 'band-thinning-trial', setup(build) {
    build.onResolve({ filter: /^band-thinning-trial$/ }, () => ({ path: helperPath }));
    build.onLoad({ filter: /src\/render\/(scene|canvas)\.ts$/ }, ({ path }) => {
      let contents = readFileSync(path, 'utf8');
      if (contents.includes("from './bandLines.js'")) throw Error('This tree already thins bands; compare without --thin.');
      if (path.endsWith('/scene.ts')) {
        const ground = "{ kind: 'path' as const, d: [...loops, ...shores], stroke: evenGround, strokeWidth: band.width * 2, round: true }";
        const ink = `{
              kind: 'path',
              d: [...loops, ...shores],
              stroke: solid ?? (band.alpha < 1 ? withAlpha(colour, band.alpha) : colour),
              strokeWidth: band.width * 2,
              round: true,
            }`;
        if (!contents.includes(ground) || !contents.includes(ink)) throw Error('Cannot locate the two realm band primitives');
        contents = `import { markBandLine } from 'band-thinning-trial';\n` + contents
          .replace(ground, 'markBandLine(' + ground + ', size)')
          .replace(ink, 'markBandLine(' + ink + ', size)');
      } else {
        const original = 'const path = tracePath(ctx, prim.d);';
        if (contents.split(original).length !== 2) throw Error('Cannot locate canvas path compiler');
        contents = `import { paintBandLine } from 'band-thinning-trial';\n` + contents.replace(original, 'const path = tracePath(ctx, paintBandLine(prim));');
      }
      return { contents, loader: 'ts' };
    });
  } };
}
