import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { DialogRpc, makeTlArticleMedia, makeTlMessageMedia, projectTlMessage, stableId } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { ReactionRpc } from './reaction-rpc.js'
import { UploadManager } from './upload-manager.js'
import { IMMediaUnavailableError } from './platform.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'media-session', platformId: 'media', userId: 'self', credentials: {}, metadata: {},
}

const conversation: IMConversation = { id: 'album-room', kind: 'direct', title: 'Album room' }

const strippedThumbnail = new Uint8Array(Buffer.from(
  'ASgcyhzwBzRjFTxoNoOKXaGHSrsK5BgYo2/WpjFx7VF0pAWo5YhGAykN7VKgUj5dv4tn+VV9o+UZAyad5WD94ZpXHYfMDs5Kgf7tU+hOCaslSwx5gP15qs3DEUXAdJIXfJ7cUpnYhQTwtFFKwXATssm9eCOmKjYksSe9FFAXPw==',
  'base64',
))

const album: IMMessage = {
  id: 'logical-album',
  sourceIds: ['platform-photo-message', 'platform-file-message'],
  conversationId: conversation.id,
  senderId: 'alice',
  timestamp: 1_800_000_000,
  content: {
    parts: [
      { type: 'text', text: 'album caption' },
      {
        type: 'media',
        media: {
          id: 'photo', kind: 'image', name: 'photo.png', mimeType: 'image/png',
          size: 1234, width: 800, height: 600, locator: { remote: 'photo' },
          strippedThumbnail,
          preview: {
            mimeType: 'image/webp', size: 7, width: 320, height: 240,
            locator: { remote: 'photo-preview' },
          },
        },
      },
      {
        type: 'media',
        media: {
          id: 'document', kind: 'file', name: 'report.pdf', mimeType: 'application/pdf',
          size: 5678, locator: { remote: 'document' },
        },
      },
    ],
  },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
    conversations: { groups: true, channels: true, subchannels: true },
  },
  async subscribe() { return () => {} },
  async sendMessage() { return album },
  async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: album }] } },
  async getHistory() { return { messages: [album] } },
  async getUser(_session, id) { return { id, firstName: id === 'alice' ? 'Alice' : 'Album room' } },
  async *downloadMedia(_session, media, options) {
    const bytes = new TextEncoder().encode((media.locator as { remote: string }).remote)
    yield bytes.subarray(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? bytes.length))
  },
  async resolveMediaUrl(_session, media) {
    return {
      url: `https://cdn.example.test/${(media.locator as { remote: string }).remote}`,
      expiresAt: Date.now() + 60_000,
      supportsRange: true,
    }
  },
}

const disposals: Array<() => Promise<void>> = []

it('projects gray-tip service actions as silent Telegram MessageService records', () => {
  const source: IMMessage = {
    id: 'gray-tip', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_001,
    content: { parts: [], serviceAction: { type: 'custom', text: 'Alice戳了戳你' } },
  }
  expect(projectTlMessage({
    conversation, source, tlId: 7, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })).toMatchObject({
    _: 'messageService', id: 7, silent: true,
    action: { _: 'messageActionCustomAction', message: 'Alice戳了戳你' },
  })
})

it('keeps ordinary messages at the existing notification default', () => {
  const source: IMMessage = {
    id: 'ordinary-message', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_001,
    content: { parts: [{ type: 'text', text: 'regular message' }] },
  }
  const projected = projectTlMessage({
    conversation, source, tlId: 7, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })
  expect(projected).toMatchObject({ _: 'message', id: 7, message: 'regular message' })
  expect(projected).not.toHaveProperty('silent')
})

it('projects a conversation-scoped sender title as a Telegram member tag', () => {
  const source: IMMessage = {
    id: 'member-tag', conversationId: conversation.id, senderId: 'alice', senderTitle: 'Group Alias',
    timestamp: 1_800_000_002, content: { parts: [{ type: 'text', text: 'tagged' }] },
  }
  expect(projectTlMessage({
    conversation, source, tlId: 8, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })).toMatchObject({ _: 'message', id: 8, fromRank: 'Group Alias' })
})

it('projects unread mentions with Telegram content-unread state', () => {
  const source: IMMessage = {
    id: 'unread-mention', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_002,
    content: { parts: [{ type: 'text', text: '@Current ping' }] },
  }
  expect(projectTlMessage({
    conversation, source, tlId: 9, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 }, mentioned: true, unreadMention: true,
  })).toMatchObject({ _: 'message', mentioned: true, mediaUnread: true })
  expect(projectTlMessage({
    conversation, source, tlId: 9, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 }, mentioned: true, unreadMention: false,
  })).toMatchObject({ _: 'message', mentioned: true, mediaUnread: undefined })
})

it('projects phone-call service actions as native Telegram call records', () => {
  const source: IMMessage = {
    id: 'call-record', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_002,
    content: { parts: [], serviceAction: { type: 'phone-call' } },
  }
  const projected = projectTlMessage({
    conversation, source, tlId: 8, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })
  expect(projected).toMatchObject({
    _: 'messageService', id: 8, silent: true,
    action: { _: 'messageActionPhoneCall', callId: Long.fromNumber(stableId('phone-call:call-record')) },
  })
  if (projected._ !== 'messageService' || projected.action._ !== 'messageActionPhoneCall') {
    throw new Error('expected native phone-call action')
  }
  expect(projected.action.reason).toBeUndefined()
  expect(projected.action.duration).toBeUndefined()
  expect(projected.action.video).toBeUndefined()
})

it('projects a custom service action with no text as an empty MessageService action', () => {
  // Some platforms emit a gray tip whose text is empty or absent. The TL action
  // still requires the `message` field, so it must not be projected as
  // `undefined` (which makes messages.getHistory serialization fail with
  // "missing required property message").
  const source: IMMessage = {
    id: 'empty-gray-tip', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_003,
    content: { parts: [], serviceAction: { type: 'custom', text: '' } },
  }
  expect(projectTlMessage({
    conversation, source, tlId: 9, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })).toMatchObject({
    _: 'messageService', id: 9, silent: true,
    action: { _: 'messageActionCustomAction', message: '' },
  })
})

it('keeps forum topic metadata when a topic message also replies to another message', () => {
  const topicConversation: IMConversation = {
    id: 'support-thread', kind: 'channel', title: 'Support', parentId: 'general',
  }
  const source: IMMessage = {
    id: 'topic-reply', conversationId: topicConversation.id, senderId: 'alice', timestamp: 2,
    replyToId: 'another-message', content: { parts: [{ type: 'text', text: 'nested reply' }] },
  }

  expect(projectTlMessage({
    conversation: topicConversation, source, tlId: 30, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 }, replyToTlId: 20, topicId: 10,
  })).toMatchObject({
    _: 'message',
    replyTo: {
      _: 'messageReplyHeader', forumTopic: true,
      replyToMsgId: 20, replyToTopId: 10,
    },
  })
})

it('projects platform inline keyboards as Telegram URL and callback buttons', () => {
  const source: IMMessage = {
    id: 'bot-message', conversationId: conversation.id, senderId: 'bot', timestamp: 3,
    content: {
      parts: [{ type: 'text', text: 'Choose' }],
      inlineKeyboard: { rows: [{ buttons: [
        { type: 'url', text: 'Open', url: 'https://example.com', style: 'primary' },
        { type: 'callback', text: 'Confirm', data: 'confirm:42', style: 'danger' },
      ] }] },
    },
  }
  expect(projectTlMessage({
    conversation, source, tlId: 31, ordinal: 0,
    fromId: { _: 'peerUser', userId: 42 },
  })).toMatchObject({
    _: 'message',
    replyMarkup: {
      _: 'replyInlineMarkup',
      rows: [{ buttons: [
        {
          _: 'keyboardButtonUrl', text: 'Open', url: 'https://example.com',
          style: { _: 'keyboardButtonStyle', bgPrimary: true },
        },
        {
          _: 'keyboardButtonCallback', text: 'Confirm',
          data: Buffer.from('confirm:42'),
          style: { _: 'keyboardButtonStyle', bgDanger: true },
        },
      ] }],
    },
  })
})

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  const store = new MessageStore(ctx.database)
  const peerId = (await store.upsertUser(session, {
    id: conversation.id, firstName: conversation.title,
  })).id
  return { store, peerId }
}

