import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The admin SPA is served by the Worker under /app (docs/03 §4): the build
// lands in apps/public/dist/app so the ASSETS binding serves its hashed files
// at /app/assets/*, while /app itself stays behind the Worker's session gate
// (run_worker_first in wrangler.toml) and returns the built index.html.
export default defineConfig({
  plugins: [react()],
  base: '/app/',
  build: {
    outDir: fileURLToPath(new URL('../public/dist/app', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // Standalone `vite dev` proxies API + auth to `wrangler dev` for HMR work.
    proxy: {
      '/app/api': 'http://127.0.0.1:8787',
      '/auth': 'http://127.0.0.1:8787',
    },
  },
})
