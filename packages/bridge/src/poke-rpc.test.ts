import { describe, expect, it, vi } from 'vitest'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { RpcError } from '@mtproto-relay/mtproto'
import { DialogRpc } from './dialogs.js'
import type { SystemPeerService } from './system-peer.js'
import type {
  IMDialogPage, IMMessage, IMPlatform, IMUser, PlatformCapabilities, PlatformSession,
} from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'poke-session',
  platformId: 'poke-test',
  userId: 'me',
  credentials: {},
  metadata: { firstName: 'Current' },
}

const notice: IMMessage = {
  id: 'poke-notice',
  conversationId: 'group',
  senderId: 'me',
  timestamp: 1_800_000_000,
  outgoing: true,
  content: { parts: [], serviceAction: { type: 'custom', text: '你戳了戳Alice' } },
}

/** Minimal platform covering a direct peer, a group and a broadcast channel. */
class PokePlatform implements IMPlatform {
  readonly capabilities: PlatformCapabilities
  readonly pokeCalls: Array<{ conversationId: string, userId: string, count: number }> = []
  readonly pokeResults: Array<IMMessage | undefined> = [notice]

  constructor(poke?: { maxCount: number }) {
    this.capabilities = {
      history: true,
      send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
      conversations: { groups: true, channels: true, subchannels: false },
      ...(poke ? { poke } : {}),
    }
  }

  async subscribe() { return () => {} }

  async sendMessage(): Promise<IMMessage> {
    throw new Error('sendMessage is not used by poke tests')
  }

  async getDialogs(): Promise<IMDialogPage> {
    return {
      dialogs: [
        { conversation: { id: 'alice', kind: 'direct', title: 'Alice' }, unreadCount: 0 },
        { conversation: { id: 'bob', kind: 'direct', title: 'Bob' }, unreadCount: 0 },
        { conversation: { id: 'group', kind: 'group', title: 'Test Group' }, unreadCount: 0 },
        { conversation: { id: 'news', kind: 'channel', title: 'News' }, unreadCount: 1 },
      ],
    }
  }

  async getHistory(): Promise<{ messages: IMMessage[] }> {
    return { messages: [] }
  }

  async getContacts(): Promise<{ users: IMUser[] }> {
    return { users: [
      { id: session.userId, firstName: 'Current' },
      { id: 'alice', firstName: 'Alice' },
      { id: 'bob', firstName: 'Bob' },
    ] }
  }

  async getUser(_session: PlatformSession, id: string): Promise<IMUser | null> {
    if (id === session.userId) return { id, firstName: 'Current' }
    return { id, firstName: id.charAt(0).toUpperCase() + id.slice(1) }
  }

  async sendPoke(
    _session: PlatformSession,
    conversation: { id: string },
    target: { userId: string },
    count: number,
  ): Promise<IMMessage | undefined> {
    this.pokeCalls.push({ conversationId: conversation.id, userId: target.userId, count })
    return this.pokeResults.shift()
  }
}

async function materialize(rpc: DialogRpc): Promise<void> {
  await rpc.getDialogs({
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  })
}

function inputUser(userId: number): tl.TypeInputUser {
  return { _: 'inputUser', userId, accessHash: Long.ZERO }
}

function parseFeatures(response: tl.RawDataJSON): unknown {
  expect(response._).toBe('dataJSON')
  return JSON.parse(response.data)
}

describe('crossgram feature advertisement', () => {
  it('advertises poke support for a direct peer and for a group', async () => {
    const platform = new PokePlatform({ maxCount: 10 })
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)

    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    }))).toEqual({ poke: { maxCount: 10 } })
    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE },
    }))).toEqual({ poke: { maxCount: 10 } })
  })

  it('withholds poke support for channels and for platforms without pokes', async () => {
    const withChannel = new PokePlatform({ maxCount: 5 })
    const channelRpc = new DialogRpc(withChannel, session)
    await materialize(channelRpc)
    expect(parseFeatures(await channelRpc.getFeatures({
      peer: { _: 'inputPeerChannel', channelId: channelRpc.peerTlId('news'), accessHash: Long.ONE },
    }))).toEqual({})

    const withoutPoke = new PokePlatform()
    const plainRpc = new DialogRpc(withoutPoke, session)
    await materialize(plainRpc)
    expect(parseFeatures(await plainRpc.getFeatures({
      peer: { _: 'inputPeerUser', userId: plainRpc.peerTlId('alice'), accessHash: Long.ZERO },
    }))).toEqual({})
  })

  it('withholds poke support for a relay-owned system peer', async () => {
    const platform = new PokePlatform({ maxCount: 10 })
    const systemPeers = {
      resolve: vi.fn(async (_session: PlatformSession, conversationId: string) =>
        conversationId === 'alice' ? { id: 'bridge:request-inbox' } : undefined),
    } as unknown as SystemPeerService
    const rpc = new DialogRpc(
      platform, session,
      undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, systemPeers,
    )
    await materialize(rpc)

    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    }))).toEqual({})
    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE },
    }))).toEqual({ poke: { maxCount: 10 } })
  })

  it('advertises reaction support per conversation kind', async () => {
    const platform = new PokePlatform()
    ;(platform as unknown as { capabilities: PlatformCapabilities }).capabilities = {
      ...platform.capabilities,
      reactions: {
        read: true, write: true, events: false, actorList: false, maxSelected: 20, kinds: ['group'],
      },
    }
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)

    // The catalog is account-wide, so only a per-conversation answer lets a
    // client hide the entry in a kind the platform keeps out of it.
    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
    }))).toEqual({ reactions: { supported: false } })
    expect(parseFeatures(await rpc.getFeatures({
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE },
    }))).toEqual({ reactions: { supported: true } })
  })
})

