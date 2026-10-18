/** Injected before the production app; observes real messages and displayed sharp frames. */
export function openingProbe() {
  const state = window.renderProbe = { timeOrigin: performance.timeOrigin, builds: [], paints: [], posts: [], displays: [], inputs: [], gaps: [], tasks: [], errors: [], pending: 0 };
  const scenes = new WeakMap(), images = new WeakMap();
  let serial = 0;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const worker = ++serial, jobs = new Map();
      let currentScene;
      const send = this.postMessage.bind(this);
      this.postMessage = (data, ...rest) => {
        const start = performance.now();
        if (data.map) {
          state.lastMap = data.map; state.lastOptions = data.options;
          state.latestBuild = { worker, id: data.id };
          if (data.type === 'build') currentScene = { build: { worker, id: data.id }, version: data.version };
          jobs.set(data.id, { start, kind: 'build' }); state.pending++;
        } else if (data.type === 'scene') {
          currentScene = { scene: data.scene, build: scenes.get(data.scene), version: data.version };
        } else if (data.type === 'paint') {
          jobs.set(data.id, { start, kind: 'paint', frame: data, ...currentScene }); state.pending++;
        }
        send(data, ...rest);
        state.posts.push({ worker, id: data.id, type: data.type ?? 'build', start, duration: performance.now() - start });
      };
      this.addEventListener('message', ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        if (data.complete !== false) { state.pending--; jobs.delete(data.id); }
        const result = { worker, id: data.id, start: job.start, received: performance.now(), profile: data.profile };
        if (data.error) state.errors.push(data.error);
        if (job.kind === 'build') {
          state.builds.push(result);
          if (data.scene) { scenes.set(data.scene, { worker, id: data.id }); state.lastScene = data.scene; }
          if (data.metadata) {
            state.lastScene = data.metadata;
            currentScene = { scene: data.metadata, build: { worker, id: data.id }, version: data.version };
          }
        } else {
          state.paints.push(result);
          if (data.bitmap && job.scene && (!job.scene.prims || job.scene.prims.length)) images.set(data.bitmap, { ...result, frame: job.frame, build: job.build });
        }
      });
      this.addEventListener('error', event => state.errors.push(event.message));
    }
  };
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
    const result = draw.call(this, source, ...args);
    const job = images.get(source);
    if (job && this.canvas.isConnected && args.length === 2 && args[0] === 0 && args[1] === 0) {
      const copied = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        state.displays.push({ ...job, copied, displayed: performance.now() });
        state.lastFrame = job.frame;
      }));
    }
    return result;
  };
  let previous;
  const frame = now => { if (previous !== undefined) state.gaps.push({ at: now, duration: now - previous }); previous = now; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  for (const name of ['wheel', 'pointerdown', 'keydown']) document.addEventListener(name, () => {
    const start = performance.now(), duringBuild = state.posts.filter(p => p.type === 'build').length > state.builds.length;
    requestAnimationFrame(() => state.inputs.push({ type: name, start, duringBuild, duration: performance.now() - start }));
  }, { capture: true, passive: true });
  new PerformanceObserver(list => state.tasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
}
