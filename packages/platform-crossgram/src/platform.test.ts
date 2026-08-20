import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { Logger } from 'cordis'
import {
  expandTelegramStrippedThumbnail, IMMediaUnavailableError, IMMessageSendRejectedError,
  IMMessageTargetUnavailableError, PlatformMessageActions, stableId,
  type IMMedia, type PlatformSession,
} from '@mtproto-relay/bridge'
import { parseQQMarkdown, QQNTPlatform } from './index.js'
import type { QQMediaLocator } from './protocol.js'
import { QQStickerProvider } from './sticker-provider.js'

const session: PlatformSession = {
  platformSessionId: 'qq-session', platformId: 'qqnt', userId: 'self', credentials: {}, metadata: {},
}

const temporaryDirectories: string[] = []

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  sharp.cache(false)
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true, maxRetries: 20, retryDelay: 25,
  })))
})

describe('QQNTPlatform mapping', () => {
  it('maps QQNT ranged-read past EOF responses to an empty Telegram chunk', async () => {
    const platform = new QQNTPlatform()
    platform.client.downloadFile = vi.fn(async function* () {
      throw new Error('QQNT native media 400: {"retcode":-5503008,"retmsg":"download range out of filesize"}')
    })
    const media: IMMedia<QQMediaLocator> = {
      id: 'file', kind: 'file', size: 1024,
      locator: {
        messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: 'file.bin', fileUuid: 'uuid',
      },
    }

    await expect(collect(platform.downloadMedia(session, media, { offset: 1024, limit: 512 })))
      .resolves.toEqual([])
    await expect(collect(platform.downloadMedia(session, media, { offset: 0, limit: 512 })))
      .rejects.toThrow('download range out of filesize')
  })

  it('maps QQNT bridge HTTP 416 ranged-read responses to an empty Telegram chunk', async () => {
    const platform = new QQNTPlatform()
    platform.client.downloadFile = vi.fn(async function* () {
      throw new Error('QQNT bridge 416: Range Not Satisfiable')
    })
    const media: IMMedia<QQMediaLocator> = {
      id: 'file', kind: 'file', size: 1024,
      locator: {
        messageId: 'message', elementId: 'element', chatType: 2, peerUid: 'group',
        kind: 'file', fileName: 'file.bin', fileUuid: 'uuid',
      },
    }

    await expect(collect(platform.downloadMedia(session, media, { offset: 1024, limit: 512 })))
      .resolves.toEqual([])
    await expect(collect(platform.downloadMedia(session, media, { offset: 0, limit: 512 })))
      .rejects.toThrow('Range Not Satisfiable')
  })

  it('refreshes a legacy user-avatar locator before downloading it', async () => {
    const platform = new QQNTPlatform()
    platform.client.getUser = vi.fn(async () => ({
      id: 'opaque-user', numericId: '1715311957', name: 'Alice',
      avatar: {
        id: 'avatar:user:opaque-user', kind: 'image' as const, mimeType: 'image/jpeg',
        locator: {
          messageId: 'avatar:user:opaque-user', elementId: 'avatar:user:opaque-user',
          chatType: 1 as const, peerUid: 'opaque-user', kind: 'image' as const,
          fileName: '1715311957.jpg', avatarUin: '1715311957',
        },
      },
    }))
    platform.client.downloadFile = vi.fn(async function* (locator) {
      expect(locator).toMatchObject({ avatarUin: '1715311957' })
      yield new TextEncoder().encode('avatar-bytes')
    })
    const media: IMMedia<QQMediaLocator> = {
      id: 'avatar:user:opaque-user:original-v1', kind: 'image', mimeType: 'image/jpeg',
      locator: {
        messageId: 'profile', elementId: 'legacy-avatar', chatType: 1,
        peerUid: 'opaque-user', kind: 'image', fileName: 'avatar.jpg',
      },
    }

    await expect(collect(platform.downloadMedia(session, media))).resolves.toEqual([
      new TextEncoder().encode('avatar-bytes'),
    ])
    expect(platform.client.getUser).toHaveBeenCalledWith('opaque-user')
  })

  it('marks expired QQ media locators for Telegram file-reference refresh', async () => {
    const platform = new QQNTPlatform()
    platform.client.downloadFile = vi.fn(async function* () {
      throw new Error('QQNT native media 404: {"retcode":-5503042,"retmsg":"file has expired"}')
    })
    const media: IMMedia<QQMediaLocator> = {
      id: 'expired', kind: 'image',
      locator: {
        messageId: 'message', elementId: 'element', chatType: 1, peerUid: 'user',
        kind: 'image', fileName: 'expired.jpg', fileUuid: 'expired',
      },
    }

    await expect(collect(platform.downloadMedia(session, media)))
      .rejects.toBeInstanceOf(IMMediaUnavailableError)
  })

  it('projects QQ bot markdown and native buttons into Telegram-compatible entities and markup', async () => {
    expect(parseQQMarkdown(
      '**粗体** *斜体* ~~删除~~ `代码` [文档](https://example.com/docs)',
    )).toEqual({
      type: 'text',
      text: '粗体 斜体 删除 代码 文档',
      entities: [
        { type: 'bold', offset: 0, length: 2 },
        { type: 'italic', offset: 3, length: 2 },
        { type: 'strikethrough', offset: 6, length: 2 },
        { type: 'code', offset: 9, length: 2 },
        { type: 'text-link', offset: 12, length: 2, url: 'https://example.com/docs' },
      ],
    })

    const platform = new QQNTPlatform()
    platform.client.getHistory = vi.fn(async () => ({
      messages: [{
        id: 'bot-message', conversationId: 'group', senderId: 'bot', timestamp: 1, outgoing: false,
        msgSeq: '7788',
        parts: [
          { type: 'markdown' as const, content: '**选择操作**' },
          { type: 'inline-keyboard' as const, keyboard: {
            botAppid: '1024',
            rows: [{ buttons: [
              {
                id: 'open', label: '打开', visitedLabel: '已打开', style: 1, type: 0,
                clickLimit: 0, unsupportTips: '', data: 'https://example.com',
                atBotShowChannelList: false, permissionType: 2, specifyRoleIds: [], specifyTinyids: [],
              },
              {
                id: 'confirm', label: '确认', visitedLabel: '已确认', style: 2, type: 1,
                clickLimit: 1, unsupportTips: '', data: 'confirm:42',
                atBotShowChannelList: false, permissionType: 2, specifyRoleIds: [], specifyTinyids: [],
              },
            ] }],
          } },
        ],
      }],
    }))
    const [message] = (await platform.getHistory(session, { id: 'group' })).messages
    expect(message.content).toMatchObject({
      parts: [{ type: 'text', text: '选择操作', entities: [{ type: 'bold', offset: 0, length: 4 }] }],
      inlineKeyboard: { rows: [{ buttons: [
        { type: 'url', text: '打开', url: 'https://example.com', style: 'primary' },
        {
          type: 'callback', text: '确认', data: 'confirm:42', style: 'danger',
          metadata: { qqnt: { id: 'confirm', botAppid: '1024' } },
        },
      ] }] },
    })

    platform.client.clickInlineKeyboard = vi.fn(async () => ({
      status: 0, promptText: '操作成功', promptType: 0, promptIcon: 0,
    }))
    await expect(platform.clickInlineButton!(session, {
      conversationId: 'group', messageId: 'bot-message', nativeSequence: '7788',
    }, message.content.inlineKeyboard!.rows[0].buttons[1] as any)).resolves.toEqual({
      message: '操作成功', alert: false,
    })
    expect(platform.client.clickInlineKeyboard).toHaveBeenCalledWith({
      conversationId: 'group', messageId: 'bot-message', messageSequence: '7788',
      buttonId: 'confirm', callbackData: 'confirm:42', botAppid: '1024',
    })
  })
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

  it('maps QQ permission and upload preparation rejections to typed platform send errors', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        error: 'QQ message send rejected: 发送失败，请先添加对方为好友 (16)', result: 16,
      }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({
        error: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
      }, { status: 422 }))
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
      throw new Error('expected permanent QQ upload rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(IMMessageSendRejectedError)
      expect(error).toMatchObject({
        reason: 'platform-rejected',
        message: 'QQ group file upload preparation failed: 永久空间不足, 请清理文件列表后重试 (-403)',
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

  it('maps request lists and resolutions without exposing approval payloads', async () => {
    const platform = new QQNTPlatform()
    const request = {
      id: 'request/opaque:42', kind: 'group-join' as const, status: 'pending' as const,
      requester: { id: 'u_opaque', name: 'Alice' }, group: { id: 'group/opaque', name: 'Group' },
      message: 'please approve', timestamp: '1710000000', source: 'doubt' as const, reason: 'QQ 风险提示', approval: { nativePayload: 'secret' },
    }
    platform.client.getRequests = vi.fn(async () => ({ requests: [request] }))
    platform.client.resolveRequest = vi.fn(async () => ({
      id: 'friend-opaque', kind: 'friend' as const, status: 'accepted' as const,
      requester: { id: 'u_friend' }, timestamp: 1710000001,
    }))

    const requestPage = await platform.getRequests(session, {
      kind: 'group-join', cursor: 'opaque-cursor', limit: 25,
    })
    expect(requestPage).toEqual({
      requests: [{
        id: 'request/opaque:42', kind: 'group-join', state: 'pending',
        requester: { id: 'u_opaque', firstName: 'Alice' },
        group: { id: 'group/opaque', kind: 'group', title: 'Group' },
        message: 'please approve', createdAt: '1710000000', metadata: { qqRequestSource: 'doubt', qqRequestReason: 'QQ 风险提示' },
      }],
    })
    expect(requestPage.nextCursor).toBeUndefined()
    await expect(platform.resolveRequest(session, 'friend-opaque', 'accept')).resolves.toEqual({
      id: 'friend-opaque', kind: 'friend', state: 'accepted',
      requester: { id: 'u_friend', firstName: 'u_friend' }, createdAt: 1710000001,
    })
    expect(platform.client.getRequests).toHaveBeenCalledWith({
      kind: 'group-join', cursor: 'opaque-cursor', limit: 25,
    })
    expect(platform.client.resolveRequest).toHaveBeenCalledWith('friend-opaque', 'accept')
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

  it('serves an empty reaction catalog immediately and backs off after an upstream timeout', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => {
      throw new Error('QQNT bridge 500: QQ reaction catalog request timed out')
    })
    const target = { conversationId: '2:group', messageId: 'message' }

    await expect(platform.getAvailableReactions(session, target)).resolves.toEqual({
      available: [], reactions: [], maxSelected: 20,
    })
    await vi.advanceTimersByTimeAsync(0)
    await expect(platform.getAvailableReactions(session, target)).resolves.toEqual({
      available: [], reactions: [], maxSelected: 20,
    })
    expect(platform.client.getReactionCatalog).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(59_999)
    await platform.getAvailableReactions(session, target)
    expect(platform.client.getReactionCatalog).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1)
    await platform.getAvailableReactions(session, target)
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.client.getReactionCatalog).toHaveBeenCalledTimes(2)
  })

  it('waits for reaction definitions when a message has reaction counts to project', async () => {
    const platform = new QQNTPlatform()
    const catalog = Promise.withResolvers<Awaited<ReturnType<typeof platform.client.getReactionCatalog>>>()
    platform.client.getReactionCatalog = vi.fn(() => catalog.promise)
    platform.client.getMessageReactions = vi.fn(async () => ({
      reactions: [{ key: '1:265', count: 3, selected: true }], maxSelected: 20,
    }))
    const pending = platform.getMessageReactions(session, {
      conversationId: '2:group', messageId: 'message', targetId: 'message',
    })
    let settled = false
    void pending.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    catalog.resolve({
      available: [{
        key: '1:265', title: '辣眼睛', presentation: {
          type: 'custom', alt: '[辣眼睛]', resource: {
            version: 1, format: 'static', mimeType: 'image/png', width: 24, height: 18,
            locator: { reactionKey: '1:265' },
          },
        },
      }],
      reactions: [], maxSelected: 20,
    })
    await expect(pending).resolves.toMatchObject({
      available: [{ key: '1:265' }], reactions: [{ key: '1:265', count: 3, selected: true }],
    })
  })

  it('does not wait for reaction definitions when a message has no reactions', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(() => new Promise<Awaited<
      ReturnType<typeof platform.client.getReactionCatalog>
    >>(() => {}))
    platform.client.getMessageReactions = vi.fn(async () => ({ reactions: [], maxSelected: 20 }))

    await expect(platform.getMessageReactions(session, {
      conversationId: '2:group', messageId: 'message', targetId: 'message',
    })).resolves.toEqual({ available: [], reactions: [], maxSelected: 20 })
  })

  it('revalidates and prepares every dialog request', async () => {
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
    await platform.getDialogs(session)

    expect(platform.client.getDialogs).toHaveBeenCalledTimes(2)
    expect(prepare).toHaveBeenCalledTimes(2)
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

  it('projects QQ group files into Telegram document-search messages', async () => {
    const platform = new QQNTPlatform()
    platform.client.searchMessages = vi.fn()
    platform.client.getGroupFiles = vi.fn(async () => ({
      total: 2,
      nextCursor: '2',
      items: [{
        type: 'folder' as const, id: 'folder', parentId: '', name: '资料',
        createTime: 1, modifyTime: 2, creatorId: '1', creatorName: 'Alice', fileCount: 1,
      }, {
        type: 'file' as const, id: 'uuid', parentId: '', name: 'manual.pdf', size: 9,
        uploadTime: 100, modifyTime: 110, downloadCount: 4, uploaderId: '42', uploaderName: 'Bob',
        busId: 102,
        media: {
          id: 'group-file:uuid', kind: 'file' as const, name: 'manual.pdf', size: 9,
          locator: {
            messageId: 'group-file:uuid', elementId: 'element', chatType: 2 as const,
            peerUid: 'group', kind: 'file' as const, fileName: 'manual.pdf',
            fileSize: '9', fileUuid: 'uuid', fileBizId: 102,
          },
        },
      }],
    }))

    await expect(platform.searchMessages(session, { id: '2:group' }, {
      query: 'manual', cursor: '0', limit: 20, mediaKind: 'file',
    })).resolves.toMatchObject({
      total: 2,
      nextCursor: '2',
      messages: [{
        id: 'qq-group-file:uuid', senderId: '42', timestamp: 100,
        content: { parts: [
          { type: 'text', text: 'manual.pdf' },
          { type: 'media', media: { name: 'manual.pdf', locator: { fileUuid: 'uuid' } } },
        ] },
      }],
    })
    expect(platform.client.getGroupFiles).toHaveBeenCalledWith('2:group', { cursor: '0', limit: 20 })
    expect(platform.client.searchMessages).not.toHaveBeenCalled()
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

  it('prefers a numeric status.selfUin for the current QQ account identity', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 21, ready: true, selfUin: '1234567890', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'u_self', numericId: '9876543210', name: 'Platform Alice',
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
        id: 'u_self', firstName: 'Platform Alice', username: '1234567890', about: 'Self signature',
        avatar: { id: 'avatar-self:original-v1', kind: 'image' }, metadata: { qq: '1234567890' },
      },
    })
    expect(platform.client.getUser).toHaveBeenCalledWith('u_self')
  })

  it('falls back to a numeric user.numericId when status.selfUin is invalid', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 21, ready: true, selfUin: 'not-a-number', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'u_self', numericId: '1234567890', name: 'Platform Alice',
    }))

    await expect(platform.getAccount()).resolves.toMatchObject({
      user: { id: 'u_self', username: '1234567890', metadata: { qq: '1234567890' } },
    })
  })

  it('rejects the current account when neither QQ identity is numeric', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 21, ready: true, selfUin: 'not-a-number', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({
      id: 'u_self', numericId: 'also-not-a-number', name: 'Platform Alice',
    }))

    await expect(platform.getAccount()).rejects.toThrow('numeric selfUin or user.numericId')
  })

  it('accepts bridge protocol 19 during the call-signal rollout', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 19, ready: true, selfUin: '10001', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({ id: 'u_self', name: 'Platform Alice' }))

    await expect(platform.getAccount()).resolves.toMatchObject({ user: { id: 'u_self' } })
  })

  it('accepts bridge protocol 24 for extracted video thumbnails', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({
      protocolVersion: 24, ready: true, selfUin: '10001', selfUid: 'u_self',
    }))
    platform.client.getUser = vi.fn(async () => ({ id: 'u_self', name: 'Platform Alice' }))

    await expect(platform.getAccount()).resolves.toMatchObject({ user: { id: 'u_self' } })
  })

  it('refuses to invent an account while QQNT is not ready', async () => {
    const platform = new QQNTPlatform()
    platform.client.status = vi.fn(async () => ({ protocolVersion: 1, ready: false }))
    await expect(platform.getAccount()).rejects.toThrow('not ready')
  })

  it('rejects bridge protocols outside the supported 19-28 range', async () => {
    for (const protocolVersion of [18, 29, 19.5, Number.NaN, '19', undefined]) {
      const platform = new QQNTPlatform()
      const status = {
        protocolVersion, ready: true, selfUin: '10001', selfUid: 'u_self',
      } as unknown as Awaited<ReturnType<typeof platform.client.status>>
      platform.client.status = vi.fn(async () => status)
      platform.client.getUser = vi.fn()

      await expect(platform.getAccount()).rejects.toThrow('supported range is 19-28')
      expect(platform.client.getUser).not.toHaveBeenCalled()
    }
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

  it('filters and cleans temporary and zero-peer dialogs without hiding real QQ service messages', async () => {
    const temporaryId = 'qqnt-multi-forward:["633125440","7668634613890478612",""]'
    const remove = vi.fn(async () => {})
    const database = {
      withTransaction: vi.fn(async (callback: (database: any) => Promise<void>) => callback({
        get: vi.fn(async (table: string, query: any) => {
          if (table === 'mtproto_im_conversation') return [{
            id: 41, platformSessionId: session.platformSessionId, platformConversationId: temporaryId,
          }, {
            id: 42, platformSessionId: session.platformSessionId, platformConversationId: '0',
          }]
          if (table === 'mtproto_im_message' && query.conversationId) return [
            { id: 51, conversationId: 41 }, { id: 52, conversationId: 42 },
          ]
          if (table === 'mtproto_im_message') return []
          if (table === 'mtproto_notification_settings') return [
            { id: 'peer-zero', scope: 'peer:0' },
            { id: 'topic-temporary', scope: `topic:${temporaryId}:7` },
            { id: 'real-peer', scope: 'peer:real-group' },
          ]
          if (table === 'mtproto_im_user') return [{
            id: 61, platformId: session.platformId, platformUserId: temporaryId,
          }]
          return []
        }),
        remove,
      })),
    }
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, undefined, database as any)
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: temporaryId, kind: 'direct' as const, title: temporaryId,
      peerUid: temporaryId, peerUin: '', chatType: 1 as const,
    }, {
      id: '0', kind: 'group' as const, title: '0',
      peerUid: '0', peerUin: '0', chatType: 2 as const,
    }, {
      id: 'real-group', kind: 'group' as const, title: 'Real group',
      peerUid: 'real-group', peerUin: '10001', chatType: 2 as const,
      lastMessage: {
        id: 'real-service', conversationId: 'real-group', senderId: '0', timestamp: 10, outgoing: false,
        serviceAction: { type: 'custom' as const, text: '群公告已更新' }, parts: [],
      },
    }] }))
    platform.client.getConversation = vi.fn()
    platform.client.getHistory = vi.fn()
    platform.client.markRead = vi.fn()

    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{
        conversation: { id: 'real-group', title: 'Real group' },
        lastMessage: { content: { serviceAction: { type: 'custom', text: '群公告已更新' }, parts: [] } },
      }],
    })
    await expect(platform.getConversation(session, temporaryId)).resolves.toBeNull()
    await expect(platform.getConversation(session, '0')).resolves.toBeNull()
    await expect(platform.getHistory(session, { id: temporaryId })).resolves.toEqual({ messages: [] })
    await expect(platform.getHistory(session, { id: '0' })).resolves.toEqual({ messages: [] })
    await expect(platform.searchMessages(session, { id: '0' }, { query: 'ignored' })).resolves.toEqual({ messages: [] })
    await expect(platform.getMessage(session, { id: '0' }, 'ghost')).resolves.toBeNull()
    await expect(platform.markRead(session, {
      conversationId: temporaryId, messageId: 'inside-forward',
    })).resolves.toBeUndefined()
    await expect(platform.markRead(session, {
      conversationId: '0', messageId: 'ghost',
    })).resolves.toBeUndefined()

    expect(platform.client.getConversation).not.toHaveBeenCalled()
    expect(platform.client.getHistory).not.toHaveBeenCalled()
    expect(platform.client.markRead).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('mtproto_im_message_reaction', { messageId: { $in: [51, 52] } })
    expect(remove).toHaveBeenCalledWith('mtproto_message_mention', { messageId: { $in: [51, 52] } })
    expect(remove).toHaveBeenCalledWith('mtproto_im_conversation', { id: { $in: [41, 42] } })
    expect(remove).toHaveBeenCalledWith('mtproto_channel_update_state', {
      platformSessionId: session.platformSessionId,
      channelId: { $in: [stableId(`peer:${temporaryId}`), stableId('peer:0')].map(String) },
    })
    expect(remove).toHaveBeenCalledWith('mtproto_notification_settings', {
      id: { $in: ['peer-zero', 'topic-temporary'] },
    })
    expect(remove).toHaveBeenCalledWith('mtproto_im_user', { id: { $in: [61] } })
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
      conversationView: 'merged-forward',
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

  it('opens merged-forward history at the newest edge and pages backward without refetching', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: 'outer-group', kind: 'group' as const, title: 'Outer group',
      peerUid: 'physical-group-uid', peerUin: '10001', chatType: 2 as const,
      lastMessage: {
        id: 'merged-root', conversationId: 'outer-group', senderId: 'alice', timestamp: 20, outgoing: false,
        parts: [{
          type: 'multi-forward' as const, title: '聊天记录', preview: '6条消息的合并转发',
          locator: { conversationId: 'outer-group', rootMessageId: 'merged-root' },
        }],
      },
    }] }))
    const archived = Array.from({ length: 6 }, (_, index) => ({
      id: `inside-${index}`, conversationId: 'archived-group', senderId: 'alice',
      sender: { id: 'alice', name: 'Alice' }, timestamp: 100 + index, outgoing: false,
      parts: [{ type: 'text' as const, text: `message ${index}` }],
    }))
    platform.client.getMultiForwardMessages = vi.fn(async () => archived)

    const [dialog] = (await platform.getDialogs(session)).dialogs
    const link = dialog.lastMessage?.content.parts[0]
    if (link?.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    const conversation = link.entities[0].conversation
    await expect(platform.getHistory(session, conversation, { limit: 2 })).resolves.toMatchObject({
      messages: [{ id: 'inside-4' }, { id: 'inside-5' }],
    })
    await expect(platform.getHistory(session, conversation, {
      limit: 2, before: { id: 'inside-4', timestamp: 104 },
    })).resolves.toMatchObject({
      messages: [{ id: 'inside-2' }, { id: 'inside-3' }],
    })
    await expect(platform.getHistory(session, conversation, {
      limit: 2, after: { id: 'inside-2', timestamp: 102 },
    })).resolves.toMatchObject({
      messages: [{ id: 'inside-3' }, { id: 'inside-4' }],
    })
    expect(platform.client.getMultiForwardMessages).toHaveBeenCalledOnce()
  })

  it('hydrates missing senders in merged-forward history from QQ user profiles', async () => {
    const platform = new QQNTPlatform()
    platform.client.forwardMessages = vi.fn(async () => [{
      id: 'merged-root', conversationId: 'outer-group', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{
        type: 'multi-forward' as const, title: '聊天记录', preview: 'Alice: archived message',
        locator: { conversationId: 'outer-group', rootMessageId: 'merged-root' },
      }],
    }])
    platform.client.getMultiForwardMessages = vi.fn(async () => [{
      id: 'provided-sender', conversationId: 'archived-group', senderId: 'provided-alice',
      sender: { id: 'provided-alice', name: 'Provided Alice' },
      timestamp: 9, outgoing: false, parts: [{ type: 'text' as const, text: 'provided sender' }],
    }, {
      id: 'lookup-error', conversationId: 'archived-group', senderId: 'lookup-error',
      timestamp: 8, outgoing: false, parts: [{ type: 'text' as const, text: 'lookup error' }],
    }, {
      id: 'lookup-null', conversationId: 'archived-group', senderId: 'lookup-null',
      timestamp: 7, outgoing: false, parts: [{ type: 'text' as const, text: 'lookup null' }],
    }, {
      id: 'lookup-undefined', conversationId: 'archived-group', senderId: 'lookup-undefined',
      timestamp: 6, outgoing: false, parts: [{ type: 'text' as const, text: 'lookup undefined' }],
    }, {
      id: 'archived-message', conversationId: 'archived-group', senderId: 'archived-alice',
      timestamp: 5, outgoing: false, parts: [{ type: 'text' as const, text: 'archived message' }],
    }, {
      id: 'duplicate-archived-message', conversationId: 'archived-group', senderId: 'archived-alice',
      timestamp: 4, outgoing: false, parts: [{ type: 'text' as const, text: 'duplicate archived message' }],
    }])
    platform.client.getUser = vi.fn(async () => ({
      id: 'archived-alice', name: 'Alice',
      avatar: {
        id: 'avatar:archived-alice', kind: 'image' as const, mimeType: 'image/jpeg',
        locator: {
          messageId: 'avatar:archived-alice', elementId: 'avatar:archived-alice', chatType: 1 as const,
          peerUid: 'archived-alice', kind: 'image' as const, fileName: 'avatar.jpg',
        },
      },
    }))
    const originalGetUser = platform.getUser.bind(platform)
    const getUser = vi.spyOn(platform, 'getUser').mockImplementation(async (userSession, userId) => {
      if (userId === 'lookup-error') throw new Error('QQ user lookup failed')
      if (userId === 'lookup-null') return null
      if (userId === 'lookup-undefined') return undefined as never
      return originalGetUser(userSession, userId)
    })

    const [merged] = await platform.forwardMessages(session, { id: 'from' }, ['a', 'b'], { id: 'to' })
    const link = merged.content.parts[0]
    if (link.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    const history = await platform.getHistory(session, link.entities[0].conversation)

    expect(history.messages[0]).toMatchObject({
      sender: { id: 'provided-alice', firstName: 'Provided Alice' },
    })
    expect(history.messages.slice(1, 4).map((message) => message.sender)).toEqual([undefined, undefined, undefined])
    expect(history.messages.slice(4)).toMatchObject([{
      sender: { id: 'archived-alice', avatar: { id: 'avatar:archived-alice:original-v1' } },
    }, {
      sender: { id: 'archived-alice', avatar: { id: 'avatar:archived-alice:original-v1' } },
    }])
    expect(getUser).not.toHaveBeenCalledWith(session, 'provided-alice')
    expect(getUser).toHaveBeenCalledWith(session, 'lookup-error')
    expect(getUser).toHaveBeenCalledWith(session, 'lookup-null')
    expect(getUser).toHaveBeenCalledWith(session, 'lookup-undefined')
    expect(platform.client.getUser).toHaveBeenCalledOnce()
    expect(platform.client.getUser).toHaveBeenCalledWith('archived-alice')
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

  it('hydrates a generic merged-forward counter from the archived messages', async () => {
    const platform = new QQNTPlatform()
    platform.client.forwardMessages = vi.fn(async () => [{
      id: 'merged-generic', conversationId: 'to', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{
        type: 'multi-forward' as const, title: '聊天记录', preview: '2条消息的合并转发',
        locator: { conversationId: 'to', rootMessageId: 'merged-generic' },
      }],
    }])
    platform.client.getMultiForwardMessages = vi.fn(async () => [{
      id: 'inside-a', conversationId: 'archived', senderId: 'alice', timestamp: 8, outgoing: false,
      sender: { id: 'alice', name: 'Alice' },
      parts: [{ type: 'text' as const, text: '第一条具体内容' }],
    }, {
      id: 'inside-b', conversationId: 'archived', senderId: 'bob', timestamp: 9, outgoing: false,
      sender: { id: 'bob', name: 'Bob' },
      parts: [{
        type: 'media' as const,
        media: {
          id: 'photo', kind: 'image' as const, size: 10,
          locator: {
            messageId: 'inside-b', elementId: 'photo', chatType: 2 as const,
            peerUid: 'archived', kind: 'image' as const, fileName: 'photo.jpg',
          },
        },
      }],
    }])

    const [merged] = await platform.forwardMessages(
      session, { id: 'from' }, ['a', 'b'], { id: 'to' },
    )
    const link = merged.content.parts[0]
    if (link.type !== 'text' || link.entities?.[0]?.type !== 'conversation-link') {
      throw new Error('merged forward link was not mapped')
    }
    expect(link.entities[0].conversation.metadata?.qqMultiForwardPreview)
      .toBe('Alice: 第一条具体内容\nBob: [图片]')
    expect(platform.client.getMultiForwardMessages).toHaveBeenCalledOnce()
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

  it('returns a sent animated sticker as untouched QQ metadata without opening the asset', async () => {
    const platform = new QQNTPlatform({}, 'qq-provider')
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
        format: 'animated', mimeType: 'image/gif',
      },
    }])
    expect(assetRequests).toBe(0)
  })

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

  it('pauses WebSocket reconnects while the QQNT kernel is not ready', async () => {
    vi.useFakeTimers()
    const retrySession = { ...session, platformSessionId: 'qq-session-not-ready' }
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const status = vi.spyOn(platform.client, 'status')
      .mockResolvedValueOnce({ protocolVersion: 22, ready: false })
      .mockResolvedValueOnce({ protocolVersion: 22, ready: false })
      .mockResolvedValueOnce({ protocolVersion: 22, ready: false })
      .mockResolvedValue({ protocolVersion: 22, ready: true, selfUin: '10000' })
    const subscribe = vi.spyOn(platform.client, 'subscribe')
      .mockRejectedValueOnce(new Error('Unexpected server response: 503'))
      .mockImplementation(async (_handler, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      })

    const unsubscribe = await platform.subscribe(retrySession, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(status).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(status).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_999)
    expect(status).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(status).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(3_999)
    expect(status).toHaveBeenCalledTimes(3)
    expect(subscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(status).toHaveBeenCalledTimes(4)
    expect(subscribe).toHaveBeenCalledTimes(2)

    await unsubscribe()
  })

  it('exponentially backs off ordinary WebSocket failures up to recovery', async () => {
    vi.useFakeTimers()
    const retrySession = { ...session, platformSessionId: 'qq-session-stream-retry' }
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    vi.spyOn(platform.client, 'status').mockResolvedValue({
      protocolVersion: 22, ready: true, selfUin: '10000',
    })
    const subscribe = vi.spyOn(platform.client, 'subscribe')
      .mockRejectedValue(new Error('socket closed before the opening handshake'))

    const unsubscribe = await platform.subscribe(retrySession, () => {})
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

    await vi.advanceTimersByTimeAsync(3_999)
    expect(subscribe).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(7_999)
    expect(subscribe).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(15_999)
    expect(subscribe).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(6)

    await vi.advanceTimersByTimeAsync(31_999)
    expect(subscribe).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(7)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(subscribe).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(8)

    await vi.advanceTimersByTimeAsync(59_999)
    expect(subscribe).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribe).toHaveBeenCalledTimes(9)

    await unsubscribe()
  })

  it('drops native AVSDK frames without delivering, reconnecting, or logging each frame', async () => {
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as unknown as Logger
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, logger)
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const frames: unknown[] = [
      { type: 'native-avsdk', version: 1, callback: 'native.avsdk.callback', args: [] },
      { type: 'native-avsdk', version: 1, callback: 'native.avsdk.callback', args: {} },
      { type: 'native-avsdk', version: 1, args: [] },
      { type: 'native-avsdk', version: 2, callback: 'native.avsdk.callback', args: [] },
      ...Array.from({ length: 10 }, () => ({
        type: 'native-avsdk', version: 1, callback: 'native.avsdk.callback', args: [],
      })),
    ]
    const acknowledged: string[] = []
    platform.client.subscribe = vi.fn(async (handler, signal, options) => {
      for (const [index, frame] of frames.entries()) {
        await handler(frame as never, `avsdk-${index}`)
        options?.onEventId?.(`avsdk-${index}`)
        acknowledged.push(`avsdk-${index}`)
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(acknowledged).toHaveLength(frames.length))

    expect(received).toEqual([])
    expect(platform.client.subscribe).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledTimes(1)
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    await unsubscribe()
  })

  it('maps and checkpoints QQNT message-edit WebSocket events', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const conversation = {
      id: 'production-group', kind: 'group' as const, title: 'Production group',
      peerUid: 'production-group', peerUin: '42', chatType: 2 as const,
    }
    const acknowledged: string[] = []
    platform.client.subscribe = vi.fn(async (handler, signal, options) => {
      await handler({
        type: 'message-edit', eventId: 'message-info:target:1:1', conversation,
        message: {
          id: 'target', conversationId: conversation.id, senderId: 'self', timestamp: 1,
          outgoing: true, msgSeq: '463806', telegramMessageId: 463806,
          parts: [{ type: 'text', text: 'edited' }],
        },
      }, '5580')
      await options.onEventId?.('5580')
      acknowledged.push('5580')
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(acknowledged).toEqual(['5580']))

    expect(received).toEqual([expect.objectContaining({
      type: 'message-edit', eventId: 'message-info:target:1:1',
      conversation: expect.objectContaining({ id: conversation.id }),
      message: expect.objectContaining({
        id: 'target', conversationId: conversation.id, outgoing: true,
        metadata: expect.objectContaining({ qqMsgSeq: '463806', telegramMessageId: 463806 }),
        content: { parts: [{ type: 'text', text: 'edited' }] },
      }),
    })])
    expect(platform.client.subscribe).toHaveBeenCalledTimes(1)
    await unsubscribe()
  })

  it('maps request WebSocket events without invoking message or gray-tip paths', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const request = {
      type: 'request' as const,
      request: {
        id: 'request/opaque:42', kind: 'group-join' as const, status: 'pending' as const,
        requester: { id: 'u_opaque', name: 'Alice' }, group: { id: 'group/opaque', name: 'Group' },
        message: 'please approve', timestamp: 1710000000,
      },
    }
    const acknowledged: string[] = []
    platform.client.subscribe = vi.fn(async (handler, signal, options) => {
      await handler(request, 'request-event')
      await options.onEventId?.('request-event')
      acknowledged.push('request-event')
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(acknowledged).toEqual(['request-event']))

    expect(received).toEqual([{
      type: 'request',
      request: {
        id: 'request/opaque:42', kind: 'group-join', state: 'pending',
        requester: { id: 'u_opaque', firstName: 'Alice' },
        group: { id: 'group/opaque', kind: 'group', title: 'Group' },
        message: 'please approve', createdAt: 1710000000,
      },
    }])
    await unsubscribe()
  })

  it('maps validated call signals into transient voice events with the exact control reference', async () => {
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, logger as unknown as Logger)
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const conversation = {
      id: '1:alice', kind: 'direct' as const, title: 'Alice', peerUid: 'alice', peerUin: '10001', chatType: 1 as const,
      participantCount: 999,
    }
    const cases = [
      { signal: 'incoming', media: 'voice' },
      { signal: 'incoming', media: 'unknown' },
      { signal: 'accept-requested', media: 'voice' },
      { signal: 'refuse-requested', media: 'voice' },
      { signal: 'logout-requested', media: 'voice' },
      { signal: 'ended', media: 'voice' },
    ] as const
    const frames = cases.map(({ signal, media }, index) => ({
      type: 'call-signal' as const, version: 1 as const, signal, media,
      callId: `call_${index}-stable`, conversation, timestamp: 100 + index,
    }))
    frames.push({ ...frames[0]!, timestamp: 200 })
    const acknowledged: string[] = []
    platform.client.subscribe = vi.fn(async (handler, signal, options) => {
      for (const [index, frame] of frames.entries()) {
        await handler(frame, `call-${index}`)
        options.onEventId?.(`call-${index}`)
        acknowledged.push(`call-${index}`)
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(acknowledged).toHaveLength(frames.length))

    expect(received.slice(0, cases.length)).toEqual(cases.map(({ signal, media }, index) => ({
      type: 'voice-call',
      callRef: `call_${index}-stable`,
      signal,
      media,
      conversation: expect.objectContaining({ id: conversation.id }),
      timestamp: 100 + index,
    })))
    expect(received[frames.length - 1]).toMatchObject({ callRef: 'call_0-stable', signal: 'incoming' })
    expect((received[0] as any).conversation.metadata).not.toHaveProperty('participantsCount')
    const debug = logger.debug.mock.calls.flat().join(' ')
    expect(debug).toContain('type=call-signal version=1 signal=incoming media=voice conversation=1:alice')
    expect(debug).not.toContain('call_0-stable')
    await unsubscribe()
  })

  it('delegates source call controls with the exact transient QQ reference', async () => {
    const platform = new QQNTPlatform()
    const controlCall = vi.spyOn(platform.client, 'controlCall').mockResolvedValue()

    await platform.voiceCalls.control(session, 'exact-qq-call-ref', 'accept')
    await platform.voiceCalls.control(session, 'exact-qq-call-ref', 'hangup')

    expect(controlCall.mock.calls).toEqual([
      ['exact-qq-call-ref', 'accept'],
      ['exact-qq-call-ref', 'hangup'],
    ])
  })

  it('ACKs invalid call-signal frames without delivery, reconnection, or payload logging', async () => {
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }
    const platform = new QQNTPlatform({}, 'qqnt:stickers', undefined, logger as unknown as Logger)
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const conversation = {
      id: '1:alice', kind: 'direct' as const, title: 'Alice', peerUid: 'alice', peerUin: '10001', chatType: 1 as const,
    }
    const overlong = 'a'.repeat(257)
    const frames: unknown[] = [
      { type: 'call-signal', version: 2, signal: 'incoming', media: 'voice', callId: 'payload-version', conversation, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'state', media: 'voice', callId: 'payload-signal', conversation, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'video', callId: 'payload-media', conversation, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload/id', conversation, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-conversation', conversation: { ...conversation, chatType: 2 }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-group', conversation: { ...conversation, kind: 'group', chatType: 2 }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-empty-id', conversation: { ...conversation, id: '' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-empty-peer', conversation: { ...conversation, peerUid: '' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-empty-uin', conversation: { ...conversation, peerUin: '' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-empty-title', conversation: { ...conversation, title: '' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-long-id', conversation: { ...conversation, id: overlong }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-long-peer', conversation: { ...conversation, peerUid: overlong }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-long-uin', conversation: { ...conversation, peerUin: '1'.repeat(33) }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-long-title', conversation: { ...conversation, title: overlong }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-unsafe-id', conversation: { ...conversation, id: 'alice/value' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-control-title', conversation: { ...conversation, title: 'Alice\nBob' }, timestamp: 1 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-timestamp', conversation, timestamp: 1.5 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-timestamp-overflow', conversation, timestamp: 0x80000000 },
      { type: 'call-signal', version: 1, signal: 'incoming', media: 'voice', callId: 'payload-timestamp-unsafe', conversation, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    ]
    const acknowledged: string[] = []
    platform.client.subscribe = vi.fn(async (handler, signal, options) => {
      for (const [index, frame] of frames.entries()) {
        await handler(frame as never, `invalid-${index}`)
        options.onEventId?.(`invalid-${index}`)
        acknowledged.push(`invalid-${index}`)
      }
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(acknowledged).toHaveLength(frames.length))

    expect(received).toEqual([])
    expect(platform.client.subscribe).toHaveBeenCalledTimes(1)
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('payload-')
    await unsubscribe()
  })

  it('delivers call-signal bursts through the transient voice path without hashing references', async () => {
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const conversation = {
      id: '1:alice', kind: 'direct' as const, title: 'Alice', peerUid: 'alice', peerUin: '10001', chatType: 1 as const,
    }
    const frames = Array.from({ length: 32 }, (_, index) => ({
      type: 'call-signal' as const, version: 1 as const, signal: 'ended' as const, media: 'voice' as const,
      callId: `burst_${index}`, conversation, timestamp: 1_000 + index,
    }))
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      for (const frame of frames) await handler(frame)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const received: unknown[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { received.push(event) })
    await vi.waitFor(() => expect(received).toHaveLength(frames.length))

    const callRefs = received.map((event: any) => event.callRef)
    expect(callRefs).toEqual(frames.map((frame) => frame.callId))
    expect(received.every((event: any) => event.type === 'voice-call' && event.signal === 'ended')).toBe(true)
    await unsubscribe()
  })

  it('does not advance a call-signal checkpoint when its handler rejects', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const frame = {
      type: 'call-signal' as const, version: 1 as const, signal: 'incoming' as const, media: 'voice' as const,
      callId: 'checkpoint_call',
      conversation: {
        id: '1:alice', kind: 'direct' as const, title: 'Alice', peerUid: 'alice', peerUin: '10001', chatType: 1 as const,
      },
      timestamp: 1,
    }
    const subscribe = vi.fn(async (handler, _signal, options) => {
      await handler(frame, 'call-checkpoint')
      options.onEventId?.('call-checkpoint')
    })
    platform.client.subscribe = subscribe

    const unsubscribe = await platform.subscribe(session, () => {
      throw new Error('message service unavailable')
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(subscribe).toHaveBeenCalledTimes(2)
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
        selfRole: 'owner',
        selfPermissions: { manageAdministrators: true },
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
    expect(dialogs.dialogs[0]!.conversation.metadata).not.toHaveProperty('qqGroupMsgMask')
    expect(platform.client.getMembers).not.toHaveBeenCalled()
    const members = await platform.getConversationMembers(session, { id: '2:1058754719' })
    expect(members.members[0]).toMatchObject({
      user: {
        id: 'u_very_long_opaque',
        firstName: 'Profile Name',
        username: '1715311957',
        avatar: { locator: { avatarUin: '1715311957' } },
        metadata: { qqName: 'Profile Name' },
      },
      role: 'administrator',
      permissions: { manageMembers: true, editAnyMessage: true, manageAdministrators: false },
      title: 'Group Alias',
    })
  })

  it('forwards Telegram administrator promotion and demotion to QQNT', async () => {
    const platform = new QQNTPlatform()
    platform.client.setMemberRole = vi.fn(async () => {})

    await platform.setConversationMemberRole!(session, { id: '2:group' }, 'opaque/member', 'administrator')
    await platform.setConversationMemberRole!(session, { id: '2:group' }, 'opaque/member', 'member')

    expect(platform.client.setMemberRole).toHaveBeenNthCalledWith(
      1, '2:group', 'opaque/member', 'administrator',
    )
    expect(platform.client.setMemberRole).toHaveBeenNthCalledWith(
      2, '2:group', 'opaque/member', 'member',
    )
  })

  it('propagates QQ group message masks into conversation metadata', async () => {
    const platform = new QQNTPlatform()
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [{
      id: '2:assistant-group', kind: 'group' as const, title: 'Assistant Group',
      peerUid: 'assistant-group', peerUin: '10001', chatType: 2 as const, groupMsgMask: 2 as const,
    }] }))
    const dialogs = await platform.getDialogs(session)
    expect(dialogs.dialogs[0]!.conversation.metadata).toMatchObject({ qqGroupMsgMask: 2 })
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

  it('keeps the profile nickname stable and omits blank member tags', async () => {
    const platform = new QQNTPlatform()
    platform.client.getMembers = vi.fn(async () => ({
      members: [{
        user: {
          id: 'member', numericId: '42', name: 'Profile Name', alias: '   ',
        },
        role: 'member' as const,
      }],
      total: 1,
    }))
    const page = await platform.getConversationMembers(session, { id: 'group' })
    expect(page.members).toMatchObject([{ user: {
      firstName: 'Profile Name',
      metadata: { qqName: 'Profile Name' },
    } }])
    expect(page.members[0].title).toBeUndefined()
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
        senderTitle: 'Group Alias',
        sender: {
          firstName: 'Profile Name',
          username: '42',
          avatar: { locator: { avatarUin: '42' } },
          metadata: { qqName: 'Profile Name' },
        },
      },
    })
    await unsubscribe()
  })

  it('keeps received images metadata-only without downloads, previews, or transforms', async () => {
    const platform = new QQNTPlatform()
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

    expect(platform.client.downloadFile).not.toHaveBeenCalled()
    expect(received).toHaveLength(2)
    for (const event of received as any[]) expect(event.message.content.parts[0]).toMatchObject({
      media: {
        name: 'photo.png', mimeType: 'image/png',
        locator: expect.not.objectContaining({ cachedPath: expect.anything() }),
      },
    })
    expect((received as any[]).every((event) => !event.message.content.parts[0].media.preview)).toBe(true)
  })

  it('delivers a live image before generating its inline stripped preview', async () => {
    const platform = new QQNTPlatform({ generatePreviews: true })
    const image = await sharp({
      create: { width: 24, height: 16, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).jpeg().toBuffer()
    const nativePreview = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).jpeg().toBuffer()
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    const sourceRequested = Promise.withResolvers<void>()
    const releaseSource = Promise.withResolvers<void>()
    platform.client.downloadFile = vi.fn(async function* (locator) {
      expect(locator).toMatchObject({
        fileName: 'photo.jpg', filePath: undefined, fileSize: undefined, imageSpec: 198,
        originImageUrl: '/download?appid=1407&fileid=photo&spec=0',
      })
      sourceRequested.resolve()
      await releaseSource.promise
      yield nativePreview
    })
    platform.client.subscribe = vi.fn(async (handler, signal) => {
      await handler({
        type: 'message',
        conversation: {
          id: '2:group', kind: 'group', title: 'Group', peerUid: 'group', peerUin: '42', chatType: 2,
        },
        message: {
          id: 'live-preview', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
          parts: [{
            type: 'media',
            media: {
              id: 'live-preview-media', kind: 'image', name: 'photo.jpg', mimeType: 'image/jpeg',
              size: image.length, width: 24, height: 16,
              preview: {
                mimeType: 'image/jpeg', size: nativePreview.length, width: 12, height: 8,
                locator: {
                  messageId: 'live-preview', elementId: 'live-preview-media', chatType: 2,
                  peerUid: 'group', kind: 'image', fileName: 'photo.jpg',
                  fileSize: String(nativePreview.length), imageSpec: 720,
                  originImageUrl: '/download?appid=1407&fileid=photo&spec=0',
                },
              },
              locator: {
                messageId: 'live-preview', elementId: 'live-preview-media', chatType: 2,
                peerUid: 'group', kind: 'image', fileName: 'photo.jpg', md5: 'LIVE-PREVIEW',
              },
            },
          }],
        },
      })
      if (!signal.aborted) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
    })
    const events: any[] = []
    const initial = Promise.withResolvers<any>()
    const edited = Promise.withResolvers<any>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      events.push(event)
      if (event.type === 'message') initial.resolve(event)
      if (event.type === 'message-edit') edited.resolve(event)
    })

    const delivered = await initial.promise
    expect(delivered.message.content.parts[0].media.preview).toMatchObject({
      size: nativePreview.length, width: 12, height: 8,
      locator: { fileName: 'photo.jpg', imageSpec: 720 },
    })
    expect(delivered.message.content.parts[0].media.strippedThumbnail).toBeUndefined()
    await sourceRequested.promise
    expect(events.map((event) => event.type)).toEqual(['message'])
    releaseSource.resolve()
    const update = await edited.promise
    expect(update.message.content.parts[0].media.preview).toMatchObject({
      size: nativePreview.length, width: 12, height: 8,
    })
    expect(update.message.content.parts[0].media.strippedThumbnail).toBeInstanceOf(Uint8Array)
    expect(platform.client.downloadFile).toHaveBeenCalledTimes(1)
    await unsubscribe()
  })

  it('strips legacy local markers before resolving the original QQ image URL', async () => {
    const platform = new QQNTPlatform()
    platform.client.resolveFileUrlForDirectDownload = vi.fn(async () => ({
      url: 'https://cdn.example.test/original.png', expiresAt: Date.now() + 60_000, supportsRange: true,
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
    await expect(platform.resolveMediaUrl(session, preview)).resolves.toMatchObject({
      url: 'https://cdn.example.test/original.png', supportsRange: true,
    })
    expect(platform.client.resolveFileUrlForDirectDownload).toHaveBeenCalledTimes(2)
    expect(platform.client.resolveFileUrlForDirectDownload).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ previewKey: expect.anything(), cachedPath: expect.anything() }),
    )
  })

  it('returns history images immediately without opening their bytes', async () => {
    const platform = new QQNTPlatform()
    const jpeg = await sharp({
      create: { width: 12, height: 8, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).jpeg().toBuffer()
    const events: any[] = []
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
    platform.client.downloadFile = vi.fn(async function* () { yield jpeg })
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => {
      events.push(event)
    })

    const history = await platform.getHistory(session, { id: '2:group' })
    const original = (history.messages[0].content.parts[0] as any).media
    expect(original).toMatchObject({
      kind: 'image', size: jpeg.length, width: 12, height: 8,
      locator: expect.not.objectContaining({ deferred: expect.anything() }),
    })

    expect(original.preview).toBeUndefined()
    expect(events.filter((event) => event.type === 'message-edit')).toEqual([])
    expect(platform.client.downloadFile).not.toHaveBeenCalled()
    await unsubscribe()
  })

  it('returns history before background inline preview generation and later publishes stripped bytes', async () => {
    const platform = new QQNTPlatform({ generatePreviews: true })
    const jpeg = await sharp({
      create: { width: 20, height: 12, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).jpeg().toBuffer()
    const wireMessage = {
      id: 'lazy-preview', conversationId: '2:group', senderId: 'alice', timestamp: 1, outgoing: false,
      parts: [{
        type: 'media' as const,
        media: {
          id: 'lazy-preview-media', kind: 'image' as const, name: 'photo.jpg', mimeType: 'image/jpeg',
          size: jpeg.length, width: 20, height: 12,
          locator: {
            messageId: 'lazy-preview', elementId: 'lazy-preview-media', chatType: 2 as const,
            peerUid: 'group', kind: 'image' as const, fileName: 'photo.jpg', md5: 'LAZY-PREVIEW',
          },
        },
      }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 20 }))
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    const sourceRequested = Promise.withResolvers<void>()
    const releaseSource = Promise.withResolvers<void>()
    platform.client.downloadFile = vi.fn(async function* () {
      sourceRequested.resolve()
      await releaseSource.promise
      yield jpeg
    })
    platform.client.resolveFileUrlForDirectDownload = vi.fn(async () => ({
      url: 'https://cdn.example.test/photo.jpg', expiresAt: Date.now() + 60_000, supportsRange: true,
    }))

    platform.client.getDialogs = vi.fn(async () => ({ conversations: [] }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const edited = Promise.withResolvers<any>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type === 'message-edit') edited.resolve(event)
    })

    const history = await platform.getHistory(session, { id: '2:group' })
    const original = (history.messages[0].content.parts[0] as any).media as IMMedia<QQMediaLocator>
    expect(original.preview).toBeUndefined()
    expect(original.strippedThumbnail).toBeUndefined()
    await sourceRequested.promise
    await expect(platform.resolveMediaUrl(session, original)).resolves.toMatchObject({
      url: 'https://cdn.example.test/photo.jpg', supportsRange: true,
    })
    expect(platform.client.resolveFileUrlForDirectDownload).toHaveBeenCalledTimes(1)

    releaseSource.resolve()
    const update = await edited.promise
    const stripped = update.message.content.parts[0].media.strippedThumbnail as Uint8Array
    expect(platform.client.downloadFile).toHaveBeenCalledTimes(1)
    expect(update.message.content.parts[0].media.preview).toBeUndefined()
    await expect(sharp(expandTelegramStrippedThumbnail(stripped)).metadata()).resolves.toMatchObject({
      format: 'jpeg', width: 20, height: 12,
    })
    await unsubscribe()
  })

  it('publishes live and historical GIF images as the same untouched QQ asset', async () => {
    const platform = new QQNTPlatform()
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
    const received = Promise.withResolvers<void>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      events.push(event)
      if (event.type === 'message') received.resolve()
    })

    await received.promise
    const history = await platform.getHistory(session, { id: '2:group' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await unsubscribe()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'message',
      message: { content: { parts: [{ media: {
        id: 'animated-media:original-v1', kind: 'image', mimeType: 'image/gif',
        locator: expect.not.objectContaining({ cachedPath: expect.anything(), previewKey: expect.anything() }),
      } }] } },
    })
    expect(history.messages[0]).toMatchObject({
      content: { parts: [{ media: { id: 'animated-media:original-v1', mimeType: 'image/gif' } }] },
    })
    expect(platform.client.downloadFile).not.toHaveBeenCalled()
  })

  it('returns history stickers immediately and opens the original asset only on demand', async () => {
    const platform = new QQNTPlatform()
    const provider = new QQStickerProvider(platform.client, 'qqnt:stickers')
    const png = await sharp({
      create: { width: 16, height: 12, channels: 4, background: { r: 70, g: 150, b: 220, alpha: 1 } },
    }).png().toBuffer()
    const events: any[] = []
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
        yield png
      },
    }))
    platform.client.subscribe = vi.fn(async (_handler, signal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const unsubscribe = await platform.subscribe(session, (event) => {
      events.push(event)
    })

    const history = await platform.getHistory(session, { id: '2:group' })
    const part = history.messages[0].content.parts[0]
    if (part.type !== 'sticker') throw new Error('missing history sticker')
    expect(part.sticker).toMatchObject({
      stickerId: 'favorite:history-sticker', format: 'static', mimeType: 'image/png',
      size: png.length, locator: expect.not.objectContaining({ deferred: expect.anything() }),
    })
    const asset = await provider.openAsset({ session, platformKind: 'qq' }, part.sticker)
    expect(await collect(asset.source.stream())).not.toHaveLength(0)

    expect(events.filter((event) => event.type === 'message-edit')).toEqual([])
    expect(platform.client.stickerSource).toHaveBeenCalledTimes(1)
    await unsubscribe()
  })

  it('projects QQ animated system faces as untouched APNG stickers without opening bytes', async () => {
    const platform = new QQNTPlatform()
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
        format: 'animated', mimeType: 'image/apng',
        locator: {
          kind: 'sysface', faceId: '476', faceType: 3, packId: '3',
          stickerId: '476', stickerType: 2, resultId: 'result-476',
        },
      },
    }])
    expect(platform.client.stickerSource).not.toHaveBeenCalled()
  })

  it('keeps catalog-keyed static and animated reactions raw until download', async () => {
    const platform = new QQNTPlatform()
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
    platform.client.downloadReactionResource = vi.fn(async function* (reactionKey, options) {
      expect(reactionKey === '1:265' || reactionKey === '1:14').toBe(true)
      const bytes = reactionKey === '1:265' ? png : apng
      const start = options?.offset ?? 0
      yield bytes.subarray(start, start + (options?.limit ?? bytes.length))
    })
    platform.client.getMessageReactions = vi.fn(async () => ({
      reactions: [{
        ...context.reactions[0],
        recentActors: [{ userId: 'actor-a' }, { userId: 'actor-b' }],
      }],
      maxSelected: 20,
    }))
    platform.client.getMessageReactionActors = vi.fn(async () => ({
      state: { reactions: context.reactions, maxSelected: 20 },
      actors: [{ reactionKey: '2:128522', actor: { userId: 'actor-a' } }],
      nextOffset: 'next-page',
    }))
    platform.client.setMessageReactions = vi.fn(async () => ({
      reactions: [{ key: '1:14', count: 1, selected: true }], maxSelected: 20,
    }))
    await vi.waitFor(async () => expect((await platform.getAvailableReactions(
      session, { conversationId: '2:g' },
    )).available).toHaveLength(3), { timeout: 5_000 })
    const catalog = await platform.getAvailableReactions(session, { conversationId: '2:g' })
    expect(catalog).toMatchObject({
      available: [{
        key: '2:128522',
      }, {
        key: '1:265',
        presentation: {
           resource: { format: 'static', mimeType: 'image/png', width: 200, height: 200 },
        },
      }, {
        key: '1:14',
        presentation: {
           resource: { format: 'animated', mimeType: 'image/apng', width: 128, height: 128 },
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
    expect(platform.client.downloadReactionResource).toHaveBeenCalledTimes(1)
    await expect(platform.getMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    })).resolves.toMatchObject({ reactions: [{
      key: '2:128522', selected: true,
      recentActors: [{ userId: 'actor-a' }, { userId: 'actor-b' }],
    }] })
    await expect(platform.getMessageReactionActors(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    }, { reactionKey: '2:128522', offset: 'current-page', limit: 25 })).resolves.toMatchObject({
      context: { available: expect.any(Array), reactions: [{ key: '2:128522', count: 2 }] },
      actors: [{ reactionKey: '2:128522', actor: { userId: 'actor-a' } }],
      nextOffset: 'next-page',
    })
    await expect(platform.setMessageReactions(session, {
      conversationId: '2:g', messageId: 'm', targetId: 'm', nativeSequence: '571',
    }, ['1:14'])).resolves.toMatchObject({ reactions: [{ key: '1:14', selected: true }] })
    expect(platform.client.getMessageReactions).toHaveBeenCalledWith('2:g', 'm', '571')
    expect(platform.client.getMessageReactionActors).toHaveBeenCalledWith(
      '2:g', 'm', '2:128522', 'current-page', 25, '571',
    )
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
    const previewLocator = {
      messageId: 'm', elementId: 'e', chatType: 1 as const, peerUid: 'u',
      kind: 'image' as const, fileName: 'x.jpg', filePath: '/tmp/x.jpg',
    }
    platform.client.sendMessage = vi.fn(async () => ({
      id: 'm', conversationId: '1:u', senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'media' as const, media: {
        id: 'e', kind: 'file' as const, name: 'clip.mp4', mimeType: 'video/mp4',
        size: 3, width: 1280, height: 720, duration: 12,
        preview: { mimeType: 'image/jpeg', size: 2, width: 1280, height: 720, locator: previewLocator },
        locator,
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
      mimeType: 'video/mp4', width: 1280, height: 720, duration: 12,
      preview: { mimeType: 'image/jpeg', size: 2, width: 1280, height: 720, locator: previewLocator },
      locator,
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

  it('maps recorded voice media with its OGG duration and rejects mixed voice messages', async () => {
    const platform = new QQNTPlatform()
    const locator = {
      messageId: 'voice-message', elementId: 'voice-element', chatType: 1 as const, peerUid: 'u',
      kind: 'voice' as const, fileName: 'voice.ogg', fileSize: '42', filePath: '/cache/voice.ogg',
    }
    platform.client.sendMessage = vi.fn(async (_conversation, _text, media) => {
      expect(media).toMatchObject([{ kind: 'file', voice: true, mimeType: 'audio/ogg', duration: 7 }])
      return {
        id: 'voice-message', conversationId: '1:u', senderId: 'self', timestamp: 10, outgoing: true,
        parts: [{ type: 'media' as const, media: {
          id: 'voice-element', kind: 'file' as const, voice: true, name: 'voice.ogg', mimeType: 'audio/ogg',
          size: 42, duration: 7, locator,
        } }],
      }
    })
    const sent = await platform.sendMessage(session, { id: '1:u' }, { parts: [{ type: 'media', media: {
      kind: 'file', voice: true, name: 'voice.ogg', mimeType: 'audio/ogg', duration: 7,
      source: { async *stream() { yield Uint8Array.of(1) } },
    } }] })
    expect(sent.content.parts).toMatchObject([{ type: 'media', media: {
      voice: true, mimeType: 'audio/ogg', size: 42, duration: 7, locator,
    } }])
    await expect(platform.sendMessage(session, { id: '1:u' }, { parts: [
      { type: 'text', text: 'no mixing' },
      { type: 'media', media: { kind: 'file', voice: true, source: { async *stream() { yield Uint8Array.of(1) } } } },
    ] })).rejects.toThrow('exactly one voice item without a reply')
  })

  it('rejects multiple voice items and voice media mixed with ordinary media', async () => {
    const platform = new QQNTPlatform()
    const send = vi.spyOn(platform.client, 'sendMessage')
    const source = { async *stream() { yield Uint8Array.of(1) } }
    for (const parts of [
      [
        { type: 'media' as const, media: { kind: 'file' as const, voice: true, source } },
        { type: 'media' as const, media: { kind: 'file' as const, voice: true, source } },
      ],
      [
        { type: 'media' as const, media: { kind: 'file' as const, voice: true, source } },
        { type: 'media' as const, media: { kind: 'file' as const, source } },
      ],
    ]) {
      await expect(platform.sendMessage(session, { id: '1:u' }, { parts }))
        .rejects.toThrow('exactly one voice item without a reply')
    }
    expect(send).not.toHaveBeenCalled()
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

  it('maps QQ device sessions to Saved Messages and keeps wire calls physical', async () => {
    const platform = new QQNTPlatform()
    const physicalId = 'device:8:phone'
    const wireMessage = {
      id: 'saved-message', conversationId: physicalId, senderId: 'self', timestamp: 10, outgoing: true,
      parts: [{ type: 'text' as const, text: 'saved' }],
    }
    platform.client.getReactionCatalog = vi.fn(async () => ({ available: [], reactions: [], maxSelected: 0 }))
    platform.client.getDialogs = vi.fn()
      .mockResolvedValueOnce({ conversations: [{
        id: physicalId,
        kind: 'direct' as const,
        title: '我的手机',
        peerUid: 'phone',
        peerUin: '',
        chatType: 8 as const,
        lastMessage: wireMessage,
      }], nextCursor: 'next' })
      .mockResolvedValueOnce({ conversations: [{
        id: 'device:134:desktop',
        kind: 'direct' as const,
        title: '我的电脑',
        peerUid: 'desktop',
        peerUin: '',
        chatType: 134 as const,
      }] })
    platform.client.getHistory = vi.fn(async () => ({ messages: [wireMessage] }))
    platform.client.sendMessage = vi.fn(async () => ({ ...wireMessage, id: 'sent-saved' }))
    platform.client.prepareFastUpload = vi.fn()

    await expect(platform.getDialogs(session)).resolves.toMatchObject({
      dialogs: [{
        conversation: {
          id: 'self', kind: 'direct', title: '我的手机',
          metadata: { chatType: 8, qqConversationId: physicalId },
        },
        lastMessage: { id: 'saved-message', conversationId: 'self' },
      }],
    })
    await expect(platform.getDialogs(session, { cursor: 'next' })).resolves.toMatchObject({ dialogs: [] })
    await expect(platform.getHistory(session, { id: 'self' })).resolves.toMatchObject({
      messages: [{ id: 'saved-message', conversationId: 'self' }],
    })
    expect(platform.client.getHistory).toHaveBeenCalledWith(physicalId, expect.any(Object))
    await expect(platform.sendMessage(session, { id: 'self' }, {
      parts: [{ type: 'text', text: 'saved' }],
    })).resolves.toMatchObject({ id: 'sent-saved', conversationId: 'self' })
    expect(platform.client.sendMessage).toHaveBeenCalledWith(
      physicalId, 'saved', undefined, expect.any(Object), expect.any(String), undefined,
      [{ type: 'text', text: 'saved', entities: undefined }], undefined, undefined,
    )
    await expect(platform.prepareMediaUpload!(session, { id: 'self' }, {
      kind: 'image', name: 'saved.png', mimeType: 'image/png',
      hashes: { size: 1, md5: 'md5', sha1: 'sha1', file10MMd5: 'prefix' },
    })).resolves.toBeUndefined()
    expect(platform.client.prepareFastUpload).not.toHaveBeenCalled()
  })
})

describe('QQNTPlatform dialogs polling', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function conversation(
    id: string,
    withLastMessage = true,
    originRequestId?: string,
    messageId = `${id}-message`,
    timestamp = 1,
  ) {
    return {
      id,
      kind: 'group' as const,
      title: id,
      peerUid: id,
      peerUin: id,
      chatType: 2 as const,
      ...(withLastMessage ? {
        lastMessage: {
          id: messageId, conversationId: id, senderId: 'member', timestamp, outgoing: false,
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

  it('revalidates the foreground dialog list instead of using the polling snapshot', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('revalidated-first')], total: 1,
    }))

    const unsubscribe = await platform.subscribe(session, () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(platform.client.getDialogs).toHaveBeenCalledOnce()

    await expect(platform.getDialogs(session, { limit: 101 })).resolves.toMatchObject({
      total: 1,
      dialogs: [{ conversation: { id: 'revalidated-first' }, lastMessage: { id: 'revalidated-first-message' } }],
    })
    expect(platform.client.getDialogs).toHaveBeenCalledTimes(2)
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

  it('recovers a changed last message for an already known dialog', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    let latestId = 'existing-1'
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('existing', true, undefined, latestId, latestId === 'existing-1' ? 1 : 2)],
    }))
    platform.client.getHistory = vi.fn(async () => ({
      messages: [conversation('existing', true, undefined, latestId, 2).lastMessage!],
    }))
    const events: any[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)
    latestId = 'existing-2'
    await vi.advanceTimersByTimeAsync(15_000)

    expect(events).toMatchObject([{
      type: 'message', conversation: { id: 'existing' }, message: { id: 'existing-2' },
    }])
    expect(platform.client.getHistory).toHaveBeenCalledWith('existing', {
      afterId: 'existing-1', limit: 100,
    })
    await unsubscribe()
  })

  it('recovers every message between the previous and latest dialog cursors in order', async () => {
    vi.useFakeTimers()
    const platform = new QQNTPlatform()
    mockSubscribe(platform)
    let latestId = '100'
    platform.client.getDialogs = vi.fn(async () => ({
      conversations: [conversation('busy', true, undefined, latestId, Number(latestId))],
    }))
    platform.client.getHistory = vi.fn(async () => ({
      messages: [
        conversation('busy', true, undefined, '102', 102).lastMessage!,
        conversation('busy', true, undefined, '101', 101).lastMessage!,
      ],
    }))
    const events: any[] = []

    const unsubscribe = await platform.subscribe(session, (event) => { events.push(event) })
    await vi.advanceTimersByTimeAsync(0)
    latestId = '102'
    await vi.advanceTimersByTimeAsync(15_000)

    expect(events.map((event) => event.message.id)).toEqual(['101', '102'])
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

  it('forwards setConversationNotificationMask to the QQNT bridge with chatType and peerUin', async () => {
    const platform = new QQNTPlatform()
    platform.client.getConversation = vi.fn(async () => ({
      id: '2:group', kind: 'group' as const, title: 'Group',
      peerUid: '1058754719', peerUin: '1058754719', chatType: 2 as const,
    }))
    await platform.getConversation(session, '2:group')

    platform.client.setNotificationMask = vi.fn(async () => {})
    await platform.setConversationNotificationMask!(session, '2:group', 4)
    expect(platform.client.setNotificationMask).toHaveBeenCalledWith(2, '1058754719', 4)

    // unknown conversation id → no platform call
    platform.client.setNotificationMask = vi.fn(async () => {})
    await platform.setConversationNotificationMask!(session, 'unknown', 1)
    expect(platform.client.setNotificationMask).not.toHaveBeenCalled()
  })

  it('skips setConversationNotificationMask when conversation metadata lacks a numeric peerUin', async () => {
    const platform = new QQNTPlatform()
    platform.client.getConversation = vi.fn(async () => ({
      id: 'bare-group', kind: 'group' as const, title: 'Bare',
      peerUid: 'bare', peerUin: '', chatType: 2 as const,
    }))
    await platform.getConversation(session, 'bare-group')
    platform.client.setNotificationMask = vi.fn(async () => {})
    await platform.setConversationNotificationMask!(session, 'bare-group', 4)
    expect(platform.client.setNotificationMask).not.toHaveBeenCalled()
  })
})
