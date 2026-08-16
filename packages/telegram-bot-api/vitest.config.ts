import { defineConfig, type Plugin } from 'vitest/config'
import { existsSync } from 'node:fs'
import unyaml from '@cordisjs/unyaml/vite'

function jsToTsPlugin(): Plugin {
  return {
    name: 'js-to-ts',
    resolveId(source, importer) {
      if (!source.endsWith('.js') || !importer || !source.startsWith('.')) return null
      const directory = importer.slice(0, importer.lastIndexOf('/'))
      const tsPath = `${directory}/${source.slice(0, -3)}.ts`
      return existsSync(tsPath) ? tsPath : null
    },
  }
}

export default defineConfig({
  plugins: [unyaml(), jsToTsPlugin()],
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
