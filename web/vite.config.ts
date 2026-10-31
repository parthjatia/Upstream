import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The app imports ../../shared as TypeScript source from the repo root.
    fs: { allow: ['../..'] }
  },
  // Vite is rooted at web/, so .env files sit one level up at the repo root.
  envDir: '..'
})
