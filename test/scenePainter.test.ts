import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenePainter } from '../src/render/scenePainter.ts';
import type { PaintReply, PaintRequest } from '../src/render/paintProtocol.ts';
import type { Scene } from '../src/render/scene.ts';

function fixture() {
  const messages: PaintRequest[] = [];
  let terminated = false;
  const worker = {
    onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'],
    postMessage: (message: PaintRequest) => messages.push(message),
    terminate: () => { terminated = true; },
  };
  const painted: number[] = [], overviews: Scene[] = [];
  const painter = new ScenePainter({
    painted: (_scene, frame) => painted.push(frame.view.x),
    overview: scene => overviews.push(scene),
    failed: () => { throw new Error('unexpected worker failure'); },
  }, worker as unknown as Worker);
  const reply = (data: PaintReply) => worker.onmessage?.call(worker as unknown as Worker, new MessageEvent('message', { data }));
  const scene: Scene = { width: 100, height: 100, background: '#fff', prims: [] };
  const view = (x: number) => ({ view: { x, y: 0, scale: 1 }, size: { width: 80, height: 60 }, dpr: 2 });
  return { painter, messages, reply, scene, view, painted, overviews, terminated: () => terminated };
}

test('navigation coalesces pending sharp paints and never presents a stale view', () => {
  const f = fixture();
  f.painter.setScene(f.scene, 'classic');
  f.painter.paint(f.view(0));
  f.painter.paint(f.view(10));
  f.painter.paint(f.view(20));
  const first = f.messages.find(m => m.type === 'paint')!;
  assert.equal(f.messages.filter(m => m.type === 'paint').length, 1);
  let closed = 0;
  f.reply({ version: first.version, id: 'id' in first ? first.id : 0, bitmap: { close: () => closed++ } as ImageBitmap });
  assert.equal(closed, 1);
  assert.deepEqual(f.painted, []);
  const next = f.messages.at(-1)!;
  assert.equal(next.type, 'paint');
  if (next.type !== 'paint') throw new Error('missing paint');
  assert.equal(next.view.x, 20, 'intermediate requests must not queue behind the worker');
  f.reply({ version: next.version, id: next.id, bitmap: {} as ImageBitmap });
  assert.deepEqual(f.painted, [20]);
});

test('a scene change rejects old bitmaps and its overview while keeping the newest request', () => {
  const f = fixture();
  f.painter.setScene(f.scene, 'classic');
  f.painter.paint(f.view(0));
  const first = f.messages.at(-1)!;
  if (first.type !== 'paint') throw new Error('missing paint');
  const replacement = { ...f.scene, width: 200 };
  f.painter.setScene(replacement, 'classic');
  f.painter.paint(f.view(30));
  let closed = 0;
  const bitmap = () => ({ close: () => closed++ } as ImageBitmap);
  f.reply({ version: first.version, id: first.id, bitmap: bitmap(), overview: { bitmap: bitmap(), width: 100, height: 100 } });
  assert.equal(closed, 2);
  assert.deepEqual(f.painted, []);
  assert.deepEqual(f.overviews, []);
  const next = f.messages.at(-1)!;
  if (next.type !== 'paint') throw new Error('missing replacement paint');
  f.reply({ version: next.version, id: next.id, bitmap: bitmap(), overview: { bitmap: bitmap(), width: 200, height: 100 } });
  assert.deepEqual(f.painted, [30]);
  assert.deepEqual(f.overviews, [replacement]);
  f.painter.dispose();
  assert.equal(f.terminated(), true);
});

test('moving again cancels a sharp reply but can retain its whole-map overview', () => {
  const f = fixture();
  f.painter.setScene(f.scene, 'classic');
  f.painter.paint(f.view(0));
  const job = f.messages.at(-1)!;
  if (job.type !== 'paint') throw new Error('missing paint');
  f.painter.invalidate();
  let closed = 0;
  f.reply({ version: job.version, id: job.id, bitmap: { close: () => closed++ } as ImageBitmap,
    overview: { bitmap: {} as ImageBitmap, width: 100, height: 100 } });
  assert.equal(closed, 1, 'a stale viewport must release its pixels');
  assert.deepEqual(f.painted, []);
  assert.deepEqual(f.overviews, [f.scene], 'a whole-map overview remains valid after a view change');
  assert.equal(f.messages.filter(message => message.type === 'paint').length, 1);
});
