import { runFitJob, slimFitJob, type FitJob, type FitOutput } from './coastFitJob.js';
import { profileCount } from './profile.js';

type Reply = { id: number; output?: FitOutput; error?: string; ms?: number };

/**
 * A few workers that run coast fits (DECISIONS §97). A worker that cannot be made, or fails,
 * leaves its fits to run in place, so a build never depends on the pool working.
 */
export class FitPool {
  private idle: Worker[] = [];
  private made = 0;
  private broken = false;
  private queue: Array<{ job: FitJob; done: (output: FitOutput) => void }> = [];
  private nextId = 0;

  constructor(private create: () => Worker | null, private helpers: number) {}

  private starting: Promise<void>[] = [];

  /**
   * Makes the workers now, so they have loaded before the first fits are handed out: a worker made
   * by a worker loads through its maker's event loop, so one made just before a long build would
   * not start until the build waits for it.
   */
  warm(): void {
    while (!this.broken && this.made < this.helpers) {
      const worker = this.make();
      if (!worker) return;
      this.starting.push(new Promise<void>(resolve => {
        const done = () => { worker.removeEventListener('message', done); worker.removeEventListener('error', done); resolve(); };
        worker.addEventListener('message', done);
        worker.addEventListener('error', done);
        worker.postMessage({ ping: true });
      }));
      this.idle.push(worker);
    }
  }

  /** Waits, for at most `ms`, until every worker made so far has started. */
  async ready(ms: number): Promise<void> {
    await Promise.race([Promise.all(this.starting), new Promise(resolve => setTimeout(resolve, ms))]);
  }

  get available(): boolean { return !this.broken && this.helpers > 0; }

  run(job: FitJob): Promise<FitOutput> {
    return new Promise(done => { this.queue.push({ job, done }); this.pump(); });
  }

  private make(): Worker | null {
    let worker: Worker | null = null;
    try { worker = this.create(); } catch { worker = null; }
    if (!worker) { this.broken = true; return null; }
    this.made++;
    return worker;
  }

  private pump(): void {
    while (this.queue.length) {
      if (this.broken) { const { job, done } = this.queue.shift()!; done(runFitJob(job)); continue; }
      const worker = this.idle.pop() ?? (this.made < this.helpers ? this.make() : null);
      if (!worker) return;
      const { job, done } = this.queue.shift()!;
      const id = this.nextId++;
      const finish = (output: FitOutput | null) => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (output) { this.idle.push(worker); done(output); }
        else { this.broken = true; worker.terminate(); done(runFitJob(job)); }
        this.pump();
      };
      const sent = performance.now();
      const onMessage = ({ data }: MessageEvent<Reply>) => {
        if (data.id !== id) return;
        profileCount('pool.remoteFitMs', Math.round(data.ms ?? 0));
        profileCount('pool.remoteRoundTripMs', Math.round(performance.now() - sent));
        finish(data.output ?? null);
      };
      const onError = () => finish(null);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ id, job: slimFitJob(job) });
    }
  }
}

/** Runs a step's fits: the heaviest here, the others in the pool at the same time. */
export async function runFitsShared(pool: FitPool | null, jobs: FitJob[]): Promise<FitOutput[]> {
  if (!pool?.available || jobs.length < 2) return jobs.map(runFitJob);
  const order = jobs.map((_, j) => j).sort((a, b) => jobs[b]!.weight - jobs[a]!.weight);
  const out: FitOutput[] = new Array(jobs.length);
  const remote = order.slice(1).map(j => pool.run(jobs[j]!).then(output => { out[j] = output; }));
  const start = performance.now();
  out[order[0]!] = runFitJob(jobs[order[0]!]!);
  profileCount('pool.localFitMs', Math.round(performance.now() - start));
  const waited = performance.now();
  await Promise.all(remote);
  profileCount('pool.waitMs', Math.round(performance.now() - waited));
  profileCount('pool.remoteJobs', jobs.length - 1);
  return out;
}
