/**
 * Long outlines an edit rebuilds unchanged are handed back as the previous
 * scene's arrays. The painter keys compiled paths and bounds by array identity,
 * so an edit then recompiles only what changed. Reuse requires equal commands,
 * number for number, so a scene's content never changes.
 */
import type { PathCmd, Prim } from './prims.js';
import { profileCount } from './profile.js';

/** Shorter command lists cost less to compile than to look up. */
const MIN_COMMANDS = 64;
let previous = new Map<string, PathCmd[][]>();

export function clearSharedPaths(): void { previous = new Map(); }

function commandKey(c: PathCmd): string { return c.join(','); }
function keyOf(d: PathCmd[]): string {
  return `${d.length}|${commandKey(d[0]!)}|${commandKey(d[d.length >> 1]!)}|${commandKey(d[d.length - 1]!)}`;
}

function sameCommands(a: PathCmd[], b: PathCmd[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x === y) continue;
    if (x.length !== y.length) return false;
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
  }
  return true;
}

/** Replace each long path and clip by an equal one from the previous scene, where there is one. */
export function shareUnchangedPaths(prims: Prim[]): void {
  const next = new Map<string, PathCmd[][]>();
  const share = (d: PathCmd[]): PathCmd[] => {
    if (d.length < MIN_COMMANDS) return d;
    const key = keyOf(d);
    let found = d;
    for (const candidate of previous.get(key) ?? []) {
      if (candidate === d || sameCommands(candidate, d)) { found = candidate; break; }
    }
    if (found !== d) { profileCount('paths.shared'); profileCount('paths.sharedCommands', d.length); }
    const list = next.get(key);
    if (!list) next.set(key, [found]);
    else if (!list.includes(found)) list.push(found);
    return found;
  };
  const walk = (list: Prim[]) => {
    for (const prim of list) {
      if (prim.kind === 'path') prim.d = share(prim.d);
      else if (prim.kind === 'group') {
        if (prim.clip) prim.clip = share(prim.clip);
        walk(prim.prims);
      }
    }
  };
  walk(prims);
  previous = next;
}
