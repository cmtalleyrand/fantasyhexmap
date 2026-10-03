/**
 * Collision audit of a finished scene.
 *
 * Placement is done by heuristics that each look at part of the picture: realm
 * names avoid city markers, river names follow rivers, the furniture searches
 * open sea. None of them re-checks the result against all the others, so this
 * does, from the scene alone: every name against every other name and against
 * the city markers, sea names against land, realm names against the ground they
 * claim, and every piece of map furniture against land, names, markers and each
 * other. It tests rectangle against rectangle (see collide.ts) rather than on the
 * placer's grid, so it can disagree with the placer, which is the point.
 *
 * Coordinates are the map's own: a scene whose page has been grown by a frame
 * keeps the map in a translated group, and everything here is in that group's
 * coordinates, where the margin band lies at negative values.
 */

import { gridPixelSize, hexCenter, hexIndex, pixelToOffset, type Point } from '../../shared/hex.js';
import { descendantsOf } from '../../shared/polityTree.js';
import type { MapState } from '../../shared/types.js';
import { boxBounds, boxesOverlap, boxContains, rectBox, textBoxes, textPrims, type TextPrim } from './collide.js';
import type { OrientedBox } from './labels.js';
import { landTestOf, type Scene } from './scene.js';

export type AuditKind =
  | 'name-overlaps-name'
  | 'name-overlaps-marker'
  | 'sea-name-over-land'
  | 'realm-name-covers-own-land'
  | 'realm-name-over-foreign-land'
  | 'furniture-overlaps-furniture'
  | 'furniture-overlaps-name'
  | 'furniture-overlaps-marker'
  | 'furniture-over-land'
  | 'furniture-off-page'
  | 'band-furniture-over-map';

export interface AuditIssue {
  kind: AuditKind;
  /** One line a person can act on. */
  message: string;
  /** Where on the map it is, in the map's own pixels. */
  at: Point;
}

/** A realm name longer than its land is reported when it covers at least this share of that land. */
const COVERED_MIN = 0.25;
/** A realm name with more than this share over another realm's land is reported. */
const FOREIGN_SHARE_MAX = 0.4;

interface Label {
  id: string;
  /** What to call it in a report. */
  text: string;
  prim: TextPrim;
  boxes: OrientedBox[];
  bounds: { x0: number; y0: number; x1: number; y1: number };
}

function labelsOf(scene: Scene): Label[] {
  const byKey = new Map<string, Label>();
  textPrims(scene.prims).forEach((prim, i) => {
    if (!prim.tag) return;
    // The lines of a wrapped realm name are one name.
    const key = prim.tag.kind === 'polity' ? `polity:${prim.tag.owner}:${prim.size}` : `${prim.tag.kind}:${i}`;
    const boxes = textBoxes(prim);
    const known = byKey.get(key);
    if (known) {
      known.boxes.push(...boxes);
      known.text += ` ${prim.text}`;
      return;
    }
    byKey.set(key, { id: key, text: prim.text, prim, boxes, bounds: { x0: 0, y0: 0, x1: 0, y1: 0 } });
  });
  const labels = [...byKey.values()];
  for (const l of labels) {
    const bs = l.boxes.map((b) => boxBounds(b));
    l.bounds = {
      x0: Math.min(...bs.map((b) => b.x0)),
      y0: Math.min(...bs.map((b) => b.y0)),
      x1: Math.max(...bs.map((b) => b.x1)),
      y1: Math.max(...bs.map((b) => b.y1)),
    };
  }
  return labels;
}

const disjoint = (a: Label['bounds'], b: Label['bounds']) => a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0;
const anyOverlap = (as: OrientedBox[], bs: OrientedBox[], pad = 0) => as.some((a) => bs.some((b) => boxesOverlap(a, b, pad)));
const centre = (l: Label): Point => ({ x: (l.bounds.x0 + l.bounds.x1) / 2, y: (l.bounds.y0 + l.bounds.y1) / 2 });
const name = (l: Label) => `${l.prim.tag!.kind} name "${l.text}"`;

