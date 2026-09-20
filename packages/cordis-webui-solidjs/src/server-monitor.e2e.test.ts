import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { describe, expect, it, vi } from 'vitest'
import SolidWebUI from './index.js'
import * as Monitor from './server-monitor.js'
describe('scoped server instrumentation', () => {
  it('captures early/late routes and final statuses, counts errors, bounds history, tracks WebSocket closure and disposes cleanly', async () => {
    const ctx = new Context(),
      server = ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      uiFiber = ctx.plugin(SolidWebUI)
    await Promise.all([server, uiFiber])
    await vi.waitFor(() => expect(uiFiber.state).toBe(2))
    const ui = ctx.get('webui') as unknown as SolidWebUI
    ctx.server.get('/early', async () =>
      Response.json({ ok: true }, { status: 201 }),
    )
    ctx.server.get('/failure', async () => {
      throw new Error('intentional route failure')
    })
    ctx.server.ws('/echo', async (_req, accept) => {
      const socket = await accept()
      socket.on('message', (data) => socket.send(data.toString()))
    })
    const monitor = ctx.plugin(Monitor, { requestLimit: 5 })
    let socket: WebSocket | undefined
    try {
      await monitor
      await vi.waitFor(() =>
        expect(
          Object.values(ui.entries).some((entry) => entry.module === 'server'),
        ).toBe(true),
      )
      const entry = Object.values(ui.entries).find(
        (entry) => entry.module === 'server',
      )!
      const late = ctx.plugin({
        name: 'late-route',
        inject: ['server'],
        apply(ctx: Context) {
          ctx.server.get(
            '/late',
            async () => new Response('late', { status: 202 }),
          )
        },
      })
      await late
      expect((await fetch(ctx.server.baseUrl + '/early')).status).toBe(201)
      expect((await fetch(ctx.server.baseUrl + '/late')).status).toBe(202)
      expect((await fetch(ctx.server.baseUrl + '/failure')).status).toBe(500)
      await vi.waitFor(() =>
        expect(
          entry.data.requests.find((row: any) => row.path === '/failure')
            ?.status,
        ).toBe(500),
      )
      expect(entry.data.routes['GET /early'].requests).toBe(1)
      expect(entry.data.routes['GET /failure'].lastStatus).toBe(500)
      for (let index = 0; index < 10; index++)
        await fetch(ctx.server.baseUrl + '/early')
      expect(entry.data.requests).toHaveLength(5)
      expect(entry.data.routes['GET /early'].requests).toBe(11)
      socket = new WebSocket(
        ctx.server.baseUrl.replace('http:', 'ws:') + '/echo',
      )
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve()
        socket!.onerror = () => reject(Error('WS failed'))
      })
      await vi.waitFor(() =>
        expect(entry.data.requests.at(-1).status).toBe(101),
      )
      socket.close()
      await vi.waitFor(() =>
        expect(entry.data.requests.at(-1).endTime).toBeTypeOf('number'),
      )
      expect(entry.data.routes['WS /echo'].requests).toBe(1)
      await entry.data.clear()
      expect(entry.data.requests).toEqual([])
      expect(entry.data.routes['GET /early'].requests).toBe(0)
      await late.dispose()
      await vi.waitFor(() =>
        expect(entry.data.routes['GET /late']).toBeUndefined(),
      )
      await monitor.dispose()
      expect(ui.entries[entry.id]).toBeUndefined()
      expect((await fetch(ctx.server.baseUrl + '/early')).status).toBe(201)
    } finally {
      socket?.close()
      await monitor.dispose()
      await uiFiber.dispose()
      await server.dispose()
    }
  })
})
