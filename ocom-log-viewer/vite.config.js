import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',
  server: {
    port: 5173,
    open: false
  },
  build: {
    outDir: '../dist/viewer',
    emptyOutDir: true
  }
});
