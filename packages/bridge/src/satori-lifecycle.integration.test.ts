import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import Http from '@cordisjs/plugin-http'
import Satori, { h } from '@satorijs/core'
import * as bridge from './index.js'
import type { IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession, Unsubscribe } from './platform.js'

const capabilities: PlatformCapabilities = {
  history: false,
  send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4_096, maxMedia: 0 },
  conversations: { groups: true, channels: false, subchannels: false },
}

class LifecyclePlatform implements IMPlatform {
  readonly capabilities = capabilities
  readonly getAccount = vi.fn(async () => ({ user: { id: 'self', firstName: 'Self' }, credentials: {} }))
  readonly subscribe = vi.fn(async (): Promise<Unsubscribe> => () => {})
  readonly getConversation = vi.fn(async (_session: PlatformSession, id: string) => ({ id, kind: 'group' as const, title: id }))
  readonly sendMessage = vi.fn(async (_session: PlatformSession, conversation: { id: string }, content: IMMessageInput): Promise<IMMessage> => ({
    id: 'sent', conversationId: conversation.id, senderId: 'self', timestamp: 1, outgoing: true, content: content as IMMessage['content'],
  }))
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

describe('bridge Satori exporter lifecycle', () => {
  it('provisions, unregisters, and reloads a platform without retaining stale Satori bots', async () => {
    const ctx = new Context()
    const mtproto = { register: vi.fn(), broadcastUpdate: vi.fn(), sendUpdateToAuthKey: vi.fn() }
    const webui = { addEntry: vi.fn(() => ({ mutate: vi.fn() })) }
    const provideMtproto = ctx.provide('mtproto', mtproto as never)
    const provideWebui = ctx.provide('webui', webui as never)
    const satoriFibers = [ctx.plugin(Http), ctx.plugin(Satori)]
    const infrastructure = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
      ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
      ...satoriFibers,
    ]
    disposals.push(() => Promise.resolve(provideWebui()), () => Promise.resolve(provideMtproto()), ...infrastructure.map(fiber => () => fiber.dispose()))
    await Promise.all(infrastructure)
    await new Promise(resolve => setTimeout(resolve, 25))
    const bridgeFiber = ctx.plugin(bridge, { satori: { platformId: 'qqnt', platform: 'qq' } })
    disposals.push(() => bridgeFiber.dispose())
    await bridgeFiber
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
