import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { classifyPaths, changedPaths } from './test-scope.mjs';

test('documentation skips work; unrelated application changes retain ordinary checks', () => {
  assert.deepEqual(classifyPaths(['README.md', 'docs/test-next-steps.md']), { code: false, rendering: false });
  for (const path of ['core/prompts.ts', 'server/index.ts', 'worker/index.ts', 'src/components/Inspector.tsx', 'src/state/store.ts', 'test/promptAlignment.test.ts']) {
    assert.deepEqual(classifyPaths([path]), { code: true, rendering: false }, path);
  }
});

test('rendering dependencies, fixtures, infrastructure and unknown files run broadly', () => {
  for (const path of ['src/render/scene.ts', 'shared/types.ts', 'test/slow/incrementalChain.test.ts', 'test/helpers/scene.ts', 'test/fixtures/map.json', 'test/seededMap.ts', 'scripts/browser-runtime.mjs', 'test/drawingInvestigation.test.ts', 'package-lock.json', '.github/workflows/deploy.yml', 'new-source/file.ts']) {
    assert.deepEqual(classifyPaths([path]), { code: true, rendering: true }, path);
  }
  assert.deepEqual(classifyPaths(['README.md', 'shared/hex.ts']), { code: true, rendering: true });
});

test('manual, scheduled, initial pushes and missing history fall back to full checks', () => {
  for (const event of ['workflow_dispatch', 'schedule', 'push']) assert.equal(changedPaths(event, {}, () => ''), null);
  assert.equal(changedPaths('push', { before: '0000', after: 'abc' }, () => ''), null);
  assert.equal(changedPaths('push', { before: 'abc', after: 'def' }, () => { throw Error('missing'); }), null);
  assert.deepEqual(classifyPaths([], true), { code: true, rendering: true });
});

test('PR merge-base and push ranges include deleted and renamed rendering paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'render.ts'), 'render');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    renameSync(join(dir, 'render.ts'), join(dir, 'README.md'));
    git('add', '-A'); git('commit', '-qm', 'rename');
    const head = git('rev-parse', 'HEAD').trim();
    const diff = range => git('diff', '--name-only', '--no-renames', '-z', range, '--');
    for (const [name, event] of [['push', { before: base, after: head }], ['pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }]]) {
      const paths = changedPaths(name, event, diff);
      assert.deepEqual(paths.sort(), ['README.md', 'render.ts']);
      assert.equal(classifyPaths(paths).rendering, true);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
