import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import WebUI from '@cordisjs/plugin-webui'
import { describe, expect, it } from 'vitest'
import type { MtprotoDebugEvent } from '@mtproto-relay/mtproto'
import * as debug from './index.js'

describe('MTProto capture HTTP API e2e', () => {
  it('serves freshly captured decoded events through the real Cordis HTTP stack', async () => {
    const listeners = new Set<(event: MtprotoDebugEvent) => void>()
    const fakeMtproto = {
      onDebug: {
        add: (listener: (event: MtprotoDebugEvent) => void) => listeners.add(listener),
        remove: (listener: (event: MtprotoDebugEvent) => void) => listeners.delete(listener),
      },
    }
    const ctx = new Context()
    const disposeMtproto = ctx.provide('mtproto', fakeMtproto as never)
    await Promise.resolve(disposeMtproto as any)
    const fibers = [
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(WebUI, { devMode: false, uiPath: '', apiPath: '/api', selfUrl: '' }),
      ctx.plugin(debug, { maxEvents: 100 }),
    ]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      expect(listeners.size).toBe(1)
      expect(Array.from(ctx.server.httpRoutes).some(route => route.path === '/api/mtproto-debug/events')).toBe(true)
      for (const listener of listeners) {
        listener({
          direction: 'client->server', phase: 'message', connectionId: 'conn-e2e', timestamp: Date.now(),
          messageId: '0x1234', authKeyId: 'auth-e2e',
          payload: { _: 'messages.sendMessage', peer: { channelId: 42 }, message: 'hello from e2e' },
        })
      }

      const endpoint = new URL('/api/mtproto-debug/events', ctx.server.baseUrl)
      endpoint.searchParams.set('messageId', '0x1234')
      endpoint.searchParams.set('field', 'payload.peer.channelId=42')
      endpoint.searchParams.set('grep', 'HELLO FROM E2E')
      const response = await fetch(endpoint)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({
        capturing: true,
        total: 1,
        matched: 1,
        events: [{ connectionId: 'conn-e2e', name: 'messages.sendMessage', messageId: '0x1234' }],
      })

      const invalid = await fetch(new URL('/api/mtproto-debug/events?phase=invalid', ctx.server.baseUrl))
      expect(invalid.status).toBe(400)
      expect(await invalid.json()).toEqual({ error: 'Invalid phase: invalid' })
    } finally {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
      await Promise.resolve(disposeMtproto())
    }
  })
})
