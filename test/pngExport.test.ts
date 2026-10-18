import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { encodePngStrips, renderPng } from '../src/render/png.ts';
import { exportPng, type PngExportRequest } from '../src/render/exportPng.ts';
import { createMapState } from '../shared/layers.ts';
import type { Scene } from '../src/render/scene.ts';

async function decode(blob: Blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const idat: Buffer[] = [];
  const types: string[] = [];
  let width = 0, height = 0;
  for (let pos = 8; pos < bytes.length;) {
    const size = bytes.readUInt32BE(pos), type = bytes.toString('ascii', pos + 4, pos + 8);
    const data = bytes.subarray(pos + 8, pos + 8 + size);
    // Check every chunk's CRC independently, including multiple IDAT chunks.
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(pos + 4, pos + 8 + size)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    assert.equal(bytes.readUInt32BE(pos + 8 + size), (crc ^ 0xffffffff) >>> 0);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    types.push(type);
    pos += size + 12;
  }
  assert.equal(types[0], 'IHDR');
  assert.equal(types.at(-1), 'IEND');
  return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

test('incremental PNG encoding preserves every scanline across strip boundaries', async () => {
  const rows = [
    new Uint8Array([0, 255, 0, 0, 255, 0, 255, 0, 128]),
    new Uint8Array([0, 0, 0, 255, 0, 1, 2, 3, 255]),
  ];
  const blob = await encodePngStrips(2, 2, (async function* () { yield* rows; })());
  assert.equal(blob.type, 'image/png');
  const png = await decode(blob);
  assert.equal(png.width, 2);
  assert.equal(png.height, 2);
  assert.deepEqual(png.raw, Buffer.concat(rows));
});

test('PNG encoding propagates a rendering error and closes the strip iterator', async () => {
  let closed = false;
  const strips = (async function* () {
    try { yield new Uint8Array([0, 0, 0, 0, 0]); throw new Error('drawing failed'); }
    finally { closed = true; }
  })();
  await assert.rejects(encodePngStrips(1, 2, strips), /drawing failed/);
  assert.equal(closed, true);
});

test('PNG rendering bounds raster memory while keeping full requested dimensions', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas');
  const sizes: number[][] = [], offsets: number[] = [];
  let surface: { width: number; height: number };
  class Canvas {
    constructor(public width: number, public height: number) { surface = this; }
    getContext() {
      return {
        setTransform: (...args: number[]) => { if (args[3] === 2) offsets.push(args[5]!); },
        clearRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          sizes.push([surface.width, surface.height]);
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) { data[i] = sizes.length; data[i + 3] = 128; }
          return { data };
        },
      };
    }
  }
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: Canvas });
  try {
    const scene: Scene = { width: 500, height: 750, background: 'transparent', prims: [] };
    const png = await decode(await renderPng(scene, 2));
    assert.deepEqual([png.width, png.height], [1000, 1500]);
    assert.deepEqual(sizes, [[1000, 1004], [1000, 1004]]);
    assert.deepEqual(offsets, [2, -998]);
    assert.equal(png.raw.length, 1500 * 4001);
    assert.deepEqual([...png.raw.subarray(0, 5)], [0, 1, 0, 0, 128]);
    assert.deepEqual([...png.raw.subarray(1000 * 4001, 1000 * 4001 + 5)], [0, 2, 0, 0, 128]);
    assert.deepEqual([surface!.width, surface!.height], [0, 0]);
  } finally {
    if (original) Object.defineProperty(globalThis, 'OffscreenCanvas', original);
    else Reflect.deleteProperty(globalThis, 'OffscreenCanvas');
  }
});

test('PNG export sends only current state to its worker and terminates on success and failure', async () => {
  const originals = ['Worker', 'OffscreenCanvas'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let terminated = 0, fail = false;
  const jobs: PngExportRequest[] = [];
  class WorkerStub {
    onmessage?: (event: { data: { blob?: Blob; error?: string } }) => void;
    postMessage(job: PngExportRequest) {
      jobs.push(job);
      queueMicrotask(() => this.onmessage?.({ data: fail ? { error: 'render failed' } : { blob: new Blob(['png']) } }));
    }
    terminate() { terminated++; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerStub });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: class {} });
  try {
    const map = createMapState('Worker PNG', 2, 2);
    map.layers.base.past = [{ data: ['Land'], warnings: [], notes: null, generatedAt: null, depVersions: {} }];
    const opts = { format: 'png' as const, labels: true, scale: 4 };
    const blob = await exportPng(map, {}, opts);
    assert.equal(await blob.text(), 'png');
    assert.equal(terminated, 1);
    assert.deepEqual(jobs[0]!.map.layers.base.past, []);
    assert.equal(map.layers.base.past.length, 1);
    assert.equal(jobs[0]!.opts.scale, 4);
    fail = true;
    await assert.rejects(exportPng(map, {}, opts), /render failed/);
    assert.equal(terminated, 2);
  } finally {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
