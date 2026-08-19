import { describe, expect, it, vi } from 'vitest'
import type {
  BridgeManagementService, IMMessage, PlatformSession, SystemPeerService,
} from '@mtproto-relay/bridge'
import {
  PLATFORM_ADMIN_CONVERSATION_ID, PlatformAdminBotProvider,
} from './index.js'

const session: PlatformSession = {
  platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001',
  credentials: {}, metadata: { firstName: 'Alice' },
}

function management() {
  return {
    status: vi.fn(async () => ({
      generatedAt: 1_700_000_000_000, uptimeSeconds: 3_661,
      memory: { rssBytes: 100 * 1024 ** 2, heapUsedBytes: 20 * 1024 ** 2, heapTotalBytes: 30 * 1024 ** 2, externalBytes: 1 },
      mtproto: { host: '0.0.0.0', port: 4430, activeConnections: 3, authorizedConnections: 2 },
      platforms: { registered: ['qq-main'], activeSessions: 1 },
      storage: { platformSessions: 1, activePlatformSessions: 1, identities: 1, authBindings: 2, clientAuthorizations: 2 },
    })),
    serverConfig: vi.fn(() => ({
      name: 'CrossGram', enable_special_config: false, host: 'relay.example.com', port: 4430,
      rsa_key: 'public-key', dcs: [{ id: 1, ip: 'relay.example.com', port: 4430 }],
    })),
    accounts: vi.fn(() => [{
      platformId: 'qq-main', platformKind: 'qq', status: 'ready', displayName: 'Alice',
      userId: '10001', virtualPhone: '+999000000000001', loginCode: '123456', remainingSeconds: 12,
    }]),
    identities: vi.fn(async () => [{
      platformId: 'qq-main', platformSessionId: 'session-a', userId: '10001', active: true,
      createdAt: 1, virtualPhone: '+999000000000001', loginCode: '123456',
      loginCodeValidUntil: Date.now() + 12_000, authBindingCount: 2, clientAuthorizationCount: 2,
    }]),
    clientAuthorizations: vi.fn(async () => []),
    refresh: vi.fn(async () => {}),
    approveLoginToken: vi.fn(),
    stickers: vi.fn(() => ({
      accounts: [{
        platformId: 'qq-main', platformSessionId: 'session-a', platformKind: 'qq',
        displayName: 'Alice', userId: '10001',
      }],
      packs: [{
        providerId: 'qq-main', packId: 'favorites', title: '收藏表情', count: 10,
        assignments: [{ platformSessionId: 'session-a', assigned: false, automatic: false }],
      }],
      updatedAt: Date.now(),
    })),
    refreshStickers: vi.fn(async () => {}),
    setStickerPackAssigned: vi.fn(async () => {}),
  }
}

function outgoing(text: string): IMMessage {
  return {
    id: `out:${text}`, conversationId: PLATFORM_ADMIN_CONVERSATION_ID,
    senderId: session.userId, content: { parts: [{ type: 'text', text }] },
    timestamp: 1, outgoing: true,
  }
}

function peerService(messages: IMMessage[]) {
  return {
    emit: vi.fn(async (_session, event) => {
      if (event.type === 'message') messages.push(event.message)
      return { committed: true }
    }),
  } as unknown as SystemPeerService
}

describe('PlatformAdminBotProvider', () => {
  it('boots a button menu and supports standalone status/server commands with bot entities', async () => {
    const api = management()
    const provider = new PlatformAdminBotProvider(api as unknown as BridgeManagementService, {
      webuiUrl: 'https://admin.example.com/',
    })
    const messages: IMMessage[] = []
    const peers = peerService(messages)
    await provider.bootstrap(session, peers)
    const peer = (await provider.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID))!
    const status = outgoing('/status@CrossGramAdminBot')
    status.content.parts[0] = { type: 'text', text: '/status@CrossGramAdminBot', entities: [
      { type: 'code', offset: 0, length: 8 },
    ] }
    await provider.receive(session, peer, status, peers)
    await provider.receive(session, peer, outgoing('/server'), peers)

    expect(messages[0]!.content.inlineKeyboard?.rows.flatMap(row => row.buttons))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'url', url: 'https://admin.example.com/' })]))
    expect(messages[1]!.content.parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('MTProto：0.0.0.0:4430') })
    expect(messages[2]!.content.parts[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('"host": "relay.example.com"'),
      entities: [{ type: 'pre', language: 'json' }],
    })
  })

  it('scopes identities and login approval to the current platform session by default', async () => {
    const api = management()
    const provider = new PlatformAdminBotProvider(api as unknown as BridgeManagementService)
    const messages: IMMessage[] = []
    const peers = peerService(messages)
    const peer = (await provider.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID))!

    await provider.receive(session, peer, outgoing('/identities'), peers)
    await provider.receive(session, peer, outgoing('/approve qq-main opaque-token'), peers)
    await provider.receive(session, peer, outgoing('/approve discord opaque-token'), peers)

    expect(api.identities).toHaveBeenCalledWith('session-a')
    expect(api.accounts).toHaveBeenCalledWith('session-a')
    expect(api.approveLoginToken).toHaveBeenCalledOnce()
    expect(api.approveLoginToken).toHaveBeenCalledWith('qq-main', 'opaque-token')
    expect(messages.at(-1)!.content.parts[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('无权管理该平台账号'),
    })
  })

  it('uses callback metadata to toggle a sticker assignment and rejects stale buttons', async () => {
    const api = management()
    const provider = new PlatformAdminBotProvider(api as unknown as BridgeManagementService)
    const messages: IMMessage[] = []
    const peers = peerService(messages)
    const peer = (await provider.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID))!
    await provider.receive(session, peer, outgoing('/stickers'), peers)
    const list = messages.at(-1)!
    const packButton = list.content.inlineKeyboard!.rows[0]!.buttons[0]!
    await provider.callback(session, peer, { message: list, data: (packButton as any).data }, peers)
    const detail = messages.at(-1)!
    const toggleButton = detail.content.inlineKeyboard!.rows[0]!.buttons[0]!
    await provider.callback(session, peer, { message: detail, data: (toggleButton as any).data }, peers)

    expect(api.setStickerPackAssigned).toHaveBeenCalledWith('session-a', 'qq-main', 'favorites', true)
    await expect(provider.callback(session, peer, { message: detail, data: 'cgadmin:missing' }, peers))
      .rejects.toMatchObject({ code: 'DATA_INVALID' })
  })

  it('honors the explicit platform-session allowlist', async () => {
    const provider = new PlatformAdminBotProvider(management() as unknown as BridgeManagementService, {
      allowedPlatformSessionIds: ['another-session'],
    })
    await expect(provider.resolve(session, PLATFORM_ADMIN_CONVERSATION_ID)).resolves.toBeUndefined()
    const peers = peerService([])
    await provider.bootstrap(session, peers)
    expect(peers.emit).not.toHaveBeenCalled()
  })
})
