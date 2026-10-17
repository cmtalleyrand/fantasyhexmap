/**
 * Compare two runs of scripts/coast-outlines.ts: per fixture, the mean, 95th-percentile and largest
 * distance between the two coastlines (in hex radii), and an overlay SVG (red before, blue after).
 *   node scripts/coast-outline-compare.mjs before.json after.json work/outline-compare
 */
import fs from 'node:fs';
const [a, b, dir] = process.argv.slice(2); fs.mkdirSync(dir, { recursive: true });
const A = JSON.parse(fs.readFileSync(a)), B = JSON.parse(fs.readFileSync(b));
const segs = lines => lines.flatMap(l => l.slice(1).map((q, i) => [l[i], q]));
const dist = (p, s) => { const [u, v] = s, dx = v.x - u.x, dy = v.y - u.y; const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p.x - u.x - dx * t, p.y - u.y - dy * t); };
const grid = (ss, c) => { const g = new Map(); ss.forEach(s => { const k = `${Math.floor((s[0].x + s[1].x) / 2 / c)},${Math.floor((s[0].y + s[1].y) / 2 / c)}`; (g.get(k) ?? g.set(k, []).get(k)).push(s); }); return g; };
const near = (p, g, c) => { let best = Infinity; const x = Math.floor(p.x / c), y = Math.floor(p.y / c); for (let r = 1; r < 6 && best === Infinity; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (const s of g.get(`${x + i},${y + j}`) ?? []) best = Math.min(best, dist(p, s)); return best; };
const rows = [];
for (const key of Object.keys(A)) {
  const size = key === 'feature-30' ? 26 : 40, c = size / 2;
  const sa = segs(A[key].lines), sb = segs(B[key].lines), ga = grid(sa, c), gb = grid(sb, c);
  const d = [...B[key].lines.flat().map(p => near(p, ga, c)), ...A[key].lines.flat().map(p => near(p, gb, c))].map(v => Math.min(v, 6 * c) / size);
  d.sort((x, y) => x - y);
  rows.push({ fixture: key, mean: +(d.reduce((s, v) => s + v, 0) / d.length).toFixed(3), p95: +d[Math.floor(d.length * 0.95)].toFixed(3), max: +d[d.length - 1].toFixed(3), closedRings: [A[key].lines.length, B[key].lines.length] });
  const path = (lines, col) => lines.map(l => `<polyline fill="none" stroke="${col}" stroke-width="${size / 20}" stroke-opacity="0.8" points="${l.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>`).join('');
  fs.writeFileSync(`${dir}/${key}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${A[key].width}" height="${A[key].height}" viewBox="0 0 ${A[key].width} ${A[key].height}"><rect width="100%" height="100%" fill="#f4f1e8"/>${path(A[key].lines, '#d22')}${path(B[key].lines, '#22d')}<text x="8" y="20" font-size="16" font-family="sans-serif">${key}: red before, blue after</text></svg>`);
}
console.table(rows);
