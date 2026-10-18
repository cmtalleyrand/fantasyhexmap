/** Sequential runs keep browser performance scenarios from competing for CPU. */
import { spawnSync } from 'node:child_process';
const driver = process.argv.includes('--driver') ? ['--driver', process.argv[process.argv.indexOf('--driver') + 1]] : [];
const runs = process.argv.includes('--runs') ? process.argv[process.argv.indexOf('--runs') + 1] : '10';
const jobs = [
  ['scripts/render-cache-performance.mjs', '--output', 'work/part34-browser/construction-final'],
  ['scripts/render-opening-performance.mjs', '--dist', 'work/part34-baseline/dist', '--warm', '--output', 'work/part34-browser/before-populated'],
  ['scripts/render-opening-performance.mjs', '--warm', '--burst', '--output', 'work/part34-browser/after-populated'],
  ['scripts/render-opening-performance.mjs', '--dist', 'work/part34-baseline/dist', '--fixture', 'work/part34-components.json', '--shore', '--output', 'work/part34-browser/before-components'],
  ['scripts/render-opening-performance.mjs', '--fixture', 'work/part34-components.json', '--shore', '--burst', '--output', 'work/part34-browser/after-components'],
  ['scripts/render-opening-performance.mjs', '--dist', 'work/part34-baseline/dist', '--opacity', '--output', 'work/part34-browser/before-opacity'],
  ['scripts/render-opening-performance.mjs', '--opacity', '--output', 'work/part34-browser/after-opacity'],
  ['scripts/render-incremental-validation.mjs', '--output', 'work/part34-browser/incremental'],
  ['scripts/render-coast-validation.mjs', '--reference-root', 'work/part34-baseline', '--only', 'populated,strait-share-Fractured', '--output', 'work/part34-browser/baseline-pixels'],
  ['scripts/render-opening-performance.mjs', '--profile', '--profile-edits', '--opacity', '--runs', '1', '--edits', '2', '--output', 'work/part34-browser/profiled-opacity'],
];
const from = process.argv.includes('--from') ? Number(process.argv[process.argv.indexOf('--from') + 1]) : 0;
for (const job of jobs.slice(from).filter(job => !process.argv.includes('--candidate-only') || !job.includes('--dist'))) {
  console.log(`Starting ${job.join(' ')}`);
  const result = spawnSync(process.execPath, [...job, '--runs', runs, ...driver], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
