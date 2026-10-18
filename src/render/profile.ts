/** Opt-in diagnostics. Kept outside scenes so profiling cannot change exported geometry. */
export interface RenderTiming { name: string; start: number; duration: number }
export interface RenderProfile {
  timeOrigin: number;
  start: number;
  duration: number;
  timings: RenderTiming[];
  counters: Record<string, number>;
}
let active: RenderProfile | undefined;
export function beginRenderProfile(): void {
  active = { timeOrigin: performance.timeOrigin, start: performance.now(), duration: 0, timings: [], counters: {} };
}
export function endRenderProfile(): RenderProfile | undefined {
  const result = active;
  active = undefined;
  if (result) result.duration = performance.now() - result.start;
  return result;
}
export function profileCount(name: string, amount = 1): void {
  if (active) active.counters[name] = (active.counters[name] ?? 0) + amount;
}
export function profileSection(name: string): () => void {
  const profile = active;
  if (!profile) return noop;
  const start = performance.now();
  return () => profile.timings.push({ name, start, duration: performance.now() - start });
}
const noop = () => {};
export function profileTime<T>(name: string, work: () => T): T {
  if (!active) return work();
  const end = profileSection(name);
  try { return work(); } finally { end(); }
}
/** Contiguous, non-overlapping phases at one level; nested sections are reported separately. */
export function profilePhases(prefix: string): (name?: string) => void {
  if (!active) return noop;
  let end = noop;
  return name => { end(); end = name ? profileSection(`${prefix}.${name}`) : noop; };
}
