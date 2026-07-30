import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import {
  IMMessageSendRejectedError, IMMessageTargetUnavailableError, PlatformMessageActions,
  type IMMedia, type PlatformSession,
} from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'
import { QQMediaCache } from './media-cache.js'
import type { QQMediaLocator } from './protocol.js'
import { QQStickerProvider } from './sticker-provider.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  sharp.cache(false)
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true, maxRetries: 20, retryDelay: 25,
  })))
})

describe('QQNTPlatform mapping', () => {
  it('uses the service environment token unless configuration overrides it', async () => {
    vi.stubEnv('QQNT_BRIDGE_TOKEN', 'service-token')
    const authorizations: Array<string | null> = []
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ ready: false, protocolVersion: 19 })
    }) as typeof globalThis.fetch

    await new QQNTPlatform({ fetch }).client.status()
    await new QQNTPlatform({ fetch, token: 'configured-token' }).client.status()

    expect(authorizations).toEqual(['Bearer service-token', 'Bearer configured-token'])
  })

  it('maps only the QQNT message endpoint permanent rejection to a platform send rejection', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        error: 'QQ message send rejected: 发送失败，请先添加对方为好友 (16)', result: 16,
      }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({
        error: 'QQ transport temporarily unavailable',
      }, { status: 500 })) as typeof globalThis.fetch
    const platform = new QQNTPlatform({ fetch })
    const send = () => platform.sendMessage(session, { id: 'u_non_friend' }, {
      parts: [{ type: 'text', text: 'hello' }],
    })

    try {
      await send()
      throw new Error('expected permanent QQ send rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(IMMessageSendRejectedError)
      expect(error).toMatchObject({
        reason: 'permission-denied',
        message: 'QQNT bridge 403: QQ message send rejected: 发送失败，请先添加对方为好友 (16)',
      })
    }
    try {
      await send()
      throw new Error('expected transient QQ send failure')
    } catch (error) {
      expect(error).not.toBeInstanceOf(IMMessageSendRejectedError)
      expect(error).toMatchObject({
        message: 'QQNT bridge 500: QQ transport temporarily unavailable',
      })
    }
  })

  it('resolves one conversation with its downloadable avatar for targeted bridge backfill', async () => {
    const platform = new QQNTPlatform()
    platform.client.getConversation = vi.fn(async () => ({
      id: '2:legacy-group', kind: 'group' as const, title: 'Legacy group',
      peerUid: 'legacy-group', peerUin: '123456', chatType: 2 as const,
      avatar: {
        id: 'legacy-avatar', kind: 'image' as const, mimeType: 'image/jpeg', size: 128,
        locator: {
          messageId: 'legacy-avatar-message', elementId: 'legacy-avatar-element',
          chatType: 2 as const, peerUid: 'legacy-group', kind: 'image' as const,
          fileName: 'legacy-avatar.jpg', fileUuid: 'legacy-avatar-uuid',
        },
      },
    }))

    await expect(platform.getConversation(session, '2:legacy-group')).resolves.toMatchObject({
      id: '2:legacy-group', kind: 'group', title: 'Legacy group',
      avatar: {
        id: 'legacy-avatar:original-v1', kind: 'image', mimeType: 'image/jpeg', size: 128,
        locator: {
          messageId: 'legacy-avatar-message', elementId: 'legacy-avatar-element',
          chatType: 2, peerUid: 'legacy-group', kind: 'image',
          fileName: 'legacy-avatar.jpg', fileUuid: 'legacy-avatar-uuid',
        },
      },
    })
    expect(platform.client.getConversation).toHaveBeenCalledWith('2:legacy-group')
  })

  it('does not wait indefinitely for reaction resources before returning history', async () => {
    const platform = new QQNTPlatform()
    let releaseCatalog!: () => void
    platform.client.getReactionCatalog = vi.fn(() => new Promise<Awaited<
      ReturnType<typeof platform.client.getReactionCatalog>
    >>((resolve) => {
      releaseCatalog = () => resolve({ available: [], reactions: [], maxSelected: 20 })
    }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'fast-history', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{ type: 'text' as const, text: 'ready' }],
    }] }))

    const started = performance.now()
    const history = await platform.getHistory(session, { id: '2:group' })
    releaseCatalog()

    expect(history.messages[0]).toMatchObject({ id: 'fast-history' })
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('reuses prepared dialog previews when a stale page refresh returns unchanged messages', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    const text = { type: 'text' as const, text: 'unchanged preview' }
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: '2:cached-group', kind: 'group' as const, title: 'Cached group',
      peerUid: 'cached-group', peerUin: 'cached-group', chatType: 2 as const,
      lastMessage: {
        id: 'preview-1', conversationId: '2:cached-group', senderId: 'alice',
        timestamp: 1, outgoing: false, parts: [text],
      },
    }] }))
    const prepare = vi.spyOn(platform as any, 'prepareRequestedMessage')

    await platform.getDialogs(session)
    expect(prepare).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(15_001)
    await platform.getDialogs(session)
    const refresh = [...(platform as any).dialogPageRefreshes.values()][0] as Promise<unknown>
    await refresh

    expect(platform.client.getDialogs).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('preserves QQ group msgSeq and replayMsgSeq as Telegram message IDs', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'opaque-qq-id', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      msgSeq: '5850634', telegramMessageId: 5850634, telegramReplyToMessageId: 5850632,
      parts: [{ type: 'text' as const, text: 'reply' }],
    }] }))

    await expect(platform.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{
        id: 'opaque-qq-id',
        metadata: {
          qqMsgSeq: '5850634', telegramMessageId: 5850634,
          telegramReplyToMessageId: 5850632, qqReplyToMsgSeq: '5850632',
        },
      }],
    })
  })

  it('maps native message-search pages and forwards every filter', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.searchMessages = vi.fn(async () => ({
      nextCursor: 'native-next',
      messages: [{
        id: 'found', conversationId: '2:group', senderId: 'alice', timestamp: 10, outgoing: false,
        parts: [{ type: 'text' as const, text: 'needle' }],
      }],
    }))

    await expect(platform.searchMessages(session, { id: '2:group' }, {
      query: 'needle', cursor: 'native-cursor', limit: 30, fromUserId: 'alice',
      minTimestamp: 5, maxTimestamp: 20, mediaKind: 'image',
    })).resolves.toMatchObject({
      messages: [{ id: 'found', content: { parts: [{ type: 'text', text: 'needle' }] } }],
      nextCursor: 'native-next',
    })
    expect(platform.client.searchMessages).toHaveBeenCalledWith('2:group', {
      q: 'needle', cursor: 'native-cursor', limit: 30, fromUserId: 'alice',
      minTimestamp: 5, maxTimestamp: 20, mediaKind: 'image',
    })
  })


  it('maps QQ wire serviceAction into IMMessage.content.serviceAction', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'system-tip', conversationId: '2:group', senderId: 'system', timestamp: 1, outgoing: false,
      serviceAction: { type: 'custom' as const, text: 'Alice joined the group' },
      parts: [],
    }] }))

    await expect(platform.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{
        id: 'system-tip',
        content: { serviceAction: { type: 'custom', text: 'Alice joined the group' }, parts: [] },
      }],
    })
  })

  it('preserves structured mini-app and share-card metadata instead of flattening it to text', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'mini-app-card', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{ type: 'card' as const, card: {
        kind: 'mini-app' as const, source: '腾讯文档', title: '项目排期', description: '本周项目安排',
        url: 'https://docs.qq.com/sheet/example', thumbnailUrl: 'https://cdn.example.com/cover.jpg',
      } }],
    }] }))

    await expect(platform.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{ content: { parts: [{ type: 'card', card: {
        kind: 'mini-app', source: '腾讯文档', title: '项目排期', description: '本周项目安排',
        url: 'https://docs.qq.com/sheet/example', thumbnailUrl: 'https://cdn.example.com/cover.jpg',
      } }] } }],
    })
  })

  it('filters reaction gray tips from history, search, direct lookup, and dialog previews by default', async () => {
    const platform = new QQNTPlatform()
    const reactionTip = {
      id: 'reaction-tip', conversationId: '2:group', senderId: 'alice', timestamp: 2, outgoing: false,
      serviceAction: { type: 'custom' as const, text: 'Alice回应了你的消息：hello' }, parts: [],
    }
    const memberTip = {
      id: 'member-tip', conversationId: '2:group', senderId: 'system', timestamp: 1, outgoing: false,
      serviceAction: { type: 'custom' as const, text: 'Alice加入了群聊' }, parts: [],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [reactionTip, memberTip] }))
    platform.client.searchMessages = vi.fn(async () => ({ messages: [reactionTip] }))
    platform.client.getMessage = vi.fn(async () => reactionTip)
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: '2:group', kind: 'group' as const, title: 'Group', peerUid: 'group', peerUin: 'group',
      chatType: 2 as const, lastMessage: reactionTip, readInboxMaxMessage: memberTip,
    }] }))

    await expect(platform.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{ id: 'member-tip' }],
    })
    await expect(platform.searchMessages(session, { id: '2:group' }, { query: '回应' }))
      .resolves.toMatchObject({ messages: [] })
    await expect(platform.getMessage(session, { id: '2:group' }, 'reaction-tip')).resolves.toBeNull()
    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{ lastMessage: undefined, readInboxMaxMessage: { id: 'member-tip' } }],
    })
  })

  it('lets an empty or replaced gray-tip filter list override the reaction default', async () => {
    const reactionTip = {
      id: 'reaction-tip', conversationId: '2:group', senderId: 'alice', timestamp: 2, outgoing: false,
      serviceAction: { type: 'custom' as const, text: 'Alice回应了你的消息：hello' }, parts: [],
    }
    const memberTip = {
      id: 'member-tip', conversationId: '2:group', senderId: 'system', timestamp: 1, outgoing: false,
      serviceAction: { type: 'custom' as const, text: 'Alice加入了群聊' }, parts: [],
    }
    const visible = new QQNTPlatform({ grayTipFilters: [] })
    visible.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    visible.client.getHistory = vi.fn(async () => ({ messages: [reactionTip] }))
    await expect(visible.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{ id: 'reaction-tip' }],
    })

    const replaced = new QQNTPlatform({ grayTipFilters: ['加入了群聊'] })
    replaced.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    replaced.client.getHistory = vi.fn(async () => ({ messages: [reactionTip, memberTip] }))
    await expect(replaced.getHistory(session, { id: '2:group' })).resolves.toMatchObject({
      messages: [{ id: 'reaction-tip' }],
    })
  })

  it('supplies the current QQ account identity and avatar to bridge', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 19, ready: true, selfUin: '10001', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'u_self', numericId: '10001', name: 'Platform Alice',
      signature: 'Self signature',
      avatar: {
        id: 'avatar-self', kind: 'image' as const, mimeType: 'image/jpeg',
        locator: {
          messageId: 'profile', elementId: 'avatar-self', chatType: 1 as const,
          peerUid: 'u_self', kind: 'image' as const, fileName: 'avatar.jpg',
        },
      },
    }))

    await expect(platform.getAccount()).resolves.toMatchObject({
      credentials: {},
      user: {
        id: 'u_self', firstName: 'Platform Alice', username: '10001', about: 'Self signature',
        avatar: { id: 'avatar-self:original-v1', kind: 'image' }, metadata: { qq: '10001' },
      },
    })
    expect(platform.client.getUser).toHaveBeenCalledWith('u_self')
  })

  it('refuses to invent an account while QQNT is not ready', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({ protocolVersion: 1, ready: false }))
    await expect(platform.getAccount()).rejects.toThrow('not ready')
  })

  it('rejects bridge protocols that can still fall back to local media downloads', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 15, ready: true, selfUin: '10001', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn()

    await expect(platform.getAccount()).rejects.toThrow('platform features require 19')
    expect(platform.client.getUser).not.toHaveBeenCalled()
  })

  it('edits QQ messages by recalling the old message and resending the replacement', async () => {
    const platform = new QQNTPlatform()
    platform.client.deleteMessages = vi.fn(async () => {})
    platform.client.sendMessage = vi.fn(async (_conversation, text) => ({
      id: 'replacement', conversationId: '2:group', senderId: 'self', timestamp: 20, outgoing: true,
      parts: [{ type: 'text' as const, text: text! }],
    }))
    const actions = new PlatformMessageActions(platform, session)

    const edited = await actions.edit({
      conversationId: '2:group', messageId: 'logical-old', targetId: 'opaque-native-old',
    }, { parts: [{ type: 'text', text: 'replacement text' }] })

    expect(platform.client.deleteMessages).toHaveBeenCalledWith('2:group', ['opaque-native-old'], true)
    expect(platform.client.sendMessage).toHaveBeenCalledOnce()
    expect(edited).toMatchObject({ message: { id: 'replacement' }, replacedMessageId: 'logical-old' })
  })

  it('forwards opaque read targets and clears the cached unread history anchor', async () => {
    const platform = new QQNTPlatform()
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: '2:group', kind: 'group' as const, title: 'Group',
      peerUid: 'group', peerUin: 'group', chatType: 2 as const,
      unreadCount: 3, firstUnread: { msgSeq: 'unread-seq', msgTime: '10' },
    }] }))
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [] }))
    platform.client.markRead = vi.fn(async () => {})
    await platform.getDialogs(session)

    await platform.markRead(session, { conversationId: '2:group', messageId: 'opaque/message' })
    await platform.getHistory(session, { id: '2:group' })

    expect(platform.client.markRead).toHaveBeenCalledWith('2:group', 'opaque/message')
    expect(platform.client.getHistory).toHaveBeenCalledWith('2:group', expect.objectContaining({
      aroundUnreadSeq: undefined,
    }))
  })

  it('downloads merged-forward files through the physical outer QQ conversation', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: 'outer-group', kind: 'group' as const, title: 'Outer group',
      peerUid: 'physical-group-uid', peerUin: '10001', chatType: 2 as const,
      lastMessage: {
        id: 'merged-root', conversationId: 'outer-group', senderId: 'alice', timestamp: 10, outgoing: false,
        parts: [{
          type: 'multi-forward' as const, title: '聊天记录',
          preview: 'Alice: hello\nBob: [图片]',
          locator: { conversationId: 'outer-group', rootMessageId: 'merged-root' },
        }],
      },
    }] }))
    const [dialog] = (await platform.getDialogs(session)).dialogs
    const link = dialog.lastMessage?.content.parts[0]
    if (link?.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    expect(link.entities[0].conversation.metadata).toMatchObject({
      virtual: true,
      qqMultiForwardPreview: 'Alice: hello\nBob: [图片]',
    })

    const archivedLocator = {
      messageId: 'archived-file-message', elementId: 'file-element', chatType: 2 as const,
      peerUid: 'archived-source-group', kind: 'file' as const, fileName: 'guide.xlsx',
      fileUuid: '/file-uuid', fileBizId: 104,
    }
    platform.client.getMultiForwardMessages = vi.fn(async () => [{
      id: 'archived-file-message', conversationId: 'archived-source-group',
      senderId: 'bob', timestamp: 9, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: { id: 'file-element', kind: 'file' as const, name: 'guide.xlsx', size: 8, locator: archivedLocator },
      }],
    }])
    platform.client.downloadFile = vi.fn(async function* () { yield new TextEncoder().encode('contents') })

    const history = await platform.getHistory(session, link.entities[0].conversation)
    const part = history.messages[0].content.parts[0]
    if (part.type !== 'media') throw new Error('merged forward file was not mapped')
    const chunks: Uint8Array[] = []
    for await (const chunk of platform.downloadMedia(session, part.media)) chunks.push(chunk)

    expect(part.media.locator).toEqual({
      ...archivedLocator, chatType: 2, peerUid: 'physical-group-uid',
    })
    expect(platform.client.downloadFile).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: 2, peerUid: 'physical-group-uid', fileUuid: '/file-uuid' }),
      { signal: undefined, offset: undefined, limit: undefined },
    )
    expect(chunks).toEqual([new TextEncoder().encode('contents')])
    expect(archivedLocator.peerUid).toBe('archived-source-group')
  })

  it('uses QQ merged forward only for multiple preserved-source messages', async () => {
    const platform = new QQNTPlatform()
    platform.client.forwardMessages = vi.fn(async (_from, ids, to, merged) => [{
      id: merged ? 'merged' : `forwarded-${ids[0]}`, conversationId: to,
      senderId: 'self', timestamp: 10, outgoing: true,
      parts: merged ? [{
        type: 'multi-forward' as const, title: 'Alice 和 Bob 的聊天记录',
        preview: 'Alice: first\nBob: second',
        locator: { conversationId: 'from', rootMessageId: 'merged' },
      }] : [{ type: 'text' as const, text: 'forwarded' }],
    }])

    await expect(platform.forwardMessages(session, { id: 'from' }, ['a'], { id: 'to' }))
      .resolves.toMatchObject([{ id: 'forwarded-a' }])
    const merged = await platform.forwardMessages(session, { id: 'from' }, ['a', 'b'], { id: 'to' })
    expect(merged).toMatchObject([{ id: 'merged', content: { parts: [{
      type: 'text', text: '查看聊天记录', entities: [{
        type: 'conversation-link', offset: 0, length: 6,
        conversation: {
          kind: 'group', title: 'Alice 和 Bob 的聊天记录',
          metadata: { qqMultiForwardPreview: 'Alice: first\nBob: second' },
        },
      }],
    }] } }])
    expect(platform.client.forwardMessages).toHaveBeenNthCalledWith(1, 'from', ['a'], 'to', false)
    expect(platform.client.forwardMessages).toHaveBeenNthCalledWith(2, 'from', ['a', 'b'], 'to', true)

    const link = merged[0].content.parts[0]
    if (link.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getMultiForwardMessages = vi.fn()
      .mockResolvedValueOnce([{
        id: 'nested-card', conversationId: 'archived-peer', senderId: 'alice', timestamp: 9, outgoing: false,
        parts: [{
          type: 'multi-forward' as const, title: '嵌套聊天记录',
          preview: 'Carol: nested',
          locator: { conversationId: 'from', rootMessageId: 'merged', parentMessageId: 'nested-card' },
        }],
      }])
      .mockResolvedValueOnce([{
        id: 'nested-message', conversationId: 'archived-peer', senderId: 'bob', timestamp: 8, outgoing: false,
        parts: [{ type: 'text' as const, text: 'nested content' }],
      }])
    const outerHistory = await platform.getHistory(session, link.entities[0].conversation)
    expect(outerHistory).toMatchObject({
      messages: [{
        id: 'nested-card', conversationId: link.entities[0].conversation.id,
        content: { parts: [{ type: 'text', text: '查看聊天记录' }] },
      }],
    })
    const nestedLink = outerHistory.messages[0].content.parts[0]
    if (nestedLink.type !== 'text' || nestedLink.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('nested merged forward link was not mapped')
    }
    await expect(platform.getHistory(session, nestedLink.entities[0].conversation)).resolves.toMatchObject({
      messages: [{
        id: 'nested-message', conversationId: nestedLink.entities[0].conversation.id,
        content: { parts: [{ type: 'text', text: 'nested content' }] },
      }],
    })
    expect(platform.client.getMultiForwardMessages).toHaveBeenNthCalledWith(1, {
      conversationId: 'from', rootMessageId: 'merged',
    })
    expect(platform.client.getMultiForwardMessages).toHaveBeenNthCalledWith(2, {
      conversationId: 'from', rootMessageId: 'merged', parentMessageId: 'nested-card',
    })
  })

  it('re-sends content instead of retaining QQ source attribution when dropAuthor is requested', async () => {
    const platform = new QQNTPlatform()
    platform.client.getMessage = vi.fn(async (_conversation, messageId) => ({
      id: messageId, conversationId: 'from', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{ type: 'text' as const, text: `copy ${messageId}` }],
    }))
    platform.client.forwardMessages = vi.fn()
    platform.client.sendMessage = vi.fn(async (_conversation, text) => ({
      id: `resent-${text}`, conversationId: 'to', senderId: 'self', timestamp: 2, outgoing: true,
      parts: [{ type: 'text' as const, text: text! }],
    }))

    const outputs = await platform.forwardMessages(
      session, { id: 'from' }, ['a', 'b'], { id: 'to' }, { dropAuthor: true },
    )
    expect(outputs.map((message) => message.id)).toEqual(['resent-copy a', 'resent-copy b'])
    expect(platform.client.forwardMessages).not.toHaveBeenCalled()
    expect(platform.client.getMessage).toHaveBeenCalledTimes(2)
  })

  it('copies authorized stored content when QQ rejects its native forward API', async () => {
    const platform = new QQNTPlatform()
    platform.client.forwardMessages = vi.fn(async () => {
      throw new Error('QQNT bridge 500: forwardMsg: forward failed (2004004)')
    })
    platform.client.getMessage = vi.fn()
    platform.client.sendMessage = vi.fn(async (_conversation, text) => ({
      id: `resent-${text}`, conversationId: 'to', senderId: 'self', timestamp: 2, outgoing: true,
      parts: [{ type: 'text' as const, text: text! }],
    }))

    const outputs = await platform.forwardMessages(
      session,
      { id: 'from' },
      ['native-a'],
      { id: 'to' },
      {
        sourceMessages: [{
          id: 'stored-a', conversationId: 'from', senderId: 'alice', timestamp: 1,
          content: { parts: [{ type: 'text', text: 'copy from relay store' }] },
        }],
      },
    )

    expect(outputs).toMatchObject([{ id: 'resent-copy from relay store' }])
    expect(platform.client.getMessage).not.toHaveBeenCalled()
    expect(platform.client.forwardMessages).toHaveBeenCalledWith('from', ['native-a'], 'to', false)
  })

  it('projects inline QQ faces as Telegram custom emoji data and restores their face index', async () => {
    const platform = new QQNTPlatform()
    const png = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 240, g: 190, b: 30, alpha: 1 } },
    }).png().toBuffer()
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [{
        key: '1:14', title: '微笑',
        presentation: {
          type: 'custom' as const, alt: '🙂',
          resource: {
            version: 1, format: 'static' as const, mimeType: 'image/png' as const,
            width: 16, height: 16, size: png.length, locator: { filePath: '/qq/s14.png' },
          },
        },
      }],
      reactions: [], maxSelected: 20,
    }))
    platform.client.downloadFile = vi.fn(async function* () { yield png })
    platform.client.getHistory = vi.fn(async () => ({
      messages: [{
        id: 'face-message', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
        parts: [{
          type: 'text' as const, text: '[微笑]',
          entities: [{ type: 'qq-face' as const, offset: 0, length: 4, faceId: '14', faceType: 1 }],
        }],
      }],
    }))

    const history = await platform.getHistory(session, { id: '2:group' })
    const text = history.messages[0].content.parts[0]
    expect(text).toMatchObject({
      type: 'text', text: '🙂',
      entities: [{ type: 'custom-emoji', offset: 0, length: 2, definition: { key: '1:14' } }],
    })

    platform.client.sendMessage = vi.fn(async () => ({
      id: 'sent-face', conversationId: '2:group', senderId: 'self', timestamp: 2, outgoing: true,
      parts: [{ type: 'text' as const, text: '🙂' }],
    }))
    await platform.sendMessage(session, { id: '2:group' }, { parts: [text as any] })
    expect((platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![6]).toMatchObject([{
      type: 'text', text: '🙂',
      entities: [{ type: 'qq-face', offset: 0, length: 2, faceId: '14', faceType: 1 }],
    }])
  })

  it('round-trips QQ mention entities and opaque reply IDs', async () => {
    const platform = new QQNTPlatform()
    platform.client.getUser = vi.fn(async (id) => ({ id, numericId: '12345', name: 'Alice' }))
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'sent', conversationId: '2:group', senderId: 'self', timestamp: 10, outgoing: true,
      replyToId: 'opaque-original',
      parts: [{
        type: 'text' as const, text: 'hello ',
      }, {
        type: 'text' as const, text: '@Alice',
        entities: [{ type: 'mention' as const, offset: 0, length: 6, userId: 'u_alice', numericId: '12345' }],
      }],
    }))

    const sent = await platform.sendMessage(session, { id: '2:group' }, {
      replyToId: 'opaque-original',
      replyToNativeSequence: '571',
      parts: [{
        type: 'text', text: 'hello @Alice',
        entities: [{ type: 'mention', offset: 6, length: 6, userId: 'u_alice' }],
      }],
    })

    const call = (platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(call[6]).toEqual([{
      type: 'text', text: 'hello @Alice',
      entities: [{ type: 'mention', offset: 6, length: 6, userId: 'u_alice', numericId: '12345' }],
    }])
    expect(call[7]).toBe('opaque-original')
    expect(call[8]).toBe('571')
    expect(platform.client.getUser).toHaveBeenCalledWith('u_alice')
    expect(sent).toMatchObject({
      replyToId: 'opaque-original',
      content: { parts: [{
        type: 'text', text: 'hello @Alice',
        entities: [{ type: 'mention', offset: 6, length: 6, userId: 'u_alice', numericId: '12345' }],
      }] },
    })
  })

  it('registers native sticker plans and maps QQ stickers back to the provider', async () => {
    const platform = new QQNTPlatform({}, 'qq-provider')
    const reference = {
      kind: 'market' as const, packageId: '42', stickerId: 'wave', name: 'Wave', key: 'secret',
      width: 320, height: 180, animated: true,
    }
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'sent-sticker', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'sticker' as const, sticker: {
        stickerId: 'market:42:wave', packId: '42', title: 'Wave',
        format: 'animated' as const, mimeType: 'image/gif', width: 320, height: 180,
        reference,
      } }],
    }))

    const sent = await platform.sendMessage(session, { id: 'u' }, { parts: [{
      type: 'sticker',
      sticker: {
        type: 'native', providerId: 'qq-provider', stickerId: 'market:42:wave', packId: '42',
        reference,
      },
    }] })

    expect((platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![5]).toEqual(reference)
    expect(sent.content.parts).toMatchObject([{
      type: 'sticker', sticker: {
        providerId: 'qq-provider', stickerId: 'market:42:wave', format: 'animated',
        locator: reference,
      },
    }])
  })

  it('materializes a sent animated sticker before returning the local echo', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-sent-sticker-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qq-provider', new QQMediaCache({ path: cachePath }))
    const gif = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 20, g: 80, b: 220, alpha: 1 } },
    }).gif().toBuffer()
    const reference = {
      kind: 'market' as const, packageId: '42', stickerId: 'wave', name: 'Wave', key: 'secret',
      width: 16, height: 12, animated: true,
    }
    let assetRequests = 0
    platform.client.stickerSource = vi.fn(() => ({
      size: gif.length,
      async *stream() {
        assetRequests++
        yield gif
      },
    }))
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'sent-sticker', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'sticker' as const, sticker: {
        stickerId: 'market:42:wave', packId: '42', title: 'Wave',
        format: 'animated' as const, mimeType: 'image/gif', width: 16, height: 12,
        reference,
      } }],
    }))

    const sent = await platform.sendMessage(session, { id: 'u' }, { parts: [{
      type: 'sticker',
      sticker: {
        type: 'native', providerId: 'qq-provider', stickerId: 'market:42:wave', packId: '42',
        reference,
      },
    }] })

    expect(sent.content.parts).toMatchObject([{
      type: 'sticker', sticker: {
        format: 'video', mimeType: 'video/webm', size: expect.any(Number),
        thumbnail: { mimeType: 'image/webp' },
      },
    }])
    const sticker = sent.content.parts[0]
    if (sticker.type !== 'sticker') throw new Error('missing sent sticker')
    expect(sticker.sticker.size).toBeGreaterThan(0)
    expect(assetRequests).toBe(1)
  }, 30_000)

  it('exposes QQ packs, assets, and native favorite mutation through the sticker provider', async () => {
    const platform = new QQNTPlatform()
    const provider = new QQStickerProvider(platform.client, 'qq-provider')
    const reference = {
      kind: 'favorite' as const, resId: 'fav', path: '/tmp/fav.png', name: 'fav.png',
      width: 1, height: 1, animated: false,
    }
    platform.client.getStickerPack = vi.fn(async () => ({
      packId: 'favorites', title: 'Favorites', stickers: [{
        stickerId: 'favorite:fav', format: 'static' as const, mimeType: 'image/png',
        width: 1, height: 1, reference,
      }],
    }))
    platform.client.stickerSource = vi.fn(() => ({ async *stream() { yield new Uint8Array([1, 2, 3]) } }))
    platform.client.setSavedSticker = vi.fn(async () => {})

    const pack = await provider.getPack({ session, platformKind: 'qq' }, 'favorites')
    expect(pack?.stickers[0]).toMatchObject({ providerId: 'qq-provider', stickerId: 'favorite:fav' })
    const asset = await provider.openAsset({ session, platformKind: 'qq' }, pack!.stickers[0])
    const chunks: number[] = []
    for await (const chunk of asset.source.stream()) chunks.push(...chunk)
    expect(chunks).toEqual([1, 2, 3])
    await provider.setSavedSticker({ session, platformKind: 'qq' }, pack!.stickers[0], true)
    expect(platform.client.setSavedSticker).toHaveBeenCalledWith(reference, true)
  })

  it('suppresses only the originating session listener echo', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    let wireHandler: ((event: any) => void | Promise<void>) | undefined
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      wireHandler = handler
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    platform.client.sendMessage = vi.fn(async (_conversation, _text, _media, _options, originRequestId) => ({
      id: 'sent', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
      originRequestId, parts: [{ type: 'text' as const, text: 'hello' }],
    }))
    const other = { ...session, platformSessionId: 'other-session' }
    const ownEvents: unknown[] = []
    const otherEvents: unknown[] = []
    const unsubscribeOwn = await platform.subscribe(session, (event) => { ownEvents.push(event) })
    const unsubscribeOther = await platform.subscribe(other, (event) => { otherEvents.push(event) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sent = await platform.sendMessage(session, { id: 'u' }, {
      parts: [{ type: 'text', text: 'hello' }],
    })
    const originRequestId = (platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![4]
    const echo = {
      type: 'message' as const,
      conversation: { id: 'u', kind: 'direct' as const, title: 'u', peerUid: 'u', peerUin: '1', chatType: 1 as const },
      message: {
        id: 'sent', conversationId: 'u', senderId: 'self', timestamp: 10, outgoing: true,
        originRequestId, parts: [{ type: 'text' as const, text: 'hello' }],
      },
    }
    // Each subscription owns a WebSocket connection; exercise the same wire event against both handlers.
    const handlers = (platform.client.subscribe as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])
    await handlers[0](echo)
    await handlers[1](echo)
    expect(sent.id).toBe('sent')
    expect(ownEvents).toEqual([])
    expect(otherEvents).toHaveLength(1)
    await unsubscribeOwn()
    await unsubscribeOther()
    expect(wireHandler).toBeTypeOf('function')
  })

  it('replaces a stale same-session subscription before opening the new WebSocket', async () => {
    const leaseSession = { ...session, platformSessionId: 'qq-session-exclusive-lease' }
    const first = new QQNTPlatform()
    const second = new QQNTPlatform()
    for (const platform of [first, second]) {
      platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
      platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    }
    const lifecycle: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const firstStopped = Promise.withResolvers<void>()
    let secondSignal: AbortSignal | undefined
    first.client.subscribe = vi.fn(async (_handler, signal) => {
      lifecycle.push('first-start')
      firstStarted.resolve()
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
      lifecycle.push('first-stop')
      firstStopped.resolve()
    })
    second.client.subscribe = vi.fn(async (_handler, signal) => {
      lifecycle.push('second-start')
      secondSignal = signal
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
      lifecycle.push('second-stop')
    })

    const unsubscribeFirst = await first.subscribe(leaseSession, () => {})
    await firstStarted.promise
    const unsubscribeSecond = await second.subscribe(leaseSession, () => {})
    await firstStopped.promise

    expect(lifecycle.slice(0, 3)).toEqual(['first-start', 'first-stop', 'second-start'])
    expect(first.client.subscribe).toHaveBeenCalledTimes(1)
    expect(second.client.subscribe).toHaveBeenCalledTimes(1)
    await unsubscribeFirst()
    expect(secondSignal?.aborted).toBe(false)
    await unsubscribeSecond()
    expect(secondSignal?.aborted).toBe(true)
  })

  it('exponentially backs off when the same stream event repeatedly fails', async () => {
    vi.useFakeTimers()
    const retrySession = { ...session, platformSessionId: 'qq-session-poison-event' }
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const wireEvent = {
      type: 'message' as const,
      conversation: {
        id: 'group', kind: 'group' as const, title: 'Group',
        peerUid: 'group', peerUin: '42', chatType: 2 as const,
      },
      message: {
        id: 'poison', conversationId: 'group', senderId: 'alice', timestamp: 1,
        outgoing: false, parts: [{ type: 'text' as const, text: 'poison' }],
      },
    }
    const subscribe = vi.spyOn(platform.client, 'subscribe').mockImplementation(async (handler, _signal, options) => {
      await handler(wireEvent, '329')
      options.onEventId?.('329')
    })

    const unsubscribe = await platform.subscribe(retrySession, () => {
      throw new Error('database generation disposed')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(3)
    expect(subscribe.mock.calls[1]?.[2]?.lastEventId).toBeUndefined()

    await unsubscribe()
  })

  it('suppresses live reaction gray tips while still forwarding the following reaction update', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    let wireHandler: ((event: any) => void | Promise<void>) | undefined
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      wireHandler = handler
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []
    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(wireHandler).toBeTypeOf('function'))
    const conversation = {
      id: '2:group', kind: 'group' as const, title: 'Group', peerUid: 'group', peerUin: 'group',
      chatType: 2 as const,
    }

    await wireHandler!({
      type: 'message', conversation,
      message: {
        id: 'reaction-tip', conversationId: '2:group', senderId: 'alice', timestamp: 2, outgoing: false,
        serviceAction: { type: 'custom', text: 'Alice回应了你的消息：hello' }, parts: [],
      },
    })
    await wireHandler!({
      type: 'message-reactions', eventId: 'reaction-now', conversation,
      target: { conversationId: '2:group', messageId: 'target', targetId: 'target' },
      context: { reactions: [{ key: '1:14', count: 1 }], maxSelected: 20 }, timestamp: 3,
    })

    expect(received).toMatchObject([{
      type: 'message-reactions', target: { messageId: 'target' },
      context: { reactions: [{ key: '1:14', count: 1 }] },
    }])
    await unsubscribe()
  })

  it('maps opaque QQ IDs and member roles without numeric coercion', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:user:u_very_long_opaque', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: {
        messageId: 'avatar:user:u_very_long_opaque', elementId: 'avatar:user:u_very_long_opaque',
        chatType: 1 as const, peerUid: 'u_very_long_opaque', kind: 'image' as const,
        fileName: '1715311957.jpg', avatarUin: '1715311957',
      },
    }
    platform.client.getDialogs = vi.fn(async () => ({
      total: 347,
      conversations: [{
        id: '2:1058754719', kind: 'group' as const, title: 'Test Group',
        peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const,
        participantCount: 42, selfRole: 'owner' as const,
        unreadCount: 7,
        firstUnread: { msgSeq: 'opaque-seq-42', msgTime: '1700000001' },
        readInboxMaxMessage: {
          id: 'read-42', conversationId: '2:1058754719', senderId: 'member',
          timestamp: 1_700_000_000, outgoing: false,
          parts: [{ type: 'text' as const, text: 'last read' }],
        },
      }],
    }))
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: {
          id: 'u_very_long_opaque', numericId: '1715311957',
          name: 'Profile Name', alias: 'Group Alias', avatar,
        },
        role: 'administrator' as const,
      }],
      total: 1,
    }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [] }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'self', numericId: '10000', name: 'Bridge',
    }))
    const dialogs = await platform.getDialogs(session)
    expect(dialogs.total).toBe(347)
    expect(dialogs.dialogs[0]).toMatchObject({
      conversation: {
        id: '2:1058754719', kind: 'group',
        metadata: {
          qqPeerUid: '1058754719', qq: '1058754719', chatType: 2,
          participantsCount: 42, qqSelfRole: 'owner',
        },
      },
      unreadCount: 7,
      readInboxMaxMessage: {
        id: 'read-42',
        content: { parts: [{ type: 'text', text: 'last read' }] },
      },
    })
    await platform.getHistory(session, { id: '2:1058754719' }, { limit: 50 })
    expect(platform.client.getHistory).toHaveBeenCalledWith('2:1058754719', {
      cursor: undefined,
      limit: 50,
      beforeId: undefined,
      afterId: undefined,
      aroundUnreadSeq: 'opaque-seq-42',
    })
    await expect(platform.getConversationMember(
      session, { id: '2:1058754719' }, 'self',
    )).resolves.toMatchObject({
      user: { id: 'self', firstName: 'Bridge' },
      role: 'owner',
      permissions: { manageMembers: true },
    })
    expect(platform.client.getMembers).not.toHaveBeenCalled()
    const members = await platform.getConversationMembers(session, { id: '2:1058754719' })
    expect(members.members[0]).toMatchObject({
      user: {
        id: 'u_very_long_opaque',
        firstName: 'Group Alias',
        username: '1715311957',
        avatar: { locator: { avatarUin: '1715311957' } },
        metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
      },
      role: 'administrator',
      permissions: { manageMembers: true, editAnyMessage: true },
    })
  })

  it('allows owners and administrators to edit any message but not regular members', async () => {
    const platform = new QQNTPlatform()
    platform.client.getMembers = vi.fn(async () => ({
      members: [
        { user: { id: 'owner', name: 'Owner' }, role: 'owner' as const },
        { user: { id: 'admin', name: 'Admin' }, role: 'administrator' as const },
        { user: { id: 'member', name: 'Member' }, role: 'member' as const },
      ],
      total: 3,
    }))

    const page = await platform.getConversationMembers(session, { id: 'group' })

    expect(page.members.map(({ role, permissions }) => ({
      role,
      editAnyMessage: permissions?.editAnyMessage,
    }))).toEqual([
      { role: 'owner', editAnyMessage: true },
      { role: 'administrator', editAnyMessage: true },
      { role: 'member', editAnyMessage: false },
    ])
  })

  it('can use the profile nickname instead of a conversation-scoped group alias', async () => {
    const platform = new QQNTPlatform({ memberName: 'nickname' })
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: {
          id: 'member', numericId: '42', name: 'Profile Name', alias: 'Group Alias',
        },
        role: 'member' as const,
      }],
      total: 1,
    }))
    await expect(platform.getConversationMembers(session, { id: 'group' })).resolves.toMatchObject({
      members: [{ user: {
        firstName: 'Profile Name',
        metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
      } }],
    })
  })

  it('does not scan the full member list when a self-role probe arrives before group metadata', async () => {
    const platform = new QQNTPlatform()
    platform.client.getMembers = vi.fn(async () => ({ members: [], total: 0 }))
    await expect(platform.getConversationMember(
      session, { id: 'cold-group' }, session.userId,
    )).resolves.toBeNull()
    expect(platform.client.getMembers).not.toHaveBeenCalled()
  })

  it('keeps the buddy address book separate and maps QQ signatures in contacts and user profiles', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:user:u1', kind: 'image' as const, name: 'avatar.png', size: 12,
      locator: {
        messageId: 'avatar:u1', elementId: 'avatar:u1', chatType: 1 as const,
        peerUid: 'u1', kind: 'image' as const, fileName: 'avatar.png', filePath: '/tmp/avatar.png',
      },
    }
    platform.client.getContacts = vi.fn(async () => ({
      users: [{ id: 'u1', numericId: '10001', name: 'Friend', signature: 'QQ signature', avatar }],
    }))
    const contacts = await platform.getContacts(session, { limit: 500 })
    expect(contacts.users).toMatchObject([{
      id: 'u1', firstName: 'Friend', username: '10001', about: 'QQ signature',
      avatar: { id: 'avatar:user:u1:original-v1', locator: { filePath: '/tmp/avatar.png' } },
    }])
    platform.client.getUser = vi.fn(async () => ({
      id: 'u1', numericId: '10001', name: 'Friend', signature: 'Updated signature', avatar,
    }))
    await expect(platform.getUser(session, 'u1')).resolves.toMatchObject({
      id: 'u1', firstName: 'Friend', username: '10001', about: 'Updated signature',
      avatar: { id: 'avatar:user:u1:original-v1', locator: { filePath: '/tmp/avatar.png' } },
    })
    expect(platform.client.getUser).toHaveBeenCalledWith('u1')

    platform.client.getUser = vi.fn(async () => ({
      id: 'u1', numericId: '10001', name: 'Friend', signature: null as unknown as string,
    }))
    await expect(platform.getUser(session, 'u1')).resolves.toMatchObject({
      id: 'u1', firstName: 'Friend', about: undefined,
    })
  })

  it('keeps cached conversation identity fields when an incremental event is incomplete', async () => {
    const platform = new QQNTPlatform()
    const avatar = {
      id: 'avatar:group:1058754719', kind: 'image' as const,
      locator: {
        messageId: 'avatar:group:1058754719', elementId: 'avatar:group:1058754719',
        chatType: 2 as const, peerUid: '1058754719', kind: 'image' as const,
        fileName: 'group.png', filePath: '/tmp/group.png',
      },
    }
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [{
        id: '1058754719', kind: 'group' as const, title: 'Bridge Test Group',
        peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const, avatar,
      }],
    }))
    await platform.getDialogs(session)
    const received = Promise.withResolvers<unknown>()
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [], reactions: [], maxSelected: 20,
    }))
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      await handler({
        type: 'message',
        conversation: {
          id: '1058754719', kind: 'group', title: '1058754719',
          peerUid: '1058754719', peerUin: '1058754719', chatType: 2,
        },
        message: {
          id: 'm1', conversationId: '1058754719', senderId: 'member',
          sender: {
            id: 'member', numericId: '42', name: 'Profile Name', alias: 'Group Alias',
            avatar: {
              id: 'avatar:user:member', kind: 'image', mimeType: 'image/jpeg',
              locator: {
                messageId: 'avatar:user:member', elementId: 'avatar:user:member',
                chatType: 1, peerUid: 'member', kind: 'image',
                fileName: '42.jpg', avatarUin: '42',
              },
            },
          },
          timestamp: 1, outgoing: false, parts: [{ type: 'text', text: 'hello' }],
        },
      })
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => received.resolve(event))

    await expect(received.promise).resolves.toMatchObject({
      type: 'message',
      conversation: {
        title: 'Bridge Test Group',
        avatar: { id: 'avatar:group:1058754719:original-v1', locator: { filePath: '/tmp/group.png' } },
      },
      message: {
        sender: {
          firstName: 'Group Alias',
          username: '42',
          avatar: { locator: { avatarUin: '42' } },
          metadata: { qqName: 'Profile Name', qqGroupAlias: 'Group Alias' },
        },
      },
    })
    await unsubscribe()
  })

  it('keeps received images in their original format and reuses database-style previews by QQ hash', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-auto-media-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qqnt:stickers', new QQMediaCache({
      path: cachePath, previewMaxDimension: 6,
    }))
    const png = await sharp({
      create: { width: 12, height: 8, channels: 4, background: { r: 30, g: 90, b: 180, alpha: 1 } },
    }).png().toBuffer()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.downloadFile = vi.fn(async function* () { yield png })
    const wireMessage = (id: string) => ({
      id, conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: `media-${id}`, kind: 'image' as const, name: 'photo.png', mimeType: 'image/png',
          size: png.length, width: 12, height: 8,
          locator: {
            messageId: id, elementId: `element-${id}`, chatType: 2 as const, peerUid: 'group',
            kind: 'image' as const, fileName: 'photo.png', md5: 'ABCDEF012345',
          },
        },
      }],
    })
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      for (const id of ['first', 'second']) await handler({
        type: 'message',
        conversation: {
          id: '2:group', kind: 'group', title: 'Group', peerUid: 'group', peerUin: '42', chatType: 2,
        },
        message: wireMessage(id),
      })
      if (signal.aborted) return
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []
    const ready = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      received.push(event)
      if (received.length === 2) ready.resolve()
    })
    await ready.promise
    await unsubscribe()

    expect(platform.client.downloadFile).toHaveBeenCalledTimes(2)
    expect(received).toHaveLength(2)
    for (const event of received as any[]) expect(event.message.content.parts[0]).toMatchObject({
      media: {
        name: 'photo.png', mimeType: 'image/png',
        locator: expect.not.objectContaining({ cachedPath: expect.anything() }),
        preview: {
          mimeType: 'image/webp', width: 6, height: 4,
          locator: { previewKey: expect.any(String) },
        },
      },
    })
  })

  it('does not resolve a generated preview to the original QQ image URL', async () => {
    const platform = new QQNTPlatform()
    platform.client.resolveFileUrl = vi.fn(async () => ({
      url: 'https://cdn.example.test/original.png', expiresAt: Date.now() + 60_000,
    }))
    const original: IMMedia<QQMediaLocator> = {
      id: 'image', kind: 'image', mimeType: 'image/png', size: 6_705_675,
      locator: {
        messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
        kind: 'image', fileName: 'original.png', fileUuid: 'uuid',
      },
    }
    const preview: IMMedia<QQMediaLocator> = {
      ...original, id: 'image:preview', mimeType: 'image/webp', size: 13_906,
      locator: { ...original.locator!, previewKey: 'generated-preview' },
    }

    await expect(platform.resolveMediaUrl(session, original)).resolves.toMatchObject({
      url: 'https://cdn.example.test/original.png', supportsRange: true,
    })
    await expect(platform.resolveMediaUrl(session, preview)).resolves.toBeUndefined()
    expect(platform.client.resolveFileUrl).toHaveBeenCalledTimes(1)
  })

  it('returns uncached history images as same-size empty placeholders and edits them when ready', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-history-placeholder-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qqnt:stickers', new QQMediaCache({
      path: cachePath, previewMaxDimension: 6,
    }))
    const jpeg = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).jpeg().toBuffer()
    const releaseDownload = Promise.withResolvers<void>()
    const downloadStarted = Promise.withResolvers<void>()
    const edited = Promise.withResolvers<any>()
    const wireMessage = {
      id: 'history-image', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: 'history-media', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg',
          size: jpeg.length, width: 12, height: 8,
          locator: {
            messageId: 'history-image', elementId: 'history-media', chatType: 2 as const,
            peerUid: 'group', kind: 'image' as const, fileName: 'photo.jpg', md5: 'HISTORY-JPEG',
          },
        },
      }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.downloadFile = vi.fn(async function* () {
      downloadStarted.resolve()
      await releaseDownload.promise
      yield jpeg
    })
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type === 'message-edit') edited.resolve(event)
    })

    const history = await platform.getHistory(session, { id: '2:group' })
    const placeholder = (history.messages[0].content.parts[0] as any).media
    expect(placeholder).toMatchObject({
      kind: 'image', size: jpeg.length, width: 12, height: 8,
      locator: { deferred: true },
    })
    const placeholderBytes: Uint8Array[] = []
    for await (const chunk of platform.downloadMedia(session, placeholder)) placeholderBytes.push(chunk)
    expect(placeholderBytes).toEqual([])

    await downloadStarted.promise
    releaseDownload.resolve()
    const update = await edited.promise
    expect(update).toMatchObject({
      type: 'message-edit',
      eventId: 'qqnt-media-ready-v1:2:group:history-image',
      message: { content: { parts: [{ media: {
        kind: 'image', size: jpeg.length, width: 12, height: 8,
        locator: expect.not.objectContaining({ deferred: expect.anything() }),
        preview: { mimeType: 'image/webp', width: 6, height: 4 },
      } }] } },
    })

    const cached = await platform.getHistory(session, { id: '2:group' })
    expect((cached.messages[0].content.parts[0] as any).media.locator).not.toHaveProperty('deferred')
    expect(platform.client.downloadFile).toHaveBeenCalledTimes(1)
    await unsubscribe()
  })

  it('publishes an animated image first, then edits it to immutable cached WebM', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-animated-upgrade-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qqnt:stickers', new QQMediaCache({
      path: cachePath, previewMaxDimension: 8,
    }))
    const gif = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 120, g: 40, b: 210, alpha: 1 } },
    }).gif().toBuffer()
    const wireMessage = {
      id: 'animated-message', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: 'animated-media', kind: 'image' as const, name: 'animation.gif', mimeType: 'image/gif',
          size: gif.length, width: 16, height: 12,
          locator: {
            messageId: 'animated-message', elementId: 'animated-media', chatType: 2 as const,
            peerUid: 'group', kind: 'image' as const, fileName: 'animation.gif', md5: 'ANIMATED123',
          },
        },
      }],
    }
    const wireConversation = {
      id: '2:group', kind: 'group' as const, title: 'Group',
      peerUid: 'group', peerUin: '42', chatType: 2 as const,
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.downloadFile = vi.fn(async function* () { yield gif })
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      await handler({ type: 'message', conversation: wireConversation, message: wireMessage })
      if (signal.aborted) return
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const events: any[] = []
    const upgraded = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      events.push(event)
      if (event.type === 'message-edit') upgraded.resolve()
    })

    await upgraded.promise
    const history = await platform.getHistory(session, { id: '2:group' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await unsubscribe()

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'message',
      message: { content: { parts: [{ media: {
        id: 'animated-media:original-v1', kind: 'image', mimeType: 'image/gif',
        locator: expect.not.objectContaining({ cachedPath: expect.anything() }),
      } }] } },
    })
    expect(events[1]).toMatchObject({
      type: 'message-edit',
      eventId: 'qqnt-media-webm-v1:2:group:animated-message',
      message: { content: { parts: [{ media: {
        id: 'animated-media:original-v1:webm-v1', kind: 'file', mimeType: 'video/webm',
        locator: { cachedPath: expect.stringMatching(/\.webm$/) },
      } }] } },
    })
    expect(history.messages[0]).toMatchObject({
      content: { parts: [{ media: { id: 'animated-media:original-v1:webm-v1', mimeType: 'video/webm' } }] },
    })
    expect(platform.client.downloadFile).toHaveBeenCalledTimes(2)
  }, 30_000)

  it('returns uncached history stickers as empty placeholders and edits them when ready', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-history-sticker-placeholder-'))
    temporaryDirectories.push(cachePath)
    const cache = new QQMediaCache({ path: cachePath, previewMaxDimension: 8 })
    const platform = new QQNTPlatform({}, 'qqnt:stickers', cache)
    const provider = new QQStickerProvider(platform.client, 'qqnt:stickers', cache)
    const png = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 70, g: 150, b: 220, alpha: 1 } },
    }).png().toBuffer()
    const releaseSource = Promise.withResolvers<void>()
    const sourceStarted = Promise.withResolvers<void>()
    const edited = Promise.withResolvers<any>()
    const wireMessage = {
      id: 'history-sticker', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'sticker' as const,
        sticker: {
          stickerId: 'favorite:history-sticker', title: 'History sticker',
          format: 'static' as const, mimeType: 'image/png', width: 16, height: 12, size: png.length,
          reference: {
            kind: 'favorite' as const, resId: 'history-sticker', path: '/saved/history.png',
            name: 'history.png', animated: false as const,
          },
        },
      }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.stickerSource = vi.fn(() => ({
      size: png.length,
      async *stream() {
        sourceStarted.resolve()
        await releaseSource.promise
        yield png
      },
    }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type === 'message-edit') edited.resolve(event)
    })

    const history = await platform.getHistory(session, { id: '2:group' })
    const part = history.messages[0].content.parts[0]
    if (part.type !== 'sticker') throw new Error('missing history sticker placeholder')
    expect(part.sticker).toMatchObject({
      stickerId: 'favorite:history-sticker', format: 'static', mimeType: 'image/webp',
      size: 0, locator: { deferred: true },
    })
    const callsBeforePlaceholderRead = vi.mocked(platform.client.stickerSource).mock.calls.length
    const placeholderAsset = await provider.openAsset({ session, platformKind: 'qq' }, part.sticker)
    const placeholderBytes: Uint8Array[] = []
    for await (const chunk of placeholderAsset.source.stream()) placeholderBytes.push(chunk)
    expect(placeholderAsset.size).toBe(0)
    expect(placeholderBytes).toEqual([])
    expect(platform.client.stickerSource).toHaveBeenCalledTimes(callsBeforePlaceholderRead)

    await sourceStarted.promise
    releaseSource.resolve()
    const update = await edited.promise
    expect(update).toMatchObject({
      type: 'message-edit',
      eventId: 'qqnt-media-ready-v1:2:group:history-sticker',
      message: { content: { parts: [{ sticker: {
        stickerId: 'favorite:history-sticker', format: 'static', mimeType: 'image/webp',
        size: expect.any(Number),
        locator: expect.not.objectContaining({ deferred: expect.anything() }),
        thumbnail: { mimeType: 'image/webp', width: 8, height: 6 },
      } }] } },
    })

    const cached = await platform.getHistory(session, { id: '2:group' })
    expect(cached.messages[0].content.parts[0]).toMatchObject({
      sticker: { size: expect.any(Number), locator: expect.not.objectContaining({ deferred: expect.anything() }) },
    })
    expect(platform.client.stickerSource).toHaveBeenCalledTimes(1)
    await unsubscribe()
  })

  it('projects QQ animated system faces as WebM video stickers without leaking fallback text', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-message-sticker-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qqnt:stickers', new QQMediaCache({ path: cachePath }))
    const gif = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 120, g: 40, b: 210, alpha: 1 } },
    }).gif().toBuffer()
    platform.client.stickerSource = vi.fn(() => ({
      size: gif.length, async *stream() { yield gif },
    }))
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'sticker-message', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'sticker' as const,
        sticker: {
          stickerId: 'sysface:476', title: '/不是吧',
          format: 'animated' as const, mimeType: 'image/apng', width: 240, height: 240,
          reference: {
            kind: 'sysface' as const, faceId: '476', faceType: 3, name: '/不是吧',
            packId: '3', stickerId: '476', stickerType: 2, resultId: 'result-476', animated: true as const,
          },
        },
      }],
    }] }))

    const history = await platform.getHistory(session, { id: '2:group' })
    expect(history.messages[0].content.parts).toMatchObject([{
      type: 'sticker', sticker: {
        stickerId: 'sysface:476', title: '/不是吧',
        format: 'video', mimeType: 'video/webm', size: expect.any(Number),
        thumbnail: { mimeType: 'image/webp' },
        locator: {
          kind: 'sysface', faceId: '476', faceType: 3, packId: '3',
          stickerId: '476', stickerType: 2, resultId: 'result-476',
        },
      },
    }])
    const part = history.messages[0].content.parts[0]
    if (part.type !== 'sticker') throw new Error('missing history sticker')
    expect(part.sticker.size).toBeGreaterThan(0)
  })

  it('caches catalog-keyed static and animated reactions without exposing bridge paths', async () => {
    const cachePath = await mkdtemp(join(tmpdir(), 'qqnt-reaction-cache-'))
    temporaryDirectories.push(cachePath)
    const platform = new QQNTPlatform({}, 'qqnt:stickers', new QQMediaCache({ path: cachePath }))
    const png = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 80, g: 140, b: 220, alpha: 1 } },
    }).png().toBuffer()
    const apng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAABAAAAAQBPJcTWAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAMAAAACAAAAAAAAAAAAAEACgAAGya3gAAAABRJREFUeJxj+MPA8J8UzDCqgRYaAJjXviFq8lROAAAAGmZjVEwAAAABAAAADAAAAAgAAAAAAAAAAAABAAoAAIBVXVQAAAAXZmRBVAAAAAJ4nGNgYPj7nzQ8qoEGGgAlJ76BvcErGQAAAABJRU5ErkJggg==',
      'base64',
    )
    const context = {
      available: [{
        key: '2:128522', title: '嘿嘿',
        presentation: { type: 'emoji' as const, emoticon: '😊' },
      }, {
        key: '1:265', title: '辣眼睛',
        presentation: {
          type: 'custom' as const, alt: '[辣眼睛]',
          resource: {
            version: 1, format: 'static' as const, mimeType: 'image/png' as const,
            width: 200, height: 200, size: png.length, locator: { reactionKey: '1:265' },
          },
        },
      }, {
        key: '1:14', title: '微笑',
        presentation: {
          type: 'custom' as const, alt: '[微笑]',
          resource: {
            version: 2, format: 'video' as const, mimeType: 'video/webm' as const,
            width: 128, height: 128, size: apng.length, locator: { reactionKey: '1:14' },
          },
        },
      }],
      reactions: [{ key: '2:128522', count: 2, selected: true }],
      maxSelected: 20,
    }
    platform.client.getReactionCatalog = vi.fn(async () => context)
    platform.client.downloadFile = vi.fn()
    platform.client.downloadReactionResource = vi.fn(async function* (reactionKey) {
      expect(reactionKey === '1:265' || reactionKey === '1:14').toBe(true)
      yield reactionKey === '1:265' ? png : apng
    })
    platform.client.getMessageReactions = vi.fn(async () => ({
      reactions: [{
        ...context.reactions[0],
        recentActors: [{ userId: 'actor-a' }, { userId: 'actor-b' }],
      }],
      maxSelected: 20,
    }))
    platform.client.setMessageReactions = vi.fn(async () => ({
      reactions: [{ key: '1:14', count: 1, selected: true }], maxSelected: 20,
    }))
    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:g' })
    expect(catalog).toMatchObject({
      available: [{
        key: '2:128522',
      }, {
        key: '1:265',
        presentation: {
          resource: { format: 'static', mimeType: 'image/webp', width: 100, height: 100 },
        },
      }, {
        key: '1:14',
        presentation: {
          resource: { format: 'video', mimeType: 'video/webm', width: 100, height: 100 },
        },
      }],
    })
    const custom = catalog.available[1]!
    if (custom.presentation.type !== 'custom') throw new Error('expected custom reaction')
    const customResource = custom.presentation.resource
    const cachedChunks: Uint8Array[] = []
    for await (const chunk of platform.downloadReactionResource(
      session, customResource, { offset: 8, limit: 4 },
    )) cachedChunks.push(chunk)
    expect(Buffer.concat(cachedChunks)).toHaveLength(4)
    expect(platform.client.downloadFile).not.toHaveBeenCalled()
    expect(platform.client.downloadReactionResource).toHaveBeenCalledTimes(2)
    await expect(platform.getMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    })).resolves.toMatchObject({ reactions: [{
      key: '2:128522', selected: true,
      recentActors: [{ userId: 'actor-a' }, { userId: 'actor-b' }],
    }] })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    }, ['1:14'])).resolves.toMatchObject({ reactions: [{ key: '1:14', selected: true }] })
    expect(platform.client.getMessageReactions).toHaveBeenCalledWith('2:g', 'm', '571')
    expect(platform.client.setMessageReactions).toHaveBeenCalledWith('2:g', 'm', ['1:14'], '571')
    platform.client.setMessageReactions = vi.fn(async () => {
      throw new Error('QQNT bridge 500: QQ database is temporarily busy')
    })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    }, ['1:14'])).rejects.toThrow('QQNT bridge 500: QQ database is temporarily busy')
    platform.client.setMessageReactions = vi.fn(async () => {
      throw new Error('QQNT bridge 404: QQ reaction target not found: m')
    })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    }, ['1:14'])).rejects.toBeInstanceOf(IMMessageTargetUnavailableError)
    await expect(platform.getAvailableReactions(session, { conversationId: '1:u' }))
      .resolves.toEqual({ available: [], reactions: [], maxSelected: 0 })
    expect(platform.client.getReactionCatalog).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('streams catalog-keyed reaction resources when no media cache is configured', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [{
        key: '1:14',
        presentation: {
          type: 'custom' as const, alt: '[微笑]',
          resource: {
            version: 2, format: 'video' as const, mimeType: 'video/webm' as const,
            width: 128, height: 128, size: 12, locator: { reactionKey: '1:14' },
          },
        },
      }],
      reactions: [], maxSelected: 20,
    }))
    const onProgress = vi.fn()
    platform.client.downloadReactionResource = vi.fn(async function* (reactionKey, options) {
      expect(reactionKey).toBe('1:14')
      expect(options).toMatchObject({ offset: 4, limit: 3 })
      await options.onChunk?.(2)
      yield Uint8Array.of(1, 2)
      await options.onChunk?.(1)
      yield Uint8Array.of(3)
    })

    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:g' })
    const definition = catalog.available[0]!
    if (definition.presentation.type !== 'custom') throw new Error('expected custom reaction')
    const chunks: Uint8Array[] = []
    for await (const chunk of platform.downloadReactionResource(
      session, definition.presentation.resource, { offset: 4, limit: 3, onProgress },
    )) chunks.push(chunk)

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]))
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: 'download', mediaIndex: 0, transferredBytes: 3, totalBytes: 12,
    })
  })

  it('streams remote reaction resources when no media cache is configured', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({
      available: [{
        key: '1:14',
        presentation: {
          type: 'custom' as const,
          alt: '[微笑]',
          resource: {
            version: 2, format: 'static' as const, mimeType: 'image/png' as const,
            width: 100, height: 100, size: 12,
            locator: {
              messageId: 'reaction-message', elementId: 'reaction-element', chatType: 2 as const,
              peerUid: '1002974327', kind: 'image' as const, fileName: 's14.png',
              originImageUrl: 'https://multimedia.nt.qq.com.cn/download?fileid=s14',
            },
          },
        },
      }],
      reactions: [],
      maxSelected: 20,
    }))
    const onProgress = vi.fn()
    platform.client.downloadFile = vi.fn(async function* (locator, options) {
      expect(locator).toMatchObject({
        messageId: 'reaction-message', fileName: 's14.png',
        originImageUrl: 'https://multimedia.nt.qq.com.cn/download?fileid=s14',
      })
      expect(options).toMatchObject({ signal: undefined })
      yield Uint8Array.of(9, 9, 9, 9, 1, 2, 3, 8)
    })

    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:g' })
    const definition = catalog.available[0]!
    if (definition.presentation.type !== 'custom') throw new Error('expected custom reaction')
    const chunks: Uint8Array[] = []
    for await (const chunk of platform.downloadReactionResource(
      session, definition.presentation.resource, { offset: 4, limit: 3, onProgress },
    )) chunks.push(chunk)

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]))
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'download', mediaIndex: 0, transferredBytes: 3, totalBytes: 12,
    })
  })

  it('maps sent media locators and streams downloads with progress', async () => {
    const platform = new QQNTPlatform()
    const locator = {
      messageId: 'm', elementId: 'e', chatType: 1 as const, peerUid: 'u',
      kind: 'file' as const, fileName: 'x.bin',
    }
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'm', conversationId: '1:u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'media' as const, media: {
        id: 'e', kind: 'file' as const, name: 'clip.mp4', mimeType: 'video/mp4',
        size: 3, width: 1280, height: 720, duration: 12, locator,
      } }],
    }))
    const sent = await platform.sendMessage(session, { id: '1:u' }, {
      parts: [{ type: 'media', media: {
        kind: 'file', name: 'clip.mp4', mimeType: 'video/mp4', size: 3,
        width: 1280, height: 720, duration: 12,
        source: { size: 3, async *stream() { yield new Uint8Array([1, 2, 3]) } },
      } }],
    })
    expect(sent.content.parts[0]).toMatchObject({ media: {
      mimeType: 'video/mp4', width: 1280, height: 720, duration: 12, locator,
    } })

    platform.client.downloadFile = vi.fn(async function* (_locator, options) {
      expect(options).toMatchObject({ offset: 1, limit: 2 })
      yield new Uint8Array([2])
      yield new Uint8Array([3])
    })
    const progress: number[] = []
    const chunks: number[] = []
    for await (const chunk of platform.downloadMedia(session, {
      id: 'e', kind: 'file', size: 3, locator,
    }, { offset: 1, limit: 2, onProgress: (item) => { progress.push(item.transferredBytes) } })) chunks.push(...chunk)
    expect(chunks).toEqual([2, 3])
    expect(progress).toEqual([1, 2])
  })

  it('infers video MIME types for QQ file elements without changing ordinary documents', async () => {
    const platform = new QQNTPlatform()
    platform.client.getHistory = vi.fn(async () => ({ messages: [{
      id: 'file-video-message', conversationId: '2:group', senderId: 'alice', timestamp: 10, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: 'file-video', kind: 'file' as const, name: 'FILE-SENT.MP4', size: 2_097_152,
          locator: {
            messageId: 'file-video-message', elementId: 'file-video', chatType: 2 as const,
            peerUid: 'group', kind: 'file' as const, fileName: 'FILE-SENT.MP4',
          },
        },
      }, {
        type: 'media' as const,
        media: {
          id: 'document', kind: 'file' as const, name: 'report.pdf', size: 4096,
          locator: {
            messageId: 'file-video-message', elementId: 'document', chatType: 2 as const,
            peerUid: 'group', kind: 'file' as const, fileName: 'report.pdf',
          },
        },
      }],
    }] }))

    const history = await platform.getHistory(session, { id: '2:group' })
    expect(history.messages[0].content.parts).toMatchObject([
      { type: 'media', media: { name: 'FILE-SENT.MP4', mimeType: 'video/mp4' } },
      { type: 'media', media: { name: 'report.pdf' } },
    ])
    const document = history.messages[0].content.parts[1]
    if (document.type !== 'media') throw new Error('ordinary document was not mapped')
    expect(document.media.mimeType).toBeUndefined()
  })

  it('keeps multiple image parts in one QQ send plan', async () => {
    const platform = new QQNTPlatform()
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'multi', conversationId: '1:u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [],
    }))
    const source = (value: number) => ({
      size: 1,
      async *stream() { yield Uint8Array.of(value) },
    })

    await platform.sendMessage(session, { id: '1:u' }, { parts: [{
      type: 'media', media: { kind: 'image', name: 'one.png', source: source(1) },
    }, {
      type: 'media', media: { kind: 'image', name: 'two.png', source: source(2) },
    }] })

    const media = (platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![2]
    expect(media).toMatchObject([{ name: 'one.png' }, { name: 'two.png' }])
    expect(platform.capabilities.send?.maxMedia).toBe(9)
  })
})

