import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

export default defineConfig({
  plugins: [unyaml()],
  test: {
    include: ['packages/mtproto/src/session/*e2e.test.ts'],
    pool: 'threads',
    testTimeout: 30_000,
  },
})
