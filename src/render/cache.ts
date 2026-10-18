/** Synchronous build-local cache policy; diagnostics must never overwrite live cache state. */
let enabled = true;
export const renderCachesEnabled = () => enabled;
export function withRenderCaches<T>(useCaches: boolean, work: () => T): T {
  const before = enabled;
  enabled = before && useCaches;
  try { return work(); } finally { enabled = before; }
}

/** Content-keyed LRU with both an entry bound and an approximate storage budget. */
export class BoundedMemo<T> {
  private entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;
  constructor(private maxEntries: number, private maxWeight: number) {}
  get(key: string): T | undefined {
    if (!enabled) return undefined;
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key); this.entries.set(key, hit);
    return hit.value;
  }
  set(key: string, value: T, payloadWeight = 0): void {
    if (!enabled) return;
    const weight = key.length * 2 + payloadWeight;
    const old = this.entries.get(key);
    if (old) { this.weight -= old.weight; this.entries.delete(key); }
    if (weight > this.maxWeight) return;
    this.entries.set(key, { value, weight }); this.weight += weight;
    while (this.entries.size > this.maxEntries || this.weight > this.maxWeight) {
      const key = this.entries.keys().next().value!;
      this.weight -= this.entries.get(key)!.weight; this.entries.delete(key);
    }
  }
  clear(): void { this.entries.clear(); this.weight = 0; }
  get size(): number { return this.entries.size; }
}
