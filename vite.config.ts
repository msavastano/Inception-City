import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at any URL (GitHub Pages project sites included).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
