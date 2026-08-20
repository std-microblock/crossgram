import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from 'cordis'
import type { IMEvent, IMPlatform, PlatformSession } from '@mtproto-relay/bridge'
import {
  IMPlatformService, SystemPeerService,
} from '@mtproto-relay/bridge'
import * as platformAdminBot from './index.js'
import { PLATFORM_ADMIN_CONVERSATION_ID } from './index.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

class FakeManagement extends Service {
  readonly setStickerPackAssigned = vi.fn(async () => {})

  constructor(ctx: Context) {
    super(ctx, 'bridgeManagement')
  }

  async status() {
    return {
      generatedAt: Date.now(), uptimeSeconds: 60,
      memory: { rssBytes: 1, heapUsedBytes: 1, heapTotalBytes: 1, externalBytes: 1 },
      mtproto: { host: '127.0.0.1', port: 4430, activeConnections: 1, authorizedConnections: 1 },
      platforms: { registered: ['qq-main'], activeSessions: 1 },
      storage: { platformSessions: 1, activePlatformSessions: 1, identities: 1, authBindings: 1, clientAuthorizations: 1 },
    }
  }

  serverConfig() {
    return { name: 'CrossGram', enable_special_config: false as const, host: '127.0.0.1', port: 4430, rsa_key: 'key', dcs: [] }
  }

  accounts(platformSessionId?: string) {
    return platformSessionId === 'session-a' ? [{
      platformId: 'qq-main', platformKind: 'qq', status: 'ready' as const,
      displayName: 'Alice', virtualPhone: '+999000000000001', loginCode: '123456',
    }] : []
  }

  async identities(platformSessionId?: string) {
    return platformSessionId === 'session-a' ? [{
      platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001', active: true,
      createdAt: 1, virtualPhone: '+999000000000001', authBindingCount: 1, clientAuthorizationCount: 1,
    }] : []
  }

  async clientAuthorizations() { return [] }
  async refresh() {}
  approveLoginToken() {}
  stickers() { return { accounts: [], packs: [], updatedAt: Date.now() } }
  async refreshStickers() {}
}

describe('platform admin bot Cordis e2e', () => {
  it('loads as an optional plugin and round-trips commands/callbacks through the real system-peer service', async () => {
    const ctx = new Context()
    let platforms!: IMPlatformService
    let peers!: SystemPeerService
    const events: IMEvent[] = []
    const serviceFiber = ctx.plugin((serviceCtx) => {
      platforms = new IMPlatformService(serviceCtx)
      peers = new SystemPeerService(serviceCtx)
      peers.attach(async (_session, event) => {
        events.push(event)
      })
      new FakeManagement(serviceCtx)
    })
    await serviceFiber
    const session: PlatformSession = {
      platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001',
      credentials: {}, metadata: { firstName: 'Alice' },
    }
    platforms.activateSession('qq-main', {} as IMPlatform, session)
    const botFiber = ctx.plugin(platformAdminBot, { pageSize: 4 })
    await botFiber
    disposals.push(async () => {
      await botFiber.dispose()
      await serviceFiber.dispose()
    })

    await vi.waitFor(() => {
      if (!events.some(event =>
        event.type === 'message' && event.message.id === 'bridge:platform-admin:welcome')) {
        throw new Error('welcome message was not emitted')
      }
    })
    const resolution = await peers.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID)
    if (!resolution) throw new Error('admin peer was not resolved')
    if (resolution.peer.conversation.metadata?.bot !== true) throw new Error('admin peer is not a bot')
    if (resolution.peer.conversation.metadata?.systemPeer !== 'platform-admin') throw new Error('wrong system peer')
    const outgoing = peers.makeOutgoing(session, resolution!, {
      parts: [{ type: 'text', text: '/identities' }],
    })
    await peers.receive(session, resolution!, outgoing)
    const identityReply = events.filter(event => event.type === 'message').at(-1)
    const identityText = identityReply?.type === 'message' && identityReply.message.content.parts[0]?.type === 'text'
      ? identityReply.message.content.parts[0].text
      : ''
    if (!identityText.includes('session-a')) throw new Error('identity command did not return the scoped identity')

    const botListOutgoing = peers.makeOutgoing(session, resolution!, {
      parts: [{ type: 'text', text: '/bots' }],
    })
    await peers.receive(session, resolution!, botListOutgoing)
    const botListReply = events.filter(event => event.type === 'message').at(-1)
    const botListText = botListReply?.type === 'message' && botListReply.message.content.parts[0]?.type === 'text'
      ? botListReply.message.content.parts[0].text
      : ''
    if (!botListText.includes('https://t.me/CrossGramAdminBot')) {
      throw new Error('bot management command did not return the t.me link')
    }

    const welcome = events.find(event =>
      event.type === 'message' && event.message.id === 'bridge:platform-admin:welcome')
    if (!welcome || welcome.type !== 'message') throw new Error('welcome missing')
    const statusButton = welcome.message.content.inlineKeyboard!.rows[0]!.buttons[0]!
    if (statusButton.type !== 'callback') throw new Error('status callback missing')
    const answer = await peers.callback(session, resolution!, {
      message: welcome.message, data: statusButton.data,
    })
    if (answer?.message !== '已打开') throw new Error('status callback did not return its toast')
    const statusReply = events.filter(event => event.type === 'message').at(-1)
    const statusText = statusReply?.type === 'message' && statusReply.message.content.parts[0]?.type === 'text'
      ? statusReply.message.content.parts[0].text
      : ''
    if (!statusText.includes('服务器状态')) throw new Error('status callback did not emit status')

    await botFiber.dispose()
    if (await peers.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID)) {
      throw new Error('admin peer remained registered after plugin disposal')
    }
  })
})
