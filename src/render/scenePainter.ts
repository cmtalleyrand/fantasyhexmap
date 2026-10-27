import type { MapState } from '../../shared/types.js';
import type { LetteringId } from './lettering.js';
import type { PaintReply, PaintView } from './paintProtocol.js';
import type { Scene, SceneOptions } from './scene.js';
import { renderSnapshot } from './sceneInputs.js';

type Build = { id: number; version: number; scene: Scene; map: MapState; options: SceneOptions; allowStandIn?: boolean; profile?: boolean };
type Paint = { id: number; version: number; scene: Scene; profile?: boolean } & PaintView;

/**
 * One job in flight, and only the newest pending map and viewport. A map whose coast
 * is not yet fitted is shown first as a stand-in: the worker returns it from the build,
 * its frame is painted, and then the exact scene is built and the last view painted again.
 */
export class ScenePainter {
  private version = 0;
  private readyVersion = 0;
  private serial = 0;
  /** The only paint job whose bitmap may be presented; 0 when none is. */
  private wanted = 0;
  private inFlight: number | null = null;
  private pending: Paint | null = null;
  private build: Build | null = null;
  /** The exact build, sent once the stand-in's frame has been painted. */
  private exact: Build | null = null;
  /** The last view asked for, painted again when the exact scene replaces a stand-in. */
  private lastView: PaintView | null = null;
  private scene: Scene | null = null;
  private jobs = new Map<number, Build | Paint>();
  private disposed = false;
  private profiling = false;

  constructor(callbacks: {
    overview: (scene: Scene, image: NonNullable<PaintReply['overview']>) => void;
    painted: (scene: Scene, view: PaintView, bitmap: ImageBitmap) => void;
    /** Only for exact scenes: a stand-in's metadata is not reported. */
    built?: (scene: Scene, metadata: NonNullable<PaintReply['metadata']>) => void;
    failed: () => void;
  }, private worker: Pick<Worker, 'onerror' | 'onmessage' | 'postMessage' | 'terminate'>) {
    this.worker.onerror = () => { if (!this.disposed) callbacks.failed(); };
    this.worker.onmessage = ({ data }: MessageEvent<PaintReply>) => {
      const job = this.jobs.get(data.id);
      const current = !this.disposed && data.version === this.version && job;
      if (data.metadata && current && 'map' in job) {
        this.readyVersion = data.version;
        if (data.standIn) this.exact = { ...job, id: ++this.serial, allowStandIn: false };
        else {
          callbacks.built?.(job.scene, data.metadata);
          // A stand-in's frame is replaced at the same view.
          if (job.allowStandIn === false && this.lastView) this.paint(this.lastView);
        }
      }
      if (data.overview) {
        // The overview follows its sharp frame in the background, after that
        // job has been released; any overview of the current map is valid.
        if (!this.disposed && data.version === this.version && this.scene) callbacks.overview(this.scene, data.overview);
        else data.overview.bitmap.close();
      }
      if (data.bitmap) {
        if (current && data.id === this.wanted && 'view' in job) callbacks.painted(job.scene, job, data.bitmap);
        else data.bitmap.close();
      }
      if (data.bitmap || !data.overview) {
        this.jobs.delete(data.id);
        if (this.inFlight === data.id) this.inFlight = null;
      }
      if (data.error && !this.disposed && data.version === this.version) callbacks.failed();
      this.flush();
    };
  }

  /** Keep geometry and associated land tests in the worker; only metadata returns. */
  setMap(map: MapState, options: SceneOptions, scene: Scene, profile = false): void {
    if (this.disposed) return;
    this.scene = scene;
    this.profiling = profile;
    this.version++;
    this.invalidate();
    this.exact = null;
    this.build = { id: ++this.serial, version: this.version, scene, map, options, allowStandIn: true, ...(profile ? { profile: true } : {}) };
    this.flush();
  }

  /** Also used by synchronous scene fixtures and callers with existing geometry. */
  setScene(scene: Scene, lettering: LetteringId, profile = false): void {
    if (this.disposed) return;
    this.scene = scene;
    this.profiling = profile;
    this.version++;
    this.readyVersion = this.version;
    this.build = null;
    this.exact = null;
    this.invalidate();
    this.worker.postMessage({ type: 'scene', version: this.version, scene, lettering, ...(profile ? { profile: true } : {}) });
  }

  invalidate(): void {
    this.wanted = 0;
    this.pending = null;
  }

  paint(view: PaintView): void {
    if (!this.scene || this.disposed) return;
    this.lastView = { view: view.view, size: view.size, dpr: view.dpr };
    this.pending = { ...this.lastView, scene: this.scene, version: this.version, id: ++this.serial, ...(this.profiling ? { profile: true } : {}) };
    this.wanted = this.pending.id;
    this.flush();
  }

  private flush(): void {
    if (this.disposed || this.inFlight !== null) return;
    if (this.build) {
      this.send(this.build);
      this.build = null;
      return;
    }
    if (this.pending && this.readyVersion === this.version) {
      const job = this.pending;
      this.pending = null;
      this.inFlight = job.id;
      this.jobs.set(job.id, job);
      this.worker.postMessage({ type: 'paint', version: job.version, id: job.id, view: job.view, size: job.size, dpr: job.dpr, ...(job.profile ? { profile: true } : {}) });
      return;
    }
    // After the stand-in's frame, or at once if no view has been asked for.
    if (this.exact) {
      this.send(this.exact);
      this.exact = null;
    }
  }

  private send(job: Build): void {
    this.inFlight = job.id;
    this.jobs.set(job.id, job);
    this.worker.postMessage({ type: 'build', version: job.version, id: job.id, map: renderSnapshot(job.map), options: job.options,
      ...(job.allowStandIn ? { allowStandIn: true } : {}), ...(job.profile ? { profile: true } : {}) });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.jobs.clear();
    this.build = null;
    this.exact = null;
    this.pending = null;
    this.scene = null;
  }
}