function historyRequest(userId: number): tl.messages.RawGetHistoryRequest {
  return {
    _: 'messages.getHistory',
    peer: { _: 'inputPeerUser', userId, accessHash: Long.ZERO },
    offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  }
}

function dialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

function wireRoundTrip<T>(object: T): T {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object as tl.TlObject)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as T
}

describe('shared-media search', () => {
  it('hydrates persisted mention users before projecting native search results', async () => {
    const { store } = await createStore()
    const mention: IMMessage = {
      id: 'search-mention', conversationId: conversation.id, senderId: 'alice',
      timestamp: 1_800_000_080,
      content: { parts: [{
        type: 'text', text: '@Carol gpt',
        entities: [{ type: 'mention', offset: 0, length: 6, userId: 'carol' }],
      }] },
    }
    const searchable: IMPlatform = {
      ...platform,
      async searchMessages() { return { messages: [mention] } },
    }
    const rpc = new DialogRpc(searchable, session, store)
    await rpc.getDialogs(dialogsRequest())
    const peer = {
      _: 'inputPeerUser' as const, userId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO,
    }

    const result = await rpc.search({
      _: 'messages.search', peer, q: 'gpt', filter: { _: 'inputMessagesFilterEmpty' },
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 20,
      maxId: 0, minId: 0, hash: Long.ZERO,
    })

    if (result._ === 'messages.messagesNotModified') throw new Error('expected search result')
    const message = result.messages[0]
    expect(message).toMatchObject({
      _: 'message', message: '@Carol gpt',
      entities: [{ _: 'messageEntityMentionName', offset: 0, length: 6 }],
    })
    const carol = await store.getUser(session.platformId, 'carol')
    expect(carol).toBeDefined()
    expect(message?._ === 'message' ? message.entities?.[0] : undefined)
      .toMatchObject({ userId: carol!.id })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('classifies photos, videos, files, GIFs, audio, voice, and links', async () => {
    const { store } = await createStore()
    const searched: IMMessage[] = [
      mediaMessage('search-document', 'document', 'report.pdf', 'application/pdf'),
      {
        id: 'search-video-album', sourceIds: ['search-video-1', 'search-video-2'],
        conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_020,
        content: { parts: [
          { type: 'text', text: 'video album' },
          { type: 'media', media: media('video-1', 'file', 'one.mp4', 'video/mp4') },
          { type: 'media', media: media('video-2', 'file', 'two.mp4', 'video/mp4') },
        ] },
      },
      mediaMessage('search-photo', 'photo', 'photo.png', 'image/png', 'image'),
      mediaMessage('search-gif', 'gif', 'animation.gif', 'image/gif', 'image'),
      mediaMessage('search-music', 'music', 'song.mp3', 'audio/mpeg'),
      {
        ...mediaMessage('search-voice', 'voice', 'voice.ogg', 'audio/ogg'),
        content: { parts: [
          { type: 'text', text: 'voice' },
          { type: 'media', media: { ...media('voice', 'file', 'voice.ogg', 'audio/ogg'), voice: true } },
        ] },
      },
      {
        id: 'search-link', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_070,
        content: { parts: [{ type: 'text', text: 'visit https://example.com/path' }] },
      },
    ]
    const queries: import('./platform.js').IMMessageSearchQuery[] = []
    const searchable: IMPlatform = {
      ...platform,
      async searchMessages(_session, _conversation, query) {
        queries.push(query)
        const coarse = searched.filter((message) => !query.mediaKind || message.content.parts.some((part) =>
          part.type === 'media' && part.media.kind === query.mediaKind))
        const start = Number(query.cursor ?? 0)
        const limit = Math.min(query.limit ?? 50, 1)
        return {
          messages: coarse.slice(start, start + limit),
          nextCursor: start + limit < coarse.length ? String(start + limit) : undefined,
        }
      },
    }
    const rpc = new DialogRpc(searchable, session, store)
    await rpc.getDialogs(dialogsRequest())
    const peer = {
      _: 'inputPeerUser' as const, userId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO,
    }
    const search = async (filter: tl.TypeMessagesFilter, limit = 100, offsetId = 0) => rpc.search({
      _: 'messages.search', peer, q: '', filter,
      minDate: 0, maxDate: 0, offsetId, addOffset: 0, limit,
      maxId: 0, minId: 0, hash: Long.ZERO,
    })
    const texts = (result: tl.messages.TypeMessages) => result._ === 'messages.messagesNotModified'
      ? []
      : result.messages.map((message) => message._ === 'message' ? message.message : '')

    expect(texts(await search({ _: 'inputMessagesFilterPhotos' }))).toEqual(['photo'])
    expect(texts(await search({ _: 'inputMessagesFilterPhotoVideo' }))).toEqual([
      'video album', '', 'photo',
    ])
    expect(texts(await search({ _: 'inputMessagesFilterDocument' }))).toEqual(['document'])
    expect(texts(await search({ _: 'inputMessagesFilterGif' }))).toEqual(['gif'])
    expect(texts(await search({ _: 'inputMessagesFilterMusic' }))).toEqual(['music'])
    expect(texts(await search({ _: 'inputMessagesFilterVoice' }))).toEqual(['voice'])
    expect(texts(await search({ _: 'inputMessagesFilterUrl' }))).toEqual([
      'visit https://example.com/path',
    ])

    const firstVideo = await search({ _: 'inputMessagesFilterVideo' }, 1)
    expect(texts(firstVideo)).toEqual(['video album'])
    expect(queries.filter((query) => query.mediaKind === 'file').slice(-2).map((query) => query.cursor))
      .toEqual([undefined, '1'])
    if (firstVideo._ === 'messages.messagesNotModified') throw new Error('expected video result')
    const firstVideoId = (firstVideo.messages[0] as tl.RawMessage).id
    expect(texts(await search({ _: 'inputMessagesFilterVideo' }, 1, firstVideoId))).toEqual([''])
  })

  it('returns non-zero counters and count-only desktop results for available media', async () => {
    const { store } = await createStore()
    const rpc = new DialogRpc(platform, session, store)
    await rpc.getDialogs(dialogsRequest())
    const peer = {
      _: 'inputPeerUser' as const, userId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO,
    }
    const countOnly = await rpc.search({
      _: 'messages.search', peer, q: '', filter: { _: 'inputMessagesFilterPhotos' },
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit: 0,
      maxId: 0, minId: 0, hash: Long.ZERO,
    })
    expect(countOnly).toMatchObject({ _: 'messages.messagesSlice', count: 1, messages: [] })

    await expect(rpc.getSearchCounters({
      _: 'messages.getSearchCounters', peer,
      filters: [
        { _: 'inputMessagesFilterPhotos' },
        { _: 'inputMessagesFilterDocument' },
        { _: 'inputMessagesFilterVideo' },
      ],
    })).resolves.toMatchObject([
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterPhotos' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterDocument' }, count: 1 },
      { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterVideo' }, count: 0 },
    ])
    expect(() => wireRoundTrip(countOnly)).not.toThrow()
  })
})

function media(id: string, kind: 'image' | 'file', name: string, mimeType: string) {
  return { id, kind, name, mimeType, size: 42, locator: { remote: id } } as const
}

function mediaMessage(
  id: string,
  text: string,
  name: string,
  mimeType: string,
  kind: 'image' | 'file' = 'file',
): IMMessage {
  return {
    id, conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_010,
    content: { parts: [
      { type: 'text', text },
      { type: 'media', media: media(id, kind, name, mimeType) },
    ] },
  }
}

describe('rich-media projection', () => {
  it('uses the durable media row ID as the Telegram media ID and reference', async () => {
    const { store, peerId } = await createStore()
    const persisted = await store.ingest(session, conversation, album)
    const rowId = persisted.projection.find((part) => part.mediaId !== null)?.mediaId
    if (!rowId) throw new Error('expected persisted media row')
    const uploadPath = await mkdtemp(join(tmpdir(), 'bridge-row-id-'))
    disposals.push(() => rm(uploadPath, { recursive: true, force: true }))
    const rpc = new DialogRpc(platform, session, store, new UploadManager(uploadPath))
    const history = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const projected = (history.messages.at(-1) as tl.RawMessage).media as tl.RawMessageMediaPhoto
    if (projected.photo?._ !== 'photo') throw new Error('expected projected photo')

    expect(projected.photo.id.toNumber()).toBe(rowId)
    expect(projected.photo.accessHash.toNumber()).toBe(rowId)
    expect(new TextDecoder().decode(projected.photo.fileReference)).toBe(`bridge-media:${rowId}`)
    await expect(rpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPhotoFileLocation', id: projected.photo.id, accessHash: projected.photo.accessHash,
        fileReference: projected.photo.fileReference, thumbSize: '',
      },
      offset: 0, limit: 1024,
    })).resolves.toMatchObject({ _: 'upload.file', bytes: new TextEncoder().encode('photo') })
    await expect(rpc.getFileUrl({
      _: 'inputPhotoFileLocation', id: projected.photo.id, accessHash: projected.photo.accessHash,
      fileReference: projected.photo.fileReference, thumbSize: '',
    })).resolves.toMatchObject({ _: 'dataJSON' })

    await expect(rpc.getFileUrl({
      _: 'inputPhotoFileLocation', id: projected.photo.id, accessHash: projected.photo.accessHash,
      fileReference: new TextEncoder().encode(`bridge-media:${rowId}:123`), thumbSize: '',
    })).rejects.toThrow('FILE_REFERENCE_INVALID')
  })

  it('projects raw GIF/APNG images as documents with client-decodable metadata', () => {
    for (const mimeType of ['image/gif', 'image/apng']) {
      expect(makeTlMessageMedia({
        id: 91, messageId: 1, ordinal: 0, partIndex: 0, platformMediaId: mimeType,
        kind: 'image', name: mimeType === 'image/gif' ? 'animation.gif' : 'animation.apng',
        mimeType, size: 123, width: 40, height: 30, duration: null,
        preview: null, strippedThumbnail: null, locator: { remote: mimeType },
      }, 1)).toMatchObject({
        _: 'messageMediaDocument',
        document: {
          _: 'document', mimeType,
          attributes: [
            { _: 'documentAttributeFilename' },
            { _: 'documentAttributeImageSize', w: 40, h: 30 },
          ],
        },
      })
    }
  })

  it('round-trips recorded voice media as an OGG document with exact size', () => {
    const projected = wireRoundTrip(makeTlMessageMedia({
      id: 92, messageId: 1, ordinal: 0, partIndex: 0, platformMediaId: 'voice',
      kind: 'file', name: 'voice.ogg', mimeType: 'audio/ogg', size: 42, width: null, height: null,
      duration: 7, voice: true, preview: null, strippedThumbnail: null, locator: { remote: 'voice' },
    }, 1)) as tl.RawMessageMediaDocument
    expect(projected._).toBe('messageMediaDocument')
    const document = projected.document
    expect(document._).toBe('document')
    if (document._ !== 'document') throw new Error('voice media should deserialize to a document')
    expect(document.mimeType).toBe('audio/ogg')
    expect(document.size).toBe(42)
    const audio = document.attributes.find((attribute) => attribute._ === 'documentAttributeAudio') as tl.RawDocumentAttributeAudio | undefined
    expect(audio?.voice).toBe(true)
    expect(audio?.duration).toBe(7)
  })

  it('marks ordinary audio documents as Telegram music', () => {
    const projected = makeTlMessageMedia({
      id: 93, messageId: 1, ordinal: 0, partIndex: 0, platformMediaId: 'music',
      kind: 'file', name: 'song.mp3', mimeType: 'audio/mpeg', size: 4200,
      width: null, height: null, duration: 123, voice: null,
      preview: null, strippedThumbnail: null, locator: { remote: 'music' },
    }, 1) as tl.RawMessageMediaDocument
    expect(projected.document).toMatchObject({
      _: 'document',
      attributes: expect.arrayContaining([{ _: 'documentAttributeAudio', duration: 123 }]),
    })
  })

  it('returns sticker/reaction direct URLs and leaves stream-only assets on upload.getFile fallback', async () => {
    const { store } = await createStore()
    const direct = { url: 'https://cdn.example.test/raw.gif', expiresAt: Date.now() + 60_000, supportsRange: true }
    const sticker = {
      getFileUrl: vi.fn(async () => direct),
      getFile: vi.fn(async () => Uint8Array.from([1, 2, 3])),
    }
    const reaction = {
      getFileUrl: vi.fn(async () => undefined),
      getFile: vi.fn(async () => ({ bytes: Uint8Array.from([4, 5, 6]), mimeType: 'image/apng' })),
    }
    const rpc = new DialogRpc(
      platform, session, store, undefined, undefined, 1, sticker as never, reaction as never,
    )
    const stickerId = Long.fromNumber(7001)
    const stickerReference = new TextEncoder().encode('bridge-sticker:qq:wave:1')
    const stickerLocation = {
      _: 'inputDocumentFileLocation' as const,
      id: stickerId, accessHash: stickerId, fileReference: stickerReference, thumbSize: '',
    }
    const url = await rpc.getFileUrl(stickerLocation)
    expect(JSON.parse(url.data)).toMatchObject({ url: direct.url, supportsRange: true })
    expect(sticker.getFileUrl).toHaveBeenCalledWith(7001, stickerReference)

    const reactionId = Long.fromNumber(7002)
    const reactionReference = new TextEncoder().encode('bridge-reaction-resource:7002:1')
    const reactionLocation = {
      _: 'inputDocumentFileLocation' as const,
      id: reactionId, accessHash: reactionId, fileReference: reactionReference, thumbSize: '',
    }
    await expect(rpc.getFileUrl(reactionLocation)).rejects.toThrow('MEDIA_DIRECT_URL_UNAVAILABLE')
    const fallback = await rpc.getFile({
      _: 'upload.getFile', precise: true, cdnSupported: false,
      location: reactionLocation, offset: 0, limit: 3,
    })
    expect(fallback).toMatchObject({ _: 'upload.file', bytes: Uint8Array.from([4, 5, 6]) })
    expect(reaction.getFile).toHaveBeenCalled()
  })

  it('uses preview dimensions when the upstream image omitted its original size', () => {
    const projected = makeTlMessageMedia({
      id: 1, messageId: 1, ordinal: 0, partIndex: 0, platformMediaId: 'missing-dimensions',
      kind: 'image', name: 'wide.jpg', mimeType: 'image/jpeg', size: 100,
      width: null, height: null, duration: null,
      preview: {
        mimeType: 'image/webp', size: 20, width: 320, height: 180,
        locator: { previewKey: 'wide-preview' },
      },
      strippedThumbnail: null, locator: { remote: 'wide-original' },
    }, 1)

    expect(projected).toMatchObject({
      _: 'messageMediaPhoto',
      photo: { _: 'photo', sizes: [
        { _: 'photoSize', type: 'm', w: 320, h: 180, size: 20 },
        { _: 'photoSize', type: 'x', w: 320, h: 180, size: 100 },
      ] },
    })
  })

  it('persists a native reply when the platform send response does not echo its reply ID', async () => {
    const { store, peerId } = await createStore()
    const sendMessage = vi.fn(async (): Promise<IMMessage> => ({
      id: 'sent-without-reply', conversationId: conversation.id, senderId: 'self',
      timestamp: 1_800_000_100, outgoing: true,
      content: { parts: [{ type: 'text', text: 'native reply' }] },
    }))
    const rpc = new DialogRpc({ ...platform, sendMessage }, session, store)
    const history = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const target = history.messages.find((message) => message._ === 'message' && message.message === 'album caption')
    expect(target).toMatchObject({ _: 'message' })

    const sent = await rpc.sendMessage({
      _: 'messages.sendMessage',
      peer: { _: 'inputPeerUser', userId: peerId, accessHash: Long.ZERO },
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: target!.id },
      message: 'native reply', randomId: Long.fromNumber(9123),
    }) as tl.RawUpdates
    const sentId = (sent.updates[0] as tl.RawUpdateMessageID).id

    expect(sent).toMatchObject({
      _: 'updates', seq: 0,
      updates: [
        { _: 'updateMessageID', id: sentId, randomId: Long.fromNumber(9123) },
        {
          _: 'updateNewMessage',
          message: { id: sentId, replyTo: { replyToMsgId: target!.id } },
        },
      ],
    })

    expect(sendMessage).toHaveBeenCalledWith(
      session,
      { id: conversation.id },
      expect.objectContaining({ replyToId: album.id }),
    )
    await expect(store.findProjectedByTlId(
      session.platformSessionId, sentId, conversation.id,
    )).resolves.toMatchObject({ source: { replyToId: album.id } })
  })

  it('projects structured platform cards as serializable Telegram WebPage previews', async () => {
    const { store, peerId } = await createStore()
    const card: IMMessage = {
      id: 'mini-app-card', conversationId: conversation.id, senderId: 'alice', timestamp: 1_800_000_010,
      content: { parts: [{ type: 'card', card: {
        kind: 'mini-app', source: '腾讯文档', title: '项目排期', description: '本周项目安排',
        url: 'https://docs.qq.com/sheet/example', thumbnailUrl: 'https://cdn.example.com/card.jpg',
      } }] },
    }
    const result = await new DialogRpc({
      ...platform, async getHistory() { return { messages: [card] } },
    }, session, store).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const message = result.messages[0] as tl.RawMessage

    expect(message).toMatchObject({
      _: 'message',
      message: '小程序 · 腾讯文档',
      media: { _: 'messageMediaWebPage', manual: true, safe: true, webpage: {
        _: 'webPage', url: 'https://docs.qq.com/sheet/example', displayUrl: 'docs.qq.com',
        type: 'app', siteName: '腾讯文档', title: '项目排期', description: '本周项目安排',
        photo: { _: 'photo', dcId: 1, sizes: [{ _: 'photoSize', type: 'x' }] },
      } },
    })
    expect(message.entities).toEqual([{
      _: 'messageEntityTextUrl', offset: 0, length: '小程序 · 腾讯文档'.length,
      url: 'https://docs.qq.com/sheet/example',
    }])
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('keeps reply headers when the target is outside the requested history window', async () => {
    const { store, peerId } = await createStore()
    const target: IMMessage = {
      id: 'old-target', conversationId: conversation.id, senderId: 'bob', timestamp: 100,
      content: { parts: [{ type: 'text', text: 'old target' }] },
    }
    const filler: IMMessage = {
      id: 'filler', conversationId: conversation.id, senderId: 'bob', timestamp: 200,
      content: { parts: [{ type: 'text', text: 'filler' }] },
    }
    const reply: IMMessage = {
      id: 'reply', conversationId: conversation.id, senderId: 'alice', timestamp: 300,
      replyToId: target.id, content: { parts: [{ type: 'text', text: 'reply' }] },
    }
    const replyPlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
      async getHistory() { return { messages: [reply, filler, target] } },
      async getMessage(_session, _conversation, id) { return id === target.id ? target : null },
    }
    const request = { ...historyRequest(peerId), limit: 1 }
    const result = await new DialogRpc(replyPlatform, session, store)
      .getHistory(request) as tl.messages.RawMessages
    const projectedTarget = await store.findProjectedByPlatformId(
      session.platformSessionId, conversation.id, target.id,
    )

    expect(result.messages[0]).toMatchObject({
      _: 'message', message: 'reply',
      replyTo: { _: 'messageReplyHeader', replyToMsgId: projectedTarget!.parts[0].tlMessageId },
    })
  })

  it('materializes persisted dialog previews without fetching every conversation history', async () => {
    const { store } = await createStore()
    const getHistory = vi.fn(async () => ({ messages: [album] }))
    const result = await new DialogRpc({ ...platform, getHistory }, session, store)
      .getDialogs(dialogsRequest()) as tl.messages.RawDialogs

    expect(getHistory).not.toHaveBeenCalled()
    expect(result.dialogs).toHaveLength(1)
    expect((result.messages[0] as tl.RawMessage).media?._).toBe('messageMediaDocument')
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('does not fetch history for a stored dialog whose cold-start preview is absent', async () => {
    const { store } = await createStore()
    const getHistory = vi.fn(async () => ({ messages: [album] }))
    const getDialogs = vi.fn(async () => ({ dialogs: [{ conversation, unreadCount: 0 }] }))
    const result = await new DialogRpc({ ...platform, getDialogs, getHistory }, session, store)
      .getDialogs(dialogsRequest()) as tl.messages.RawDialogs

    expect(getHistory).not.toHaveBeenCalled()
    expect(result.dialogs).toMatchObject([{ topMessage: 0 }])
    expect(result.messages).toEqual([])
  })

  it('projects interleaved text and images as one native Telegram rich message', async () => {
    const { store, peerId } = await createStore()
    const article: IMMessage = {
      ...album,
      id: 'interleaved-article',
      content: { parts: [
        { type: 'text', text: 'opening bold paragraph', entities: [
          { type: 'bold', offset: 8, length: 4 },
          { type: 'italic', offset: 8, length: 14 },
        ] },
        { type: 'media', media: {
          id: 'first-image', kind: 'image', name: 'first.jpg', mimeType: 'image/jpeg',
          size: 1234, width: 800, height: 600, locator: { remote: 'first-image' },
        } },
        { type: 'text', text: 'closing paragraph' },
        { type: 'media', media: {
          id: 'second-image', kind: 'image', name: 'second.jpg', mimeType: 'image/jpeg',
          size: 5678, width: 640, height: 480, locator: { remote: 'second-image' },
        } },
      ] },
    }
    const result = await new DialogRpc({
      ...platform, async getHistory() { return { messages: [article] } },
    }, session, store).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const messages = result.messages as tl.RawMessage[]
    const message = messages[0]!

    expect(messages).toHaveLength(1)
    expect(message.groupedId).toBeUndefined()
    expect(message).toMatchObject({
      _: 'message', message: 'opening bold paragraph\nclosing paragraph',
      richMessage: { _: 'richMessage', blocks: [
        { _: 'pageBlockParagraph', text: { _: 'textConcat', texts: [
          { _: 'textPlain', text: 'opening ' },
          { _: 'textItalic', text: { _: 'textBold', text: { _: 'textPlain', text: 'bold' } } },
          { _: 'textItalic', text: { _: 'textPlain', text: ' paragraph' } },
        ] } },
        { _: 'pageBlockPhoto', caption: { text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } } },
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'closing paragraph' } },
        { _: 'pageBlockPhoto', caption: { text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } } },
      ] },
    })
    expect(message.media).toBeUndefined()
    const richMessage = message.richMessage!
    const photoBlocks = richMessage.blocks.filter((block): block is tl.RawPageBlockPhoto => block._ === 'pageBlockPhoto')
    const photos = richMessage.photos as tl.RawPhoto[]
    expect(photos).toHaveLength(2)
    expect(photoBlocks.map((block) => block.photoId)).toEqual(photos.map((photo) => photo.id))
    expect(makeTlArticleMedia(article, [])).toBeUndefined()
    expect(wireRoundTrip(result).messages[0]).toMatchObject({ richMessage: { _: 'richMessage' }, media: undefined })
  })

  it('asks the conversation-view provider for rich-message links instead of hard-coding one viewer', () => {
    const linked: IMConversation = {
      id: 'linked-archive', kind: 'group', title: 'Linked archive',
      metadata: { conversationView: 'custom-view' },
    }
    const article: IMMessage = {
      ...album,
      id: 'linked-rich-message',
      content: { parts: [
        { type: 'media', media: { id: 'first', kind: 'image', mimeType: 'image/jpeg', locator: null } },
        { type: 'text', text: 'open archive', entities: [{
          type: 'conversation-link', offset: 0, length: 12, conversation: linked,
        }] },
        { type: 'media', media: { id: 'second', kind: 'image', mimeType: 'image/jpeg', locator: null } },
      ] },
    }
    const mediaRows = [
      { id: 1, partIndex: 0, platformMediaId: 'first', width: 1, height: 1, size: 1 },
      { id: 2, partIndex: 2, platformMediaId: 'second', width: 1, height: 1, size: 1 },
    ] as never

    expect(makeTlArticleMedia(article, mediaRows)?.blocks[1]).toMatchObject({
      _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'open archive' },
    })
    expect(makeTlArticleMedia(
      article, mediaRows, 1, {
        conversationLink: (conversation) => `https://viewer.example/${conversation.id}`,
      },
    )?.blocks[1]).toMatchObject({
      _: 'pageBlockParagraph', text: {
        _: 'textUrl', text: { _: 'textPlain', text: 'open archive' },
        url: 'https://viewer.example/linked-archive',
      },
    })
  })

  it('preserves mentions, custom emoji, and partial blockquotes in rich-message history', async () => {
    const { store, peerId } = await createStore()
    const definition = {
      key: 'custom:article',
      presentation: {
        type: 'custom' as const, alt: '😀', resource: {
          version: 1, format: 'static' as const, mimeType: 'image/webp' as const,
          width: 100, height: 100, size: 4,
        },
      },
    }
    const article: IMMessage = {
      ...album,
      id: 'rich-entities-history',
      content: { parts: [
        { type: 'text', text: 'intro @Bob quote 😀 outro', entities: [
          { type: 'mention', offset: 6, length: 4, userId: 'bob' },
          { type: 'blockquote', offset: 11, length: 5 },
          { type: 'custom-emoji', offset: 17, length: 2, definition },
        ] },
        { type: 'media', media: { id: 'history-first', kind: 'image', mimeType: 'image/jpeg', locator: null } },
        { type: 'text', text: 'full quote', entities: [{ type: 'blockquote', offset: 0, length: 10 }] },
        { type: 'media', media: { id: 'history-second', kind: 'image', mimeType: 'image/jpeg', locator: null } },
      ] },
      reactionContext: { available: [definition], reactions: [], maxSelected: 1 },
    }
    const reactions = new ReactionRpc(platform, session)
    const result = await new DialogRpc(
      { ...platform, async getHistory() { return { messages: [article] } }, },
      session, store, undefined, undefined, 1, undefined, reactions,
    ).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const message = result.messages[0] as tl.RawMessage
    const richMessage = message.richMessage!

    expect(message.media).toBeUndefined()
    expect(richMessage.blocks.map((block) => block._)).toEqual([
      'pageBlockParagraph', 'pageBlockBlockquote', 'pageBlockParagraph',
      'pageBlockPhoto', 'pageBlockBlockquote', 'pageBlockPhoto',
    ])
    const initialText = (richMessage.blocks[0] as tl.RawPageBlockParagraph).text as tl.RawTextConcat
    expect(initialText.texts).toEqual(expect.arrayContaining([
      { _: 'textPlain', text: 'intro ' },
      { _: 'textMentionName', text: { _: 'textPlain', text: '@Bob' }, userId: expect.any(Number) },
    ]))
    expect(richMessage.blocks[1]).toMatchObject({
      _: 'pageBlockBlockquote', text: { _: 'textPlain', text: 'quote' }, caption: { _: 'textEmpty' },
    })
    expect(richMessage.blocks[4]).toMatchObject({
      _: 'pageBlockBlockquote', text: { _: 'textPlain', text: 'full quote' }, caption: { _: 'textEmpty' },
    })
    const customText = (richMessage.blocks[2] as tl.RawPageBlockParagraph).text as tl.RawTextConcat
    const emoji = customText.texts.find((item): item is tl.RawTextCustomEmoji => item._ === 'textCustomEmoji')
    expect(emoji).toMatchObject({ _: 'textCustomEmoji', alt: '😀' })
    expect(reactions.getCustomEmojiDocuments([emoji!.documentId])).toHaveLength(1)
    expect(wireRoundTrip(result)).toMatchObject({ messages: [{ richMessage: { _: 'richMessage' } }] })
  })

  it('keeps repeated image-object parts distinct in rich messages', async () => {
    const { store, peerId } = await createStore()
    const image = {
      id: 'reused-image', kind: 'image' as const, mimeType: 'image/jpeg', size: 1234,
      width: 800, height: 600, locator: { remote: 'reused-image' },
    }
    const article: IMMessage = {
      ...album,
      id: 'reused-image-article',
      content: { parts: [
        { type: 'media', media: image },
        { type: 'text', text: 'between images' },
        { type: 'media', media: image },
      ] },
    }
    const result = await new DialogRpc({
      ...platform, async getHistory() { return { messages: [article] } },
    }, session, store).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const message = result.messages[0] as tl.RawMessage
    const richMessage = message.richMessage!

    expect(message.media).toBeUndefined()
    expect(richMessage.blocks.map((block) => block._)).toEqual([
      'pageBlockPhoto', 'pageBlockParagraph', 'pageBlockPhoto',
    ])
    expect(richMessage.photos).toHaveLength(2)
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('keeps a trailing single-image caption out of article projection', async () => {
    const { store, peerId } = await createStore()
    const captionedImage: IMMessage = {
      ...album,
      id: 'trailing-caption',
      content: { parts: [
        { type: 'media', media: {
          id: 'only-image', kind: 'image', mimeType: 'image/jpeg', locator: { remote: 'only-image' },
        } },
        { type: 'text', text: 'caption after image' },
      ] },
    }
    const result = await new DialogRpc({
      ...platform, async getHistory() { return { messages: [captionedImage] } },
    }, session, store).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const message = result.messages[0] as tl.RawMessage

    expect(result.messages).toHaveLength(1)
    expect(message).toMatchObject({
      message: 'caption after image', media: { _: 'messageMediaPhoto' },
    })
  })

  it('expands mixed media into consecutive ungrouped Telegram messages', async () => {
    const { store, peerId } = await createStore()
    const rpc = new DialogRpc(platform, session, store)
    const result = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const messages = result.messages as tl.RawMessage[]

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.id)).toEqual([0x40000001, 0x40000000])
    expect(messages.map((message) => message.groupedId)).toEqual([undefined, undefined])
    expect(messages.map((message) => message.message)).toEqual(['', 'album caption'])
    expect(messages.map((message) => message.media?._)).toEqual([
      'messageMediaDocument', 'messageMediaPhoto',
    ])
    expect((messages[0].media as tl.RawMessageMediaDocument).document).toMatchObject({
      _: 'document', accessHash: Long.fromNumber(2), mimeType: 'application/pdf', size: 5678,
      attributes: [{ _: 'documentAttributeFilename', fileName: 'report.pdf' }],
    })
    expect((messages[1].media as tl.RawMessageMediaPhoto).photo).toMatchObject({
      _: 'photo', accessHash: Long.fromNumber(1), sizes: [
        { _: 'photoStrippedSize', type: 'i', bytes: strippedThumbnail },
        { _: 'photoSize', type: 'm', w: 320, h: 240, size: 7 },
        { _: 'photoSize', type: 'x', w: 800, h: 600, size: 1234 },
      ],
    })
    const photo = (messages[1].media as tl.RawMessageMediaPhoto).photo as tl.RawPhoto
    expect(photo.sizes.map((size) => size.type)).toEqual(['i', 'm', 'x'])
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('adds a 1280px original-byte alias before an oversized photo', () => {
    const media = makeTlMessageMedia({
      id: 19_855,
      messageId: 1,
      ordinal: 0,
      partIndex: 0,
      platformMediaId: 'oversized-photo',
      kind: 'image',
      name: 'wide.jpg',
      mimeType: 'image/jpeg',
      size: 320_332,
      width: 2_832,
      height: 1_280,
      duration: null,
      preview: null,
      strippedThumbnail: new Uint8Array(strippedThumbnail).buffer,
      locator: {},
    }, 1_785_912_121)

    if (media._ !== 'messageMediaPhoto' || media.photo?._ !== 'photo') {
      throw new Error('expected projected photo')
    }
    expect(media.photo.sizes).toMatchObject([
      { _: 'photoStrippedSize', type: 'i' },
      { _: 'photoSize', type: 'y', w: 1280, h: 579, size: 320_332 },
      { _: 'photoSize', type: 'w', w: 2832, h: 1280, size: 320_332 },
    ])
    expect(() => wireRoundTrip(media)).not.toThrow()
  })

  it('omits a redundant native preview that has the original photo dimensions', () => {
    const media = makeTlMessageMedia({
      id: 19_856,
      messageId: 1,
      ordinal: 0,
      partIndex: 0,
      platformMediaId: 'small-outgoing-photo',
      kind: 'image',
      name: 'small.jpg',
      mimeType: 'image/jpeg',
      size: 14_256,
      width: 277,
      height: 119,
      duration: null,
      preview: {
        size: 0,
        width: 277,
        height: 119,
        locator: { imageSpec: 720 },
      },
      strippedThumbnail: null,
      locator: { imageSpec: 0 },
      voice: false,
    }, 1_800_000_000)

    expect(media).toMatchObject({
      _: 'messageMediaPhoto',
      photo: { _: 'photo', sizes: [
        { _: 'photoSize', type: 'x', w: 277, h: 119, size: 14_256 },
      ] },
    })
  })

  it('omits a zero-byte native preview even when it has distinct display dimensions', () => {
    const media = makeTlMessageMedia({
      id: 19_857,
      messageId: 1,
      ordinal: 0,
      partIndex: 0,
      platformMediaId: 'wide-zero-byte-preview',
      kind: 'image',
      name: 'wide.png',
      mimeType: 'image/png',
      size: 149_806,
      width: 1_920,
      height: 860,
      duration: null,
      preview: {
        size: 0,
        width: 1_280,
        height: 573,
        locator: { imageSpec: 720 },
      },
      strippedThumbnail: null,
      locator: { imageSpec: 0 },
      voice: false,
    }, 1_800_000_001)

    expect(media).toMatchObject({
      _: 'messageMediaPhoto',
      photo: { _: 'photo', sizes: [
        { _: 'photoSize', type: 'y', w: 1_280, h: 573, size: 149_806 },
        { _: 'photoSize', type: 'w', w: 1_920, h: 860, size: 149_806 },
      ] },
    })
  })

  it('does not advertise a zero-byte video preview as a downloadable thumbnail', () => {
    const media = makeTlMessageMedia({
      id: 19_858,
      messageId: 1,
      ordinal: 0,
      partIndex: 0,
      platformMediaId: 'video-zero-byte-preview',
      kind: 'file',
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: 2_048,
      width: 1_920,
      height: 1_080,
      duration: 4,
      preview: {
        size: 0,
        width: 320,
        height: 180,
        locator: { imageSpec: 720 },
      },
      strippedThumbnail: new Uint8Array(strippedThumbnail).buffer,
      locator: { fileUuid: 'video' },
      voice: false,
    }, 1_800_000_002)

    if (media._ !== 'messageMediaDocument' || media.document?._ !== 'document') {
      throw new Error('expected projected video document')
    }
    expect(media.document.thumbs?.map((thumb) => thumb._)).toEqual(['photoStrippedSize'])
    expect(media.document.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        _: 'documentAttributeVideo', duration: 4, w: 1_920, h: 1_080, supportsStreaming: true,
      }),
    ]))
  })

  it('serves an advertised native photo preview for Telegram thumb_size m requests', async () => {
    const { store, peerId } = await createStore()
    const uploadPath = await mkdtemp(join(tmpdir(), 'bridge-preview-'))
    disposals.push(() => rm(uploadPath, { recursive: true, force: true }))
    const rpc = new DialogRpc(platform, session, store, new UploadManager(uploadPath))
    const history = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const media = (history.messages.at(-1) as tl.RawMessage).media as tl.RawMessageMediaPhoto
    if (media.photo?._ !== 'photo') throw new Error('expected photo')
    const file = await rpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPhotoFileLocation', id: media.photo!.id, accessHash: media.photo!.accessHash,
        fileReference: media.photo!.fileReference, thumbSize: 'm',
      },
      offset: 0, limit: 1024,
    })
    if (file._ !== 'upload.file') throw new Error('expected file')
    expect(new TextDecoder().decode(file.bytes)).toBe('photo-preview')
    expect(file.type).toEqual({ _: 'storage.fileWebp' })

    const direct = await rpc.getFileUrl({
      _: 'inputPhotoFileLocation', id: media.photo.id, accessHash: media.photo.accessHash,
      fileReference: media.photo.fileReference, thumbSize: 'm',
    })
    expect(JSON.parse(direct.data)).toMatchObject({
      url: 'https://cdn.example.test/photo-preview', supportsRange: true,
    })
  })

  it('restores a persisted user ID and avatar locator in a fresh DialogRpc instance', async () => {
    const { store } = await createStore()
    const avatar = {
      id: 'avatar:user:alice', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: { remote: 'avatar-bytes' },
    }
    const avatarPlatform: IMPlatform = {
      ...platform,
      async getContacts() {
        return { users: [{ id: 'alice', firstName: 'Alice', username: '1715311957', avatar }] }
      },
      async getUser(_session, id) {
        return id === session.userId ? null : null
      },
    }
    const firstRpc = new DialogRpc(avatarPlatform, session, store)
    const contacts = await firstRpc.getContacts()
    const alice = contacts.users[0] as tl.RawUser
    if (alice.photo?._ !== 'userProfilePhoto') throw new Error('expected persisted avatar')

    const freshRpc = new DialogRpc(avatarPlatform, session, store)
    const file = await freshRpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPeerPhotoFileLocation',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        photoId: alice.photo.photoId,
      },
      offset: 0, limit: 1024,
    })

    expect(file._).toBe('upload.file')
    if (file._ === 'upload.file') expect(new TextDecoder().decode(file.bytes)).toBe('avatar-bytes')
    expect(await freshRpc.userTlId('alice')).toBe(alice.id)
  })

  it('refreshes a stale persisted user avatar locator before downloading it', async () => {
    const { store } = await createStore()
    const staleAvatar = {
      id: 'avatar:user:alice', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: { remote: 'stale-avatar' },
    }
    const freshAvatar = {
      ...staleAvatar,
      locator: { remote: 'fresh-avatar' },
    }
    const getUser = vi.fn(async (_session: PlatformSession, id: string) => (
      id === 'alice' ? { id, firstName: 'Alice', username: '1715311957', avatar: freshAvatar } : null
    ))
    const avatarPlatform: IMPlatform = {
      ...platform,
      async getContacts() {
        return { users: [{ id: 'alice', firstName: 'Alice', username: '1715311957', avatar: staleAvatar }] }
      },
      getUser,
    }
    const firstRpc = new DialogRpc(avatarPlatform, session, store)
    const contacts = await firstRpc.getContacts()
    const alice = contacts.users[0] as tl.RawUser
    if (alice.photo?._ !== 'userProfilePhoto') throw new Error('expected persisted avatar')

    const resumed = new DialogRpc(avatarPlatform, session, store)
    const file = await resumed.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPeerPhotoFileLocation',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        photoId: alice.photo.photoId,
      },
      offset: 0, limit: 1024,
    })

    expect(getUser).toHaveBeenCalledWith(session, 'alice')
    expect(file._).toBe('upload.file')
    if (file._ === 'upload.file') expect(new TextDecoder().decode(file.bytes)).toBe('fresh-avatar')
  })

  it('maps unavailable platform media to Telegram file-reference expiry', async () => {
    const { store, peerId } = await createStore()
    const uploadPath = await mkdtemp(join(tmpdir(), 'bridge-expired-media-'))
    disposals.push(() => rm(uploadPath, { recursive: true, force: true }))
    const unavailablePlatform: IMPlatform = {
      ...platform,
      async *downloadMedia() {
        throw new IMMediaUnavailableError('upstream media expired')
      },
    }
    const rpc = new DialogRpc(unavailablePlatform, session, store, new UploadManager(uploadPath))
    const history = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const media = (history.messages.at(-1) as tl.RawMessage).media as tl.RawMessageMediaPhoto
    if (media.photo?._ !== 'photo') throw new Error('expected photo')

    await expect(rpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPhotoFileLocation', id: media.photo.id, accessHash: media.photo.accessHash,
        fileReference: media.photo.fileReference, thumbSize: 'x',
      },
      offset: 0, limit: 1024,
    })).rejects.toMatchObject({ code: 400, text: 'FILE_REFERENCE_EXPIRED' })
  })

  it('restores a persisted group avatar without reloading dialogs after restart', async () => {
    const { store } = await createStore()
    const avatar = {
      id: 'avatar:group:cold', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: { remote: 'group-avatar-bytes' },
    }
    const group: IMConversation = {
      id: 'cold-avatar-group', kind: 'group', title: 'Cold avatar group', avatar,
    }
    await store.ingestDialogs(session, [{ conversation: group, unreadCount: 0 }])
    const getDialogs = vi.fn(async () => {
      throw new Error('persisted group avatars must not reload dialogs')
    })
    const resumed = new DialogRpc({ ...platform, getDialogs }, session, store)
    const channelId = resumed.peerTlId(group.id)
    const dialogs = await resumed.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [{
        _: 'inputDialogPeer',
        peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ONE },
      }],
    })
    const chat = dialogs.chats[0]
    if (chat?._ !== 'channel' || chat.photo._ !== 'chatPhoto') {
      throw new Error('expected persisted group avatar')
    }

    const freshRpc = new DialogRpc({ ...platform, getDialogs }, session, store)
    const file = await freshRpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputPeerPhotoFileLocation',
        peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ONE },
        photoId: chat.photo.photoId, big: false,
      },
      offset: 0, limit: 1024,
    })

    expect(getDialogs).not.toHaveBeenCalled()
    expect(file._).toBe('upload.file')
    if (file._ === 'upload.file') {
      expect(new TextDecoder().decode(file.bytes)).toBe('group-avatar-bytes')
    }
  })

  it('backfills and persists a legacy group avatar on its first file request', async () => {
    const { store } = await createStore()
    const avatar = {
      id: 'avatar:group:legacy', kind: 'image' as const, mimeType: 'image/jpeg',
      locator: { remote: 'legacy-group-avatar-bytes' },
    }
    const legacy: IMConversation = {
      id: 'legacy-avatar-group', kind: 'group', title: 'Legacy avatar group',
    }
    await store.ingestDialogs(session, [{ conversation: legacy, unreadCount: 0 }])
    const getDialogs = vi.fn(async () => {
      throw new Error('legacy avatar backfill must not reload dialogs')
    })
    const getConversation = vi.fn(async (_session, conversationId: string) => (
      conversationId === legacy.id ? { ...legacy, avatar } : null
    ))
    const resumed = new DialogRpc({ ...platform, getDialogs, getConversation }, session, store)
    const channelId = resumed.peerTlId(legacy.id)
    const location = {
      _: 'inputPeerPhotoFileLocation' as const,
      peer: { _: 'inputPeerChannel' as const, channelId, accessHash: Long.ONE },
      photoId: Long.fromNumber(stableId(`avatar:${avatar.id}`)),
      big: false,
    }

    const [first, concurrent] = await Promise.all([
      resumed.getFile({
        _: 'upload.getFile', precise: false, cdnSupported: false,
        location, offset: 0, limit: 1024,
      }),
      resumed.getFile({
        _: 'upload.getFile', precise: false, cdnSupported: false,
        location, offset: 1, limit: 1024,
      }),
    ])
    expect(first._).toBe('upload.file')
    if (first._ === 'upload.file') {
      expect(new TextDecoder().decode(first.bytes)).toBe('legacy-group-avatar-bytes')
    }
    expect(concurrent._).toBe('upload.file')
    expect(getConversation).toHaveBeenCalledOnce()
    expect(getDialogs).not.toHaveBeenCalled()

    const persisted = await store.getConversation(session.platformSessionId, legacy.id)
    expect(persisted?.avatar).toEqual(avatar)
    const coldGetConversation = vi.fn(async () => {
      throw new Error('persisted avatar must survive another restart')
    })
    const cold = new DialogRpc({ ...platform, getDialogs, getConversation: coldGetConversation }, session, store)
    const second = await cold.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location, offset: 0, limit: 1024,
    })
    expect(second._).toBe('upload.file')
    expect(coldGetConversation).not.toHaveBeenCalled()
  })

  it('restores persisted identities and inline thumbnails when getMessages is the first RPC', async () => {
    const { store } = await createStore()
    const self = await store.upsertUser(session, { id: session.userId, firstName: 'Current' })
    const ingested = await store.ingest(session, conversation, album)
    const sender = await store.getUser(session.platformId, album.senderId)
    const getDialogs = vi.fn(platform.getDialogs)
    const getHistory = vi.fn(platform.getHistory)

    const result = await new DialogRpc({ ...platform, getDialogs, getHistory }, session, store).getMessages({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: ingested.projection[0].tlMessageId }],
    }) as tl.messages.RawMessages

    expect(result.messages[0]).toMatchObject({
      _: 'message', fromId: { _: 'peerUser', userId: sender!.id },
      media: { _: 'messageMediaPhoto', photo: { _: 'photo', sizes: [
        { _: 'photoStrippedSize', type: 'i', bytes: strippedThumbnail },
        { _: 'photoSize', type: 'm' },
        { _: 'photoSize', type: 'x' },
      ] } },
    })
    expect(result.users).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'user', id: self.id, self: true }),
      expect.objectContaining({ _: 'user', id: sender!.id, firstName: 'Alice' }),
    ]))
    expect(getDialogs).not.toHaveBeenCalled()
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('projects converted animated images as WebM documents with a preview', async () => {
    const { store, peerId } = await createStore()
    const uploadPath = await mkdtemp(join(tmpdir(), 'bridge-document-preview-'))
    disposals.push(() => rm(uploadPath, { recursive: true, force: true }))
    const animated: IMMessage = {
      ...album,
      id: 'animated-image',
      content: { parts: [{
        type: 'media',
        media: {
          id: 'animated', kind: 'file', name: 'animated.webm', mimeType: 'video/webm',
          size: 123, width: 320, height: 180, locator: { remote: 'animated' },
          strippedThumbnail,
          preview: {
            mimeType: 'image/webp', size: 12, width: 160, height: 90,
            locator: { remote: 'animated-preview' },
          },
        },
      }] },
    }
    const rpc = new DialogRpc({
      ...platform, async getHistory() { return { messages: [animated] } },
    }, session, store, new UploadManager(uploadPath))
    const result = await rpc.getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const projected = result.messages.find((message) => message._ === 'message'
      && message.media?._ === 'messageMediaDocument'
      && message.media.document?._ === 'document'
      && message.media.document.mimeType === 'video/webm')
    expect(projected).toMatchObject({
      _: 'message', media: {
        _: 'messageMediaDocument', video: true,
        document: {
          _: 'document', mimeType: 'video/webm',
          thumbs: [
            { _: 'photoStrippedSize', type: 'i', bytes: strippedThumbnail },
            { _: 'photoSize', type: 'm', w: 160, h: 90, size: 12 },
          ],
          attributes: expect.arrayContaining([expect.objectContaining({
            _: 'documentAttributeVideo', nosound: true, supportsStreaming: true, w: 320, h: 180,
          })]),
        },
      },
    })
    expect(() => wireRoundTrip(result)).not.toThrow()

    const document = (projected as tl.RawMessage).media as tl.RawMessageMediaDocument
    if (document.document?._ !== 'document') throw new Error('expected animated document')
    const previewFile = await rpc.getFile({
      _: 'upload.getFile', precise: false, cdnSupported: false,
      location: {
        _: 'inputDocumentFileLocation', id: document.document.id,
        accessHash: document.document.accessHash, fileReference: document.document.fileReference,
        thumbSize: 'm',
      },
      offset: 0, limit: 1024,
    })
    if (previewFile._ !== 'upload.file') throw new Error('expected preview file')
    expect(new TextDecoder().decode(previewFile.bytes)).toBe('animated-preview')
  })

  it('projects native MP4 media as a seekable Telegram video with duration', async () => {
    const { store, peerId } = await createStore()
    const video: IMMessage = {
      ...album,
      id: 'native-video',
      content: { parts: [{
        type: 'media',
        media: {
          id: 'clip', kind: 'file', name: 'clip.mp4', mimeType: 'video/mp4',
          size: 1_048_576, width: 1920, height: 1080, duration: 42,
          locator: { remote: 'clip' },
        },
      }] },
    }
    const result = await new DialogRpc({
      ...platform, async getHistory() { return { messages: [video] } },
    }, session, store).getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const message = result.messages.find((item) => item._ === 'message') as tl.RawMessage

    expect(message.media).toMatchObject({
      _: 'messageMediaDocument', video: true,
      document: {
        _: 'document', mimeType: 'video/mp4', size: 1_048_576,
        attributes: expect.arrayContaining([expect.objectContaining({
          _: 'documentAttributeVideo', supportsStreaming: true,
          duration: 42, w: 1920, h: 1080,
        })]),
      },
    })
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('keeps same-kind media grouped as a Telegram album', async () => {
    const { store, peerId } = await createStore()
    const imageAlbum: IMMessage = {
      ...album,
      id: 'image-album',
      content: {
        parts: [
          { type: 'text', text: 'album caption' },
          { type: 'media', media: { id: 'one', kind: 'image', locator: null } },
          { type: 'media', media: { id: 'two', kind: 'image', locator: null } },
        ],
      },
    }
    const imagePlatform: IMPlatform = {
      ...platform,
      async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0, lastMessage: imageAlbum }] } },
      async getHistory() { return { messages: [imageAlbum] } },
    }
    const result = await new DialogRpc(imagePlatform, session, store)
      .getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const messages = result.messages as tl.RawMessage[]
    expect(messages[0].groupedId?.toString()).toBe(messages[1].groupedId?.toString())
    expect(messages[0].groupedId).toBeDefined()
  })

  it('reuses message and grouped IDs in a fresh DialogRpc instance', async () => {
    const { store, peerId } = await createStore()
    const first = await new DialogRpc(platform, session, store)
      .getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const second = await new DialogRpc(platform, session, store)
      .getHistory(historyRequest(peerId)) as tl.messages.RawMessages
    const pick = (result: tl.messages.RawMessages) => (result.messages as tl.RawMessage[]).map((message) => ({
      id: message.id,
      groupedId: message.groupedId?.toString(),
      media: message.media?._,
    }))
    expect(pick(second)).toEqual(pick(first))
  })

  it('hydrates persisted group message users before serving peer dialogs after restart', async () => {
    const { store } = await createStore()
    const group: IMConversation = { id: 'cold-group', kind: 'group', title: 'Cold group' }
    const lastMessage: IMMessage = {
      id: 'cold-last', conversationId: group.id, senderId: 'alice',
      sender: { id: 'alice', firstName: 'Alice' }, timestamp: 1_800_000_300,
      content: { parts: [{ type: 'text', text: 'persisted group message' }] },
    }
    await store.ingestMany(session, group, [lastMessage], { allocation: 'history' })
    const getDialogs = vi.fn(async () => {
      throw new Error('persisted peer dialogs must not reload the upstream dialog list')
    })
    const resumed = new DialogRpc({ ...platform, getDialogs }, session, store)
    const channelId = resumed.peerTlId(group.id)

    const result = await resumed.getPeerDialogs({
      _: 'messages.getPeerDialogs',
      peers: [{
        _: 'inputDialogPeer',
        peer: { _: 'inputPeerChannel', channelId, accessHash: Long.ONE },
      }],
    })

    expect(getDialogs).not.toHaveBeenCalled()
    expect(result.messages).toMatchObject([{
      _: 'message', message: 'persisted group message',
      fromId: { _: 'peerUser' },
    }])
    expect(result.users).toMatchObject([{ _: 'user', firstName: 'Alice' }])
    expect(() => wireRoundTrip(result)).not.toThrow()
  })

  it('requests and materializes bounded history windows instead of loading the full conversation', async () => {
    const { store, peerId } = await createStore()
    const messages = Array.from({ length: 1_000 }, (_, index): IMMessage => ({
      id: String(1_000 - index),
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: 1_000 - index,
      content: { parts: [{ type: 'text', text: String(1_000 - index) }] },
    }))
    const queries: Array<{ limit?: number, before?: { id: string } }> = []
    const pagedPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{ conversation, unreadCount: 0, lastMessage: messages[0] }] }
      },
      async getHistory(_session, _conversation, query) {
        queries.push({ limit: query?.limit, before: query?.before })
        const start = query?.before ? messages.findIndex((message) => message.id === query.before!.id) + 1 : 0
        return { messages: messages.slice(start, start + (query?.limit ?? 100)) }
      },
    }
    const rpc = new DialogRpc(pagedPlatform, session, store)
    const first = await rpc.getHistory({ ...historyRequest(peerId), limit: 2 }) as tl.messages.RawMessages
    expect(queries).toMatchObject([{ limit: 3, before: undefined }])
    expect(first.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual(['1000', '999'])

    const offsetId = (first.messages[1] as tl.RawMessage).id
    const second = await rpc.getHistory({ ...historyRequest(peerId), offsetId, limit: 2 }) as tl.messages.RawMessages
    expect(queries[1]).toMatchObject({ limit: 3, before: { id: '999' } })
    expect(second.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual(['998', '997'])
    expect((await store.readHistory(session.platformSessionId, conversation.id, { limit: 100 })).length)
      .toBeLessThanOrEqual(6)
  })

  it('waits for an authoritative history revalidation before serving a stored first screen', async () => {
    const { store, peerId } = await createStore()
    const messages = Array.from({ length: 60 }, (_, index): IMMessage => ({
      id: `stored-${60 - index}`,
      conversationId: conversation.id,
      senderId: 'alice',
      sender: { id: 'alice', firstName: 'Alice' },
      timestamp: 60 - index,
      content: { parts: [{ type: 'text', text: `stored ${60 - index}` }] },
    }))
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
    const releaseUpstream = Promise.withResolvers<void>()
    const getHistory = vi.fn(async () => {
      await releaseUpstream.promise
      return { messages: messages.slice(0, 51) }
    })
    const rpc = new DialogRpc({ ...platform, getHistory }, session, store)

    let settled = false
    const pending = rpc.getHistory({ ...historyRequest(peerId), limit: 50 })
      .finally(() => { settled = true }) as Promise<tl.messages.RawMessages>
    await vi.waitFor(() => expect(getHistory).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    releaseUpstream.resolve()
    const result = await pending

    expect(result.messages).toHaveLength(50)
    expect(result.messages[0]).toMatchObject({ _: 'message', message: 'stored 60' })
  })

  it('lets an adapter fetch around unread state for a persisted negative-offset window', async () => {
    const { store, peerId } = await createStore()
    const messages = ['old', 'read', 'unread', 'latest'].map((id, index): IMMessage => ({
      id,
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: index + 1,
      content: { parts: [{ type: 'text', text: id }] },
    }))
    const queries: Array<{ limit?: number, before?: { id: string } }> = []
    const unreadPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{
          conversation,
          unreadCount: 2,
          lastMessage: messages[3],
          readInboxMaxMessage: messages[1],
        }] }
      },
      async getHistory(_session, _conversation, query) {
        queries.push({ limit: query?.limit, before: query?.before })
        return { messages }
      },
    }
    const rpc = new DialogRpc(unreadPlatform, session, store)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const dialog = dialogs.dialogs[0] as tl.RawDialog
    const history = await rpc.getHistory({
      ...historyRequest(peerId),
      offsetId: dialog.readInboxMaxId,
      addOffset: -2,
      limit: 3,
    }) as tl.messages.RawMessages

    expect(queries).toEqual([{ limit: 6, before: undefined }])
    expect(history.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual([
      'unread', 'read', 'old',
    ])
  })

  it('keeps a deep persisted unread anchor inside a negative-offset history window', async () => {
    const { store, peerId } = await createStore()
    const messages = Array.from({ length: 200 }, (_, index): IMMessage => ({
      id: String(index + 1),
      conversationId: conversation.id,
      senderId: 'alice',
      timestamp: index + 1,
      content: { parts: [{ type: 'text', text: String(index + 1) }] },
    }))
    await store.ingestMany(session, conversation, messages, { allocation: 'history' })
    const unreadPlatform: IMPlatform = {
      ...platform,
      async getDialogs() {
        return { dialogs: [{
          conversation,
          unreadCount: 150,
          lastMessage: messages[199],
          readInboxMaxMessage: messages[49],
        }] }
      },
      async getHistory() {
        return { messages: messages.slice(24, 100) }
      },
    }
    const rpc = new DialogRpc(unreadPlatform, session, store)
    const dialogs = await rpc.getDialogs(dialogsRequest()) as tl.messages.RawDialogs
    const dialog = dialogs.dialogs[0] as tl.RawDialog
    const history = await rpc.getHistory({
      ...historyRequest(peerId),
      offsetId: dialog.readInboxMaxId,
      addOffset: -25,
      limit: 50,
    }) as tl.messages.RawMessages

    expect(history.messages.map((message) => message._ === 'message' ? message.message : '')).toEqual(
      Array.from({ length: 50 }, (_, index) => String(74 - index)),
    )
  })
})
