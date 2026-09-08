import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Two entries, not one route inside the app. `landing.html` is served
    // *before* the session gate (src/server/api.ts), so it has to boot without
    // the app's API client, graph view or setup wizard — none of which an
    // unauthenticated visitor can use anyway. They share the stylesheet and the
    // palette module, so the token layer stays single-sourced.
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        landing: resolve(import.meta.dirname, 'landing.html'),
      },
    },
  },
  server: {
    port: 4318,
    // The engine serves the API; the dev server only serves the shell.
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
