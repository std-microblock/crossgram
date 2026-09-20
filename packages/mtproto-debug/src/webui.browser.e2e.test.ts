import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import WebUI from '@cordisjs/plugin-webui'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import * as debug from './index.js'

describe('production WebUI lazy capture in Chromium', () => {
  it('keeps history off global sockets, pages metadata, fetches details on expansion and reconnects cleanly', async () => {
    const ctx = new Context()
    const disposeMtproto = ctx.provide('mtproto', {} as never)
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(WebUI, { devMode: false, uiPath: '', apiPath: '/api', selfUrl: '' }),
      ctx.plugin(debug, { maxEvents: 1000 }),
    ]
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      await Promise.all(fibers)
      await vi.waitFor(() => expect(Object.values(ctx.webui.entries)).toHaveLength(1))
      for (let index = 0; index < 250; index++) ctx.emit('mtproto/debug', {
        direction: 'client->server', phase: 'message', connectionId: 'browser-test', timestamp: Date.now(),
        payload: { _: 'test.call' + index, secret: 'PAYLOAD_ONLY_ON_DEMAND' + 'x'.repeat(32_000) },
      })
      // Previously this history alone exceeded the 8 MiB initial socket cap.
      await new Promise(resolve => setTimeout(resolve, 100))
      browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
      const page = await browser.newPage()
      const errors: string[] = []
      const requests: string[] = []
      const frames: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('request', request => {
        if (request.url().includes('/api/mtproto-debug/events?')) requests.push(request.url())
      })
      page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))))
      await page.goto(ctx.server.baseUrl + '/')
      await page.waitForFunction(() => document.querySelector('#app')!.textContent!.length > 0)
      await vi.waitFor(() => expect(frames.some(frame => frame.includes('entry:init'))).toBe(true))
      expect(requests).toEqual([])
      expect(frames.join('')).not.toContain('PAYLOAD_ONLY_ON_DEMAND')
      expect(frames.join('')).not.toContain('searchText')
      expect(frames.join('')).not.toContain('chunks')
      expect(Buffer.byteLength(frames[0])).toBeLessThan(10_000)
      frames.length = 0
      ctx.emit('mtproto/debug', {
        direction: 'client->server', phase: 'message', connectionId: 'browser-test', timestamp: Date.now(),
        payload: { _: 'test.live', secret: 'NOT_BROADCAST' },
      })
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(frames.join('')).not.toContain('NOT_BROADCAST')
      expect(frames.join('')).not.toContain('entry:delta')

      await page.goto(ctx.server.baseUrl + '/mtproto-debug')
      await page.waitForSelector('.debug-event')
      expect(requests.length).toBeGreaterThan(0)
      expect(requests.every(url => new URL(url).searchParams.get('summary') === 'true')).toBe(true)
      const firstList = await page.request.get(requests[0])
      const list = await firstList.json()
      expect(list.events).toHaveLength(100)
      expect(JSON.stringify(list)).not.toContain('PAYLOAD_ONLY_ON_DEMAND')
      expect(JSON.stringify(list)).not.toContain('payload"')
      expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(100_000)

      await page.getByRole('button', { name: 'Load older events' }).click()
      await vi.waitFor(() => expect(requests.some(url => new URL(url).searchParams.has('beforeId'))).toBe(true))
      await page.waitForFunction(() => !(document.querySelector('[aria-label="Load newer events"]') as HTMLButtonElement)?.disabled)
      await page.locator('.event-header').first().click()
      await vi.waitFor(() => expect(requests.some(url => new URL(url).searchParams.has('id'))).toBe(true))
      await page.waitForFunction(() => document.querySelector('.event-detail')?.textContent?.includes('PAYLOAD_ONLY_ON_DEMAND'))

      await page.goto(ctx.server.baseUrl + '/')
      const count = requests.length
      await new Promise(resolve => setTimeout(resolve, 1200))
      expect(requests).toHaveLength(count)
      const beforeReload = await page.evaluate(() => performance.timeOrigin)
      const client = Object.values(ctx.webui.clients)[0]
      expect(client).toBeDefined()
      client.socket.close(1012, 'Reconnect regression test')
      await page.waitForFunction(previous => performance.timeOrigin !== previous, beforeReload)
      await vi.waitFor(() => expect(Object.keys(ctx.webui.clients)).toHaveLength(1))
      expect(errors).toEqual([])
    } finally {
      await browser?.close()
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
      disposeMtproto()
    }
  }, 30_000)
})
