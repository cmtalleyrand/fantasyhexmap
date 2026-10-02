/**
 * Paper grain.
 *
 * The grain is one small tile of RGBA pixels, computed here from a seed, that
 * both renderers repeat across the map: the canvas renderer turns the pixels
 * into a pattern, and the SVG renderer embeds the same pixels as a PNG. Because
 * the pixels come from this module rather than from either back end (an SVG
 * turbulence filter, say), the PNG and SVG exports show identical grain.
 */

import { sequence } from './seed.js';

export interface GrainTile {
  /** Stable identity: the same colour and strength always give the same id. */
  id: string;
  size: number;
  rgba: Uint8ClampedArray;
}

const TILE = 128;
const tiles = new Map<string, GrainTile>();
const uris = new Map<string, string>();

function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0x5a4630;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Value noise on a lattice that wraps at the tile edge, so the tile repeats seamlessly. */
function periodicNoise(cells: number, seed: string): (x: number, y: number) => number {
  const next = sequence('grain', seed, cells);
  const lattice = Array.from({ length: cells * cells }, () => next());
  const at = (i: number, j: number) => lattice[((j % cells) + cells) % cells * cells + ((i % cells) + cells) % cells]!;
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / TILE) * cells;
    const fy = (y / TILE) * cells;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fade(fx - i);
    const v = fade(fy - j);
    const top = at(i, j) * (1 - u) + at(i + 1, j) * u;
    const bottom = at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u;
    return top * (1 - v) + bottom * v;
  };
}

/** A tile of `colour` speckle whose opacity peaks at `strength` (0-1). */
export function grainTile(colour: string, strength: number): GrainTile {
  const id = `grain-${colour.replace('#', '')}-${Math.round(strength * 1000)}`;
  const hit = tiles.get(id);
  if (hit) return hit;
  const [r, g, b] = parseHex(colour);
  // Low-contrast large mottling, carried mostly by fine fibre and speckle:
  // a strong large-scale term repeats visibly as a lattice across the map.
  const blotch = periodicNoise(4, 'blotch');
  const fibre = periodicNoise(32, 'fibre');
  const speck = sequence('grain', 'speck');
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const tone = 0.2 * blotch(x, y) + 0.4 * fibre(x, y) + 0.4 * speck();
      // Most of the tile is near clear; the darker flecks carry the texture.
      const alpha = Math.max(0, tone - 0.3) / 0.7;
      const k = (y * TILE + x) * 4;
      rgba[k] = r;
      rgba[k + 1] = g;
      rgba[k + 2] = b;
      rgba[k + 3] = Math.round(255 * strength * alpha);
    }
  }
  const tile = { id, size: TILE, rgba };
  tiles.set(id, tile);
  return tile;
}

// --- PNG encoding ----------------------------------------------------------------
// A minimal encoder (stored, uncompressed deflate blocks) so the SVG back end can
// embed the tile without a canvas, which also lets it run under node.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const blocks: number[] = [0x78, 0x01];
  for (let off = 0; off < raw.length || off === 0; off += 65535) {
    const len = Math.min(65535, raw.length - off);
    const last = off + len >= raw.length ? 1 : 0;
    blocks.push(last, len & 255, len >> 8, ~len & 255, (~len >> 8) & 255);
    for (let i = 0; i < len; i++) blocks.push(raw[off + i]!);
    if (last) break;
  }
  blocks.push(...u32(adler32(raw)));
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(blocks)),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? B64[n & 63]! : '=';
  }
  return out;
}

export function tileDataUri(tile: GrainTile): string {
  const hit = uris.get(tile.id);
  if (hit) return hit;
  const uri = `data:image/png;base64,${base64(encodePng(tile.size, tile.size, tile.rgba))}`;
  uris.set(tile.id, uri);
  return uri;
}
