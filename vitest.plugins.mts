import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vitest/config'

const jsToTsPackageDirectories = ['bridge', 'mtproto', 'platform-admin-bot', 'platform-discord'].map((name) =>
  join(import.meta.dirname, 'packages', name),
)

export function jsToTsPlugin(): Plugin {
  return {
    name: 'js-to-ts',
    resolveId(source, importer) {
      if (
        !source.endsWith('.js') ||
        !importer ||
        !source.startsWith('.') ||
        !jsToTsPackageDirectories.some((directory) => importer.startsWith(`${directory}/`))
      ) {
        return null
      }

      const tsPath = join(dirname(importer), `${source.slice(0, -3)}.ts`)
      return existsSync(tsPath) ? tsPath : null
    },
  }
}
