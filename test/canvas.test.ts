import assert from 'node:assert/strict';
import test from 'node:test';
import { drawPrims, drawScene } from '../src/render/canvas.ts';
import type { PathCmd, Prim } from '../src/render/prims.ts';

test('scene bounds clip oversized geometry and restore the caller canvas state', () => {
  const calls: unknown[][] = [];
  const ctx = {
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['begin']),
    rect: (...args: number[]) => calls.push(['rect', ...args]),
    clip: () => calls.push(['clip']),
    arc: (...args: number[]) => calls.push(['arc', ...args]),
    fill: () => calls.push(['fill']),
  } as unknown as CanvasRenderingContext2D;
  drawScene(ctx, {
    width: 100, height: 80, background: 'transparent',
    prims: [{ kind: 'circle', c: { x: 50, y: 40 }, r: 120, fill: '#fff' }],
  });
  assert.deepEqual(calls, [
    ['save'], ['begin'], ['rect', 0, 0, 100, 80], ['clip'],
    ['begin'], ['arc', 50, 40, 120, 0, Math.PI * 2], ['fill'], ['restore'],
  ]);
});

test('shared paths compile once and retain fill, stroke and clip rules across transforms', () => {
  const original = globalThis.Path2D;
  const commands: unknown[][] = [];
  class TestPath {
    moveTo(...args: number[]) { commands.push(['M', ...args]); }
    lineTo(...args: number[]) { commands.push(['L', ...args]); }
    quadraticCurveTo(...args: number[]) { commands.push(['Q', ...args]); }
    bezierCurveTo(...args: number[]) { commands.push(['C', ...args]); }
    closePath() { commands.push(['Z']); }
  }
  globalThis.Path2D = TestPath as unknown as typeof Path2D;
  try {
    const calls: unknown[][] = [];
    const ctx = {
      globalAlpha: 1,
      fill: (...args: unknown[]) => calls.push(['fill', ...args]),
      stroke: (...args: unknown[]) => calls.push(['stroke', ...args]),
      clip: (...args: unknown[]) => calls.push(['clip', ...args]),
      save() {}, restore() {}, translate() {}, setLineDash() {},
    } as unknown as CanvasRenderingContext2D;
    const d: PathCmd[] = [['M', 0, 0], ['L', 10, 0], ['Q', 12, 3, 10, 10], ['C', 8, 12, 2, 12, 0, 10], ['Z']];
    const prims: Prim[] = [{ kind: 'group', translate: { x: 5, y: 7 }, clip: d, clipRule: 'evenodd', prims: [
      { kind: 'path', d, fill: '#fff', fillRule: 'evenodd', stroke: '#000' },
      { kind: 'path', d, stroke: '#f00' },
    ] }];
    drawPrims(ctx, prims);
    drawPrims(ctx, prims);
    assert.deepEqual(commands, d);
    assert.equal(calls.length, 8);
    const path = calls[0]![1];
    assert.ok(path instanceof TestPath);
    assert.ok(calls.every(call => call[1] === path));
    assert.deepEqual(calls[0], ['clip', path, 'evenodd']);
    assert.deepEqual(calls[1], ['fill', path, 'evenodd']);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'Path2D');
    else globalThis.Path2D = original;
  }
});

test('rendering falls back to context paths when Path2D is unavailable', () => {
  const original = globalThis.Path2D;
  Reflect.deleteProperty(globalThis, 'Path2D');
  try {
    const calls: unknown[][] = [];
    const ctx = {
      beginPath: () => calls.push(['begin']),
      moveTo: (...args: number[]) => calls.push(['M', ...args]),
      lineTo: (...args: number[]) => calls.push(['L', ...args]),
      closePath: () => calls.push(['Z']),
      fill: (...args: unknown[]) => calls.push(['fill', ...args]),
    } as unknown as CanvasRenderingContext2D;
    drawPrims(ctx, [{ kind: 'path', d: [['M', 0, 0], ['L', 10, 0], ['Z']], fill: '#fff', fillRule: 'evenodd' }]);
    assert.deepEqual(calls, [['begin'], ['M', 0, 0], ['L', 10, 0], ['Z'], ['fill', 'evenodd']]);
  } finally {
    if (original !== undefined) globalThis.Path2D = original;
  }
});
