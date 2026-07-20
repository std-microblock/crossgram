import { existsSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vitest/config'

function jsToTsPlugin(): Plugin {
  return {
    name: 'js-to-ts',
    resolveId(source, importer) {
      if (!source.endsWith('.js') || !importer || !source.startsWith('.')) return null
      const directory = importer.slice(0, importer.lastIndexOf('/'))
      const path = `${directory}/${source.slice(0, -3)}.ts`
      return existsSync(path) ? path : null
    },
  }
}

export default defineConfig({
  plugins: [jsToTsPlugin()],
  test: { include: ['src/**/*.test.ts'] },
})
