import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 4318,
    // The engine serves the API; the dev server only serves the shell.
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
