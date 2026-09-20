import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { describe, expect, it, vi } from 'vitest'
import { chromium } from 'playwright'
import SolidWebUI, { escapeScriptJSON, normalizePath } from './index.js'
import { safeAsset } from './entry.js'

async function start(uiPath = '') {
  const ctx = new Context()
  const fibers = [ctx.plugin(Server, { host: '127.0.0.1', port: 0 }), ctx.plugin(SolidWebUI, { uiPath })]
  await Promise.all(fibers)
  await vi.waitFor(() => expect(fibers.map(fiber => fiber.state)).toEqual([2, 2]))
  const ui = ctx.get('webui') as unknown as SolidWebUI
  return { ctx, ui, url: ctx.server.baseUrl, stop: async () => { for (const fiber of fibers.reverse()) await fiber.dispose() } }
}
async function connect(url: string) {
  const frames: any[] = []
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/api')
  socket.addEventListener('message', event => frames.push(JSON.parse(String(event.data))))
  await vi.waitFor(() => expect(frames[0]?.type).toBe('entry:init'))
  return { socket, frames, send: (type: string, body: unknown) => socket.send(JSON.stringify({ type, body })) }
}
describe('Solid WebUI production service', () => {
  it('escapes embedded settings and rejects unsafe paths', () => {
    expect(escapeScriptJSON({ title: '</script>\u2028' })).not.toContain('<')
    expect(JSON.parse(escapeScriptJSON({ title: '</script>' })).title).toBe('</script>')
    for (const value of ['/../private', '/bad path', '/a?b', '/a\\b', 'relative']) expect(() => normalizePath(value)).toThrow()
    for (const value of ['../private', '/abs', 'C:/secret', 'a\\b', 'a/../b']) expect(safeAsset(value)).toBe(false)
    expect(normalizePath('/console///')).toBe('/console')
  })
  it('serves exact manifests under a prefix without exposing arbitrary files', async () => {
    const app = await start('/console')
    try {
      const home = await fetch(app.url + '/console', { headers: { accept: 'text/html' } })
      expect(home.status).toBe(200)
      expect(home.headers.get('cache-control')).toBe('no-store')
      const html = await home.text()
      expect(html).toContain('window.SOLID_WEBUI_CONFIG')
      const asset = /src="([^"]+\.js)"/.exec(html)![1]
      expect(asset).toMatch(/^\/console\/assets\//)
      const js = await fetch(app.url + asset)
      expect(js.status).toBe(200)
      expect(js.headers.get('cache-control')).toContain('immutable')
      for (const route of ['/console/assets/missing.js', '/console/-/modules/missing/private', '/console/package.json']) {
        expect((await fetch(app.url + route)).status).toBe(404)
      }
      expect((await fetch(app.url + '/console/not-a-page', { headers: { accept: 'text/html' } })).status).toBe(404)
    } finally { await app.stop() }
  })
  it('scopes entries to plugin lifetime and streams Muon only to subscribed clients', async () => {
    const app = await start()
    let entry: ReturnType<SolidWebUI['addEntry']> | undefined
    const plugin = app.ctx.plugin({ name: 'test-entry', inject: ['webui'], apply(ctx: Context) {
      entry = (ctx.get('webui') as unknown as SolidWebUI).addEntry<any>({ baseUrl: import.meta.url, client: 'debug', routes: ['/capture'] }, { count: 0, large: 'x'.repeat(100_000), increment() { entry!.mutate((data: any) => data.count++) } }) as any
    } })
    let a: Awaited<ReturnType<typeof connect>> | undefined, b: typeof a
    try {
      await plugin
      await vi.waitFor(() => expect(Object.keys(app.ui.entries)).toHaveLength(1))
      a = await connect(app.url); b = await connect(app.url)
      expect(JSON.stringify(a.frames[0])).not.toContain('large')
      const id = entry!.id
      a.send('entry:subscribe', { id })
      await vi.waitFor(() => expect(a!.frames.some(frame => frame.type === 'entry:snapshot')).toBe(true))
      a.send('rpc:request', { sn: 1, entryId: id, method: 'increment', args: [] })
      await vi.waitFor(() => expect(a!.frames.some(frame => frame.type === 'rpc:response' && frame.body.ok)).toBe(true))
      expect(a.frames.some(frame => frame.type === 'entry:delta')).toBe(true)
      expect(b.frames.some(frame => frame.type === 'entry:delta')).toBe(false)
      await plugin.dispose()
      await vi.waitFor(() => expect(a!.frames.at(-1).body.entries[id]).toBe(null))
      expect(app.ui.entries[id]).toBeUndefined()
    } finally { a?.socket.close(); b?.socket.close(); await plugin.dispose(); await app.stop() }
  })
  it('renders the production shell on mobile without overflow or Vue', async () => {
    const app = await start('/console')
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(app.url + '/console/')
      await page.getByRole('heading', { name: 'Your space. In sync.' }).waitFor()
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.getByRole('button', { name: 'Open navigation' }).click()
      await expect.poll(() => page.locator('.navigation').getAttribute('class')).toContain('open')
      await page.getByRole('button', { name: 'Close navigation' }).click()
      expect(await page.evaluate(() => '__VUE__' in window)).toBe(false)
      const timeOrigin = await page.evaluate(() => performance.timeOrigin)
      Object.values(app.ui.clients)[0].socket.close(1012, 'test reconnect')
      await page.getByText('Reconnecting… Your place is saved.', { exact: false }).waitFor()
      await page.getByText('All connected', { exact: true }).waitFor()
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
      expect(errors).toEqual([])
    } finally { await browser.close(); await app.stop() }
  })
})
