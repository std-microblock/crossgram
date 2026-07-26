import { defineConfig } from 'vitest/config'
import unyaml from '@cordisjs/unyaml/vite'

export default defineConfig({
  plugins: [unyaml()],
  test: {
    include: ['src/**/*.test.ts', 'client/**/*.test.ts'],
    testTimeout: 30_000,
  },
})
