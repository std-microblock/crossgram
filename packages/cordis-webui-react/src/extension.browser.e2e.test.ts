import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { waitForConnection } from './browser-test-utils.js'
import ReactWebUI from './index.js'
import { buildClient } from '../build.js'

const workRoot = fileURLToPath(
  new URL('../../../work/react-webui-tests/', import.meta.url),
)
describe('independently built React extensions', () => {
  it('shares one React context via import maps, lazily loads CSS/code, receives Muon state and disposes with its backend', async () => {
    await mkdir(workRoot, { recursive: true })
    const directory = await mkdtemp(join(workRoot, 'extension-'))
    await mkdir(join(directory, 'client'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'test-react-extension', type: 'module' }),
      'utf8',
    )
    await writeFile(
      join(directory, 'client/style.css'),
      '.extension-card { border: 3px solid rgb(50, 100, 75); padding: 20px; }',
      'utf8',
    )
    await writeFile(
      join(directory, 'client/index.tsx'),
      "import { useState } from 'react'; import { useRpc } from 'cordis-webui-react/client'; import { PageHeader } from 'cordis-webui-react/components'; import './style.css'; function Page(props) { const rpc=useRpc(props.entryId); const [local,setLocal]=useState(0); return <section className='extension-card'><PageHeader title='Independent React extension' />{rpc.ready ? (<><output aria-label='Server count'>{rpc.data.count}</output><button onClick={() => rpc.data.increment()}>Increment server</button><button onClick={() => setLocal(local+1)}>Local signal {local}</button></>) : null}</section> } export default {pages:[{path:'/extension',title:'Test extension',icon:'◇',component:Page}]}",
      'utf8',
    )
    await buildClient({ root: directory })
    const manifest = JSON.parse(
      await readFile(join(directory, 'dist/manifest.json'), 'utf8'),
    )
    const main = Object.values(manifest).find(
      (chunk: any) => chunk.isEntry,
    ) as any
    const source = await readFile(join(directory, 'dist', main.file), 'utf8')
    expect(source).toContain('react')
    expect(source).toContain('cordis-webui-react/client')
    const ctx = new Context(),
      server = ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      webui = ctx.plugin(ReactWebUI)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
      plugin: ReturnType<Context['plugin']> | undefined
    try {
      await Promise.all([server, webui])
      await vi.waitFor(() => expect(webui.state).toBe(2))
      const ui = ctx.get('webui') as unknown as ReactWebUI
      plugin = ctx.plugin({
        name: 'test-react-entry',
        inject: ['webui'],
        apply(ctx: Context) {
          const entry = (
            ctx.get('webui') as unknown as ReactWebUI
          ).addEntry<any>(
            {
              baseUrl: pathToFileURL(join(directory, 'index.mjs')).href,
              client: 'test-react-extension',
              manifest: './dist/manifest.json',
              routes: ['/extension'],
            },
            {
              count: 0,
              increment() {
                entry.mutate((data: any) => {
                  data.count++
                })
              },
            },
          )
        },
      })
      await plugin
      await vi.waitFor(() => expect(Object.keys(ui.entries)).toHaveLength(1))
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage()
      const errors: string[] = [],
        requests: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => requests.push(request.url()))
      await page.goto(ctx.server.baseUrl)
      await waitForConnection(page)
      expect(requests.some((url) => url.includes('/-/modules/'))).toBe(false)
      await page
        .getByRole('button', { name: 'extension', exact: false })
        .first()
        .click()
      await page
        .getByRole('heading', { name: 'Independent React extension' })
        .waitFor()
      await page.getByRole('button', { name: 'Increment server' }).click()
      await expect
        .poll(() => page.getByLabel('Server count').textContent())
        .toBe('1')
      await page.getByRole('button', { name: 'Local signal 0' }).click()
      await page.getByRole('button', { name: 'Local signal 1' }).waitFor()
      await expect
        .poll(() =>
          page
            .locator('.extension-card')
            .evaluate((element) => getComputedStyle(element).borderTopWidth),
        )
        .toBe('3px')
      expect(requests.some((url) => url.includes('/-/modules/'))).toBe(true)
      await plugin.dispose()
      await page.getByRole('heading', { name: 'Page not available' }).waitFor()
      expect(
        Object.values(ui.clients).every(
          (client) => client.subscriptions.size === 0,
        ),
      ).toBe(true)
      expect(await page.locator('link[href*="/-/modules/"]').count()).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      await plugin?.dispose()
      await webui.dispose()
      await server.dispose()
      if (
        !resolve(directory).startsWith(
          resolve(workRoot) + (process.platform === 'win32' ? '\\' : '/'),
        )
      )
        throw new Error('Unsafe test cleanup')
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
