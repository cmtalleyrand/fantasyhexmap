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

test('construction keeps only the latest pending map and waits before painting', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const f = fixture();
  const map = createMapState('worker', 4, 4);
  const opts = { size: 26, visible: defaultVisibility(), labels: true };
  f.painter.setMap(map, opts, f.scene);
  f.painter.paint(f.view(10));
  const first = f.messages.at(-1)!;
  assert.equal(first.type, 'build');
  f.painter.setMap({ ...map, description: 'intermediate' }, opts, { ...f.scene });
  f.painter.setMap({ ...map, description: 'latest' }, opts, { ...f.scene });
  f.painter.paint(f.view(30));
  assert.equal(f.messages.length, 1);
  if (first.type !== 'build') throw new Error('missing build');
  f.reply({ version: first.version, id: first.id, metadata: { width: 100, height: 100, background: '#fff' } });
  const latest = f.messages.at(-1)!;
  assert.equal(latest.type, 'build');
  if (latest.type !== 'build') throw new Error('missing latest build');
  assert.equal(latest.map.description, 'latest');
  f.reply({ version: latest.version, id: latest.id, metadata: { width: 100, height: 100, background: '#fff' } });
  const paint = f.messages.at(-1)!;
  assert.equal(paint.type, 'paint');
  if (paint.type !== 'paint') throw new Error('missing paint');
  assert.equal(paint.view.x, 30);
});

test('a sharp bitmap releases its job; the overview follows without blocking later work', () => {
  const f = fixture();
  f.painter.setScene(f.scene, 'classic');
  f.painter.paint(f.view(0));
  const first = f.messages.at(-1)!;
  if (first.type !== 'paint') throw new Error('missing paint');
  f.reply({ version: first.version, id: first.id, bitmap: {} as ImageBitmap });
  assert.deepEqual(f.painted, [0]);
  f.painter.paint(f.view(20));
  assert.equal(f.messages.filter(m => m.type === 'paint').length, 2, 'navigation must not wait for the overview');
  f.reply({ version: first.version, id: first.id, overview: { bitmap: {} as ImageBitmap, width: 100, height: 100 } });
  assert.deepEqual(f.overviews, [f.scene], 'a released job\'s overview still belongs to the current map');
  assert.equal(f.messages.filter(m => m.type === 'paint').length, 2, 'an overview reply does not release the pending sharp job');
  const second = f.messages.at(-1)!;
  if (second.type !== 'paint') throw new Error('missing second paint');
  f.reply({ version: second.version, id: second.id, bitmap: {} as ImageBitmap });
  assert.deepEqual(f.painted, [0, 20]);
  f.painter.dispose();
  let closed = 0;
  f.reply({ version: first.version, id: first.id, bitmap: { close: () => closed++ } as ImageBitmap });
  assert.equal(closed, 1);
});

test('an overview finishing after an edit is released, not shown', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const f = fixture();
  const map = createMapState('overview', 4, 4);
  const opts = { size: 26, visible: defaultVisibility(), labels: true };
  f.painter.setScene(f.scene, 'classic');
  f.painter.paint(f.view(0));
  const paint = f.messages.at(-1)!;
  if (paint.type !== 'paint') throw new Error('missing paint');
  f.reply({ version: paint.version, id: paint.id, bitmap: {} as ImageBitmap });
  f.painter.setMap(map, opts, { ...f.scene });
  assert.equal(f.messages.at(-1)!.type, 'build', 'an edit is sent while the old overview is still painting');
  let closed = 0;
  f.reply({ version: paint.version, id: paint.id, overview: { bitmap: { close: () => closed++ } as ImageBitmap, width: 100, height: 100 } });
  assert.equal(closed, 1);
  assert.deepEqual(f.overviews, []);
});

