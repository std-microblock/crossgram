import { describe, expect, it, vi } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTClient } from './client.js'
import { QQNTPlatform } from './index.js'
import type { WireMessage } from './protocol.js'

const session: PlatformSession = {
  platformSessionId: 'poke-client',
  platformId: 'qqnt',
  userId: 'self-uid',
  credentials: {},
  metadata: {},
}

function bridgeFetch(bridgeProtocol: number, requests: Array<{ url: string, method?: string, body: unknown }>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/status')) {
      return Response.json({ protocolVersion: bridgeProtocol, ready: true, selfUid: 'self-uid' })
    }
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ count: 2, message: notice })
  })
}

const notice: WireMessage = {
  id: 'poke-notice',
  conversationId: 'group-uid',
  senderId: 'self-uid',
  timestamp: 1_800_000_000,
  outgoing: true,
  parts: [],
  serviceAction: { type: 'custom', text: '你戳了戳Alice' },
}

describe('QQNT poke client', () => {
  it('posts a poke burst once the bridge reports protocol 33', async () => {
    const requests: Array<{ url: string, method?: string, body: unknown }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      token: 'secret',
      fetch: bridgeFetch(33, requests),
    })

    const result = await client.sendPoke('group uid', 'member-uid', 2)

    expect(requests).toEqual([{
      url: 'http://bridge.invalid/v1/conversations/group%20uid/pokes',
      method: 'POST',
      body: { userId: 'member-uid', count: 2 },
    }])
    expect(result.message?.id).toBe('poke-notice')
  })

  it('refuses to poke a bridge that predates protocol 33', async () => {
    const requests: Array<{ url: string, method?: string, body: unknown }> = []
    const client = new QQNTClient({
      endpoint: 'http://bridge.invalid/v1',
      fetch: bridgeFetch(32, requests),
    })

    await expect(client.sendPoke('group-uid', 'member-uid', 1))
      .rejects.toThrow('QQNT bridge protocol 33 is required for pokes')
    expect(requests).toEqual([])
  })
})

describe('QQNT poke platform mapping', () => {
  it('maps the confirmed poke notice onto the platform conversation', async () => {
    const platform = new QQNTPlatform()
    const requested: Array<{ conversationId: string, userId: string, count: number }> = []
    platform.client.sendPoke = vi.fn(async (conversationId, userId, count) => {
      requested.push({ conversationId, userId, count })
      return { message: notice }
    })

    const message = await platform.sendPoke(
      session, { id: 'group-uid' }, { userId: 'member-uid' }, 3,
    )

    expect(requested).toEqual([{ conversationId: 'group-uid', userId: 'member-uid', count: 3 }])
    expect(message).toMatchObject({
      id: 'poke-notice',
      conversationId: 'group-uid',
      content: { serviceAction: { type: 'custom', text: '你戳了戳Alice' } },
    })
    expect(platform.capabilities.poke).toEqual({ maxCount: 10 })
  })

  it('advertises reactions for groups only, since QQ one-to-one chats have none', () => {
    const platform = new QQNTPlatform()

    // The catalog is account-wide, so the kind restriction is what keeps
    // one-to-one chats from publishing a reaction list at all.
    expect(platform.capabilities.reactions).toMatchObject({
      read: true, write: true, maxSelected: 20, kinds: ['group'],
    })
  })

  it('reports no notice when the bridge could not confirm one', async () => {
    const platform = new QQNTPlatform()
    platform.client.sendPoke = vi.fn(async () => ({}))

    await expect(platform.sendPoke(session, { id: 'group-uid' }, { userId: 'member-uid' }, 1))
      .resolves.toBeUndefined()
  })
})
