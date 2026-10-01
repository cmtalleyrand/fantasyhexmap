/**
 * Font stacks and text measurement shared by the renderers and label layout.
 *
 * The scene builder is pure and also runs under node (tests), where there is no
 * canvas. Measurement therefore uses a canvas when one exists and otherwise
 * falls back to a per-character estimate for upper-case semibold display type.
 */

export const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const FANTASY_FONT_STACK = '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

export const FALLBACK_CHAR_EM = 0.66;
/** Exports are rendered by other software with possibly different fonts. */
const SAFETY = 1.04;
const PROBE_PX = 100;

let probe: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();

function context() {
  if (probe !== undefined) return probe;
  try {
    if (typeof OffscreenCanvas !== 'undefined') probe = new OffscreenCanvas(1, 1).getContext('2d');
    else if (typeof document !== 'undefined') probe = document.createElement('canvas').getContext('2d');
    else probe = null;
  } catch {
    probe = null;
  }
  return probe;
}

/** Width of `text` in em (multiply by font size for pixels) in the fantasy face. */
export function fantasyTextEm(text: string, weight = 600): number {
  const key = `${weight}|${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  const ctx = context();
  let em = text.length * FALLBACK_CHAR_EM;
  if (ctx) {
    ctx.font = `${weight} ${PROBE_PX}px ${FANTASY_FONT_STACK}`;
    const measured = ctx.measureText(text).width / PROBE_PX;
    if (measured > 0) em = measured * SAFETY;
  }
  widths.set(key, em);
  return em;
}
