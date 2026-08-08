import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The admin SPA is served by the Worker under /app/*; built asset URLs
// therefore resolve from /app/assets/ (see docs/03-architecture.md §4).
export default defineConfig({
  plugins: [react()],
  base: '/app/assets/',
  build: {
    outDir: 'dist',
  },
})
