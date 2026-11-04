/** Paired, fresh-process construction benchmark. See DECISIONS §82–83. */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  if (!sorted.length) throw Error('Cannot take the median of no samples');
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function statistics(base: number[], next: number[], seed = 0x83) {
  if (!base.length || base.length !== next.length || [...base, ...next].some(v => !Number.isFinite(v) || v <= 0)) {
    throw Error('Expected matching, nonempty lists of positive finite timings');
  }
  const ratios = base.map((v, i) => next[i]! / v);
  // Fixed seed makes the report reproducible from its saved samples.
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const boot = Array.from({ length: 10_000 }, () => median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]!))).sort((a, b) => a - b);
  const percentile = (p: number) => {
    const position = (boot.length - 1) * p, lo = Math.floor(position);
    return boot[lo]! + (boot[Math.ceil(position)]! - boot[lo]!) * (position - lo);
  };
  const low = percentile(.025), high = percentile(.975);
  return { medianRatio: median(ratios), interval95: [low, high], minRatio: Math.min(...ratios), maxRatio: Math.max(...ratios),
    baseMedianMs: median(base), newMedianMs: median(next), verdict: high < 1 ? 'faster' : low > 1 ? 'slower' : 'unresolved' };
}

type Sample = { ms: number; cpuMs: number; hash: string };
export function parseArgs(args: string[]) {
  const config = { base: '', root: resolve('.'), kind: 'populated', pairs: 30, allowDifferent: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--allow-different') { config.allowDifferent = true; continue; }
    if (!['--base', '--root', '--kind', '--pairs'].includes(flag)) throw Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
    if (flag === '--base') config.base = resolve(value);
    if (flag === '--root') config.root = resolve(value);
    if (flag === '--kind') config.kind = value;
    if (flag === '--pairs') config.pairs = Number(value);
  }
  if (!config.base) throw Error('--base <tree> is required (use --base . --root . for a self-comparison)');
  if (!['populated', 'mixed'].includes(config.kind)) throw Error('--kind must be populated or mixed');
  if (!Number.isSafeInteger(config.pairs) || config.pairs < 1) throw Error('--pairs must be a positive integer');
  return config;
}

async function sample(root: string, kind: string): Promise<Sample> {
  const runner = fileURLToPath(new URL('./render-construction-profile.ts', import.meta.url));
  // Files also work in restricted environments where child-process pipe sockets are unavailable.
  const scratch = mkdtempSync(resolve(tmpdir(), 'perf-sample-'));
  const out = resolve(scratch, 'stdout'), err = resolve(scratch, 'stderr');
  const outFd = openSync(out, 'w'), errFd = openSync(err, 'w');
  let stdout = '', stderr = '';
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', runner, '--sample', '--root', root, '--edits', '0', '--kind', kind],
      { cwd: resolve(dirname(runner), '..'), stdio: ['ignore', outFd, errFd] });
    const status = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    stdout = readFileSync(out, 'utf8'); stderr = readFileSync(err, 'utf8');
    if (status.code !== 0) throw Error(`Sample for ${root} failed (${status.signal ?? status.code}): ${stderr}`);
  } finally {
    closeSync(outFd); closeSync(errFd);
    rmSync(scratch, { recursive: true, force: true });
  }
  let cold: Sample;
  try { cold = JSON.parse(stdout).cold; } catch { throw Error(`Invalid sample JSON for ${root}: ${stdout}\n${stderr}`); }
  if (!cold || !Number.isFinite(cold.ms) || cold.ms <= 0 || !Number.isFinite(cold.cpuMs) || cold.cpuMs <= 0 || !/^[a-f0-9]{64}$/.test(cold.hash)) {
    throw Error(`Invalid timing or hash in sample for ${root}`);
  }
  return { ms: cold.ms, cpuMs: cold.cpuMs, hash: cold.hash };
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString(), samples: { phase: string; pair?: number; tree: 'base' | 'new'; sample: Sample }[] = [];
  const output = resolve('work/perf-compare', `${timestamp.replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(output), { recursive: true });
  const report: Record<string, unknown> = { timestamp, runtime: process.version, ...config, bootstrap: { iterations: 10_000, seed: 0x83 }, samples };
  const hashes: Partial<Record<'base' | 'new', string>> = {};
  const take = async (tree: 'base' | 'new', phase: string, pair?: number) => {
    const result = await sample(tree === 'base' ? config.base : config.root, config.kind);
    samples.push({ phase, pair, tree, sample: result });
    // Preserve completed samples if the host disappears before finally can run.
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    if (hashes[tree] && hashes[tree] !== result.hash) throw Error(`${tree} scene changed during the benchmark: ${hashes[tree]} → ${result.hash}`);
    hashes[tree] = result.hash;
    return result;
  };
  try {
    console.error('Checking scene hashes…');
    await take('base', 'preflight'); await take('new', 'preflight');
    report.hashesEqual = hashes.base === hashes.new;
    if (hashes.base !== hashes.new) {
      const message = `Scene hashes differ: base ${hashes.base}, new ${hashes.new}`;
      if (!config.allowDifferent) throw Error(`${message}. Use --allow-different only for an intentional scene change.`);
      console.error(message);
    }
    for (let i = 0; i < 2; i++) { await take('base', 'warmup'); await take('new', 'warmup'); }
    const base: Sample[] = [], next: Sample[] = [];
    for (let pair = 1; pair <= config.pairs; pair++) {
      for (const tree of pair % 2 ? ['base', 'new'] as const : ['new', 'base'] as const) {
        (tree === 'base' ? base : next).push(await take(tree, 'measured', pair));
      }
      console.error(`Pair ${pair}/${config.pairs}: new/base ${(next.at(-1)!.ms / base.at(-1)!.ms).toFixed(4)}`);
    }
    const wall = statistics(base.map(s => s.ms), next.map(s => s.ms));
    const cpu = statistics(base.map(s => s.cpuMs), next.map(s => s.cpuMs));
    Object.assign(report, { wall, cpu, pairRatios: base.map((s, i) => ({ pair: i + 1, wall: next[i]!.ms / s.ms, cpu: next[i]!.cpuMs / s.cpuMs })) });
    console.log('Measure  Median ratio  95% CI           Min–max          Base ms  New ms  Verdict');
    for (const [name, stats] of [['Wall', wall], ['CPU', cpu]] as const) {
      const f = (v: number) => v.toFixed(4);
      console.log(`${name.padEnd(7)}  ${f(stats.medianRatio)}        ${stats.interval95.map(f).join('–')}    ${f(stats.minRatio)}–${f(stats.maxRatio)}    ${stats.baseMedianMs.toFixed(1)}  ${stats.newMedianMs.toFixed(1)}  ${stats.verdict}`);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.error(`Full samples: ${output}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
