import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'
describe('Solid statistics with the real collector and runtime sampler', () => {
  it('renders all five sections, bounds chart/table work, receives live samples and resets through RPC on desktop/mobile', async () => {
    const statistics = await vi.importActual<{
      apply(
        ctx: Context,
        config: { sampleIntervalMs: number; topMethods: number },
      ): void
      inject: string[]
    }>('../../mtproto-statistics/src/index.ts')
    const ctx = new Context(),
      disposeMtproto = ctx.provide('mtproto', {} as never)
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SolidWebUI),
      ctx.plugin(statistics, { sampleIntervalMs: 500, topMethods: 100 }),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI
      await vi.waitFor(() =>
        expect(
          Object.values(ui.entries).some(
            (entry) => entry.module === '@mtproto-relay/mtproto-statistics',
          ),
        ).toBe(true),
      )
      const entry = Object.values(ui.entries).find(
        (entry) => entry.module === '@mtproto-relay/mtproto-statistics',
      )!
      const connection = {
        id: 'stats-connection',
        remoteAddress: '127.0.0.2',
        clientInfo: {
          deviceModel: 'Test phone',
          systemVersion: 'Test OS',
          appVersion: '1.0.0',
          langPack: 'android',
          apiId: 12345,
        },
      }
      const scope = {
        mtprotoConnection: connection,
        clientInfo: connection.clientInfo,
        authKeyId: new Uint8Array([1, 2, 3, 4]),
      }
      ;(ctx.emit as Function)('mtproto/connection', connection, 'open')
      ;(ctx.emit as Function)('mtproto/traffic', {
        connection,
        direction: 'received',
        bytes: 4096,
        timestamp: Date.now(),
      })
      ;(ctx.emit as Function)('mtproto/traffic', {
        connection,
        direction: 'sent',
        bytes: 2048,
        timestamp: Date.now(),
      })
      const rpc = (request: unknown, response: unknown) =>
        (ctx.waterfall as Function)(
          scope,
          'mtproto/rpc',
          request,
          async () => response,
        )
      for (let id = 0; id < 65; id++)
        await rpc({ _: 'messages.test' + id }, { _: 'messages.messages' })
      await rpc(
        { _: 'test.missing' },
        {
          _: 'mt_rpc_error',
          errorCode: 400,
          errorMessage: 'METHOD_NOT_IMPLEMENTED: test.missing',
        },
      )
      const location = {
        _: 'inputDocumentFileLocation',
        id: '100',
        accessHash: '100',
        fileReference: new TextEncoder().encode('bridge-media:100'),
        thumbSize: '',
      }
      await rpc(
        { _: 'crossgram.getFileUrl', location },
        { _: 'dataJSON', data: '{"url":"https://cdn.example.test/file"}' },
      )
      await rpc(
        { _: 'upload.getFile', location, offset: 0, limit: 131072 },
        { _: 'upload.file', bytes: new Uint8Array(128) },
      )
      await vi.waitFor(() => expect(entry.data.snapshot.rpc.count).toBe(68), {
        timeout: 3000,
      })
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 1440, height: 1000 },
        }),
        errors: string[] = [],
        frames: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) =>
          frames.push(String(frame.payload)),
        ),
      )
      await page.goto(ctx.server.baseUrl)
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(frames.join('')).not.toContain('messages.test')
      await page
        .locator('.navigation')
        .getByRole('button', { name: 'MTProto statistics', exact: true })
        .click()
      await page
        .getByRole('heading', { name: 'Slowest RPC methods', exact: true })
        .waitFor()

      // The plugin stylesheet is hoisted into a shared chunk; verify it actually loaded.
      expect(
        await page
          .locator('.stat-spark')
          .first()
          .evaluate((element) => getComputedStyle(element).height),
      ).toBe('65px')
      await page.getByRole('tab', { name: 'RPC', exact: true }).click()
      const methods = page.getByLabel('RPC methods', { exact: true })
      await expect.poll(() => methods.locator('tbody tr').count()).toBe(25)
      await page
        .getByLabel('Search RPC methods', { exact: true })
        .fill('messages.test64')
      await expect.poll(() => methods.locator('tbody tr').count()).toBe(1)
      await page
        .getByRole('heading', { name: 'RPC failure reasons', exact: true })
        .waitFor()
      await page
        .getByRole('tab', { name: 'Network & IPs', exact: true })
        .click()
      await page.getByRole('cell', { name: '127.0.0.2', exact: true }).waitFor()
      await page.getByRole('tab', { name: 'File routes', exact: true }).click()
      await page
        .getByRole('cell', { name: 'Test phone', exact: true })
        .waitFor()
      expect(
        await page
          .locator('.stat-metric')
          .filter({ hasText: 'Direct-download rate' })
          .innerText(),
      ).toContain('50.00%')
      await page.getByRole('tab', { name: 'Runtime', exact: true }).click()
      await page.getByText('V8 contexts', { exact: true }).waitFor()
      await page
        .getByLabel('Chart interval', { exact: true })
        .selectOption('hours')
      await page
        .getByLabel('Chart interval', { exact: true })
        .selectOption('minutes')
      await page
        .getByLabel('Chart interval', { exact: true })
        .selectOption('seconds')
      await page.setViewportSize({ width: 390, height: 844 })
      for (const tab of [
        'Overview',
        'RPC',
        'Network & IPs',
        'File routes',
        'Runtime',
      ]) {
        await page.getByRole('tab', { name: tab, exact: true }).click()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          tab,
        ).toBe(true)
        const paths = await page
          .locator('.spark-line')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('d') ?? ''),
          )
        expect(
          paths.every((path) => (path.match(/[ML]/g) ?? []).length <= 120),
        ).toBe(true)
      }
      await page.getByRole('tab', { name: 'Overview', exact: true }).click()
      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-statistics-mobile.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.screenshot({
          path: join(
            process.env.WEBUI_SCREENSHOTS,
            'solid-statistics-desktop.png',
          ),
          fullPage: true,
          animations: 'disabled',
        })
      }
      await page
        .getByRole('button', { name: 'Reset statistics', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Reset statistics', exact: true })
        .click()
      await vi.waitFor(() => expect(entry.data.snapshot.rpc.count).toBe(0))
      expect(entry.data.snapshot.activeConnections).toBe(1)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      disposeMtproto()
    }
  }, 60_000)
})
