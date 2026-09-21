import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import solid from 'vite-plugin-solid'
import { publicAssets } from './build-assets.js'
import { sharedModules } from './src/imports.js'
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [solid(), publicAssets()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'solid-js' },
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
