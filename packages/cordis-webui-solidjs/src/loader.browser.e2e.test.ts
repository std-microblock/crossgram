import { Context } from 'cordis'
import { Loader } from '@cordisjs/plugin-loader'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'

const root = new URL('../../../', import.meta.url)
describe('real loader and Schemastery browser workflow', () => {
  it('lazy-loads management, validates and persists forms, retains drafts across state updates, and manages plugin lifecycle on a phone', async () => {
    const workRoot = fileURLToPath(new URL('work/solid-webui-tests/', root))
    await mkdir(workRoot, { recursive: true })
    const directory = await mkdtemp(join(workRoot, 'loader-'))
    const fixture = join(directory, 'fixture.mjs'), config = join(directory, 'app.yml')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'solid-loader-test', type: 'module', dependencies: {} }), 'utf8')
    await writeFile(fixture, 
      "import z from 'schemastery'; export const name='schema-fixture'; export const Config=z.object({host:z.string().required().description('Server address'),port:z.natural().min(1).max(65535).default(8080),secret:z.string().role('secret'),hidden:z.string().hidden(),enabled:z.boolean().default(true),tags:z.array(String),mode:z.union(['fast','safe'])}); export function apply() {}", 'utf8')
    await writeFile(config, 
      "- id: timer\n  name: '@cordisjs/plugin-timer'\n- id: server\n  name: '@cordisjs/plugin-server'\n  config:\n    host: 127.0.0.1\n    port: 0\n- id: loader-ui\n  name: '@cordisjs/plugin-loader-webui'\n- id: sample\n  name: '" + pathToFileURL(fixture).href + "'\n  label: Example bridge\n  disabled: true\n  config:\n    host: example.test\n    port: 8080\n    secret: keep-secret\n    hidden: keep-hidden\n    enabled: true\n    tags: []\n    mode: fast\n", 'utf8')
    const ctx = new Context(); ctx.baseUrl = root.href
    const loader = ctx.plugin(Loader), webui = ctx.plugin(SolidWebUI)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await loader
      await ctx.loader.create({ name: '@cordisjs/plugin-include', config: { path: pathToFileURL(config).href, enableLogs: false } })
      await vi.waitFor(() => expect(Object.values((ctx.get('webui') as unknown as SolidWebUI)?.entries ?? {}).some(entry => entry.module === 'loader')).toBe(true), { timeout: 10_000 })
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const requests: string[] = [], errors: string[] = []
      page.on('request', request => requests.push(request.url()))
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(ctx.server.baseUrl)
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(requests.some(url => /assets\/loader-/.test(url))).toBe(false)
      await page.getByRole('button', { name: 'Manage plugins' }).click()
      await page.getByRole('button', { name: 'Example bridge Disabled' }).click()
      const host = page.getByLabel('Host', { exact: false })
      await host.fill('new.example.test')
      await page.getByLabel('Port', { exact: true }).fill('70000')
      await page.getByText('Maximum is 65535', { exact: true }).first().waitFor()
      expect(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled()).toBe(true)
      await page.getByLabel('Port', { exact: true }).fill('5443')
      expect(await page.getByLabel('Secret', { exact: true }).getAttribute('type')).toBe('password')
      expect(await page.getByLabel('Hidden', { exact: true }).count()).toBe(0)
      // An unrelated backend tree refresh must not remount the editor or erase input.
      const entry = Object.values((ctx.get('webui') as unknown as SolidWebUI).entries).find(entry => entry.module === 'loader')!
      entry.mutate((data: any) => { data.entries = data.entries.map((item: any) => ({ ...item })) })
      await page.waitForTimeout(100)
      expect(await host.inputValue()).toBe('new.example.test')
      await page.getByRole('button', { name: 'Save changes', exact: true }).click()
      await page.getByText('Configuration saved', { exact: true }).waitFor()
      await vi.waitFor(async () => { const saved = await readFile(config, 'utf8'); expect(saved).toContain('new.example.test'); expect(saved).toContain('5443'); expect(saved).toContain('keep-hidden'); expect(saved).toContain('keep-secret') })
      expect(requests.some(url => /assets\/loader-/.test(url))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Enable plugin', exact: true }).click()
      await page.getByRole('button', { name: 'Disable plugin', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Remove plugin', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
      expect(await page.getByRole('button', { name: 'Remove plugin', exact: true }).count()).toBe(1)
      await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
      await page.getByRole('dialog').getByLabel('Installed plugin package').fill(pathToFileURL(fixture).href)
      await page.getByRole('dialog').getByLabel('Display name (optional)').fill('Temporary plugin')
      await page.getByRole('dialog').getByRole('button', { name: 'Create plugin' }).click()
      await page.getByRole('heading', { name: 'Temporary plugin', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Remove plugin', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Remove plugin', exact: true }).click()
      await page.getByRole('heading', { name: 'Everything in its right place' }).waitFor()
      await vi.waitFor(async () => expect(await readFile(config, 'utf8')).not.toContain('Temporary plugin'))
      await page.getByRole('button', { name: 'Example bridge Running' }).click()
      expect(errors).toEqual([])
      await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0) })
      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await page.screenshot({ path: join(process.env.WEBUI_SCREENSHOTS, 'solid-plugins-mobile.png'), fullPage: true })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: join(process.env.WEBUI_SCREENSHOTS, 'solid-plugins-desktop.png'), fullPage: true })
      }
    } finally {
      await browser?.close(); await webui.dispose(); await loader.dispose()
      if (!resolve(directory).startsWith(resolve(workRoot) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Unsafe test cleanup')
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
