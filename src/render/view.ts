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
  if (scale === view.scale) return view;
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Two-finger pan and zoom. The view at the start of the gesture is scaled by
 * how far the fingers have spread, and moved so that the map point that was
 * between them at the start is between them now.
 */
export function pinchView(start: View, a0: ScreenPoint, b0: ScreenPoint, a: ScreenPoint, b: ScreenPoint): View {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d = Math.hypot(b.x - a.x, b.y - a.y) || d0;
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, start.scale * (d / d0)));
  const mid0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const world = { x: (mid0.x - start.x) / start.scale, y: (mid0.y - start.y) / start.scale };
  return { scale, x: mid.x - world.x * scale, y: mid.y - world.y * scale };
}
