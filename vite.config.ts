import { defineConfig } from 'vite';

// Fixed port so the Playwright webServer never latches onto another project's dev server.
export default defineConfig({
  server: { port: 5291, strictPort: true },
});
