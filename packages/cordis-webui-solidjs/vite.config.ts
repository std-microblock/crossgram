import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [solid()],
  build: { target: 'es2022', manifest: true, sourcemap: true, chunkSizeWarningLimit: 180 },
})
