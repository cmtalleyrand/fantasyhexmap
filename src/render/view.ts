/** Pan and zoom of the interactive map: screen = world * scale + (x, y). */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.12;
export const MAX_SCALE = 6;

/**
 * Zoom by `factor` about the screen point (px, py), keeping whatever is under
 * that point where it is. The wheel zooms about the cursor and the buttons about
 * the middle of the viewport; both go through here.
 */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}
