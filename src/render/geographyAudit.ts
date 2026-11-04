import { gridPixelSize, inBounds, pixelToOffset, type Point } from '../../shared/hex.js';
import { checkBaseGeography, geographyCategory, geographyMessage, type GeographyIssue } from '../../shared/geography.js';
import type { BaseData } from '../../shared/types.js';

/**
 * On-demand drawing check, outside the scene builder and paint path. Sample actual dry land,
 * not colours, ink or ice, then find connected land pieces within each constrained hex.
 * This is a finite-resolution screen (20 samples per hex radius); very small features still
 * need image review. Intermediate probes prevent a sub-sample water gap becoming a connection.
 */
export function auditGeography(base: BaseData, cols: number, rows: number, size: number,
  landAt: (p: Point) => boolean, islandAt?: (p: Point) => boolean): GeographyIssue[] {
  const issues = checkBaseGeography(base, cols, rows);
  const invalidPassages = new Set(issues.filter(issue => issue.kind === 'passage-neighbours').map(issue => issue.hex));
  const step = size / 20;
  const bounds = gridPixelSize(cols, rows, size);
  const width = Math.ceil(bounds.width / step), height = Math.ceil(bounds.height / step);
  const land = new Uint8Array(width * height);
  const owner = new Int32Array(land.length);
  const point = (at: number): Point => ({ x: (at % width + .5) * step, y: (Math.floor(at / width) + .5) * step });
  for (let at = 0; at < land.length; at++) {
    const p = point(at), h = pixelToOffset(p.x, p.y, size);
    if (!inBounds(cols, rows, h.col, h.row)) continue;
    owner[at] = h.row * cols + h.col;
    if (landAt(p)) land[at] = 1;
  }
  const connects = (a: number, b: number): boolean => {
    const from = point(a), to = point(b);
    for (const t of [.25, .5, .75]) if (!landAt({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return false;
    // Diagonal samples can follow a real oblique shore, but a point-only corner
    // contact is not a land bridge: there must be width on both sides of its middle.
    if (from.x !== to.x && from.y !== to.y) {
      const x = (from.x + to.x) / 2, y = (from.y + to.y) / 2;
      const dx = (to.y - from.y) * .02, dy = (from.x - to.x) * .02;
      if (!landAt({ x: x + dx, y: y + dy }) || !landAt({ x: x - dx, y: y - dy })) return false;
    }
    return true;
  };
  const pieces = new Map<number, Array<{ touches: Set<number>; island: boolean }>>();
  const queue = new Int32Array(land.length);
  for (let at = 0; at < land.length; at++) {
    if (land[at] !== 1) continue;
    const hex = owner[at]!, type = base[hex];
    if (!type || type === 'Land' || type === 'Glacier') continue;
    const touches = new Set<number>();
    let island = false;
    let head = 0, tail = 1;
    queue[0] = at; land[at] = 2;
    while (head < tail) {
      const p = queue[head++]!, x = p % width, y = Math.floor(p / width);
      if (type === 'Mainland and islands' && islandAt && !island) island = islandAt(point(p));
      const neighbours = [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1,
        y > 0 ? p - width : -1, y + 1 < height ? p + width : -1,
        x > 0 && y > 0 ? p - width - 1 : -1, x + 1 < width && y > 0 ? p - width + 1 : -1,
        x > 0 && y + 1 < height ? p + width - 1 : -1, x + 1 < width && y + 1 < height ? p + width + 1 : -1];
      for (const n of neighbours) {
        if (n < 0 || !land[n]) continue;
        if (owner[n] === hex) {
          if (land[n] === 1 && connects(p, n)) { land[n] = 2; queue[tail++] = n; }
        } else if (connects(p, n)) touches.add(owner[n]!);
      }
    }
    const existing = pieces.get(hex);
    const component = { touches, island };
    if (existing) existing.push(component);
    else pieces.set(hex, [component]);
  }
  const report = (hex: number, kind: GeographyIssue['kind'], detail: string) =>
    issues.push({ hex, kind, message: geographyMessage(base, cols, hex, detail) });
  for (let hex = 0; hex < cols * rows; hex++) {
    const type = base[hex], components = pieces.get(hex) ?? [];
    if (type === 'Sea' || type === 'Lake' || type === 'Sea Ice') {
      if (components.some(({ touches }) => touches.size === 0)) report(hex, 'detached-water-land',
        'drawn land is detached from land in neighbouring hexes. Use an island hex for detached islands.');
    } else if (type === 'Islands') {
      if (components.some(({ touches }) => touches.size > 0)) report(hex, 'island-connection',
        'an island connects to land in a neighbouring hex; islands must stay detached.');
    } else if (type === 'Mainland and islands') {
      if (!components.some(({ touches }) => [...touches].some(h => geographyCategory(base[h]) === 'land'))) {
        report(hex, 'mainland-connection', 'the drawn mainland does not connect to a neighbouring land hex.');
      }
      if (!components.some(({ touches, island }) => touches.size === 0 && (!islandAt || island))) report(hex, 'missing-islands',
        'there is no detached offshore island in the drawing.');
      if (components.some(({ touches, island }) => touches.size > 0
        && (island || ![...touches].some(h => geographyCategory(base[h]) === 'land')))) {
        report(hex, 'island-connection', 'an offshore island connects to mainland or to land in a neighbouring hex instead of staying detached.');
      }
    } else if (type === 'Isthmus' || type === 'Strait') {
      // Data errors are already reported above; do not invent banks for invalid input.
      if (invalidPassages.has(hex)) continue;
      const banks = new Set(components.flatMap(({ touches }) => [...touches].filter(h => geographyCategory(base[h]) === 'land')));
      if (banks.size !== 2 || (type === 'Isthmus' && !components.some(({ touches }) => [...touches].filter(h => geographyCategory(base[h]) === 'land').length === 2))) {
        report(hex, 'passage-connection', type === 'Isthmus'
          ? 'the drawn land neck does not join both neighbouring land hexes.'
          : 'the drawn banks do not connect to both neighbouring land hexes.');
      }
    }
  }
  return issues;
}