/** Points spread over a set of boxes, `step` apart. */
function samplesOver(boxes: OrientedBox[], step: number): Point[] {
  const out: Point[] = [];
  for (const box of boxes) {
    const b = boxBounds(box);
    for (let y = b.y0; y <= b.y1; y += step) {
      for (let x = b.x0; x <= b.x1; x += step) if (boxContains(box, x, y)) out.push({ x, y });
    }
    out.push({ x: box.cx, y: box.cy });
  }
  return out;
}

export function auditScene(map: MapState, scene: Scene, size: number): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const { cols, rows } = map;
  const { width: mapW, height: mapH } = gridPixelSize(cols, rows, size);
  const base = map.layers.base.data;
  const labels = labelsOf(scene);
  const markers = scene.markers ?? [];
  const step = Math.max(2, size / 4);

  const hexAt = (p: Point): number | null => {
    if (p.x < 0 || p.y < 0 || p.x >= mapW || p.y >= mapH) return null;
    const { col, row } = pixelToOffset(p.x, p.y, size);
    return hexIndex(cols, Math.min(cols - 1, Math.max(0, col)), Math.min(rows - 1, Math.max(0, row)));
  };

  // Names against names, and against markers.
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i]!;
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j]!;
      if (disjoint(a.bounds, b.bounds) || !anyOverlap(a.boxes, b.boxes)) continue;
      issues.push({ kind: 'name-overlaps-name', message: `${name(a)} overlaps ${name(b)}`, at: centre(a) });
    }
    for (const m of markers) {
      if (a.bounds.x1 < m.cx - m.halfW || a.bounds.x0 > m.cx + m.halfW || a.bounds.y1 < m.cy - m.halfH || a.bounds.y0 > m.cy + m.halfH) continue;
      if (!anyOverlap(a.boxes, [m])) continue;
      issues.push({ kind: 'name-overlaps-marker', message: `${name(a)} covers a city marker`, at: { x: m.cx, y: m.cy } });
    }
  }

  const drawn = landTestOf(scene);
  /** Land as drawn, where the scene can say; otherwise by hex type. */
  const landAt = (p: Point): boolean => {
    if (drawn) return drawn(p);
    const i = hexAt(p);
    const type = i === null || !base ? null : base[i];
    return !!type && type !== 'Sea' && type !== 'Lake' && type !== 'Sea Ice';
  };

  // Sea names over land.
  if (base) {
    for (const l of labels.filter((x) => x.prim.tag!.kind === 'water')) {
      // A lake's name lies in the lake, a sea's in the sea; neither over the land between.
      const over = samplesOver(l.boxes, step).filter((p) => {
        const i = hexAt(p);
        return i !== null && base[i] !== 'Lake' && landAt(p);
      });
      if (over.length > 0) issues.push({ kind: 'sea-name-over-land', message: `${name(l)} lies over land`, at: centre(l) });
    }
  }

  // Realm names against the ground they claim, and against other realms' ground.
  const polities = map.layers.polities.data;
  if (polities && base) {
    for (const l of labels.filter((x) => x.prim.tag!.kind === 'polity')) {
      const own = new Set<string>([l.prim.tag!.owner!, ...descendantsOf(polities.polities, l.prim.tag!.owner!)]);
      const samples = samplesOver(l.boxes, step);
      let foreign = 0;
      for (const p of samples) {
        const i = hexAt(p);
        if (i === null || !landAt(p)) continue;
        const owner = polities.owner[i];
        if (!(owner && own.has(owner))) foreign++;
      }
      if (samples.length > 0 && foreign / samples.length > FOREIGN_SHARE_MAX) {
        issues.push({
          kind: 'realm-name-over-foreign-land',
          message: `${name(l)} has ${Math.round((100 * foreign) / samples.length)}% of its length over other land`,
          at: centre(l),
        });
      }

      // A name longer than the land it names cannot sit on it, only across it.
      const axis = l.boxes[0]!.rotation;
      const along = (p: Point) => p.x * Math.cos(axis) + p.y * Math.sin(axis);
      const land: Point[] = [];
      polities.owner.forEach((o, i) => {
        if (!o || !own.has(o)) return;
        const c = hexCenter(i % cols, Math.floor(i / cols), size);
        for (let y = c.y - size; y <= c.y + size; y += step) {
          for (let x = c.x - size; x <= c.x + size; x += step) {
            const p = { x, y };
            const at = pixelToOffset(x, y, size);
            if (at.col === i % cols && at.row === Math.floor(i / cols) && landAt(p)) land.push(p);
          }
        }
      });
      if (land.length === 0) continue;
      const reach = (ps: number[]) => Math.max(...ps) - Math.min(...ps);
      const landLength = reach(land.map(along));
      const nameLength = reach(l.boxes.flatMap((b) => [along({ x: b.cx, y: b.cy }) - b.halfW, along({ x: b.cx, y: b.cy }) + b.halfW]));
      const covered = land.filter((p) => l.boxes.some((b) => boxContains(b, p.x, p.y))).length / land.length;
      if (nameLength > landLength + size * 0.1 && covered >= COVERED_MIN) {
        issues.push({
          kind: 'realm-name-covers-own-land',
          message: `${name(l)} is longer than the land it names and prints across ${Math.round(100 * covered)}% of it`,
          at: centre(l),
        });
      }
    }
  }

  // Map furniture.
  const furniture = scene.furniture ?? [];
  const origin = scene.origin ?? { x: 0, y: 0 };
  furniture.forEach((f, i) => {
    const at = { x: f.box.cx, y: f.box.cy };
    const label = `${f.kind}${f.where === 'band' ? ' (in the margin band)' : ''}`;
    if (f.kind !== 'legend') {
      const b = boxBounds(f.box);
      if (b.x0 + origin.x < 0 || b.y0 + origin.y < 0 || b.x1 + origin.x > scene.width || b.y1 + origin.y > scene.height) {
        issues.push({ kind: 'furniture-off-page', message: `${label} runs off the page`, at });
      }
    }
    if (f.where === 'sea' && base) {
      const found = new Set<string>();
      for (const p of samplesOver([f.box], step)) {
        const k = hexAt(p);
        const type = k === null ? null : base[k];
        if (landAt(p)) found.add('land');
        else if (type === 'Sea Ice' || type === 'Glacier') found.add('ice');
      }
      if (found.size > 0 || anyOverlapRect(f.box, mapW, mapH)) {
        issues.push({ kind: 'furniture-over-land', message: `${label} is not on open sea${found.size ? ` (over ${[...found].join(' and ')})` : ''}`, at });
      }
    }
    if (f.where === 'band' && boxesOverlap(f.box, rectBox(0, 0, mapW, mapH))) {
      issues.push({ kind: 'band-furniture-over-map', message: `${label} lies over the map`, at });
    }
    for (const l of labels) {
      if (disjoint(boxBounds(f.box), l.bounds) || !anyOverlap([f.box], l.boxes)) continue;
      // The piece's own lettering is part of it.
      if (l.prim.tag!.kind === f.kind) continue;
      issues.push({ kind: 'furniture-overlaps-name', message: `${label} overlaps ${name(l)}`, at });
    }
    for (const m of markers) {
      if (boxesOverlap(f.box, m)) issues.push({ kind: 'furniture-overlaps-marker', message: `${label} covers a city marker`, at });
    }
    for (const g of furniture.slice(i + 1)) {
      if (boxesOverlap(f.box, g.box)) {
        issues.push({ kind: 'furniture-overlaps-furniture', message: `${label} overlaps the ${g.kind}`, at });
      }
    }
  });
  return issues;
}

/** Whether any part of `box` lies outside the map's rectangle. */
function anyOverlapRect(box: OrientedBox, w: number, h: number): boolean {
  const b = boxBounds(box);
  return b.x0 < 0 || b.y0 < 0 || b.x1 > w || b.y1 > h;
}

/** An audit as text, one line per issue, or a line saying there were none. */
export function formatAudit(issues: AuditIssue[]): string {
  if (issues.length === 0) return 'No overlaps found.';
  const lines = issues.map((i) => `- ${i.message} (near ${Math.round(i.at.x)}, ${Math.round(i.at.y)})`);
  return `${issues.length} overlap${issues.length === 1 ? '' : 's'} found:\n${lines.join('\n')}`;
}
