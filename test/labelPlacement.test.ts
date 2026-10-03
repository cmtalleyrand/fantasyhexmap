import assert from 'node:assert/strict';
import test from 'node:test';
import { hexCenter } from '../shared/hex.ts';
import { claimBox, placePolityLabels, type PolityLabel } from '../src/render/labels.ts';

const SIZE = 20;
const measure = (text: string) => text.length * 0.7;

/** Hexes of a `cols` x `rows` grid whose centres lie in the pixel rectangle, owned by `id`. */
function ownedIn(cols: number, rows: number, id: string, rect: { x0: number; x1: number; y0: number; y1: number }) {
  const owner: (string | null)[] = Array(cols * rows).fill(null);
  for (let i = 0; i < owner.length; i++) {
    const c = hexCenter(i % cols, Math.floor(i / cols), SIZE);
    if (c.x >= rect.x0 && c.x <= rect.x1 && c.y >= rect.y0 && c.y <= rect.y1) owner[i] = id;
  }
  return owner;
}

function place(cols: number, rows: number, owner: (string | null)[], name: string, obstacles: Parameters<typeof placePolityLabels>[0]['obstacles'] = []): PolityLabel | undefined {
  return placePolityLabels({
    cols,
    rows,
    size: SIZE,
    owner,
    polities: [{ id: 'a', name }],
    obstacles,
    minHexes: 0,
    measure,
  })[0];
}

test('a name keeps its place in the corner that a tilted name\'s bounding box would have blocked', () => {
  // A long name tilted 30 degrees claims a thin diagonal strip, but its
  // axis-aligned bounds cover a far larger rectangle, corners included.
  const tilted = claimBox({ x: 350, y: 200 }, 440, 24, Math.PI / 6, 12);
  const owner = ownedIn(20, 12, 'a', { x0: 440, x1: 560, y0: 60, y1: 150 });
  const alone = place(20, 12, owner, 'AB');
  const beside = place(20, 12, owner, 'AB', [tilted]);
  assert.ok(alone && beside);
  assert.deepEqual(beside.at, alone.at);
  assert.equal(beside.size, alone.size);
  assert.ok(beside.at.x > 160 && beside.at.x < 540 && beside.at.y > 90 && beside.at.y < 310, 'the name sits inside the tilted name\'s bounding box');
});

test('a name does not run over a tilted name it shares a territory with', () => {
  const tilted = claimBox({ x: 350, y: 200 }, 440, 24, Math.PI / 6, 12);
  // Territory spanning the strip itself: the name must find clear ground.
  const owner = ownedIn(20, 12, 'a', { x0: 100, x1: 600, y0: 40, y1: 300 });
  const label = place(20, 12, owner, 'REALM', [tilted]);
  assert.ok(label);
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  const w = measure('REALM') * label.size;
  // Sample along the name's baseline: no sample lies inside the tilted strip.
  for (let t = -0.5; t <= 0.5; t += 0.1) {
    const px = label.at.x + t * w * Math.cos(label.rotation);
    const py = label.at.y + t * w * Math.sin(label.rotation);
    const along = (px - 350) * c + (py - 200) * s;
    const across = -(px - 350) * s + (py - 200) * c;
    const inside = Math.abs(along) <= 220 && Math.abs(across) <= 12;
    assert.ok(!inside, `baseline point (${px.toFixed(0)}, ${py.toFixed(0)}) lies on the tilted name`);
  }
});

test('two names keep clear space between them instead of touching', () => {
  const cols = 24;
  const owner = ownedIn(cols, 1, 'a', { x0: 0, x1: 900, y0: 0, y1: 100 });
  const alone = place(cols, 1, owner, 'AHNVER');
  assert.ok(alone);
  const width = measure('AHNVER') * alone.size;
  // Another name begins exactly where this one ends.
  const touching = claimBox({ x: alone.at.x + width / 2 + 40, y: alone.at.y }, 80, alone.size * 1.1, 0, alone.size);
  const apart = place(cols, 1, owner, 'AHNVER', [{ ...touching, padX: 0, padY: 0 }]);
  assert.ok(apart);
  const right = apart.at.x + (measure('AHNVER') * apart.size) / 2;
  const gap = touching.cx - touching.halfW - right;
  assert.ok(gap >= apart.size * 0.2, `gap ${gap.toFixed(1)} is under a fifth of the type size ${apart.size.toFixed(1)}`);
});

test('a ring-shaped realm is named on its band, grazing its lake at most', () => {
  const cols = 18;
  const rows = 16;
  const c0 = { x: 320, y: 200 };
  const lake = new Set<number>();
  const owner: (string | null)[] = Array(cols * rows).fill(null);
  for (let i = 0; i < owner.length; i++) {
    const c = hexCenter(i % cols, Math.floor(i / cols), SIZE);
    const r = Math.hypot(c.x - c0.x, c.y - c0.y);
    if (r > 190) continue;
    owner[i] = 'a';
    if (r < 80) lake.add(i); // the realm's own lake, in its middle
  }
  const [label] = placePolityLabels({
    cols,
    rows,
    size: SIZE,
    owner,
    polities: [{ id: 'a', name: 'Kingdom' }],
    obstacles: [],
    minHexes: 0,
    lakes: lake,
    measure,
  });
  assert.ok(label, 'the ring is named');
  const w = measure('KINGDOM') * label.size;
  let over = 0;
  const steps = 20;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps - 0.5;
    const x = label.at.x + t * w * Math.cos(label.rotation);
    const y = label.at.y + t * w * Math.sin(label.rotation);
    if (Math.hypot(x - c0.x, y - c0.y) < 80) over++;
  }
  assert.ok(over / (steps + 1) <= 0.15, `${over} of ${steps + 1} baseline points lie over the lake`);
});
