import { hexCenter, type Point } from '../../shared/hex.js';
import type { CoastGeometry } from './coast.js';
import type { PathCmd } from './prims.js';
import { fitCoastAreas } from './coastArea.js';
import { pathPolylines } from './ice.js';

/**
 * One coast fit, as plain data a worker can be sent (DECISIONS §97): either the whole coast, or
 * one independent group of rings (`movable`), with everything `fitCoastAreas` reads.
 */
export interface FitJob {
  geometry: CoastGeometry;
  targets: Map<number, { share: number; width?: number }>;
  cols: number;
  rows: number;
  size: number;
  page: { width: number; height: number };
  ink: number;
  passages: number[];
  rounds?: number;
  repairEdges: boolean;
  movable?: number[];
  polylines: Point[][];
  /** Roughly how long the fit takes, for sharing jobs out: the points it moves. */
  weight: number;
}

/** A fit's result: the whole coast's paths and anchors, or a group's paths in `movable` order. */
export interface FitOutput {
  paths: PathCmd[][];
  anchors: Map<string, Point>;
  detail?: Map<string, number>;
}

/**
 * The job with only what `fitCoastAreas` reads of the coast (its paths, anchors and held detail,
 * and whether each chain is closed): about a sixth of the copying to send it to a worker.
 */
export function slimFitJob(job: FitJob): FitJob {
  const g = job.geometry;
  return { ...job, geometry: { component: g.component, aggregate: g.aggregate, paths: g.paths, anchors: g.anchors, detail: g.detail,
    chains: g.chains.map(c => ({ closed: c.closed, points: [], edges: [] })), strips: [], toWater: [], toLand: [], grown: [],
    water: new Map(), land: new Map() } };
}

export function runFitJob(job: FitJob): FitOutput {
  const movable = job.movable ? new Set(job.movable) : undefined;
  const fitted = fitCoastAreas(job.geometry, job.targets, job.cols, job.rows, job.size, job.page, job.ink, job.passages,
    job.rounds, job.repairEdges, movable, job.polylines);
  return job.movable
    ? { paths: job.movable.map(k => fitted.paths[k]!), anchors: new Map(), detail: fitted.detail }
    : { paths: fitted.paths, anchors: fitted.anchors, detail: fitted.detail };
}

/** The steps of a build that may hand its coast fits out: each yield asks for these fits' results, in order. */
export type FitSteps<T> = Generator<FitJob[], T, FitOutput[]>;

/** Runs every fit in place, one after another: the plain synchronous build. */
export function runFitsHere<T>(steps: FitSteps<T>): T {
  let step = steps.next();
  while (!step.done) step = steps.next(step.value.map(runFitJob));
  return step.value;
}

/**
 * A small fit for a new worker to run while it waits: a wobbly island asked for shares it does not
 * have. It compiles the fit's code before the first real fit arrives, as the paint worker's own
 * fits have by then (DECISIONS §97). Its result is thrown away.
 */
export function warmUpJob(variant: number): FitJob {
  const size = 20, cols = 12, rows = 12, centre = hexCenter(5, 5, size);
  const ring: Point[] = Array.from({ length: 96 }, (_, k) => {
    const a = (k / 96) * Math.PI * 2, r = size * (2.6 + 0.35 * Math.sin(a * 3 + variant) + 0.2 * Math.cos(a * 5));
    return { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) };
  });
  const paths: PathCmd[][] = [[...ring.map((p, j): PathCmd => [j ? 'L' : 'M', p.x, p.y]), ['Z']]];
  const targets = new Map<number, { share: number }>();
  for (let row = 2; row <= 8; row++) for (let col = 2; col <= 8; col++) {
    const c = hexCenter(col, row, size), d = Math.hypot(c.x - centre.x, c.y - centre.y) / size;
    if (d > 1.2 && d < 4) targets.set(row * cols + col, { share: Math.max(0.1, Math.min(0.9, 1.2 - d / 3.5 + 0.1 * Math.sin(col * 7 + row + variant))) });
  }
  return {
    geometry: { component: true, chains: [{ closed: true, points: [], edges: [] }], paths, anchors: new Map(), strips: [], toWater: [],
      toLand: [], grown: [], water: new Map(), land: new Map() },
    targets, cols, rows, size, page: { width: size * Math.sqrt(3) * (cols + 0.5), height: size * (1.5 * rows + 0.5) }, ink: 0.8,
    passages: [], repairEdges: false, polylines: [pathPolylines(paths[0]!, 8)[0] ?? ring], weight: 0,
  };
}
