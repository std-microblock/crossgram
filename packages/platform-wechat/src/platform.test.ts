import { describe, expect, it, vi } from 'vitest'
import type { IMEvent } from '@mtproto-relay/bridge'
import { IMMessageSendRejectedError } from '@mtproto-relay/bridge'
import { ComWeChatPlatform } from './index.js'
import enUS from './locales/en-US.yml'
import zhCN from './locales/zh-CN.yml'
import type { ComWeChatCallback } from './types.js'

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

function platformWithResponses(responses: Record<string, unknown>) {
  return new ComWeChatPlatform({
    endpoint: 'http://127.0.0.1:18888/api/',
    fetch: async (input) => response(responses[new URL(String(input)).searchParams.get('type')!] ?? {}),
  })
}

function mapCallback(platform: ComWeChatPlatform, callback: ComWeChatCallback): IMEvent | undefined {
  return (platform as unknown as { mapCallback(value: ComWeChatCallback): IMEvent | undefined }).mapCallback(callback)
}

describe('ComWeChat configuration locales', () => {
  it('keeps English and Simplified Chinese descriptions in their respective locale files', () => {
    expect(enUS.maxCallbackConnections).toContain('Maximum simultaneous')
    expect(zhCN.maxCallbackConnections).toContain('连接数上限')
  })
})

