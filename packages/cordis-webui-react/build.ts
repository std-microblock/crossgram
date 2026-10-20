import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { publicAssets } from './build-assets.js'
import { resolve } from 'node:path'
import { sharedModules } from './src/imports.js'

export interface ClientBuildOptions {
  root: string
  entry?: string
  outDir?: string
  sourcemap?: boolean
}
/**
 * Build an independently installed React extension against the shell's shared
 * runtime. The build is pinned to production so the JSX transform targets
 * `react/jsx-runtime` even when the caller (for example a test runner) exports
 * a development or test `NODE_ENV`.
 */
export async function buildClient(options: ClientBuildOptions) {
  // Plugin React decides between the JSX and the dev-JSX runtime while it runs;
  // a caller such as a test runner may export NODE_ENV=test, so pin the whole
  // build to production and restore the caller's value afterwards.
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    return await build({
      configFile: false,
      root: options.root,
      base: './',
      mode: 'production',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [react(), publicAssets()],
      esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
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
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
}
