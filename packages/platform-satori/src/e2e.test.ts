import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Http from '@cordisjs/plugin-http'
import Satori, { Bot, h, type Universal } from '@satorijs/core'
import { IMPlatformService } from '@mtproto-relay/bridge'
import * as satoriPlatformPlugin from './index.js'

class ImportedMockAdaptor extends Bot {
  sent: h[] = []

  constructor(ctx: Context) {
    super(ctx, {}, 'imported-mock')
    this.platform = 'mock'
    this.user = { id: 'self', name: 'Imported Account' }
  }

  async connect() { this.online() }

  async createMessage(channelId: string, content: h.Fragment): Promise<Universal.Message[]> {
    this.sent = h.normalize(content)
    return [{
      id: 'sent-through-adaptor', channel: { id: channelId, type: 0 },
      user: this.user, elements: this.sent, timestamp: Date.now(),
    }]
  }

  async createUpload(): Promise<string[]> {
    return ['internal:mock/self/upload']
  }
}

const fibers: Array<{ dispose(): unknown }> = []

afterEach(async () => {
  for (const fiber of fibers.splice(0).reverse()) await fiber.dispose()
})

describe('Satori adaptor import e2e', () => {
  it('loads a Satori Bot Cordis plugin and bridges bidirectional messages', async () => {
    const ctx = new Context()
    const http = ctx.plugin(Http)
    const satori = ctx.plugin(Satori)
    const registry = ctx.plugin((serviceCtx) => { new IMPlatformService(serviceCtx) })
    const bridge = ctx.plugin(satoriPlatformPlugin, { bot: 'mock:self' })
    const adaptor = ctx.plugin(ImportedMockAdaptor)
    fibers.push(http, satori, registry, bridge, adaptor)
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 20))

    const platform = ctx.imPlatform.require('satori')
    await expect(platform.getAccount?.()).resolves.toMatchObject({
      user: { id: 'self', firstName: 'Imported Account' },
    })
    const events: unknown[] = []
    const unsubscribe = await platform.subscribe({
      platformSessionId: 'session', platformId: 'satori', userId: 'self', credentials: {}, metadata: {},
    }, (event) => { events.push(event) })
    const bot = ctx.bots[0] as ImportedMockAdaptor
    bot.dispatch(bot.session({
      type: 'message-created',
      channel: { id: 'room', type: 0, name: 'Room' },
      user: { id: 'alice', name: 'Alice' },
      message: { id: 'incoming', content: 'hello from adaptor' },
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toMatchObject([{
      type: 'message', conversation: { id: 'room', kind: 'group' },
      message: { id: 'incoming', senderId: 'alice', content: { parts: [{ type: 'text', text: 'hello from adaptor' }] } },
    }])

    await expect(platform.sendMessage({
      platformSessionId: 'session', platformId: 'satori', userId: 'self', credentials: {}, metadata: {},
    }, { id: 'room' }, { parts: [{ type: 'text', text: 'hello to adaptor' }] }))
      .resolves.toMatchObject({ id: 'sent-through-adaptor', outgoing: true })
    expect(bot.sent.join('')).toBe('hello to adaptor')
    await unsubscribe()
  })
})