describe('crossgram sendPoke', () => {
  it('sends a burst for a group member and publishes the notice', async () => {
    const platform = new PokePlatform({ maxCount: 10 })
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)
    const published = vi.spyOn(rpc as unknown as {
      _publishLocalMessage: (...args: unknown[]) => Promise<unknown>
    }, '_publishLocalMessage')

    const result = await rpc.sendPoke({
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE },
      userId: inputUser(rpc.peerTlId('alice')),
      count: 5,
    })

    expect(result).toMatchObject({ _: 'boolTrue' })
    expect(platform.pokeCalls).toEqual([{ conversationId: 'group', userId: 'alice', count: 5 }])
    expect(published).toHaveBeenCalledTimes(1)
    expect(published.mock.calls[0]).toEqual([
      'group',
      { ...notice, conversationId: 'group', outgoing: true },
    ])
  })

  it('pokes the peer of a direct chat without a published notice', async () => {
    const platform = new PokePlatform({ maxCount: 10 })
    platform.pokeResults.length = 0
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)
    const published = vi.spyOn(rpc as unknown as {
      _publishLocalMessage: (...args: unknown[]) => Promise<unknown>
    }, '_publishLocalMessage')

    await rpc.sendPoke({
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO },
      userId: inputUser(rpc.peerTlId('alice')),
      count: 1,
    })

    expect(platform.pokeCalls).toEqual([{ conversationId: 'alice', userId: 'alice', count: 1 }])
    expect(published).not.toHaveBeenCalled()
  })

  it('rejects unsupported, invalid and mismatched poke requests', async () => {
    const platform = new PokePlatform({ maxCount: 3 })
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)
    const group = { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE } as const
    const alice = { _: 'inputPeerUser', userId: rpc.peerTlId('alice'), accessHash: Long.ZERO } as const

    await expect(rpc.sendPoke({ peer: group, userId: inputUser(rpc.peerTlId('alice')), count: 4 }))
      .rejects.toMatchObject({ code: 400, text: 'POKE_COUNT_INVALID' })
    await expect(rpc.sendPoke({ peer: group, userId: inputUser(rpc.peerTlId('alice')), count: 0 }))
      .rejects.toMatchObject({ code: 400, text: 'POKE_COUNT_INVALID' })
    // A direct chat can only poke its own peer.
    await expect(rpc.sendPoke({ peer: alice, userId: inputUser(999_999), count: 1 }))
      .rejects.toMatchObject({ code: 400, text: 'USER_ID_INVALID' })
    await expect(rpc.sendPoke({ peer: alice, userId: inputUser(rpc.peerTlId('bob')), count: 1 }))
      .rejects.toMatchObject({ code: 400, text: 'POKE_TARGET_INVALID' })
    expect(platform.pokeCalls).toEqual([])

    const plain = new PokePlatform()
    const unsupported = new DialogRpc(plain, session)
    await materialize(unsupported)
    await expect(unsupported.sendPoke({
      peer: { _: 'inputPeerUser', userId: unsupported.peerTlId('alice'), accessHash: Long.ZERO },
      userId: inputUser(unsupported.peerTlId('alice')),
      count: 1,
    })).rejects.toMatchObject({ code: 400, text: 'POKE_NOT_SUPPORTED' })
  })

  it('surfaces platform failures without publishing anything', async () => {
    const platform = new PokePlatform({ maxCount: 10 })
    platform.sendPoke = async () => { throw new Error('QQ poke rejected') }
    const rpc = new DialogRpc(platform, session)
    await materialize(rpc)
    const published = vi.spyOn(rpc as unknown as {
      _publishLocalMessage: (...args: unknown[]) => Promise<unknown>
    }, '_publishLocalMessage')

    await expect(rpc.sendPoke({
      peer: { _: 'inputPeerChannel', channelId: rpc.peerTlId('group'), accessHash: Long.ONE },
      userId: inputUser(rpc.peerTlId('alice')),
      count: 2,
    })).rejects.toThrow('QQ poke rejected')
    expect(published).not.toHaveBeenCalled()
  })
})
