import { runFitJob, warmUpJob, type FitJob } from './coastFitJob.js';

/** Runs coast fits for the paint worker's build (DECISIONS §97). */
const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<{ id: number; job: FitJob; ping?: boolean }>) => void;
  postMessage: (reply: unknown) => void;
};
/** Small fits run while idle after starting, one per task, until the first real fit arrives. */
let warming = 0;
const WARM_UPS = 24;
const warm = () => {
  if (warming < 0 || warming >= WARM_UPS) return;
  runFitJob(warmUpJob(warming++));
  setTimeout(warm, 0);
};
host.onmessage = ({ data }) => {
  if (data.ping) { host.postMessage({ ping: true }); setTimeout(warm, 0); return; }
  warming = -1;
  try {
    const start = performance.now();
    const output = runFitJob(data.job);
    host.postMessage({ id: data.id, output, ms: performance.now() - start });
  } catch (error) { host.postMessage({ id: data.id, error: String(error) }); }
};
