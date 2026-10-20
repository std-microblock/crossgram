import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { publicAssets } from './build-assets.js'
import { sharedModules } from './src/imports.js'
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  mode: 'production',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [react(), publicAssets()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: {
    target: 'es2022',
    manifest: true,
    sourcemap: true,
    chunkSizeWarningLimit: 180,
    rollupOptions: {
      input: [
        resolve(import.meta.dirname, 'index.html'),
        ...Object.values(sharedModules).map((file) =>
          resolve(import.meta.dirname, file),
        ),
      ],
      preserveEntrySignatures: 'strict',
    },
  },
})
