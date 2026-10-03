/**
 * The bundled font files, for the browser only.
 *
 * Vite turns each import into a URL of a file shipped with the app, so the
 * fonts work offline and on GitHub Pages with no outside host. Faces are
 * registered with the FontFace API under "HexMap ..." family names (so a
 * copy the user happens to have installed cannot stand in for them), loaded
 * on demand per pairing, and embedded in SVG exports so the file looks the
 * same in any viewer.
 */

import cinzel500 from '@fontsource/cinzel/files/cinzel-latin-500-normal.woff2?url';
import cinzel600 from '@fontsource/cinzel/files/cinzel-latin-600-normal.woff2?url';
import ebgaramond500 from '@fontsource/eb-garamond/files/eb-garamond-latin-500-normal.woff2?url';
import ebgaramond600 from '@fontsource/eb-garamond/files/eb-garamond-latin-600-normal.woff2?url';
import ebgaramond500i from '@fontsource/eb-garamond/files/eb-garamond-latin-500-italic.woff2?url';
import imfell400 from '@fontsource/im-fell-english/files/im-fell-english-latin-400-normal.woff2?url';
import imfell400i from '@fontsource/im-fell-english/files/im-fell-english-latin-400-italic.woff2?url';
import imfellsc400 from '@fontsource/im-fell-english-sc/files/im-fell-english-sc-latin-400-normal.woff2?url';
import almendra400 from '@fontsource/almendra/files/almendra-latin-400-normal.woff2?url';
import almendra400i from '@fontsource/almendra/files/almendra-latin-400-italic.woff2?url';
import almendrasc400 from '@fontsource/almendra-sc/files/almendra-sc-latin-400-normal.woff2?url';
import uncial400 from '@fontsource/uncial-antiqua/files/uncial-antiqua-latin-400-normal.woff2?url';
import { invalidateTextMeasures } from './fonts.js';
import { BUNDLED_FACES, letteringFaces, type BundledFace, type LetteringId } from './lettering.js';
import type { Prim, Scene } from './scene.js';

const FILES: Record<string, string> = {
  'cinzel-500': cinzel500,
  'cinzel-600': cinzel600,
  'ebgaramond-500': ebgaramond500,
  'ebgaramond-600': ebgaramond600,
  'ebgaramond-500i': ebgaramond500i,
  'imfell-400': imfell400,
  'imfell-400i': imfell400i,
  'imfellsc-400': imfellsc400,
  'almendra-400': almendra400,
  'almendra-400i': almendra400i,
  'almendrasc-400': almendrasc400,
  'uncial-400': uncial400,
};

const loaded = new Map<string, Promise<void>>();

function loadFace(face: BundledFace): Promise<void> {
  const hit = loaded.get(face.file);
  if (hit) return hit;
  const promise = (async () => {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return;
    const font = new FontFace(face.family, `url(${FILES[face.file]}) format("woff2")`, {
      weight: String(face.weight),
      style: face.italic ? 'italic' : 'normal',
    });
    await font.load();
    document.fonts.add(font);
  })().catch(() => {
    // A face that fails to load falls back to the stack's next font; drop the
    // failed attempt so a later call can try again.
    loaded.delete(face.file);
  });
  loaded.set(face.file, promise);
  return promise;
}

/**
 * Load every face a pairing uses. Resolves once they are ready (or have
 * failed, leaving the fallback fonts); text measured before then is measured
 * again afterwards.
 */
export async function loadLettering(id: LetteringId): Promise<void> {
  const faces = letteringFaces(id);
  if (faces.length === 0) return;
  await Promise.all(faces.map(loadFace));
  invalidateTextMeasures();
}

const dataUris = new Map<string, Promise<string>>();

async function dataUri(face: BundledFace): Promise<string> {
  let hit = dataUris.get(face.file);
  if (!hit) {
    hit = fetch(FILES[face.file]!)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return `data:font/woff2;base64,${btoa(binary)}`;
      });
    dataUris.set(face.file, hit);
  }
  return hit;
}

function textPrims(prims: Prim[]): Array<Extract<Prim, { kind: 'text' }>> {
  return prims.flatMap((p) => (p.kind === 'text' ? [p] : p.kind === 'group' ? textPrims(p.prims) : []));
}

/**
 * `@font-face` rules for the bundled faces a scene's text uses, with the font
 * data inline, for an SVG export to carry its own fonts.
 */
export async function embeddedFontCss(scene: Scene): Promise<string> {
  const used = new Set<BundledFace>();
  for (const t of textPrims(scene.prims)) {
    if (!t.font) continue;
    for (const face of BUNDLED_FACES) {
      if (
        t.font.startsWith(`"${face.family}"`) &&
        face.italic === Boolean(t.italic) &&
        face.weight === (t.weight ?? 600)
      ) {
        used.add(face);
      }
    }
  }
  const rules = await Promise.all(
    [...used].map(async (face) =>
      `@font-face{font-family:"${face.family}";src:url(${await dataUri(face)}) format("woff2");font-weight:${face.weight};font-style:${face.italic ? 'italic' : 'normal'};}`,
    ),
  );
  return rules.join('\n');
}
