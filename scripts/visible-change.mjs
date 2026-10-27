/**
 * The owner's picture criterion: no visible change, not byte identity (DECISIONS §76).
 *
 * Two RGBA images differ visibly when a change survives a one-pixel tolerance for
 * position: each pixel's channels are compared with the range its 3×3 neighbourhood
 * spans in the other image, both ways. A value inside that range is what a shift of up
 * to a pixel (or an antialiased edge between) produces. Edge antialiasing, first-draw
 * raster variation and sub-pixel geometry moves fall below it; a feature that appears,
 * vanishes, moves by more than a pixel or changes colour does not.
 *
 * Self-contained so browser scripts can inject it with `toString()`.
 */
export function visibleChange(a, b, width, height, limits = {}) {
  const strong = limits.strong ?? 32, weak = limits.weak ?? 8;
  const strongShare = limits.strongShare ?? 1e-4, weakShare = limits.weakShare ?? 1e-2;
  const outside = (from, to, x, y) => {
    const i = (y * width + x) * 4;
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      let low = 255, high = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          const v = to[(yy * width + xx) * 4 + c];
          if (v < low) low = v;
          if (v > high) high = v;
        }
      const v = from[i + c], d = v < low ? low - v : v > high ? v - high : 0;
      if (d > worst) worst = d;
    }
    return worst;
  };
  let changedPixels = 0, maxChannelDelta = 0, strongPixels = 0, weakPixels = 0, maxTolerantDelta = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!d) continue;
    changedPixels++;
    if (d > maxChannelDelta) maxChannelDelta = d;
    const tolerant = Math.max(outside(a, b, x, y), outside(b, a, x, y));
    if (tolerant > maxTolerantDelta) maxTolerantDelta = tolerant;
    if (tolerant > strong) strongPixels++;
    if (tolerant > weak) weakPixels++;
  }
  const pixels = width * height;
  const visible = strongPixels > strongShare * pixels || weakPixels > weakShare * pixels;
  return { visible, changedPixels, maxChannelDelta, maxTolerantDelta, strongPixels, weakPixels };
}