describe('QQNTPlatform dialogs polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function conversation(id: string, withLastMessage = true, originRequestId?: string) {
    return {
      id,
      kind: 'group' as const,
      title: id,
      peerUid: id,
      peerUin: id,
      chatType: 2 as const,
      ...(withLastMessage ? {
        lastMessage: {
          id: `${id}-message`, conversationId: id, senderId: 'member', timestamp: 1, outgoing: false,
          originRequestId, parts: [{ type: 'text' as const, text: id }],
        },
      } : {}),
    }
  }

  function mockSubscribe(platform: QQNTPlatform) {
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    })
  }

  it('follows every nextCursor page when establishing the initial dialogs baseline', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    platform.client.getDialogs = vi.fn(async ({ cursor }) => cursor === undefined
      ? { conversations: [conversation('first')], nextCursor: 'page-2' }
      : cursor === 'page-2'
        ? { conversations: [conversation('second')], nextCursor: 'page-3' }
        : { conversations: [conversation('third')] })
    const events: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)

    expect(events).toEqual([])
    expect(platform.client.getDialogs).toHaveBeenCalledTimes(3)
    expect(platform.client.getDialogs).toHaveBeenNthCalledWith(1, {
      cursor: undefined, afterId: undefined, limit: 100,
    }, expect.any(AbortSignal))
    expect(platform.client.getDialogs).toHaveBeenNthCalledWith(2, {
      cursor: 'page-2', afterId: undefined, limit: 100,
    }, expect.any(AbortSignal))
    expect(platform.client.getDialogs).toHaveBeenNthCalledWith(3, {
      cursor: 'page-3', afterId: undefined, limit: 100,
    }, expect.any(AbortSignal))
    await unsubscribe()
  })

  it('serves the foreground dialog list from the prepared polling cache', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('cached-first')], total: 1,
    }))

    const unsubscribe = await platform.subscribe(session, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.client.getDialogs).toHaveBeenCalledOnce()

    await expect(platform.getDialogs(session, { limit: 101 })).resolves.toMatchObject({
      total: 1,
      dialogs: [{ conversation: { id: 'cached-first' }, lastMessage: { id: 'cached-first-message' } }],
    })
    expect(platform.client.getDialogs).toHaveBeenCalledOnce()
    await unsubscribe()
  })

  it('forwards opaque dialog offsets to the bridge', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [conversation('next')] }))

    await platform.getDialogs(session, { afterId: 'opaque-previous', limit: 20 })

    expect(platform.client.getDialogs).toHaveBeenCalledWith({
      cursor: undefined, afterId: 'opaque-previous', limit: 20,
    }, undefined)
  })

  it('injects a newly discovered dialog with a real last message only once', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    let includeNewConversation = false
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('existing'), ...(includeNewConversation ? [conversation('new-group')] : [])],
    }))
    const events: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)
    includeNewConversation = true
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(events).toMatchObject([{
      type: 'message', conversation: { id: 'new-group' }, message: { id: 'new-group-message' },
    }])
    expect(events).toHaveLength(1)
    await unsubscribe()
  })

  it('waits for a real last message before injecting a newly discovered dialog', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    let includeNewConversation = false
    let newConversationHasMessage = false
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [
        conversation('existing'),
        ...(includeNewConversation ? [conversation('new-group', newConversationHasMessage)] : []),
      ],
    }))
    const events: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)
    includeNewConversation = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(events).toEqual([])
    newConversationHasMessage = true
    await vi.advanceTimersByTimeAsync(15_000)

    expect(events).toMatchObject([{
      type: 'message', conversation: { id: 'new-group' }, message: { id: 'new-group-message' },
    }])
    await unsubscribe()
  })

  it('does not double-deliver a poll message while its WebSocket delivery is in flight', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    let wireHandler: ((event: any) => Promise<void>) | undefined
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      wireHandler = handler
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    })
    let includeNewConversation = false
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('existing'), ...(includeNewConversation ? [conversation('new-group')] : [])],
    }))
    const handlerStarted = Promise.withResolvers<void>()
    const releaseHandler = Promise.withResolvers<void>()
    const handler = vi.fn(async () => {
      handlerStarted.resolve()
      await releaseHandler.promise
    })

    const unsubscribe = await platform.subscribe(session, handler)
    await vi.advanceTimersByTimeAsync(0)
    includeNewConversation = true
    const polling = vi.advanceTimersByTimeAsync(15_000)
    await handlerStarted.promise
    await wireHandler!({
      type: 'message',
      conversation: conversation('new-group'),
      message: {
        id: 'new-group-message', conversationId: 'new-group', senderId: 'member', timestamp: 1, outgoing: false,
        parts: [{ type: 'text', text: 'new-group' }],
      },
    })

    expect(handler).toHaveBeenCalledOnce()
    releaseHandler.resolve()
    await polling
    await unsubscribe()
  })

  it('retries an un-replayed WebSocket message through dialogs polling after its handler fails', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    let wireHandler: ((event: any) => Promise<void>) | undefined
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      wireHandler = handler
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    })
    let includeNewConversation = false
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('existing'), ...(includeNewConversation ? [conversation('new-group')] : [])],
    }))
    let attempts = 0
    const handler = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary handler failure')
    })

    const unsubscribe = await platform.subscribe(session, handler)
    await vi.advanceTimersByTimeAsync(0)
    includeNewConversation = true
    await expect(wireHandler!({
      type: 'message',
      conversation: conversation('new-group'),
      message: {
        id: 'new-group-message', conversationId: 'new-group', senderId: 'member', timestamp: 1, outgoing: false,
        parts: [{ type: 'text', text: 'new-group' }],
      },
    })).rejects.toThrow('temporary handler failure')
    expect(handler).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(handler).toHaveBeenCalledTimes(2)
    await unsubscribe()
  })

  it('suppresses a poll echo for its origin session', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    platform.client.sendMessage = vi.fn(async (_conversation, text, _media, _options, originRequestId) => ({
      id: 'sent', conversationId: 'new-group', senderId: 'self', timestamp: 1, outgoing: true,
      originRequestId, parts: [{ type: 'text' as const, text: text! }],
    }))
    let includeNewConversation = false
    let originRequestId: string | undefined
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [
        conversation('existing'),
        ...(includeNewConversation ? [conversation('new-group', true, originRequestId)] : []),
      ],
    }))
    const events: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)
    await platform.sendMessage(session, { id: 'new-group' }, { parts: [{ type: 'text', text: 'echo' }] })
    originRequestId = (platform.client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]![4]
    includeNewConversation = true
    await vi.advanceTimersByTimeAsync(15_000)

    expect(events).toEqual([])
    await unsubscribe()
  })

  it('retries a poll message after its handler fails', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    let includeNewConversation = false
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('existing'), ...(includeNewConversation ? [conversation('new-group')] : [])],
    }))
    let attempts = 0
    const handler = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary handler failure')
    })

    const unsubscribe = await platform.subscribe(session, handler)
    await vi.advanceTimersByTimeAsync(0)
    includeNewConversation = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(handler).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(handler).toHaveBeenCalledTimes(2)
    await unsubscribe()
  })

  it('stops dialogs polling after unsubscribe', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))

    const unsubscribe = await platform.subscribe(session, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.client.getDialogs).toHaveBeenCalledTimes(1)
    await unsubscribe()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(platform.client.getDialogs).toHaveBeenCalledTimes(1)
  })
})
