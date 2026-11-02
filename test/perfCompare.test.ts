import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, statistics, parseArgs } from '../scripts/perf-compare.ts';

test('paired statistics use ratios, average even medians and bootstrap deterministically', () => {
  assert.equal(median([9, 1, 3, 5]), 4);
  // Absolute medians can mislead when machine speed varies; each pair cancels that variation.
  const base = [100, 1000, 200, 2000], next = base.map(v => v * .9);
  const result = statistics(base, next);
  assert.equal(result.medianRatio, .9);
  assert.deepEqual(result.interval95, [.9, .9]);
  assert.equal(result.verdict, 'faster');
  assert.deepEqual(result, statistics(base, next));
  assert.equal(statistics(base, base.map(v => v * 1.01)).verdict, 'slower');
  assert.equal(statistics(base, base).verdict, 'unresolved');
});

test('confidence interval includes uncertainty for mixed pair outcomes', () => {
  const result = statistics([100, 100, 100, 100], [95, 99, 101, 105]);
  assert.equal(result.medianRatio, 1);
  assert.ok(result.interval95[0]! < 1 && result.interval95[1]! > 1);
  assert.equal(result.verdict, 'unresolved');
  assert.throws(() => statistics([], []));
  assert.throws(() => statistics([1], [1, 2]));
  assert.throws(() => statistics([0], [1]));
  assert.throws(() => statistics([1], [NaN]));
});

test('CLI requires explicit base and validates values before running samples', () => {
  assert.equal(parseArgs(['--base', '.']).pairs, 30);
  const config = parseArgs(['--base', '.', '--root', '.', '--kind', 'mixed', '--pairs', '100', '--allow-different']);
  assert.equal(config.base, config.root);
  assert.equal(config.kind, 'mixed');
  assert.equal(config.pairs, 100);
  assert.equal(config.allowDifferent, true);
  for (const args of [[], ['--base'], ['--base', '--root', '.'], ['--base', '.', '--pairs', '0'],
    ['--base', '.', '--pairs', '1.5'], ['--base', '.', '--kind', 'typo'], ['--base', '.', '--typo']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('runner saves alternating pairs, rejects hash changes and permits intentional differences', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, openSync, closeSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const folder = mkdtempSync(join(tmpdir(), 'perf-compare-test-'));
  const runner = fileURLToPath(new URL('../scripts/perf-compare.ts', import.meta.url));
  const tsx = fileURLToPath(import.meta.resolve('tsx'));
  try {
    for (const side of ['base', 'new']) {
      mkdirSync(join(folder, side, 'src/render'), { recursive: true });
      writeFileSync(join(folder, side, 'src/render/scene.ts'), 'export function buildStaticScene() { const start = performance.now(); while (performance.now() - start < 2) {} return { same: true }; }');
    }
    const run = (extra: string[] = []) => {
      const out = join(folder, 'stdout'), err = join(folder, 'stderr');
      const outFd = openSync(out, 'w'), errFd = openSync(err, 'w');
      try {
        const result = spawnSync(process.execPath, ['--import', tsx, runner,
          '--base', join(folder, 'base'), '--root', join(folder, 'new'), '--pairs', '2', ...extra],
          { cwd: folder, stdio: ['ignore', outFd, errFd] });
        assert.ifError(result.error);
        return { status: result.status, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
      } finally { closeSync(outFd); closeSync(errFd); }
    };
    const report = () => {
      const files = readdirSync(join(folder, 'work/perf-compare')).sort();
      return JSON.parse(readFileSync(join(folder, 'work/perf-compare', files.at(-1)!), 'utf8'));
    };
    const success = run();
    assert.equal(success.status, 0, success.stdout + success.stderr);
    const result = report();
    assert.equal(result.hashesEqual, true);
    assert.deepEqual(result.samples.map((s: { phase: string }) => s.phase),
      ['preflight', 'preflight', 'warmup', 'warmup', 'warmup', 'warmup', 'measured', 'measured', 'measured', 'measured']);
    assert.deepEqual(result.samples.slice(6).map((s: { tree: string }) => s.tree), ['base', 'new', 'new', 'base']);
    assert.equal(result.bootstrap.iterations, 10_000);
    assert.equal(result.pairRatios.length, 2);
    assert.ok(result.pairRatios.every((p: { wall: number; cpu: number }) => p.wall > 0 && p.cpu > 0));
    writeFileSync(join(folder, 'new/src/render/scene.ts'), 'export function buildStaticScene() { return { different: true }; }');
    const mismatch = run();
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /Scene hashes differ/);
    assert.equal(report().samples.length, 2);
    const allowed = run(['--allow-different']);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(report().hashesEqual, false);
    writeFileSync(join(folder, 'new/src/render/scene.ts'), 'export function buildStaticScene() { return { nonce: Math.random() }; }');
    const drift = run(['--allow-different']);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /new scene changed during the benchmark/);
    writeFileSync(join(folder, 'new/src/render/scene.ts'), 'throw Error("broken fixture");');
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /broken fixture/);
    assert.match(report().error, /Sample .* failed/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
