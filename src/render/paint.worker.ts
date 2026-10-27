import { drawScene } from './canvas.js';
import { loadLettering } from './fontFiles.js';
import { MAP_COLOURS } from './palette.js';
import type { PaintReply, PaintRequest } from './paintProtocol.js';
import { buildStaticScene, type Scene } from './scene.js';
import { SceneInputs } from './sceneInputs.js';
import { beginRenderProfile, endRenderProfile, profileCount, profileTime, type RenderProfile } from './profile.js';

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<PaintRequest>) => void;
  postMessage: (reply: PaintReply, transfer: Transferable[]) => void;
};
type Entry = { version: number; scene: Scene; fonts: Promise<void>; overview: boolean; overviewRunning?: boolean };
let current: Entry | null = null;
/** Overview resolution and the rows rasterized between yields. */
const OVERVIEW_PIXELS = 4_000_000, OVERVIEW_BAND_PIXELS = 1_000_000;
const inputs = new SceneInputs();

host.onmessage = async ({ data }) => {
  if (data.type === 'scene') {
    current = { version: data.version, scene: data.scene, fonts: loadLettering(data.lettering), overview: false };
    return;
  }
  if (data.type === 'build') {
    try {
      const start = performance.now();
      await loadLettering(data.options.style?.knobs.lettering ?? 'classic');
      if (data.profile) beginRenderProfile();
      const map = profileTime('worker.retain', () => inputs.retain(data.map));
      const scene = buildStaticScene(map, data.options);
      current = { version: data.version, scene, fonts: Promise.resolve(), overview: false };
      const { prims: _prims, ...metadata } = scene;
      host.postMessage({ version: data.version, id: data.id, metadata, timings: { buildMs: performance.now() - start },
        ...(data.profile ? { profile: endRenderProfile() } : {}) }, []);
    } catch (error) {
      if (data.profile) endRenderProfile();
      host.postMessage({ version: data.version, id: data.id, error: String(error) }, []);
    }
    return;
  }
  const entry = current;
  if (!entry || entry.version !== data.version) return;
  try {
    await entry.fonts;
    if (current !== entry) {
      host.postMessage({ version: data.version, id: data.id }, []);
      return;
    }
    const start = performance.now();
    if (data.profile) beginRenderProfile();
    const scene = entry.scene;
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
    // At a whole-map view the sharp frame already holds every overview pixel:
    // copy it rather than rasterizing every path a second time.
    const density = overviewDensity(scene, data.dpr * data.view.scale);
    const copied = !entry.overview && !entry.overviewRunning && coversScene(scene, data, density)
      ? copyOverview(canvas, scene, data, density) : null;
    const bitmap = canvas.transferToImageBitmap();
    profileCount('paint.viewportPixels', bitmap.width * bitmap.height);
    host.postMessage({ version: data.version, id: data.id, bitmap,
      timings: { paintMs: performance.now() - start }, ...(data.profile ? { profile: endRenderProfile() } : {}) }, [bitmap]);
    if (copied) {
      entry.overview = true;
      host.postMessage({ version: data.version, id: data.id, overview: copied, timings: { overviewMs: 0 } }, [copied.bitmap]);
    } else if (!entry.overview && !entry.overviewRunning) {
      // The overview yields between bands, so a later edit or view is never
      // queued behind a whole-map rasterization. A newer scene abandons it.
      entry.overviewRunning = true;
      void paintOverview(entry, data.version, data.id, density, data.profile === true)
        .finally(() => { entry.overviewRunning = false; });
    }
  } catch (error) {
    if (data.profile) endRenderProfile();
    host.postMessage({ version: data.version, id: data.id, error: String(error) }, []);
  }
};

type Frame = Extract<PaintRequest, { type: 'paint' }>;

/** Every navigation position has a bounded whole-map fallback. */
function overviewDensity(scene: Scene, viewDensity: number): number {
  return Math.min(viewDensity, Math.sqrt(OVERVIEW_PIXELS / Math.max(1, scene.width * scene.height)));
}

function coversScene(scene: Scene, frame: Frame, density: number): boolean {
  const { view, size } = frame;
  return density > 0 && view.x >= 0 && view.y >= 0
    && view.x + scene.width * view.scale <= size.width && view.y + scene.height * view.scale <= size.height;
}

function copyOverview(canvas: OffscreenCanvas, scene: Scene, frame: Frame, density: number) {
  const { view, dpr } = frame;
  const overview = new OffscreenCanvas(Math.max(1, Math.floor(scene.width * density)), Math.max(1, Math.floor(scene.height * density)));
  const context = overview.getContext('2d');
  if (!context) return null;
  // The whole map as the sharp frame shows it, scaled down when the overview's density is capped.
  const shown = view.scale * dpr;
  context.drawImage(canvas, view.x * dpr, view.y * dpr, scene.width * shown, scene.height * shown,
    0, 0, overview.width, overview.height);
  return { bitmap: overview.transferToImageBitmap(), width: scene.width, height: scene.height };
}

async function paintOverview(entry: Entry, version: number, id: number, density: number, profile: boolean): Promise<void> {
  const scene = entry.scene;
  const width = Math.max(1, Math.floor(scene.width * density)), height = Math.max(1, Math.floor(scene.height * density));
  const overview = new OffscreenCanvas(width, height);
  const context = overview.getContext('2d');
  if (!context) throw new Error('Overview canvas unavailable');
  const sx = width / scene.width, sy = height / scene.height;
  const band = Math.max(1, Math.ceil(OVERVIEW_BAND_PIXELS / width));
  const merged = profile ? { timeOrigin: performance.timeOrigin, start: performance.now(), duration: 0,
    timings: [] as RenderProfile['timings'], counters: {} as RenderProfile['counters'] } : undefined;
  let ms = 0;
  try {
    for (let y = 0; y < height; y += band) {
      // Yield first: messages that arrived during the last band run before the next.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (current !== entry) return;
      const start = performance.now();
      if (profile) beginRenderProfile();
      const rows = Math.min(band, height - y);
      // Each band rasterizes on its own canvas, so its cost is paid now rather
      // than all at once when the overview is transferred.
      const strip = new OffscreenCanvas(width, rows);
      const ctx = strip.getContext('2d');
      if (!ctx) throw new Error('Overview canvas unavailable');
      ctx.translate(0, -y);
      ctx.scale(sx, sy);
      const top = y / sy, bottom = (y + rows) / sy, margin = 2 / sy;
      ctx.fillStyle = scene.background;
      ctx.fillRect(0, top, scene.width, bottom - top);
      drawScene(ctx, scene, { left: -margin, top: top - margin, right: scene.width + margin, bottom: bottom + margin }, true);
      const image = strip.transferToImageBitmap();
      context.drawImage(image, 0, y);
      image.close();
      ms += performance.now() - start;
      const part = profile ? endRenderProfile() : undefined;
      if (merged && part) {
        merged.timings.push(...part.timings);
        for (const [name, value] of Object.entries(part.counters)) merged.counters[name] = (merged.counters[name] ?? 0) + value;
      }
    }
    const image = { bitmap: overview.transferToImageBitmap(), width: scene.width, height: scene.height };
    if (merged) {
      merged.counters['paint.overviewPixels'] = image.bitmap.width * image.bitmap.height;
      merged.duration = performance.now() - merged.start;
    }
    entry.overview = true;
    host.postMessage({ version, id, overview: image, timings: { overviewMs: ms }, ...(merged ? { profile: merged } : {}) }, [image.bitmap]);
  } catch (error) {
    if (profile) endRenderProfile();
    host.postMessage({ version, id, error: String(error) }, []);
  }
}

