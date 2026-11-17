import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works at any URL (GitHub Pages project sites included).
  base: './',
  // The rotating hallway's corridor (src/world/hallway/hallway.glb) is a file like the sounds.
  assetsInclude: ['**/*.glb'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
