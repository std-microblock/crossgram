import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'
import { jsToTsPlugin } from './vitest.plugins.mts'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [unyaml(), jsToTsPlugin()],
  test: {
    include: ['packages/**/*.e2e.test.{ts,tsx}', 'packages/**/e2e.test.{ts,tsx}'],
    pool: 'threads',
    testTimeout: 30_000,
  },
})
