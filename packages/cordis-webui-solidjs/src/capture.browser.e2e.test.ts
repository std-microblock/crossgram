import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'
import { expectReconnectWithoutReload } from './browser-test-utils.js'
import type { MtprotoDebugEvent } from '../../mtproto/src/debug.js'
describe('Solid capture with the real MTProto capture backend', () => {
  it('keeps large payloads off sockets, lazily fetches details, groups RPC results, filters/pages, reconnects and cleans up on mobile navigation', async () => {
    // Load the real non-strict backend through Vitest without pulling its generated protocol project into the UI's strict TypeScript project.
    const debug = await vi.importActual<{
      apply(ctx: Context, config: { maxEvents: number }): void
      inject: string[]
    }>('../../mtproto-debug/src/index.ts')
    const ctx = new Context(),
      disposeMtproto = ctx.provide('mtproto', {} as never)
    const emitDebug = (event: MtprotoDebugEvent) =>
      (ctx.emit as Function)('mtproto/debug', event)
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(SolidWebUI),
      ctx.plugin(debug, { maxEvents: 1000 }),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as SolidWebUI
      await vi.waitFor(() => expect(Object.keys(ui.entries)).toHaveLength(1))
      for (let index = 0; index < 250; index++)
        emitDebug({
          direction: 'client->server',
          phase: 'message',
          connectionId: 'mobile',
          timestamp: Date.now(),
          payload: {
            _: 'test.call' + index,
            private: 'ON_DEMAND_ONLY_' + index + 'x'.repeat(32_000),
          },
        })
      const at = Date.now()
      emitDebug({
        direction: 'client->server',
        phase: 'message',
        connectionId: 'rpc',
        timestamp: at,
        messageId: 'req-1' as never,
        payload: { _: 'messages.getHistory', peer: { _: 'inputPeerSelf' } },
      })
      emitDebug({
        direction: 'server->client',
        phase: 'message',
        connectionId: 'rpc',
        timestamp: at + 1200,
        payload: {
          _: 'rpc_result',
          reqMsgId: 'req-1',
          result: {
            _: 'mt_rpc_error',
            errorCode: 400,
            errorMessage: 'EXAMPLE_ERROR',
          },
        },
      })
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      })
      const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        }),
        errors: string[] = [],
        requests: string[] = [],
        frames: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        if (request.url().includes('/api/mtproto-debug/events?'))
          requests.push(request.url())
      })
      page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) =>
          frames.push(String(frame.payload)),
        ),
      )
      await page.goto(ctx.server.baseUrl)
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(requests).toEqual([])
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await page
        .locator('.navigation')
        .getByRole('button', { name: 'MTProto capture', exact: true })
        .click()
      await page.locator('.capture-row').first().waitFor()
      expect(
        requests.every(
          (url) => new URL(url).searchParams.get('summary') === 'true',
        ),
      ).toBe(true)
      expect(await page.locator('.capture-row').count()).toBeLessThanOrEqual(
        100,
      )
      await page
        .locator('.capture-row-header')
        .filter({ hasText: 'messages.getHistory' })
        .click()
      await page.locator('.json-toggle').filter({ hasText: 'result' }).click()
      await page.getByText('EXAMPLE_ERROR', { exact: false }).waitFor()
      expect(await page.locator('.rpc-error').count()).toBe(1)
      await page.waitForTimeout(1100)
      expect(
        await page.getByText('EXAMPLE_ERROR', { exact: false }).isVisible(),
      ).toBe(true)
      await page.evaluate(() => {
        ;(document.activeElement as HTMLElement)?.blur()
        window.scrollTo(0, 0)
        document.querySelector('.capture-list')!.scrollTop = 0
      })
      if (process.env.WEBUI_SCREENSHOTS) {
        await mkdir(process.env.WEBUI_SCREENSHOTS, { recursive: true })
        await page.screenshot({
          path: join(process.env.WEBUI_SCREENSHOTS, 'solid-capture-mobile.png'),
          fullPage: true,
          animations: 'disabled',
        })
      }
      expect(requests.some((url) => new URL(url).searchParams.has('id'))).toBe(
        true,
      )
      await page.getByRole('button', { name: 'Load older events' }).click()
      await page.locator('.capture-row-header').first().click()
      await page
        .getByText(/ON_DEMAND_ONLY_/)
        .first()
        .waitFor()
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      await page.getByLabel('Search captured events').fill('test.call15')
      await expect
        .poll(() => page.locator('.capture-row-title strong').allTextContents())
        .toEqual(expect.arrayContaining(['test.call15']))
      await page.getByLabel('Search captured events').fill('')
      await page.getByRole('button', { name: 'Show latest events' }).click()
      await page
        .getByRole('button', { name: 'Pause capture', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Start capture', exact: true })
        .waitFor()
      await expectReconnectWithoutReload(page, ui)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await page
        .getByRole('button', { name: 'Clear capture', exact: true })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Clear capture', exact: true })
        .click()
      await page.getByRole('heading', { name: 'No matching events' }).waitFor()
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await page
        .locator('.navigation')
        .getByRole('button', { name: 'Overview', exact: true })
        .click()
      const count = requests.length
      await page.waitForTimeout(1300)
      expect(requests).toHaveLength(count)
      expect(Object.values(ui.clients)[0].subscriptions.size).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      disposeMtproto()
    }
  }, 60_000)
})