describe('ComWeChatPlatform account and directory operations', () => {
  it('maps the logged-in account wxId and nickname', async () => {
    const platform = platformWithResponses({ '0': { is_login: 1 }, '1': { data: { wxId: 'self', nickname: 'Self' } } })

    await expect(platform.getAccount()).resolves.toMatchObject({
      credentials: {}, user: { id: 'self', firstName: 'Self', metadata: { wechatId: 'self' } },
    })
  })

  it('rejects account lookup when ComWeChat is logged out', async () => {
    const platform = platformWithResponses({ '0': { is_login: 0 } })

    await expect(platform.getAccount()).rejects.toThrow('ComWeChat is not logged in')
  })

  it('rejects account lookup without data.wxId', async () => {
    const platform = platformWithResponses({ '0': { is_login: 1 }, '1': { data: { nickname: 'Self' } } })

    await expect(platform.getAccount()).rejects.toThrow('self info did not contain data.wxId')
  })

  it('maps real type-15 wxRemark and wxNickName contact fields into dialogs', async () => {
    const platform = platformWithResponses({ '15': { data: [
      { wxid: 'friend', wxRemark: 'Friend remark', wxNickName: 'Ignored nickname' },
      { wxid: 'room@chatroom', wxNickName: 'Group name' },
    ] } })

    await expect(platform.getDialogs({} as never)).resolves.toMatchObject({
      total: 2,
      dialogs: [
        { conversation: { id: 'friend', kind: 'direct', title: 'Friend remark' }, unreadCount: 0 },
        { conversation: { id: 'room@chatroom', kind: 'group', title: 'Group name' }, unreadCount: 0 },
      ],
    })
  })

  it('paginates dialogs after a contact ID', async () => {
    const platform = platformWithResponses({ '15': { data: [
      { wxid: 'first' }, { wxid: 'second' }, { wxid: 'third' },
    ] } })

    await expect(platform.getDialogs({} as never, { afterId: 'first', limit: 1 })).resolves.toMatchObject({
      dialogs: [{ conversation: { id: 'second' } }], total: 3, nextCursor: '2',
    })
  })

  it('returns no members for a direct conversation without calling group members', async () => {
    const fetch = vi.fn(async () => response({ data: [] }))
    const platform = new ComWeChatPlatform({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    await expect(platform.getConversationMembers({} as never, { id: 'friend' })).resolves.toEqual({ members: [], total: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('maps and paginates type-25 member IDs using type-26 wxNickName lookups', async () => {
    const platform = platformWithResponses({
      '25': { members: 'first^Gsecond^G', result: 'OK' },
      '26': { data: { wxNickName: 'Member nickname' } },
    })

    await expect(platform.getConversationMembers({} as never, { id: 'room@chatroom' }, { limit: 1 }))
      .resolves.toMatchObject({ total: 2, nextCursor: '1', members: [{ user: { id: 'first', firstName: 'Member nickname' } }] })
  })

  it('looks up nicknames only for the current member page with bounded concurrency', async () => {
    let activeLookups = 0
    let maxActiveLookups = 0
    const lookedUp: string[] = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const type = new URL(String(input)).searchParams.get('type')
      if (type === '25') {
        return response({ members: `${Array.from({ length: 20 }, (_, index) => `member-${index}`).join('^G')}^G` })
      }
      if (type === '26') {
        const { wxid } = JSON.parse(String(init?.body)) as { wxid: string }
        lookedUp.push(wxid)
        activeLookups++
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups)
        await new Promise(resolve => setTimeout(resolve, 1))
        activeLookups--
        return response({ data: { wxNickName: `Name ${wxid}` } })
      }
      return response({})
    })
    const platform = new ComWeChatPlatform({ endpoint: 'http://127.0.0.1:18888/api/', fetch })

    const page = await platform.getConversationMembers(
      {} as never,
      { id: 'room@chatroom' },
      { afterId: 'member-4', limit: 10 },
    )

    expect(page).toMatchObject({ total: 20, nextCursor: '15' })
    expect(page.members.map(member => member.user.id)).toEqual(Array.from({ length: 10 }, (_, index) => `member-${index + 5}`))
    expect(page.members[0]?.user.firstName).toBe('Name member-5')
    expect(page.members[9]?.user.firstName).toBe('Name member-14')
    expect(lookedUp).toEqual(Array.from({ length: 10 }, (_, index) => `member-${index + 5}`))
    expect(maxActiveLookups).toBeLessThanOrEqual(8)
  })

  it('falls back to wxid when a type-26 member nickname lookup fails', async () => {
    const platform = platformWithResponses({ '25': { members: 'member^G', result: 'OK' }, '26': null })

    await expect(platform.getConversationMembers({} as never, { id: 'room@chatroom' }))
      .resolves.toMatchObject({ members: [{ user: { id: 'member', firstName: 'member' } }] })
  })
})

describe('ComWeChatPlatform capabilities', () => {
  it('does not claim unsupported sending capabilities', () => {
    const platform = platformWithResponses({})

    expect(platform.capabilities.send).toMatchObject({ text: false, images: false, files: false, mixed: false })
  })

  it('rejects sends as receive-only with a typed permanent rejection', async () => {
    const platform = platformWithResponses({})

    await expect(platform.sendMessage({} as never, { id: 'friend' }, { parts: [{ type: 'text', text: 'hello' }] }))
      .rejects.toMatchObject({
        name: 'IMMessageSendRejectedError',
        reason: 'platform-rejected',
        message: 'ComWeChat reference API does not provide a correlatable final message ID; this adapter is receive-only.',
      })
    await expect(platform.sendMessage({} as never, { id: 'friend' }, { parts: [] }))
      .rejects.toBeInstanceOf(IMMessageSendRejectedError)
  })
})

describe('ComWeChatPlatform callback mapping', () => {
  it('maps a direct sender to a direct conversation and sender ID', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'direct-message', sender: 'friend', message: 'hello', timestamp: 1_700_000_000,
    })

    expect(event).toMatchObject({
      type: 'message', conversation: { id: 'friend', kind: 'direct' },
      message: { id: 'direct-message', conversationId: 'friend', senderId: 'friend', outgoing: false },
    })
  })

  it('maps a group callback sender as the conversation and wxid as the author', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'group-message', sender: 'room@chatroom', wxid: 'member', message: 'hello', timestamp: 1_700_000_000,
    })

    expect(event).toMatchObject({
      type: 'message', conversation: { id: 'room@chatroom', kind: 'group' },
      message: { conversationId: 'room@chatroom', senderId: 'member' },
    })
  })

  it('maps a desktop-originated direct callback as outgoing with self as its author', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'desktop-message', sender: 'friend', self: 'self', message: 'sent from desktop', isSendMsg: true, isSendByPhone: '0',
    })

    expect(event).toMatchObject({
      type: 'message', conversation: { id: 'friend', kind: 'direct' },
      message: { conversationId: 'friend', senderId: 'self', outgoing: true },
    })
  })

  it('maps a phone-originated direct callback as outgoing with self as its author', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'phone-message', sender: 'friend', self: 'self', message: 'sent from phone', isSendMsg: '1', isSendByPhone: true,
    })

    expect(event).toMatchObject({
      type: 'message', conversation: { id: 'friend', kind: 'direct' },
      message: { conversationId: 'friend', senderId: 'self', outgoing: true },
    })
  })

  it('maps a group outgoing callback with self as its author', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'group-outgoing', sender: 'room@chatroom', wxid: 'member', self: 'self', message: 'sent to group', isSendMsg: true,
    })

    expect(event).toMatchObject({
      type: 'message', conversation: { id: 'room@chatroom', kind: 'group' },
      message: { conversationId: 'room@chatroom', senderId: 'self', outgoing: true },
    })
  })

  it('uses the cached account ID when an outgoing callback omits self', async () => {
    const platform = platformWithResponses({
      '0': { is_login: 1 },
      '1': { data: { wxId: 'cached-self', nickname: 'Self' } },
    })
    await platform.getAccount()

    const event = mapCallback(platform, {
      type: 1, msgid: 'fallback-self', sender: 'friend', message: 'sent without callback self', isSendMsg: true,
    })

    expect(event).toMatchObject({ type: 'message', message: { senderId: 'cached-self', outgoing: true } })
  })

  it('maps a real incoming callback with false flags as incoming', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'incoming-message', sender: 'friend', message: 'received', isSendMsg: false, isSendByPhone: 0,
    })

    expect(event).toMatchObject({ type: 'message', message: { outgoing: false } })
  })

  it('normalizes millisecond callback timestamps to Unix seconds', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 1, msgid: 'timestamped', sender: 'friend', message: 'hello', timestamp: 1_700_000_123_456,
    })

    expect(event).toMatchObject({ type: 'message', message: { timestamp: 1_700_000_123 } })
  })

  it('maps a text callback to a text message part', () => {
    const event = mapCallback(platformWithResponses({}), { type: 1, msgid: 'text', sender: 'friend', message: 'plain text' })

    expect(event).toMatchObject({ type: 'message', message: { content: { parts: [{ type: 'text', text: 'plain text' }] } } })
  })

  it.each([
    [3, '[WeChat image attachment unavailable: local media import is disabled]'],
    [2004, '[WeChat file attachment unavailable: local media import is disabled]'],
  ])('degrades callback media type %s to safe text without importing its filepath', (type, text) => {
    const event = mapCallback(platformWithResponses({}), {
      type, msgid: `media-${type}`, sender: 'friend', filepath: '/arbitrary/untrusted/file', message: 'ignored',
    })

    expect(event).toMatchObject({ type: 'message', message: { content: { parts: [{ type: 'text', text }] } } })
  })

  it('degrades unsupported callback types to text instead of silently losing the message', () => {
    const event = mapCallback(platformWithResponses({}), {
      type: 999, msgid: 'unknown', sender: 'friend', filepath: '/arbitrary/untrusted/file', message: 'opaque payload',
    })

    expect(event).toMatchObject({
      type: 'message', message: { content: { parts: [{ type: 'text', text: '[WeChat unsupported message type 999]' }] } },
    })
  })
})
