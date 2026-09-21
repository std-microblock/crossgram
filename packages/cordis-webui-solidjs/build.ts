import { build } from 'vite'
import solid from 'vite-plugin-solid'
import { publicAssets } from './build-assets.js'
import { resolve } from 'node:path'
import { sharedModules } from './src/imports.js'

export interface ClientBuildOptions {
  root: string
  entry?: string
  outDir?: string
  sourcemap?: boolean
}
/** Build an independently installed Solid extension against the shell's shared runtime. */
export async function buildClient(options: ClientBuildOptions) {
  return build({
    configFile: false,
    root: options.root,
    base: './',
    plugins: [solid(), publicAssets()],
    esbuild: { jsx: 'automatic', jsxImportSource: 'solid-js' },
    build: {
      target: 'es2022',
      outDir: options.outDir ?? 'dist',
      manifest: 'manifest.json',
      sourcemap: options.sourcemap ?? true,
      // No implicit deletion outside the package output; Vite retains its normal root safety check.
      rollupOptions: {
        input: resolve(options.root, options.entry ?? 'client/index.tsx'),
        preserveEntrySignatures: 'strict',
        external: Object.keys(sharedModules),
      },
    },
  })
}
