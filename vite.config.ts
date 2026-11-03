import { defineConfig } from 'vite';

// base: './' so the built files work from any static host path.
const built = new Date().toLocaleString('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export default defineConfig({
  base: './',
  define: { __BUILD__: JSON.stringify(built) },
  build: { target: 'es2022' },
});
