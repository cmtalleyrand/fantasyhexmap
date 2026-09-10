import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * A Content-Security-Policy on the production build.
 *
 * This matters most in the static deployment, where the page holds the user's
 * own API key. `connect-src` is the load-bearing line: even if something managed
 * to run script on this origin, it could not post the key to an attacker's
 * server, because the only place this page may talk to is Anthropic (and a
 * configured proxy). `script-src 'self'` means no third-party code can be pulled
 * in to try - the app deliberately loads no CDN, fonts or analytics.
 *
 * Injected at build time only: the dev server needs websockets for HMR.
 */
function csp(): Plugin {
  return {
    name: 'hexmap-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const extra = process.env.VITE_API_BASE?.trim();
      let proxyOrigin = '';
      if (extra) {
        try {
          proxyOrigin = ` ${new URL(extra).origin}`;
        } catch {
          throw new Error(`VITE_API_BASE is not a valid URL: ${extra}`);
        }
      }
      const policy = [
        "default-src 'none'",
        "script-src 'self'",
        // React sets style attributes; Vite injects a stylesheet from this origin.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        `connect-src 'self' https://api.anthropic.com${proxyOrigin}`,
        "base-uri 'none'",
        "form-action 'none'",
        // frame-ancestors is deliberately absent: it is ignored in a <meta> CSP and
        // only works as a response header, which static Pages hosting cannot set.
        // A host that can send headers should serve this same policy as one.
      ].join('; ');
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so the workflow sets
  // VITE_BASE. A local build or a user site is served from the root.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), csp()],
  server: {
    port: 5173,
    proxy: {
      // Everything AI-related goes through the local Express server, which is
      // the only place the Anthropic API key exists.
      '/api': {
        target: `http://localhost:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});
