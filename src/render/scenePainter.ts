import type { MapState } from '../../shared/types.js';
import type { LetteringId } from './lettering.js';
import type { PaintReply, PaintView } from './paintProtocol.js';
import type { Scene, SceneOptions } from './scene.js';
import { renderSnapshot } from './sceneInputs.js';

type Build = { id: number; version: number; scene: Scene; map: MapState; options: SceneOptions; profile?: boolean };
type Paint = { id: number; version: number; scene: Scene; profile?: boolean } & PaintView;

/** One job in flight, and only the newest pending map and viewport. */
export class ScenePainter {
  private version = 0;
  private readyVersion = 0;
  private wanted = 0;
  private inFlight: number | null = null;
  private pending: Paint | null = null;
  private build: Build | null = null;
  private scene: Scene | null = null;
  private jobs = new Map<number, Build | Paint>();
  private disposed = false;
  private profiling = false;

  constructor(callbacks: {
    overview: (scene: Scene, image: NonNullable<PaintReply['overview']>) => void;
    painted: (scene: Scene, view: PaintView, bitmap: ImageBitmap) => void;
    built?: (scene: Scene, metadata: NonNullable<PaintReply['metadata']>) => void;
    failed: () => void;
  }, private worker: Pick<Worker, 'onerror' | 'onmessage' | 'postMessage' | 'terminate'>) {
    this.worker.onerror = () => { if (!this.disposed) callbacks.failed(); };
    this.worker.onmessage = ({ data }: MessageEvent<PaintReply>) => {
      const job = this.jobs.get(data.id);
      const current = !this.disposed && data.version === this.version && job;
      if (data.metadata && current) {
        this.readyVersion = data.version;
        callbacks.built?.(job.scene, data.metadata);
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
    this.build = { id: ++this.wanted, version: this.version, scene, map, options, ...(profile ? { profile: true } : {}) };
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
    this.invalidate();
    this.worker.postMessage({ type: 'scene', version: this.version, scene, lettering, ...(profile ? { profile: true } : {}) });
  }

  invalidate(): void {
    this.wanted++;
    this.pending = null;
  }

  paint(view: PaintView): void {
    if (!this.scene || this.disposed) return;
    this.pending = { ...view, scene: this.scene, version: this.version, id: ++this.wanted, ...(this.profiling ? { profile: true } : {}) };
    this.flush();
  }

  private flush(): void {
    if (this.disposed || this.inFlight !== null) return;
    if (this.build) {
      const job = this.build;
      this.build = null;
      this.inFlight = job.id;
      this.jobs.set(job.id, job);
      this.worker.postMessage({ type: 'build', version: job.version, id: job.id, map: renderSnapshot(job.map), options: job.options, ...(job.profile ? { profile: true } : {}) });
      return;
    }
    if (!this.pending || this.readyVersion !== this.version) return;
    const job = this.pending;
    this.pending = null;
    this.inFlight = job.id;
    this.jobs.set(job.id, job);
    this.worker.postMessage({ type: 'paint', version: job.version, id: job.id, view: job.view, size: job.size, dpr: job.dpr, ...(job.profile ? { profile: true } : {}) });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.jobs.clear();
    this.build = null;
    this.pending = null;
    this.scene = null;
  }
}
