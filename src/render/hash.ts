/** Content hashes for cache keys: FNV-1a style lanes over exact bits, joined as one short string. */

/** Two 32-bit hashes of the exact bits of `values`. */
export function hashNumbers(values: number[]): string {
  const bytes = new Uint8Array(Float64Array.from(values).buffer);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let k = 0; k < bytes.length; k++) {
    a = Math.imul(a ^ bytes[k]!, 0x01000193);
    b = Math.imul(b ^ bytes[k]!, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** Two 32-bit hashes of a string's UTF-16 code units. */
export function hashText(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** Four 32-bit hashes of a string, for keys where a collision would reuse the wrong drawing. */
export function hashText128(text: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995, c = 0x9e3779b9, d = 0x85ebca6b;
  for (let k = 0; k < text.length; k++) {
    const x = text.charCodeAt(k);
    a = Math.imul(a ^ x, 0x01000193);
    b = Math.imul(b ^ x, 0x5bd1e995) ^ (b >>> 15);
    c = Math.imul(c ^ x, 0xcc9e2d51) ^ (c >>> 13);
    d = Math.imul((d + x) | 0, 0x1b873593) ^ (d >>> 16);
  }
  return [a, b, c, d].map(v => (v >>> 0).toString(36)).join('.');
}

/** Four 32-bit hashes of the exact bits of `values`, for keys where a collision would reuse the wrong drawing. */
export function hashNumbers128(values: ArrayLike<number>): string {
  // Word by word over the doubles' bits: a quarter of the steps of a byte-wise hash.
  const words = new Uint32Array(Float64Array.from(values as ArrayLike<number>).buffer);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995, c = 0x9e3779b9, d = 0x85ebca6b;
  for (let k = 0; k < words.length; k++) {
    const x = words[k]!;
    a = Math.imul(a ^ x, 0x01000193); a ^= a >>> 16;
    b = Math.imul(b ^ x, 0x5bd1e995) ^ (b >>> 15);
    c = Math.imul(c ^ x, 0xcc9e2d51); c = (c << 13) | (c >>> 19);
    d = Math.imul((d + x) | 0, 0x1b873593) ^ (d >>> 16);
  }
  return [a, b, c, d].map(v => (v >>> 0).toString(36)).join('.') + `.${words.length}`;
}
