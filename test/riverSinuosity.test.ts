import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { measureRiverCourse, riverLength, riverSystemLength, formatLength, riverHexAreaKm2, riverLengthCorrectionFactor } from '../shared/riverLength.ts';
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
  close(measured.drawnLength, 10);
  close(measured.length, 10 * riverLengthCorrectionFactor(dims));
  close(measured.correctionFactor, 1.05 * (0.75 * dims.width * dims.height) ** 0.02);
  close(measured.sinuosity, 10 / 6);
  close(measureRiverCourse([{ x: 0, y: 0 }, { x: 6, y: 0 }], dims, 10).sinuosity, 1);
  for (const line of [[], [{ x: 2, y: 3 }]]) {
    const empty = measureRiverCourse(line, dims, 10);
    assert.equal(empty.length, 0);
    assert.equal(empty.drawnLength, 0);
    assert.equal(empty.sinuosity, 1);
  }
  // Width and height are independent, including stretched hexes.
  close(measureRiverCourse(line, { width: dims.width * 2, height: dims.height }, 10).drawnLength, 2 * Math.hypot(6, 4));
  close(measureRiverCourse(line.map(p => ({ x: p.x * 3, y: p.y * 3 })), dims, 30).length, measured.length);
});

test('unresolved sinuosity uses whole-hex km² regardless of display units or zoom', () => {
  const km = { width: 10, height: 20, unit: 'km' };
  const expected = 1.05 * 150 ** 0.02;
  for (const [unit, inKm] of [['km', 1], ['m', 0.001], ['mi', 1.609344], ['ft', 0.0003048], ['yd', 0.0009144], ['leagues', 4.828032]] as const) {
    const converted = { width: km.width / inKm, height: km.height / inKm, unit };
    close(riverHexAreaKm2(converted)!, 150);
    close(riverLengthCorrectionFactor(converted), expected);
    const measured = measureRiverCourse([{ x: 0, y: 0 }, { x: 10, y: 20 }], converted, 26);
    const reference = measureRiverCourse([{ x: 0, y: 0 }, { x: 10, y: 20 }], km, 26);
    close(measured.length * inKm, reference.length);
  }
  assert.equal(riverHexAreaKm2({ ...km, unit: 'custom' }), null);
  assert.equal(riverLengthCorrectionFactor({ ...km, unit: 'custom' }), 1);
  // Preserve the requested formula even below one square kilometre.
  close(riverLengthCorrectionFactor({ width: 0.01, height: 0.02, unit: 'km' }), 1.05 * 0.00015 ** 0.02);
});

test('scene length follows the actual tapered network and changes with irregularity and manual guidance', () => {
  const { map, river, visible } = fixture();
  const lengths: number[] = [];
  for (const wander of ['verygentle', 'wild'] as const) {
    const style = resolveStyle({ preset: 'parchment', overrides: { riverWander: wander } });
    const scene = buildScene(map, { size: 26, visible, labels: false, style });
    const line = riverCourses([river], 26, map.id, undefined, [], wander).get(river.id)!.centreline;
    const expected = line.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - line[i]!.x, p.y - line[i]!.y) * 10 / 26, 0);
    close(scene.riverMeasurements![river.id]!.drawnLength, expected);
    close(scene.riverMeasurements![river.id]!.length, expected * riverLengthCorrectionFactor(map.hexDimensions));
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
    r: { length: 123, drawnLength: 100, correctionFactor: 1.23, sinuosity: 1.2 },
    branch: { length: 45, drawnLength: 36, correctionFactor: 1.25, sinuosity: 1.1 },
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
