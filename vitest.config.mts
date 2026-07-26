import { configDefaults, defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

export default defineConfig({
  plugins: [unyaml()],
  test: {
    include: ['packages/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'packages/**/*e2e.test.ts'],
    pool: 'threads',
    testTimeout: 30_000,
  },
})
