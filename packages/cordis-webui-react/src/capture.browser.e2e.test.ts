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
  it('tails the capture, saves/lists/downloads/deletes logs, filters, pages, inspects RPC results, reconnects and cleans up on mobile navigation', async () => {
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
      ).toBe('16px')
      expect(
        requests.every(
          (url) => new URL(url).searchParams.get('summary') === 'true',
        ),
      ).toBe(true)
      expect(await page.locator('.capture-row').count()).toBeLessThanOrEqual(
        100,
      )
      // The list tails the buffer: the newest event is the last row and the
      // list is already scrolled to the bottom without any user action.
      await expect
        .poll(() =>
          page.locator('.capture-row-header strong').last().textContent(),
        )
        .toBe('messages.getHistory')
      expect(
        await page.locator('.capture-list').evaluate((element) => ({
          atBottom:
            element.scrollHeight - element.scrollTop - element.clientHeight <=
            24,
          scrollable: element.scrollHeight > element.clientHeight,
        })),
      ).toEqual({ atBottom: true, scrollable: true })

      // A log can be downloaded without saving it on the server.
      await page
        .getByRole('button', { name: 'Save log', exact: true })
        .click()
      const saveDialog = page.getByRole('dialog', { name: 'Save log' })
      await saveDialog.waitFor()
      await saveDialog.getByLabel('Log name').fill('e2e-log')
      await expect
        .poll(() => saveDialog.locator('.capture-facts dd').first().textContent())
        .toBe('252')
      const unsavedDownload = page.waitForEvent('download')
      await saveDialog
        .getByRole('link', { name: 'Download', exact: true })
        .click()
      const unsaved = await unsavedDownload
      expect(unsaved.suggestedFilename()).toMatch(
        /^e2e-log-\d{8}-\d{6}\.json$/,
      )
      const unsavedLog = JSON.parse(
        await readFile((await unsaved.path())!, 'utf8'),
      )
      expect(unsavedLog.format).toBe('crossgram.mtproto-capture')
      expect(unsavedLog.events).toHaveLength(252)
      expect(
        unsavedLog.events.some((event: { payload?: unknown }) =>
          JSON.stringify(event.payload ?? '').includes('ON_DEMAND_ONLY_'),
        ),
      ).toBe(true)
      // Saving writes a full log file server-side, off the WebSocket.
      await saveDialog
        .getByRole('button', { name: 'Save on server', exact: true })
        .click()
      await page.getByText(/^Saved log e2e-log$/).waitFor()
      const recordingFiles = (await readdir(recordingsPath)).filter(
        (name) => name.endsWith('.json') && !name.endsWith('.meta.json'),
      )
      expect(recordingFiles).toHaveLength(1)
      const fileName = recordingFiles[0]!
      expect(fileName).toMatch(/^e2e-log-mtproto-.+\.json$/)
      const recording = JSON.parse(
        await readFile(join(recordingsPath, fileName), 'utf8'),
      )
      expect(recording.format).toBe('crossgram.mtproto-capture')
      expect(recording.version).toBe(1)
      expect(recording.label).toBe('e2e-log')
      expect(recording.events).toHaveLength(252)
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      // Saving opens the saved-log browser, which shows the file name, size
      // and lets the operator download or delete the file.
      const logsDialog = page.getByRole('dialog', { name: 'Saved logs' })
      await logsDialog.waitFor()
      const row = logsDialog.locator('.recording-row')
      await row.waitFor()
      expect(await row.locator('.recording-label').textContent()).toBe(
        'e2e-log',
      )
      const meta = await row.locator('.recording-meta').textContent()
      expect(meta).toContain(fileName)
      expect(meta).toContain('252 events')
      expect(
        (await logsDialog.locator('.capture-logs-note').textContent()) ?? '',
      ).toContain(recordingsPath)
      const downloadPromise = page.waitForEvent('download')
      await row
        .getByRole('link', { name: 'Download e2e-log', exact: true })
        .click()
      const download = await downloadPromise
      expect(download.suggestedFilename()).toBe(fileName)
      const downloaded = JSON.parse(
        await readFile((await download.path())!, 'utf8'),
      )
      expect(downloaded.format).toBe(recording.format)
      expect(downloaded.events).toHaveLength(recording.events.length)
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'])
      await row
        .getByRole('button', { name: 'Copy file path for e2e-log' })
        .click()
      await page.getByText('Copied file path').waitFor()
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
      ).toContain(fileName)
      await row.getByRole('button', { name: 'Delete', exact: true }).click()
      const confirm = page.getByRole('dialog', { name: 'Delete this log?' })
      await confirm.waitFor()
      await confirm
        .getByRole('button', { name: 'Delete', exact: true })
        .click()
      await expect
        .poll(() => logsDialog.locator('.recording-row').count())
        .toBe(0)
      await expect
        .poll(async () =>
          (await readdir(recordingsPath)).filter((name) =>
            name.endsWith('.json'),
          ),
        )
        .toEqual([])
      await logsDialog
        .getByRole('button', { name: 'Close dialog' })
        .click()

      // Right-click opens the DevTools-style context menu; filters live in it.
      await page.locator('.capture-row').last().click({ button: 'right' })
      await page.getByRole('menu', { name: 'Event actions' }).waitFor()
      await page.getByRole('menuitem', { name: 'Copy method name' }).click()
      await page.getByText('Copied method name').waitFor()
      await page.locator('.capture-row').last().click({ button: 'right' })
      await page
        .getByRole('menuitem', { name: 'Only this connection' })
        .click()
      await expect
        .poll(() => page.locator('.filter-chip').allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining('Connection:')]))
      await expect
        .poll(() => page.locator('.capture-row').count())
        .toBeLessThanOrEqual(8)
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click()
      await expect
        .poll(() => page.locator('.filter-chip').count())
        .toBe(0)
      await page.locator('.capture-row').last().click({ button: 'right' })
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
      // A direction filter hides the other half of the pair, so the inspector
      // fetches it back instead of dropping the request/result switch.
      await page.getByLabel('Direction').selectOption('client->server')
      await expect
        .poll(() =>
          page
            .locator('.capture-row-header strong')
            .filter({ hasText: 'rpc_result' })
            .count(),
        )
        .toBe(0)
      await page
        .locator('.capture-row-header')
        .filter({ hasText: 'messages.getHistory' })
        .click()
      await page
        .getByRole('tablist', { name: 'Captured event sections' })
        .waitFor()
      expect(
        await page.locator('.capture-inspector-name').textContent(),
      ).toContain('messages.getHistory')
      await page.getByRole('tab', { name: 'Result', exact: true }).click()
      await expect
        .poll(() => page.locator('.capture-inspector-name').textContent())
        .toContain('rpc_result')
      // Selecting the response itself opens on its own payload, with the
      // request it belongs to one tab away.
      await page.getByLabel('Direction').selectOption('server->client')
      await page
        .locator('.capture-row-header')
        .filter({ hasText: 'rpc_result' })
        .first()
        .click()
      await page
        .getByRole('tablist', { name: 'Captured event sections' })
        .waitFor()
      await expect
        .poll(() => page.locator('.capture-inspector-name').textContent())
        .toContain('rpc_result')
      await page.getByRole('tab', { name: 'Request', exact: true }).click()
      await expect
        .poll(() => page.locator('.capture-inspector-name').textContent())
        .toContain('messages.getHistory')
      await page.getByLabel('Direction').selectOption('')
      await page.locator('.capture-row').first().waitFor()
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
      // Scrolling back reveals the jump-to-latest affordance and keeps paging
      // towards older events.
      const initialRows = await page.locator('.capture-row').count()
      await page.locator('.capture-list').evaluate((element) => {
        element.scrollTop = 0
      })
      await expect
        .poll(() => page.locator('.capture-row').count())
        .toBeGreaterThan(initialRows)
      await page.locator('.capture-jump').waitFor()
      for (let index = 0; index < 3; index++)
        emitDebug({
          direction: 'client->server',
          phase: 'message',
          connectionId: 'tail',
          timestamp: Date.now(),
          payload: { _: 'test.tail' + index },
        })
      await expect
        .poll(() => page.locator('.capture-jump').textContent())
        .toContain('3 new events')
      await page.locator('.capture-jump').click()
      await expect.poll(() => page.locator('.capture-jump').count()).toBe(0)
      // Payloads for list rows are fetched only when an event is opened.
      await page
        .locator('.capture-row-header')
        .filter({ hasText: 'test.call' })
        .first()
        .click()
      await page
        .getByText(/ON_DEMAND_ONLY_/)
        .first()
        .waitFor()
      expect(frames.join('')).not.toContain('ON_DEMAND_ONLY_')
      await page.getByLabel('Filter captured events').fill('test.call15')
      await expect
        .poll(() => page.locator('.capture-row-header strong').allTextContents())
        .toEqual(expect.arrayContaining(['test.call15']))
      await page.getByLabel('Filter captured events').fill('')
      // On a wide viewport the inspector sits beside the list instead of below.
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.locator('.capture-row-header').last().click()
      await page.locator('.capture-inspector').waitFor()
      const listBox = (await page.locator('.capture-list').boundingBox())!
      const inspectorBox = (await page
        .locator('.capture-inspector')
        .boundingBox())!
      expect(inspectorBox.x).toBeGreaterThan(listBox.x + listBox.width - 1)
      if (process.env.WEBUI_SCREENSHOTS) {
        await page.screenshot({
          path: join(process.env.WEBUI_SCREENSHOTS, 'solid-capture-desktop.png'),
          animations: 'disabled',
        })
      }
      await page.setViewportSize({ width: 390, height: 844 })
      await page
        .getByRole('button', { name: 'Pause capture', exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Resume capture', exact: true })
        .waitFor()
      await expectReconnectWithoutReload(page, ui)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      // Clearing the buffer lives on the toolbar and confirms in place: the
      // first click arms the button, the second one drops the events.
      const clearButton = page.getByRole('button', {
        name: 'Clear buffer',
        exact: true,
      })
      const clearConfirm = page.getByRole('button', {
        name: 'Confirm clear buffer',
        exact: true,
      })
      await clearButton.click()
      await clearConfirm.waitFor()
      expect(await page.locator('.capture-row').count()).toBeGreaterThan(0)
      // Backing out of the confirmation leaves the buffer untouched.
      await page.keyboard.press('Escape')
      await expect.poll(() => clearConfirm.count()).toBe(0)
      await clearButton.click()
      await clearConfirm.click()
      await page.getByRole('heading', { name: 'Nothing captured yet' }).waitFor()
      // Nothing is buffered anymore, so saving a log is disabled.
      expect(
        await page
          .getByRole('button', { name: 'Save log', exact: true })
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
  }, 90_000)
})

