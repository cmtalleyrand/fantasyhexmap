import type { MapState } from '../../shared/types.js';
import type { BuildReply } from './buildProtocol.js';
import type { LetteringId } from './lettering.js';
import type { Scene, SceneOptions } from './scene.js';

/**
 * Builds scenes off the page's thread: one build in flight and only the newest request
 * waiting, so a run of edits builds the last of them, not each in turn. A reply to an
 * older request than the newest is dropped.
 */
export class SceneBuilder {
  private latest = 0;
  private inFlight: number | null = null;
  private pending: { id: number; map: MapState; options: SceneOptions; lettering: LetteringId } | null = null;

  constructor(callbacks: {
    built: (scene: Scene) => void;
    failed: () => void;
  }, private worker: Pick<Worker, 'onerror' | 'onmessage' | 'postMessage' | 'terminate'>) {
    this.worker.onerror = () => callbacks.failed();
    this.worker.onmessage = ({ data }: MessageEvent<BuildReply>) => {
      if (this.inFlight === data.id) this.inFlight = null;
      if (data.error) callbacks.failed();
      else if (data.scene && data.id === this.latest) callbacks.built(data.scene);
      this.flush();
    };
  }

  build(map: MapState, options: SceneOptions, lettering: LetteringId): void {
    this.pending = { id: ++this.latest, map, options, lettering };
    this.flush();
  }

  private flush(): void {
    if (this.inFlight !== null || !this.pending) return;
    const job = this.pending;
    this.pending = null;
    this.inFlight = job.id;
    this.worker.postMessage(job);
  }

  dispose(): void {
    this.worker.terminate();
    this.pending = null;
  }
}
