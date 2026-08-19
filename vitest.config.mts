import { configDefaults, defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'
import { jsToTsPlugin } from './vitest.plugins.mts'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [unyaml(), jsToTsPlugin()],
  test: {
    include: ['packages/**/*.test.ts', 'deploy/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'packages/**/*e2e.test.ts'],
    pool: 'threads',
    testTimeout: 30_000,
  },
})