test('profiling is opt-in and follows unified construction into viewport painting', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const map = createMapState('profile worker', 4, 4);
  const opts = { size: 26, visible: defaultVisibility(), labels: true };
  const f = fixture();
  f.painter.setMap(map, opts, f.scene, true);
  f.painter.paint(f.view(0));
  const build = f.messages.at(-1)!;
  if (build.type !== 'build') throw new Error('missing build');
  assert.equal(build.profile, true);
  f.reply({ version: build.version, id: build.id, metadata: { width: 100, height: 100, background: '#fff' } });
  const paint = f.messages.at(-1)!;
  assert.equal(paint.type, 'paint');
  assert.equal(paint.profile, true);
  const plain = fixture();
  plain.painter.setMap(map, opts, plain.scene);
  assert.equal(Object.hasOwn(plain.messages[0]!, 'profile'), false);
});

test('a stand-in is painted before its exact build, and the exact scene repaints the same view', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const messages: PaintRequest[] = [];
  const worker = { onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'],
    postMessage: (message: PaintRequest) => messages.push(message), terminate: () => {} };
  const painted: number[] = [], built: number[] = [];
  const painter = new ScenePainter({
    painted: (_scene, frame) => painted.push(frame.view.x),
    built: () => built.push(messages.length),
    overview: () => {},
    failed: () => { throw new Error('unexpected worker failure'); },
  }, worker as unknown as Worker);
  const reply = (data: PaintReply) => worker.onmessage?.call(worker as unknown as Worker, new MessageEvent('message', { data }));
  const scene: Scene = { width: 100, height: 100, background: '#fff', prims: [] };
  const view = { view: { x: 10, y: 0, scale: 1 }, size: { width: 80, height: 60 }, dpr: 1 };
  painter.setMap(createMapState('worker', 4, 4), { size: 26, visible: defaultVisibility(), labels: true }, scene);
  painter.paint(view);
  const first = messages.at(-1)!;
  if (first.type !== 'build') throw new Error('missing build');
  assert.equal(first.allowStandIn, true);
  reply({ version: first.version, id: first.id, standIn: true, metadata: { width: 100, height: 100, background: '#fff' } });
  assert.deepEqual(built, [], 'a stand-in\'s metadata is provisional');
  const standInPaint = messages.at(-1)!;
  if (standInPaint.type !== 'paint') throw new Error('the stand-in is painted first');
  reply({ version: standInPaint.version, id: standInPaint.id, bitmap: {} as ImageBitmap });
  assert.deepEqual(painted, [10]);
  const exact = messages.at(-1)!;
  if (exact.type !== 'build') throw new Error('then the exact scene is built');
  assert.equal(exact.allowStandIn, undefined);
  reply({ version: exact.version, id: exact.id, metadata: { width: 100, height: 100, background: '#fff' } });
  assert.equal(built.length, 1);
  const repaint = messages.at(-1)!;
  if (repaint.type !== 'paint') throw new Error('the exact scene is painted at the last view');
  assert.equal(repaint.view, view.view);
  reply({ version: repaint.version, id: repaint.id, bitmap: {} as ImageBitmap });
  assert.deepEqual(painted, [10, 10]);
  assert.equal(messages.length, 4);
});

test('an edit during a stand-in drops its pending exact build', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const f = fixture();
  const map = createMapState('worker', 4, 4), opts = { size: 26, visible: defaultVisibility(), labels: true };
  f.painter.setMap(map, opts, f.scene);
  f.painter.paint(f.view(0));
  const first = f.messages.at(-1)!;
  if (first.type !== 'build') throw new Error('missing build');
  f.reply({ version: first.version, id: first.id, standIn: true, metadata: { width: 100, height: 100, background: '#fff' } });
  const standInPaint = f.messages.at(-1)!;
  if (standInPaint.type !== 'paint') throw new Error('missing stand-in paint');
  f.painter.setMap({ ...map, description: 'edited' }, opts, { ...f.scene });
  f.reply({ version: standInPaint.version, id: standInPaint.id, bitmap: { close: () => {} } as ImageBitmap });
  const next = f.messages.at(-1)!;
  if (next.type !== 'build') throw new Error('missing build');
  assert.equal(next.map.description, 'edited');
  assert.equal(next.allowStandIn, true);
  assert.equal(f.messages.filter(m => m.type === 'build').length, 2, 'the superseded exact build is never sent');
});
