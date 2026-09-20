import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'
import unyaml from '@cordisjs/unyaml/vite'
import { jsToTsPlugin } from './vitest.plugins.mts'
export default defineConfig({
  test: { maxWorkers: 2, projects: [
    { plugins: [unyaml(), jsToTsPlugin()], test: { name: 'server', environment: 'node', include: ['packages/cordis-webui-solidjs/src/**/*.test.ts'], testTimeout: 30_000 } },
    { plugins: [solid({ hot: false }), jsToTsPlugin()], test: { name: 'client', environment: 'happy-dom', include: ['packages/cordis-webui-solidjs/client/**/*.test.{ts,tsx}'], testTimeout: 30_000 } },
  ] },
})
