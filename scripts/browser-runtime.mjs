import { pathToFileURL } from 'node:url';
import { resolve, extname } from 'node:path';
import { readFile } from 'node:fs/promises';

// An explicit driver path supports managed environments without installing scratch dependencies.
// A preinstalled Chromium is taken from --chromium, else from CHROMIUM_PATH.
export async function launchBrowser(args = process.argv) {
  const executablePath = args.includes('--chromium') ? args[args.indexOf('--chromium') + 1] : process.env.CHROMIUM_PATH || undefined;
  const driver = args.includes('--driver') ? pathToFileURL(resolve(args[args.indexOf('--driver') + 1])).href : 'playwright';
  const { chromium } = await import(driver).catch(error => {
    throw new Error('Run npm ci to install the browser test driver, or pass --driver /path/to/playwright-core/index.mjs', { cause: error });
  });
  return chromium.launch({ ...(executablePath ? { executablePath } : {}),
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--num-raster-threads=1'] });
}

/** Serve a build through browser interception: no server, port, or external network needed. */
export async function serveBuild(context, root, extra = {}) {
  await context.route('http://render.test/**', async route => {
    const url = new URL(route.request().url());
    const path = decodeURIComponent(url.pathname);
    try {
      if (path in extra) return await route.fulfill({ status: 200, contentType: 'text/javascript', body: extra[path] });
      if (path === '/blank') return await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' });
      const file = resolve(root, path === '/' ? 'index.html' : path.slice(1));
      if (!file.startsWith(resolve(root) + '/')) return await route.abort();
      const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' })[extname(file)] ?? 'application/octet-stream';
      await route.fulfill({ status: 200, contentType, body: await readFile(file) });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
}
