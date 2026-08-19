import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import WebUI from '@cordisjs/plugin-webui'
import { describe, expect, it, vi } from 'vitest'

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024

describe('Cordis WebUI socket backpressure e2e', () => {
  it('removes an overloaded real WebSocket client instead of retaining future broadcasts', async () => {
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(WebUI, { devMode: false, uiPath: '', apiPath: '/api', selfUrl: '' }),
    ]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 100))

    const endpoint = new URL('/api', ctx.server.baseUrl)
    endpoint.protocol = 'ws:'
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('WebUI socket failed to open')), { once: true })
    })

    try {
      await vi.waitFor(() => expect(Object.keys(ctx.webui.clients)).toHaveLength(1))
      const client = Object.values(ctx.webui.clients)[0]!
      Object.defineProperty(client.socket, 'bufferedAmount', {
        configurable: true,
        get: () => MAX_BUFFERED_BYTES,
      })

      ctx.webui.broadcast('entry:delta', { id: 'slow-client-test', value: 'blocked' })

      await new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }))
      await vi.waitFor(() => expect(Object.keys(ctx.webui.clients)).toHaveLength(0))
    } finally {
      socket.close()
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    }
  })
})
