import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

export default defineConfig({
  plugins: [unyaml()],
  test: {
    include: ['packages/**/*.e2e.test.{ts,tsx}'],
    pool: 'threads',
    testTimeout: 30_000,
  },
})
