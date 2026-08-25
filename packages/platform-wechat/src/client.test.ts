import { describe, expect, it, vi } from 'vitest'
import { ComWeChatClient, normalizeEndpoint } from './client.js'

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('ComWeChatClient', () => {
  it('sends a JSON POST to the ComWeChat API type endpoint', async () => {
    const fetch = vi.fn(async () => json({ data: { wxId: 'self' } }))
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    await expect(client.getSelfInfo()).resolves.toEqual({ data: { wxId: 'self' } })

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      new URL('http://127.0.0.1:18888/api/?type=1'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
  })

  it('reports a non-success HTTP response with its request type', async () => {
    const client = new ComWeChatClient({
      endpoint: 'http://127.0.0.1:18888/api/',
      fetch: async () => json({ error: 'unavailable' }, 503),
    })

    await expect(client.getContacts()).rejects.toThrow('ComWeChat request type 15 returned HTTP 503')
  })

  it('wraps timeout aborts from the HTTP transport', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
      throw new Error('unreachable')
    })
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', requestTimeoutMs: 1, fetch })

    await expect(client.getSelfInfo()).rejects.toThrow('ComWeChat request type 1 failed')
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it.each([
    [1, true],
    ['1', true],
    [0, false],
    ['0', false],
  ])('returns %s login status as %s', async (is_login, expected) => {
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', fetch: async () => json({ is_login }) })

    await expect(client.isLoggedIn()).resolves.toBe(expected)
  })

  it('sends the callback listener port in a type 9 request', async () => {
    const fetch = vi.fn(async () => json({}))
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    await client.startCallback(23456)

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:18888/api/?type=9'),
      expect.objectContaining({ body: '{"port":23456}' }),
    )
  })

  it('sends an empty type 10 request to stop callback delivery', async () => {
    const fetch = vi.fn(async () => json({}))
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    await client.stopCallback()

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:18888/api/?type=10'),
      expect.objectContaining({ body: '{}' }),
    )
  })

  it('sends group member nickname lookup account fields unchanged', async () => {
    const fetch = vi.fn(async () => json({}))
    const client = new ComWeChatClient({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    await client.getGroupMemberNickname('room@chatroom', 'member')

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:18888/api/?type=26'),
      expect.objectContaining({ body: '{"chatroom_id":"room@chatroom","wxid":"member"}' }),
    )
  })

  it('uses array contact data and discards malformed contact items', async () => {
    const client = new ComWeChatClient({
      endpoint: 'http://127.0.0.1:18888/api/',
      fetch: async () => json({ data: [{ wxid: 'friend' }, null, 'not-a-contact'] }),
    })

    await expect(client.getContacts()).resolves.toEqual([{ wxid: 'friend' }])
  })

  it.each([
    ['normal', 'first^Gsecond^G', [{ wxid: 'first' }, { wxid: 'second' }]],
    ['trailing separator', 'first^Gsecond^G', [{ wxid: 'first' }, { wxid: 'second' }]],
    ['empty members', '', []],
    ['duplicates', 'first^Gfirst^Gsecond^G', [{ wxid: 'first' }, { wxid: 'second' }]],
  ])('parses %s type-25 root members', async (_name, members, expected) => {
    const client = new ComWeChatClient({
      endpoint: 'http://127.0.0.1:18888/api/',
      fetch: async () => json({ members, result: 'OK' }),
    })

    await expect(client.getGroupMembers('room@chatroom')).resolves.toEqual(expected)
  })

  it('returns no group members and warns for malformed type-25 root members', async () => {
    const onWarning = vi.fn()
    const client = new ComWeChatClient({
      endpoint: 'http://127.0.0.1:18888/api/', onWarning,
      fetch: async () => json({ members: 1, result: 'OK' }),
    })

    await expect(client.getGroupMembers('room@chatroom')).resolves.toEqual([])
    expect(onWarning).toHaveBeenCalledWith('ComWeChat group members response has no supported members payload')
  })

  it('returns an empty list and warns for an unsupported contact payload', async () => {
    const onWarning = vi.fn()
    const client = new ComWeChatClient({
      endpoint: 'http://127.0.0.1:18888/api/', onWarning,
      fetch: async () => json({ data: { unexpected: true } }),
    })

    await expect(client.getContacts()).resolves.toEqual([])
    expect(onWarning).toHaveBeenCalledWith('ComWeChat contacts response has no supported array payload')
  })

  it('rejects endpoint protocols other than HTTP and HTTPS', () => {
    expect(() => normalizeEndpoint('file:///tmp/comwechat')).toThrow('ComWeChat endpoint must use http:// or https://')
  })
})
