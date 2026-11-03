import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Unknown files run everything. Only known unrelated paths can skip rendering.
export function classifyPaths(paths, full = false) {
  let code = full, rendering = full;
  for (const path of paths) {
    if (path.startsWith('docs/') || /\.(md|txt)$/.test(path)) continue;
    code = true;
    if (/^(core\/|server\/|worker\/|src\/(api\/|state\/|components\/)|src\/(App\.tsx|main\.tsx|styles\.css|preloadRecovery\.ts|vite-env\.d\.ts)$)/.test(path)) continue;
    if (/^test\/[^/]+\.test\.ts$/.test(path)
      && !/^test\/(drawingInvestigation|incrementalRender|lakeStraitRendering)\.test\.ts$/.test(path)) continue;
    rendering = true;
  }
  return { code, rendering };
}

export function changedPaths(eventName, event, diff) {
  if (eventName === 'workflow_dispatch' || eventName === 'schedule') return null;
  const base = eventName === 'pull_request' ? event.pull_request?.base?.sha : event.before;
  const head = eventName === 'pull_request' ? event.pull_request?.head?.sha : event.after;
  if (!base || !head || /^0+$/.test(base)) return null;
  // Both old and new paths of renames count. PRs compare against the merge base.
  const range = eventName === 'pull_request' ? `${base}...${head}` : `${base}..${head}`;
  try {
    return diff(range).split('\0').filter(Boolean);
  } catch {
    return null; // Missing history must never silently skip checks.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const paths = changedPaths(process.env.GITHUB_EVENT_NAME, event, (range) =>
    execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', range, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const scope = classifyPaths(paths ?? [], paths === null);
  const output = Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join('');
  console.log(output.trimEnd());
  appendFileSync(process.env.GITHUB_OUTPUT, output);
}
