/**
 * Deterministic pseudo-randomness for decoration.
 *
 * Anything drawn with a little irregularity - an island's outline, a river's
 * wander, paper grain - takes its randomness from a hash of what it belongs to
 * (the map, the hex, the purpose). The same map therefore looks the same on
 * every render, the PNG and SVG exports agree, and editing one hex cannot
 * reshuffle the decoration on any other.
 */

/** 32-bit FNV-1a over the parts, finished with a murmur-style avalanche. */
export function hash32(...parts: Array<string | number>): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const s = typeof part === 'number' ? part.toString(36) : part;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    // Separator, so ('ab', 'c') and ('a', 'bc') differ.
    h ^= 0x1f;
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** A float in [0, 1) fixed by the parts. */
export function unit(...parts: Array<string | number>): number {
  return hash32(...parts) / 4294967296;
}

/** A float in [-1, 1) fixed by the parts. */
export function signed(...parts: Array<string | number>): number {
  return unit(...parts) * 2 - 1;
}

/** A small, fast generator for sequences (xorshift32), seeded from the parts. */
export function sequence(...parts: Array<string | number>): () => number {
  let h = hash32(...parts) || 0x9e3779b9;
  return () => {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    return h / 4294967296;
  };
}
