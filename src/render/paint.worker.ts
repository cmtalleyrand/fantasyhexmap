import { drawScene } from './canvas.js';
import { loadLettering } from './fontFiles.js';
import { MAP_COLOURS } from './palette.js';
import type { PaintReply, PaintRequest } from './paintProtocol.js';

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<PaintRequest>) => void;
  postMessage: (reply: PaintReply, transfer: Transferable[]) => void;
};
let current: { message: Extract<PaintRequest, { type: 'scene' }>; fonts: Promise<void>; overview: boolean } | null = null;

host.onmessage = async ({ data }) => {
  if (data.type === 'scene') {
    current = { message: data, fonts: loadLettering(data.lettering), overview: false };
    return;
  }
  const entry = current;
  if (!entry || entry.message.version !== data.version) return;
  try {
    await entry.fonts;
    const scene = entry.message.scene;
    const canvas = new OffscreenCanvas(Math.max(1, Math.floor(data.size.width * data.dpr)), Math.max(1, Math.floor(data.size.height * data.dpr)));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Offscreen canvas unavailable');
    ctx.setTransform(data.dpr, 0, 0, data.dpr, 0, 0);
    ctx.fillStyle = MAP_COLOURS.background;
    ctx.fillRect(0, 0, data.size.width, data.size.height);
    ctx.translate(data.view.x, data.view.y);
    ctx.scale(data.view.scale, data.view.scale);
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    const margin = 2 / (data.dpr * data.view.scale);
    drawScene(ctx, scene, { left: -data.view.x / data.view.scale - margin, top: -data.view.y / data.view.scale - margin,
      right: (data.size.width - data.view.x) / data.view.scale + margin, bottom: (data.size.height - data.view.y) / data.view.scale + margin }, true);
    const bitmap = canvas.transferToImageBitmap();
    const reply: PaintReply = { version: data.version, id: data.id, bitmap };
    const transfer: Transferable[] = [bitmap];
    if (!entry.overview) {
      // Every navigation position has a bounded whole-map fallback. A pan
      // outside the last sharp viewport never needs synchronous path painting.
      const density = Math.min(data.dpr * data.view.scale, Math.sqrt(4_000_000 / Math.max(1, scene.width * scene.height)));
      const overview = new OffscreenCanvas(Math.max(1, Math.floor(scene.width * density)), Math.max(1, Math.floor(scene.height * density)));
      const context = overview.getContext('2d');
      if (!context) throw new Error('Overview canvas unavailable');
      context.scale(overview.width / scene.width, overview.height / scene.height);
      context.fillStyle = scene.background;
      context.fillRect(0, 0, scene.width, scene.height);
      drawScene(context, scene, undefined, true);
      reply.overview = { bitmap: overview.transferToImageBitmap(), width: scene.width, height: scene.height };
      transfer.push(reply.overview.bitmap);
      entry.overview = true;
    }
    host.postMessage(reply, transfer);
  } catch (error) {
    host.postMessage({ version: data.version, id: data.id, error: String(error) }, []);
  }
};
