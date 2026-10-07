import type { LetteringId } from './lettering.js';
import type { PaintReply, PaintView } from './paintProtocol.js';
import type { Scene } from './scene.js';

/** One paint in flight and only the newest pending view: no stale-job backlog. */
export class ScenePainter {
  private version = 0;
  private wanted = 0;
  private inFlight: number | null = null;
  private pending: ({ id: number; version: number; scene: Scene } & PaintView) | null = null;
  private scene: Scene | null = null;
  private jobs = new Map<number, { scene: Scene } & PaintView>();

  constructor(callbacks: {
    overview: (scene: Scene, image: NonNullable<PaintReply['overview']>) => void;
    painted: (scene: Scene, view: PaintView, bitmap: ImageBitmap) => void;
    failed: () => void;
  }, private worker: Pick<Worker, 'onerror' | 'onmessage' | 'postMessage' | 'terminate'>) {
    this.worker.onerror = () => callbacks.failed();
    this.worker.onmessage = ({ data }: MessageEvent<PaintReply>) => {
      const job = this.jobs.get(data.id);
      this.jobs.delete(data.id);
      if (this.inFlight === data.id) this.inFlight = null;
      const current = data.version === this.version && job;
      if (data.overview) {
        if (current) callbacks.overview(job.scene, data.overview);
        else data.overview.bitmap.close();
      }
      if (data.bitmap) {
        if (current && data.id === this.wanted) callbacks.painted(job.scene, job, data.bitmap);
        else data.bitmap.close();
      }
      if (data.error && current) callbacks.failed();
      this.flush();
    };
  }

  setScene(scene: Scene, lettering: LetteringId): void {
    this.scene = scene;
    this.version++;
    this.invalidate();
    this.worker.postMessage({ type: 'scene', version: this.version, scene, lettering });
  }

  invalidate(): void {
    this.wanted++;
    this.pending = null;
  }

  paint(view: PaintView): void {
    if (!this.scene) return;
    this.pending = { ...view, scene: this.scene, version: this.version, id: ++this.wanted };
    this.flush();
  }

  private flush(): void {
    if (this.inFlight !== null || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.inFlight = job.id;
    this.jobs.set(job.id, job);
    this.worker.postMessage({ type: 'paint', version: job.version, id: job.id, view: job.view, size: job.size, dpr: job.dpr });
  }

  dispose(): void {
    this.worker.terminate();
    this.jobs.clear();
    this.pending = null;
  }
}
