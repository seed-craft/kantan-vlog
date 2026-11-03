import { defineConfig } from 'vite';

// base: './' so the built files work from any static host path.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
