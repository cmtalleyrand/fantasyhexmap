import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves a project site from /<repo>/, so the workflow sets
  // VITE_BASE. A local build or a user site is served from the root.
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
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
