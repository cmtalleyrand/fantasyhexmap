import { drawScene } from './canvas.js';
import type { Scene } from './scene.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < bytes.length - 4; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
  return bytes;
}

/** Encode scanlines incrementally: only the compressed file accumulates in memory. */
export async function encodePngStrips(width: number, height: number, strips: AsyncIterable<Uint8Array>): Promise<Blob> {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6], 8); // 8-bit RGBA
  const parts: BlobPart[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header)];
  const iterator = strips[Symbol.asyncIterator]();
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate')).getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(chunk('IDAT', value));
    }
  } finally {
    await reader.cancel();
    await iterator.return?.();
  }
  parts.push(chunk('IEND', new Uint8Array()));
  return new Blob(parts, { type: 'image/png' });
}

/** Keep each raster buffer near one million pixels, regardless of output height. */
export async function renderPng(scene: Scene, scale = 2): Promise<Blob> {
  const width = Math.ceil(scene.width * scale), height = Math.ceil(scene.height * scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error('PNG export requires positive, finite dimensions and scale.');
  }
  const rowsPerStrip = Math.max(1, Math.floor(1_000_000 / width));
  const bleed = 2;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, Math.min(rowsPerStrip, height) + bleed * 2)
    : document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.min(rowsPerStrip, height) + bleed * 2;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not create a 2D canvas context for export.');
  async function* strips(): AsyncGenerator<Uint8Array> {
    try {
      for (let y = 0; y < height; y += rowsPerStrip) {
        const rows = Math.min(rowsPerStrip, height - y);
        ctx!.setTransform(1, 0, 0, 1, 0, 0);
        ctx!.clearRect(0, 0, canvas.width, canvas.height);
        if (scene.background !== 'transparent') {
          ctx!.fillStyle = scene.background;
          ctx!.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx!.setTransform(scale, 0, 0, scale, 0, bleed - y);
        drawScene(ctx!, scene, { left: 0, top: (y - bleed) / scale, right: width / scale,
          bottom: (y + rows + bleed) / scale }, true);
        const rgba = ctx!.getImageData(0, bleed, width, rows).data;
        const stride = width * 4;
        const raw = new Uint8Array(rows * (stride + 1));
        for (let row = 0; row < rows; row++) {
          // PNG filter 0 (none); no previous strip needs to remain in memory.
          raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
        }
        yield raw;
        // Also keep older browsers responsive when running without a worker.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally { canvas.width = canvas.height = 0; }
  }
  return encodePngStrips(width, height, strips());
}
