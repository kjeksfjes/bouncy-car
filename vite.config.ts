import { defineConfig } from 'vite';

// Fixed port so the Playwright webServer never latches onto another project's dev server.
// Relative asset paths, so the build runs from any folder (GitHub Pages serves it under /bouncy-car/).
export default defineConfig({
  base: './',
  server: { port: 5291, strictPort: true },
});
