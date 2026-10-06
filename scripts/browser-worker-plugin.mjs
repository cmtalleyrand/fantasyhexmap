import { buildSync } from 'esbuild';
import { resolve } from 'node:path';

/** Give standalone browser fixtures the same worker entry point as Vite. */
export function browserWorkerPlugin() {
  return {
    name: 'browser-fixture-workers',
    setup(build) {
      build.onResolve({ filter: /\?worker$/ }, args => ({
        path: resolve(args.resolveDir, args.path.replace(/\?worker$/, '')),
        namespace: 'fixture-worker',
      }));
      build.onLoad({ filter: /.*/, namespace: 'fixture-worker' }, args => {
        const result = buildSync({ entryPoints: [args.path], bundle: true, write: false, format: 'iife', loader: { '.woff2': 'dataurl' } });
        return { loader: 'js', contents: `export default class extends Worker {
          constructor() {
            const url = URL.createObjectURL(new Blob([${JSON.stringify(result.outputFiles[0].text)}], {type:'text/javascript'}));
            super(url);
            this.addEventListener('message', () => URL.revokeObjectURL(url), {once:true});
            this.addEventListener('error', () => URL.revokeObjectURL(url), {once:true});
          }
        }` };
      });
    },
  };
}

/** Observe real worker requests, including discarded replies, without altering them. */
export function workerProbe() {
  window.workerJobs = 0;
  window.workerPaints = 0;
  window.lastWorkerPaint = 0;
  window.workerDurations = [];
  window.lastSharpFrame = 0;
  window.sharpFramesPending = 0;
  let scene;
  const jobs = new Map();
  const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    if (source instanceof HTMLCanvasElement && this.canvas.isConnected && !source.isConnected) window.workerBacking = source;
    if (source instanceof ImageBitmap && args.length === 2 && args[0] === 0 && args[1] === 0) {
      window.workerBacking = this.canvas;
      window.sharpFramesPending++;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.lastSharpFrame = performance.now();
        window.sharpFramesPending--;
      }));
    }
    return nativeDrawImage.call(this, source, ...args);
  };
  window.workerReference = (draw, frame, background, compositeClips = false) => {
    const canvas = new OffscreenCanvas(Math.max(1, Math.floor(frame.size.width * frame.dpr)), Math.max(1, Math.floor(frame.size.height * frame.dpr)));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, frame.size.width, frame.size.height);
    ctx.translate(frame.view.x, frame.view.y);
    ctx.scale(frame.view.scale, frame.view.scale);
    ctx.fillStyle = frame.scene.background;
    ctx.fillRect(0, 0, frame.scene.width, frame.scene.height);
    draw(ctx, frame.scene, undefined, compositeClips);
    const output = document.createElement('canvas');
    output.width = canvas.width; output.height = canvas.height;
    output.getContext('2d').drawImage(canvas, 0, 0);
    return output.toDataURL();
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', event => {
        if (event.data?.id !== undefined) {
          window.workerJobs--;
          window.workerPaints++;
          window.lastWorkerPaint = performance.now();
          const job = jobs.get(event.data.id);
          if (job) window.workerDurations.push(performance.now() - job.started);
          if (event.data.bitmap) window.workerLastFrame = jobs.get(event.data.id);
          jobs.delete(event.data.id);
        }
      });
    }
    postMessage(...args) {
      if (args[0]?.type === 'scene') scene = args[0].scene;
      if (args[0]?.type === 'paint') {
        window.workerJobs++;
        jobs.set(args[0].id, { ...args[0], scene, started: performance.now() });
      }
      super.postMessage(...args);
    }
  };
}
