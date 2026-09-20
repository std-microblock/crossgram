import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import Timer from '@cordisjs/plugin-timer'
import Http from '@cordisjs/plugin-http'
import Database from '@cordisjs/plugin-database'
import SQLite from '@cordisjs/plugin-database-sqlite'
import * as DatabaseUI from '@cordisjs/plugin-database-webui'
import * as LoggerUI from '@cordisjs/plugin-logger-webui'
import * as ServerUI from './server-monitor.js'
import * as HttpUI from '@cordisjs/plugin-http-webui'
import * as Insight from '@cordisjs/plugin-insight'
import Notifier from '@cordisjs/plugin-notifier'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'

const root = new URL('../../../', import.meta.url)
describe('Solid administration pages against Cordis backends', () => {
  it('edits real SQLite data, browses logs, calls notifications, inspects server and HTTP traffic, and explores services on mobile', async () => {
    const workRoot = fileURLToPath(new URL('work/solid-webui-tests/', root))
    await mkdir(workRoot, { recursive: true })
    const directory = await mkdtemp(join(workRoot, 'admin-'))
    const ctx = new Context()
    ctx.baseUrl = root.href
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SolidWebUI),
      ctx.plugin(Timer),
      ctx.plugin(Http),
      ctx.plugin(Database),
      ctx.plugin(SQLite, { path: ':memory:' }),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
      disposeProxy: (() => void) | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI
      ;(ctx.database as any).extend(
        'ui_records',
        { id: 'unsigned', name: 'string', enabled: 'boolean', details: 'json' },
        { primary: 'id' },
      )
      for (let id = 1; id <= 65; id++)
        await (ctx.database as any).create('ui_records', {
          id,
          name: 'Record ' + id,
          enabled: true,
          details: { id },
        })
      ctx.server.get('/health', async () => Response.json({ healthy: true }))
      ctx.server.all('/proxy/{*target}', async (req) =>
        Response.json({
          method: req.method,
          body: await req.text(),
          destination: req.path.slice('/proxy/'.length),
        }),
      )
      ctx.server.ws('/proxy/{*target}', async (_req, accept) => {
        const socket = await accept()
        socket.on('message', (data) => socket.send(data.toString()))
      })
      disposeProxy = ctx.provide('server.proxy', {
        baseUrl: ctx.server.baseUrl + '/proxy',
      } as never)
      fibers.push(
        ctx.plugin(DatabaseUI, { pageSize: 50 }),
        ctx.plugin(LoggerUI, {
          path: pathToFileURL(join(directory, 'logs.db')).href,
          bufferSize: 1000,
          maxAge: 30,
        }),
        ctx.plugin(ServerUI, { requestLimit: 30 }),
        ctx.plugin(HttpUI, { historyLimit: 5 }),
        ctx.plugin(Insight),
        ctx.plugin(Notifier, {}),
      )
      await Promise.all(fibers)
      await vi.waitFor(() => expect(Object.keys(ui.entries)).toHaveLength(6))
      const { h } = await import(
        pathToFileURL(
          createRequire(
            import.meta.resolve('@cordisjs/plugin-notifier'),
          ).resolve('@cordisjs/element'),
        ).href
      )
      let notificationCalls = 0
      const notification = ctx.notifier.create({
        type: 'warning',
        content: [
          h('p', 'An example service needs attention.'),
          h(
            'button',
            {
              onClick: () => {
                notificationCalls++
                notification.update('Service recovered')
              },
            },
            'Retry service',
          ),
        ],
      })
      for (let index = 0; index < 160; index++)
        ctx.logger('fixture').info('sample log %s', index)
      await new Promise((resolve) => setTimeout(resolve, 150))
      await ctx.http.get(ctx.server.baseUrl + '/health')
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = [],
        requests: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => requests.push(request.url()))
      await page.goto(ctx.server.baseUrl)
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(
        requests.some((url) =>
          /assets\/(database|logs|http|server|insight|notifications)-/.test(
            url,
          ),
        ),
      ).toBe(false)
      const navigate = async (title: string) => {
        await page.getByRole('button', { name: 'Open navigation' }).click()
        await page
          .locator('.navigation')
          .getByRole('button', { name: title, exact: true })
          .click()
      }
      await navigate('Database')
      await page
        .getByRole('button', { name: 'Edit name in row 1', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByLabel('Value (string)')
        .fill('Updated through Solid')
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Save cell' })
        .click()
      await vi.waitFor(async () =>
        expect(
          (await (ctx.database as any).get('ui_records', { id: 1 }))[0].name,
        ).toBe('Updated through Solid'),
      )
      await page.getByRole('button', { name: 'Next page' }).click()
      await page
        .getByRole('button', { name: 'Edit name in row 51', exact: true })
        .waitFor()
      expect(
        await page
          .locator('tbody tr')
          .first()
          .locator('td')
          .first()
          .textContent(),
      ).toBe('51')
      await navigate('Logs')
      await page.getByLabel('Search loaded logs').fill('sample log')
      await page
        .getByText(/sample log 159/)
        .first()
        .waitFor()
      expect(await page.locator('.log-record').count()).toBeLessThanOrEqual(100)
      await page.getByRole('button', { name: 'Pause live' }).click()
      ctx.logger('fixture').info('sample log NEW_PAUSED')
      await page.waitForTimeout(150)
      expect(await page.getByText(/NEW_PAUSED/).count()).toBe(0)
      await page.getByRole('button', { name: 'Resume live' }).click()
      await page
        .getByText(/NEW_PAUSED/)
        .first()
        .waitFor()
      await page
        .getByRole('button', { name: 'Older logs', exact: true })
        .click()
      await page.getByRole('button', { name: 'Newer logs' }).waitFor()
      await navigate('Notifications')
      await page.getByRole('button', { name: 'Retry service' }).click()
      await page.getByText('Service recovered', { exact: true }).waitFor()
      expect(notificationCalls).toBe(1)
      await navigate('Outbound traffic')
      await page
        .getByRole('button', {
          name: ctx.server.baseUrl + '/health',
          exact: true,
        })
        .waitFor()
      await page.getByRole('button', { name: 'Compose request' }).click()
      await page.getByLabel('Method', { exact: true }).selectOption('POST')
      await page.getByLabel('Request URL').fill('https://example.test/echo')
      await page.getByLabel('Body format').selectOption('json')
      await page
        .getByLabel('Request body', { exact: true })
        .fill('{"hello":"solid"}')
      await page.getByRole('button', { name: 'Send request' }).click()
      await expect
        .poll(() =>
          page.getByLabel('Response body', { exact: true }).textContent(),
        )
        .toContain('solid')
      await page.getByLabel('Method', { exact: true }).selectOption('WS')
      await page.getByLabel('Request URL').fill('wss://example.test/socket')
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      await page.getByText('open', { exact: true }).waitFor()
      await page.getByLabel('WebSocket message').fill('hello websocket')
      await page
        .getByRole('button', { name: 'Send message', exact: true })
        .click()
      await expect
        .poll(() => page.getByText('hello websocket', { exact: true }).count())
        .toBe(2)
      await page
        .getByRole('button', { name: 'Disconnect', exact: true })
        .click()
      await navigate('Server routes')
      await page.getByLabel('Filter routes').fill('/health')
      await page.getByRole('button', { name: '/health', exact: true }).waitFor()
      await page.getByRole('button', { name: 'View requests' }).click()
      await page.getByLabel('Filter requests').fill('/health')
      await page.request.get(ctx.server.baseUrl + '/health')
      await page
        .getByRole('button', { name: '/health', exact: true })
        .first()
        .waitFor()
      await navigate('Service map')
      await page
        .getByRole('img', {
          name: 'Selected plugin and its immediate relationships',
        })
        .waitFor()
      expect(await page.locator('.graph-node').count()).toBeLessThanOrEqual(41)
      for (const route of [
        'Database',
        'Logs',
        'Notifications',
        'Outbound traffic',
        'Server routes',
        'Service map',
      ]) {
        await navigate(route)
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          route,
        ).toBe(true)
      }
      const active = Object.values(ui.clients)[0]
      expect(active.subscriptions.size).toBe(1)
      expect(errors).toEqual([])
      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await navigate('Database')
        await page
          .getByRole('button', { name: 'Edit name in row 1', exact: true })
          .waitFor()
        await page.evaluate(() => {
          ;(document.activeElement as HTMLElement)?.blur()
          window.scrollTo(0, 0)
        })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-database-mobile.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-database-desktop.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
        await page
          .locator('.navigation')
          .getByRole('button', { name: 'Overview', exact: true })
          .click()
        await page.evaluate(() => {
          ;(document.activeElement as HTMLElement)?.blur()
          window.scrollTo(0, 0)
        })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-overview-desktop.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
      }
      notification.dispose()
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      disposeProxy?.()
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
