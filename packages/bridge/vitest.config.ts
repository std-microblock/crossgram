import { defineConfig, type Plugin } from 'vitest/config'
import { existsSync } from 'node:fs'
import unyaml from '@cordisjs/unyaml/vite'

/**
 * Rewrite `.js` import specifiers to `.ts` for local files, so vitest resolves
 * the source (the package uses NodeNext-style `.js` specifiers).
 */
function jsToTsPlugin(): Plugin {
  return {
    name: 'js-to-ts',
    resolveId(source, importer) {
      if (!source.endsWith('.js') || !importer || !source.startsWith('.')) return null
      const dir = importer.slice(0, importer.lastIndexOf('/'))
      const tsPath = `${dir}/${source.slice(0, -3)}.ts`
      if (existsSync(tsPath)) return tsPath
      return null
    },
  }
}

export default defineConfig({
  plugins: [unyaml(), jsToTsPlugin()],
  test: {
    include: ['src/**/*.test.ts', 'client/**/*.test.ts', 'client/**/*.test.tsx'],
    testTimeout: 30000,
  },
})
