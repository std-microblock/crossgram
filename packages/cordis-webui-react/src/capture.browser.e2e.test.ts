import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { chromium } from 'playwright'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import ReactWebUI from './index.js'
import {
  expectReconnectWithoutReload,
  waitForConnection,
  openPage,
  clickNav,
} from './browser-test-utils.js'
import type { MtprotoDebugEvent } from '../../mtproto/src/debug.js'
describe('React capture with the real MTProto capture backend', () => {
  it('keeps large payloads off sockets, lazily fetches details, groups RPC results, saves/lists/downloads/deletes recordings, filters/pages, reconnects and cleans up on mobile navigation', async () => {
    const recordingsPath = await mkdtemp(
      join(tmpdir(), 'crossgram-mtproto-recordings-'),
    )
    // Load the real non-strict backend through Vitest without pulling its generated protocol project into the UI's strict TypeScript project.
    const debug = await vi.importActual<{
      apply(
        ctx: Context,
        config: { maxEvents: number, recordingsPath?: string },
      ): void
      inject: string[]
    }>('../../mtproto-debug/src/index.ts')
    const ctx = new Context(),
      disposeMtproto = ctx.provide('mtproto', {} as never)
    const emitDebug = (event: MtprotoDebugEvent) =>
      (ctx.emit as Function)('mtproto/debug', event)
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(ReactWebUI),
      ctx.plugin(debug, { maxEvents: 1000, recordingsPath }),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() =>
        expect(fibers.every((fiber) => fiber.state === 2)).toBe(true),
      )
      const ui = ctx.get('webui') as unknown as ReactWebUI
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
      await waitForConnection(page)
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'])
      expect(requests).toEqual([])
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      await openPage(page, 'MTProto capture')
      await page.locator('.capture-row').first().waitFor()
      expect(
        await page
          .locator('.capture-direction')
          .first()
          .evaluate((element) => getComputedStyle(element).width),
      ).toBe('22px')
      expect(
        requests.every(
          (url) => new URL(url).searchParams.get('summary') === 'true',
        ),
      ).toBe(true)
      expect(await page.locator('.capture-row').count()).toBeLessThanOrEqual(
        100,
      )
      // Saving writes a full recording file server-side, off the WebSocket.
      await page
        .getByRole('button', { name: 'Save recording', exact: true })
        .click()
      const saveDialog = page.getByRole('dialog', { name: 'Save recording' })
      await saveDialog.waitFor()
      await saveDialog.getByLabel('Recording label').fill('e2e-recording')
      await saveDialog.getByRole('button', { name: 'Save', exact: true }).click()
      await page.getByText(/^Saved recording mtproto-/).waitFor()
      const savedId = (
        await page.locator('.capture-flash').textContent()
      )!.replace('Saved recording ', '')
      const recordingFiles = (await readdir(recordingsPath)).filter(
        (name) => name.endsWith('.json') && !name.endsWith('.meta.json'),
      )
      expect(recordingFiles).toEqual([savedId + '.json'])
      const recording = JSON.parse(
        await readFile(join(recordingsPath, savedId + '.json'), 'utf8'),
      )
      expect(recording.format).toBe('crossgram.mtproto-capture')
      expect(recording.version).toBe(1)
      expect(recording.events).toHaveLength(252)
      expect(
        recording.events.some((event: { payload?: unknown }) =>
          JSON.stringify(event.payload ?? '').includes('ON_DEMAND_ONLY_'),
        ),
      ).toBe(true)
      const meta = JSON.parse(
        await readFile(join(recordingsPath, savedId + '.meta.json'), 'utf8'),
      )
      expect(meta).toMatchObject({
        id: savedId,
        label: 'e2e-recording',
        eventCount: recording.events.length,
      })
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      // The recordings dialog lists, downloads and deletes the saved capture.
      await page
        .getByRole('button', { name: 'Recordings', exact: true })
        .click()
      const recordingsDialog = page.getByRole('dialog', {
        name: 'Saved recordings',
      })
      await recordingsDialog.waitFor()
      const row = recordingsDialog.locator('.recording-row')
      await row.waitFor()
      expect(await row.locator('.recording-label').textContent()).toBe(
        'e2e-recording',
      )
      expect(await row.locator('.recording-meta').textContent()).toContain(
        recording.events.length + ' events',
      )
      const downloadPromise = page.waitForEvent('download')
      await row.locator('.recording-download').click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(savedId + '.json')
      const downloaded = JSON.parse(
        await readFile((await download.path())!, 'utf8'),
      )
      expect(downloaded.format).toBe(recording.format)
      expect(downloaded.events).toHaveLength(recording.events.length)
      await row.getByRole('button', { name: 'Delete', exact: true }).click()
      const confirm = page.getByRole('dialog', {
        name: 'Delete this recording?',
      })
      await confirm.waitFor()
      await confirm
        .getByRole('button', { name: 'Delete', exact: true })
        .click()
      await expect
        .poll(() => recordingsDialog.locator('.recording-row').count())
        .toBe(0)
      await expect
        .poll(async () =>
          (await readdir(recordingsPath)).filter((name) =>
            name.endsWith('.json'),
          ),
        )
        .toEqual([])
      await recordingsDialog
        .getByRole('button', { name: 'Close dialog' })
        .click()
      // Right-click opens the DevTools-style context menu; filters live in it.
      await page.locator('.capture-row').first().click({ button: 'right' })
      await page.getByRole('menu', { name: 'Event actions' }).waitFor()
      await page.getByRole('menuitem', { name: 'Copy method name' }).click()
      await page.getByText('Copied method name').waitFor()
      await page.locator('.capture-row').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Filter this connection' }).click()
      await expect
        .poll(() => page.locator('.filter-chip').allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining('Conn:')]))
      await page.getByRole('button', { name: /^Filters/ }).click()
      await page.getByRole('button', { name: 'Clear all filters' }).click()
      await expect
        .poll(() => page.locator('.filter-chip').count())
        .toBe(0)
      await page.locator('.capture-row').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Copy method name' }).click()
      await page.getByText('Copied method name').waitFor()
      await page.getByRole('button', { name: 'Close details' }).click()
      await page
        .locator('.capture-row-header')
        .filter({ hasText: 'messages.getHistory' })
        .click()
      await page.getByRole('tab', { name: 'Result', exact: true }).click()
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
      // The shell owns scrolling: navigating to another page starts at the top.
      await page.evaluate(() => window.scrollTo(0, 1500))
      await clickNav(page, 'Overview')
      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      await clickNav(page, 'MTProto capture')
      await page.locator('.capture-row').first().waitFor()
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
      // The list pages itself: scrolling to the end requests older events.
      const initialRows = await page.locator('.capture-row').count()
      await page.locator('.capture-list').evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect
        .poll(() => page.locator('.capture-row').count())
        .toBeGreaterThan(initialRows)
      await page.locator('.capture-row-header').last().click()
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
      // Nothing is buffered anymore, so saving a recording is disabled.
      expect(
        await page
          .getByRole('button', { name: 'Save recording', exact: true })
          .isDisabled(),
      ).toBe(true)
      await clickNav(page, 'Overview')
      const count = requests.length
      await page.waitForTimeout(1300)
      expect(requests).toHaveLength(count)
      expect(Object.values(ui.clients)[0].subscriptions.size).toBe(0)
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await fiber.dispose()
      disposeMtproto()
      await rm(recordingsPath, { recursive: true, force: true })
    }
  }, 60_000)
})
