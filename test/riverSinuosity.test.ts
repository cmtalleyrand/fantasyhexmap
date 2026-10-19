import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { measureRiverCourse, riverLength, riverSystemLength, formatLength } from '../shared/riverLength.ts';
import { DEFAULT_HEX_DIMENSIONS, type River } from '../shared/types.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { riverCourses } from '../src/render/rivers.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { buildExportScene } from '../src/render/exportScene.ts';
import { DEFAULT_LEGEND_OPTIONS, legendSections } from '../src/render/legend.ts';

const dims = { width: Math.sqrt(3) * 10, height: 20 };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

function fixture() {
  const map = createMapState('Sinuous', 8, 5);
  map.id = 'sinuosity-test';
  map.hexDimensions = { ...DEFAULT_HEX_DIMENSIONS, ...dims, lengthRounding: 0.1 };
  const river: River = {
    id: 'r', name: 'Winding', terminus: 'OffMap',
    segments: Array.from({ length: 7 }, (_, col) => ({
      col: col + 1, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false,
    })),
  };
  map.layers.rivers.data = { rivers: [river] };
  // No base layer: isolate the course from shoreline trimming.
  const visible = { ...defaultVisibility(), rivers: true };
  return { map, river, visible };
}

test('length includes bends; sinuosity compares the course with its endpoint distance', () => {
  const line = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 0 }];
  const measured = measureRiverCourse(line, dims, 10);
  close(measured.length, 10);
  close(measured.sinuosity, 10 / 6);
  close(measureRiverCourse([{ x: 0, y: 0 }, { x: 6, y: 0 }], dims, 10).sinuosity, 1);
  assert.deepEqual(measureRiverCourse([], dims, 10), { length: 0, sinuosity: 1 });
  assert.deepEqual(measureRiverCourse([{ x: 2, y: 3 }], dims, 10), { length: 0, sinuosity: 1 });
  // Width and height are independent, including stretched hexes.
  close(measureRiverCourse(line, { width: dims.width * 2, height: dims.height }, 10).length, 2 * Math.hypot(6, 4));
  close(measureRiverCourse(line.map(p => ({ x: p.x * 3, y: p.y * 3 })), dims, 30).length, 10);
});

test('scene length follows the actual tapered network and changes with irregularity and manual guidance', () => {
  const { map, river, visible } = fixture();
  const lengths: number[] = [];
  for (const wander of ['verygentle', 'wild'] as const) {
    const style = resolveStyle({ preset: 'parchment', overrides: { riverWander: wander } });
    const scene = buildScene(map, { size: 26, visible, labels: false, style });
    const line = riverCourses([river], 26, map.id, undefined, [], wander).get(river.id)!.centreline;
    const expected = line.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - line[i]!.x, p.y - line[i]!.y) * 10 / 26, 0);
    close(scene.riverMeasurements![river.id]!.length, expected);
    assert.ok(scene.riverMeasurements![river.id]!.sinuosity > 1);
    lengths.push(expected);
  }
  assert.notEqual(lengths[0], lengths[1]);
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const before = buildScene(map, { size: 26, visible, labels: false, style }).riverMeasurements!.r!.length;
  river.segments[3]!.reach = { min: 0.9, max: null };
  const after = buildScene(map, { size: 26, visible, labels: false, style }).riverMeasurements!.r!.length;
  assert.notEqual(before, after);
});

test('branch totals use measured lengths and legends match exported scene measurements', () => {
  const { map, river, visible } = fixture();
  const branch = { ...river, id: 'branch', branchOf: river.id };
  close(riverSystemLength(river, [river, branch], dims, {
    r: { length: 123, sinuosity: 1.2 }, branch: { length: 45, sinuosity: 1.1 },
  }), 168);
  for (const preset of ['classic', 'parchment'] as const) {
    const style = resolveStyle({ preset, overrides: {} });
    const scene = buildExportScene(map, visible, {
      format: 'svg', labels: false, size: 26, style,
      legend: { ...DEFAULT_LEGEND_OPTIONS, riverLengths: true },
    });
    const measured = scene.riverMeasurements!.r!;
    const label = `Winding - ${formatLength(measured.length, map.hexDimensions.unit, 0.1)}`;
    assert.ok(scene.prims.some(p => p.kind === 'text' && p.text === label));
    assert.ok(legendSections(map, visible, 'colour', { ...DEFAULT_LEGEND_OPTIONS, riverLengths: true }, style)
      .find(s => s.id === 'rivers')!.entries.some(e => e.label === label));
    if (preset === 'classic') close(measured.length, riverLength(river, dims));
  }
});
