import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import Http from '@cordisjs/plugin-http'
import Satori, { h } from '@satorijs/core'
import * as bridge from '@mtproto-relay/bridge'
import MemoryUpdateStore from '@mtproto-relay/update-store-memory'
import type {
  IMEvent, IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession, Unsubscribe,
} from '@mtproto-relay/bridge'
import * as exporter from './index.js'

const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4_096, maxMedia: 0 },
  conversations: { groups: true, channels: false, subchannels: false },
}

class LifecyclePlatform implements IMPlatform {
  readonly capabilities = capabilities
  readonly getAccount = vi.fn(async () => ({ user: { id: 'self', firstName: 'Self' }, credentials: {} }))
  readonly getConversation = vi.fn(async (_session: PlatformSession, id: string) => ({ id, kind: 'group' as const, title: id }))
  readonly sendMessage = vi.fn(async (_session: PlatformSession, conversation: { id: string }, content: IMMessageInput): Promise<IMMessage> => ({
    id: 'sent', conversationId: conversation.id, senderId: 'self', timestamp: 1, outgoing: true, content: content as IMMessage['content'],
  }))
  private _handler?: (event: IMEvent) => void | Promise<void>

  readonly subscribe = vi.fn(async (_session: PlatformSession, handler: (event: IMEvent) => void | Promise<void>): Promise<Unsubscribe> => {
    this._handler = handler
    return () => { this._handler = undefined }
  })

  async emit(event: IMEvent): Promise<void> {
    if (!this._handler) throw new Error('platform is not subscribed')
    await this._handler(event)
  }
}

const disposals: Array<() => unknown> = []

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await Promise.resolve(dispose())
})

async function installSatoriScope(ctx: Context) {
  const fibers = [ctx.plugin(Http), ctx.plugin(Satori)]
  await Promise.all(fibers)
  return async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve(fiber.dispose())
  }
}

describe('standalone Satori exporter lifecycle', () => {
  it('ingests Satori messages when the provider suppresses its own echo, then reloads without stale bots', async () => {
    const ctx = new Context()
    const mtproto = {
      register: vi.fn(), broadcastUpdate: vi.fn(), sendUpdateToAuthKey: vi.fn(),
      rsaKey: { publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----' },
    }
    const webui = { addEntry: vi.fn(() => ({ mutate: vi.fn() })) }
    const provideMtproto = ctx.provide('mtproto', mtproto as never)
    const provideWebui = ctx.provide('webui', webui as never)
    const satoriFibers = [ctx.plugin(Http), ctx.plugin(Satori)]
    const infrastructure = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(MemoryUpdateStore),
      ...satoriFibers,
    ]
    disposals.push(() => Promise.resolve(provideWebui()), () => Promise.resolve(provideMtproto()), ...infrastructure.map(fiber => () => fiber.dispose()))
    await Promise.all(infrastructure)
    await new Promise(resolve => setTimeout(resolve, 25))
    const bridgeFiber = ctx.plugin(bridge)
    disposals.push(() => bridgeFiber.dispose())
    await bridgeFiber
    const exporterFiber = ctx.plugin(exporter, { platformId: 'qqnt', platform: 'qq' })
    disposals.push(() => exporterFiber.dispose())
    await exporterFiber
    await ctx.database.prepared()

    const platform = new LifecyclePlatform()
    const unregister = ctx.imPlatform.register(platform, 'qqnt')
    await vi.waitFor(() => expect(platform.getAccount).toHaveBeenCalledOnce())
    const disposeFirstScope = async () => {
      for (const fiber of satoriFibers.reverse()) await Promise.resolve(fiber.dispose())
    }
    await vi.waitFor(() => expect(ctx.bots).toHaveLength(1))
    const oldBot = ctx.bots[0]!
    expect(oldBot.status).toBe(1)
    const received: string[] = []
    ctx.on('message-created', event => received.push(event.event.message!.id))
    await platform.emit({
      type: 'message',
      conversation: { id: 'group:42', kind: 'group', title: 'Group 42' },
      message: {
        id: 'incoming:1', conversationId: 'group:42', senderId: 'alice', timestamp: 1,
        content: { parts: [{ type: 'text', text: 'hello from bridge' }] },
      },
    })
    await vi.waitFor(() => expect(received).toEqual(['incoming:1']))

    const [activeSession] = await ctx.database.get('mtproto_platform_session', { platformId: 'qqnt', active: true })
    if (!activeSession) throw new Error('missing active bridge session')
    await ctx.database.create('mtproto_auth_binding', {
      authKeyId: '0011223344556677', platformId: 'qqnt', platformSessionId: activeSession.id,
    })
    await ctx.bots[0]!.createMessage('group:42', [h.text('sent through Satori')])
    await vi.waitFor(async () => expect(await ctx.database.get('mtproto_im_message', {
      platformSessionId: activeSession.id, primaryPlatformMessageId: 'sent',
    })).toMatchObject([{ outgoing: true, text: 'sent through Satori' }]))
    await vi.waitFor(() => expect(mtproto.sendUpdateToAuthKey).toHaveBeenCalledWith(
      expect.any(Uint8Array), expect.objectContaining({
        _: 'updates', updates: [expect.objectContaining({
          _: 'updateNewChannelMessage', message: expect.objectContaining({ message: 'sent through Satori' }),
        })],
      }), undefined,
    ))
    expect(received).toEqual(['incoming:1'])

    unregister()
    await vi.waitFor(() => expect(ctx.bots).toHaveLength(0))
    await expect(oldBot.createMessage('group:42', [h.text('stale')])).rejects.toThrow('not ready')

    const replacement = new LifecyclePlatform()
    const unregisterReplacement = ctx.imPlatform.register(replacement, 'qqnt')
    disposals.push(unregisterReplacement)
    await vi.waitFor(() => expect(ctx.bots).toHaveLength(1))
    const secondBot = ctx.bots[0]!
    expect(secondBot).not.toBe(oldBot)
    expect(secondBot.selfId).toBe('self')

    await disposeFirstScope()
    await expect(secondBot.createMessage('group:42', [h.text('stale')])).rejects.toThrow('not ready')

    const disposeSecondScope = await installSatoriScope(ctx)
    disposals.push(disposeSecondScope)
    await vi.waitFor(() => expect(ctx.bots).toHaveLength(1))
    expect(ctx.bots[0]).not.toBe(secondBot)
    expect(ctx.bots[0]!.selfId).toBe('self')
  })
})
