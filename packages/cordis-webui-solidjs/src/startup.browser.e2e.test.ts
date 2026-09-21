import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
const root = fileURLToPath(new URL('../../../', import.meta.url))
describe('actual Cordis CLI startup', () => {
  it('loads the new service by package name and discovers separately built client manifests without Vue', async () => {
    const work = join(root, 'work/solid-webui-tests')
    await mkdir(work, { recursive: true })
    const directory = await mkdtemp(join(work, 'startup-')),
      marker = join(directory, 'ready.json'),
      config = join(directory, 'app.yml')
    const fixture = join(directory, 'fixture.mjs')
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'solid-startup-fixture',
        type: 'module',
        dependencies: {},
      }),
      'utf8',
    )
    await writeFile(
      fixture,
      "import { writeFile } from 'node:fs/promises'; export const inject=['server','webui']; export async function apply(ctx){const entry=ctx.webui.addEntry({baseUrl:" +
        JSON.stringify(
          pathToFileURL(join(root, 'packages/bridge/src/index.ts')).href,
        ) +
        ",manifest:'../dist/manifest.json',routes:['/platform-accounts','/sticker-packs','/bots']},{accounts:[],serverConfig:{name:'CrossGram',host:'example.test',port:4430,dcs:[],rsa_key:'PUBLIC'},stickerAccounts:[],stickerPacks:[],bots:[],refresh:async()=>{}}); await entry.ready; await writeFile(" +
        JSON.stringify(marker) +
        ',JSON.stringify({baseUrl:ctx.server.baseUrl,buildId:ctx.webui.buildId,module:entry.toJSON()}));}',
      'utf8',
    )
    await writeFile(
      config,
      "- name: '@cordisjs/plugin-timer'\n- name: '@cordisjs/plugin-server'\n  config:\n    host: 127.0.0.1\n    port: 0\n- name: 'cordis-webui-solidjs'\n  config:\n    uiPath: /console\n- name: '@cordisjs/plugin-loader-webui'\n- name: 'cordis-webui-solidjs/server'\n- name: '" +
        pathToFileURL(fixture).href +
        "'\n",
      'utf8',
    )
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--import',
        '@cordisjs/unyaml',
        join(root, 'node_modules/cordis/bin.js'),
        'run',
        '--no-daemon',
        pathToFileURL(config).href,
      ],
      {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, NODE_ENV: 'production' },
        // Cordis' worker enables its IPC lifecycle from config even in --no-daemon mode.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    )
    let output = '',
      browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    child.stdout!.on('data', (value) => {
      output = (output + value).slice(-20_000)
    })
    child.stderr!.on('data', (value) => {
      output = (output + value).slice(-20_000)
    })
    try {
      let info: any
      await vi.waitFor(
        async () => {
          if (child.exitCode !== null) throw Error('CLI exited: ' + output)
          try {
            info = JSON.parse(await readFile(marker, 'utf8'))
          } catch {
            throw Error('Waiting for CLI startup: ' + output)
          }
        },
        { timeout: 15_000 },
      )
      expect(info.buildId).toMatch(/^[a-f0-9]{16}$/)
      expect(info.module.module).toBe('@mtproto-relay/bridge')
      expect(
        info.module.files.some((file: string) => file.includes('/-/modules/')),
      ).toBe(true)
      expect(info.module.pages.map((page: any) => page.path)).toEqual([
        '/platform-accounts',
        '/sticker-packs',
        '/bots',
      ])
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = [],
        urls: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => urls.push(request.url()))
      await page.goto(info.baseUrl + '/console/platform-accounts')
      await page
        .getByRole('heading', { name: 'No platform accounts yet' })
        .waitFor()
      expect(urls.some((url) => url.includes('/-/modules/'))).toBe(true)
      expect(await page.evaluate(() => '__VUE__' in window)).toBe(false)
      expect(errors).toEqual([])
      expect(output).not.toMatch(
        /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|Cannot find package|failed to load/i,
      )
    } finally {
      await browser?.close()
      if (child.exitCode === null) {
        const closed = once(child, 'close')
        child.kill('SIGTERM')
        await closed
      }
      if (
        !resolve(directory).startsWith(
          resolve(work) + (process.platform === 'win32' ? '\\' : '/'),
        )
      )
        throw Error('Unsafe cleanup')
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)
})
