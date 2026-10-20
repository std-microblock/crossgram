import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import unyaml from '@cordisjs/unyaml/vite'
import { jsToTsPlugin } from './vitest.plugins.mts'
export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [
      {
        plugins: [unyaml(), jsToTsPlugin()],
        test: {
          name: 'server',
          environment: 'node',
          include: ['packages/cordis-webui-react/src/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'client',
          environment: 'happy-dom',
          include: [
            'packages/cordis-webui-react/client/**/*.test.{ts,tsx}',
            'packages/bridge/client/**/*.test.{ts,tsx}',
            'packages/history-backfill/client/**/*.test.{ts,tsx}',
            'packages/mtproto-debug/client/**/*.test.{ts,tsx}',
            'packages/mtproto-statistics/client/**/*.test.{ts,tsx}',
          ],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
