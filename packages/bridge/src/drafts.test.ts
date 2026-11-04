import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { defineModels } from './models.js'
import { DraftStore } from './draft-store.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { UploadManager } from './upload-manager.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'

const session: PlatformSession = {
  platformSessionId: 'draft-session', platformId: 'draft-platform', userId: 'self',
  credentials: {}, metadata: { firstName: 'Self' },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createDatabase() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx.database
}

function getDialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

function inputPeer(userId: number): tl.RawInputPeerUser {
  return { _: 'inputPeerUser', userId, accessHash: Long.ONE }
}

describe('bridge-local drafts', () => {
  it('round-trips rich draft fields without involving a platform adapter', async () => {
    const database = await createDatabase()
    const drafts = new DraftStore(database)
    const draft: tl.RawDraftMessage = {
      _: 'draftMessage', noWebpage: true, invertMedia: true,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: 91, topMsgId: 17 },
      message: 'formatted draft',
      entities: [
        { _: 'messageEntityBold', offset: 0, length: 9 },
        { _: 'messageEntityCustomEmoji', offset: 10, length: 5, documentId: Long.fromString('9876543210') },
      ],
      media: { _: 'inputMediaWebPage', url: 'https://example.com', optional: true },
      date: 1_800_000_000,
      effect: Long.fromString('123456789'),
    }

    await drafts.save(session.platformSessionId, 'alice', 17, draft)

    const stored = await drafts.get(session.platformSessionId, 'alice', 17)
    expect(stored).toMatchObject({
      conversationId: 'alice', topMsgId: 17,
      draft: {
        _: 'draftMessage', noWebpage: true, invertMedia: true, message: 'formatted draft',
        replyTo: { _: 'inputReplyToMessage', replyToMsgId: 91, topMsgId: 17 },
        media: { _: 'inputMediaWebPage', url: 'https://example.com', optional: true },
      },
    })
    expect(stored!.draft.entities).toEqual(draft.entities)
    expect(stored!.draft.effect?.equals(draft.effect!)).toBe(true)
    await drafts.save(session.platformSessionId, 'alice', 17, {
      ...draft, message: 'edited draft', date: draft.date + 1,
    })
    await expect(drafts.list(session.platformSessionId)).resolves.toHaveLength(1)
    await expect(drafts.get(session.platformSessionId, 'alice', 17)).resolves.toMatchObject({
      draft: { message: 'edited draft', date: draft.date + 1 },
    })
  })

  it('persists, projects, enumerates, updates, and clears drafts locally', async () => {
    const database = await createDatabase()
    const store = new MessageStore(database)
    const drafts = new DraftStore(database)
    const sent: IMMessage[] = []
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
        conversations: { groups: false, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return {
          dialogs: [{
            conversation: { id: 'alice', kind: 'direct' as const, title: 'Alice' },
            unreadCount: 0,
            lastMessage: {
              id: 'seed', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_000,
              content: { parts: [{ type: 'text' as const, text: 'seed' }] },
            },
          }],
        }
      },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id === 'self' ? 'Self' : 'Alice' } },
      async sendMessage(_session, target, content) {
        const message: IMMessage = {
          id: `sent-${sent.length + 1}`, conversationId: target.id, senderId: 'self',
          timestamp: 1_800_000_010 + sent.length, outgoing: true,
          content: { parts: content.parts.flatMap((part) => part.type === 'text' ? [part] : []) },
        }
        sent.push(message)
        return message
      },
    }
    const publish = vi.fn(async () => {})
    const rpc = new DialogRpc(platform, session, store, {
        dcId: 1,
        authKeyId: 'source-auth-key',
        drafts: drafts,
        onDraftUpdate: publish,
    }
    )
    const initial = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const peerId = rpc.peerTlId('alice')
    const peer = inputPeer(peerId)
    const topMessage = (initial.dialogs[0] as tl.RawDialog).topMessage

    await expect(rpc.saveDraft({
      _: 'messages.saveDraft', peer, noWebpage: true,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: topMessage },
      message: 'local only', entities: [{ _: 'messageEntityItalic', offset: 0, length: 5 }],
    })).resolves.toEqual({ _: 'boolTrue' })
    expect(sent).toHaveLength(0)
    expect(publish).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        _: 'updateDraftMessage', peer: { _: 'peerUser', userId: peerId },
        draft: expect.objectContaining({ _: 'draftMessage', message: 'local only', noWebpage: true }),
      }),
      'source-auth-key',
    )

    const projected = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    expect((projected.dialogs[0] as tl.RawDialog).draft).toMatchObject({
      _: 'draftMessage', message: 'local only',
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: topMessage },
      entities: [{ _: 'messageEntityItalic', offset: 0, length: 5 }],
    })

    const resumed = new DialogRpc(platform, session, store, {
        dcId: 1,
        authKeyId: 'resumed-auth-key',
        drafts: drafts,
    }
    )
    const all = await resumed.getAllDrafts() as tl.RawUpdates
    expect(all.updates).toEqual([
      expect.objectContaining({
        _: 'updateDraftMessage', peer: { _: 'peerUser', userId: peerId },
        draft: expect.objectContaining({ _: 'draftMessage', message: 'local only' }),
      }),
    ])

    await rpc.saveDraft({ _: 'messages.saveDraft', peer, message: '' })
    expect(await drafts.list(session.platformSessionId)).toEqual([])
    expect(publish).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        _: 'updateDraftMessage',
        draft: expect.objectContaining({ _: 'draftMessageEmpty' }),
      }),
      'source-auth-key',
    )
    await rpc.saveDraft({ _: 'messages.saveDraft', peer, message: 'clear on send' })

    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'sent body', randomId: Long.ONE,
      clearDraft: true,
    })
    expect(sent).toHaveLength(1)
    expect(await drafts.list(session.platformSessionId)).toEqual([])
    expect(publish).toHaveBeenLastCalledWith(
      session,
      expect.objectContaining({
        _: 'updateDraftMessage',
        draft: expect.objectContaining({ _: 'draftMessageEmpty' }),
      }),
      'source-auth-key',
    )
  })
})

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function emptyCaption(): tl.RawPageCaption {
  return { _: 'pageCaption', text: { _: 'textEmpty' }, credit: { _: 'textEmpty' } }
}

describe('bridge-local rich drafts', () => {
  async function createHarness() {
    const database = await createDatabase()
    const store = new MessageStore(database)
    const drafts = new DraftStore(database)
    const directory = await mkdtemp(join(tmpdir(), 'bridge-rich-draft-'))
    const uploads = new UploadManager(directory)
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
        conversations: { groups: false, channels: false, subchannels: false },
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return {
          dialogs: [{
            conversation: { id: 'alice', kind: 'direct' as const, title: 'Alice' },
            unreadCount: 0,
            lastMessage: {
              id: 'seed', conversationId: 'alice', senderId: 'alice', timestamp: 1_700_000_000,
              content: { parts: [{ type: 'text' as const, text: 'seed' }] },
            },
          }],
        }
      },
      async getHistory() { return { messages: [] } },
      async getUser(_session, id) { return { id, firstName: id === 'self' ? 'Self' : 'Alice' } },
      async sendMessage() { throw new Error('a rich draft never sends') },
    }
    const rpc = new DialogRpc(platform, session, store, {
        uploads: uploads,
        dcId: 1,
        authKeyId: 'source-auth-key',
        drafts: drafts,
        onDraftUpdate: async () => {},
    }
    )
    disposals.push(async () => { await rm(directory, { recursive: true, force: true }) })
    await rpc.getDialogs(getDialogsRequest())
    const peerId = rpc.peerTlId('alice')
    return { rpc, uploads, drafts, peerId, peer: inputPeer(peerId) }
  }

  async function stagePhoto(
    rpc: DialogRpc,
    uploads: UploadManager,
    peer: tl.RawInputPeerUser,
  ): Promise<tl.RawInputPhoto> {
    await uploads.savePart(session.platformSessionId, '701', 0, TINY_PNG)
    const media = await rpc.uploadMedia({
      _: 'messages.uploadMedia', peer,
      media: { _: 'inputMediaUploadedPhoto', file: { _: 'inputFile', id: Long.fromNumber(701), parts: 1, name: 'draft.png', md5Checksum: '' } },
    })
    if (media._ !== 'messageMediaPhoto' || media.photo._ !== 'photo') {
      throw new Error('staged photo was not materialised')
    }
    return {
      _: 'inputPhoto', id: media.photo.id, accessHash: media.photo.accessHash,
      fileReference: media.photo.fileReference,
    }
  }

  function richDraft(photo: tl.RawInputPhoto): tl.RawInputRichMessage {
    return {
      _: 'inputRichMessage',
      blocks: [
        { _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'draft body' } },
        { _: 'pageBlockPhoto', photoId: photo.id, caption: emptyCaption() },
      ],
      photos: [photo],
    }
  }

  async function dialogDraft(rpc: DialogRpc): Promise<tl.RawDraftMessage> {
    const dialogs = await rpc.getDialogs(getDialogsRequest()) as tl.messages.RawDialogs
    const draft = (dialogs.dialogs[0] as tl.RawDialog).draft
    if (draft?._ !== 'draftMessage') throw new Error('dialog carried no rich draft')
    return draft
  }

  it('keeps an article draft with the media the relay can still serve', async () => {
    const { rpc, uploads, drafts, peer } = await createHarness()
    const photo = await stagePhoto(rpc, uploads, peer)

    await expect(rpc.saveDraft({
      _: 'messages.saveDraft', peer, message: '', richMessage: richDraft(photo),
    })).resolves.toEqual({ _: 'boolTrue' })

    const stored = await drafts.list(session.platformSessionId)
    expect(stored).toHaveLength(1)
    const storedDraft = stored[0]!.draft as tl.RawDraftMessage
    expect(storedDraft).toMatchObject({
      _: 'draftMessage', message: 'draft body',
      richMessage: {
        _: 'richMessage',
        blocks: [{ _: 'pageBlockParagraph' }, { _: 'pageBlockPhoto' }],
      },
    })
    expect(storedDraft.richMessage?.photos).toHaveLength(1)

    const draft = await dialogDraft(rpc)
    expect(draft).toMatchObject({
      _: 'draftMessage', message: 'draft body',
      richMessage: {
        _: 'richMessage',
        blocks: [{ _: 'pageBlockParagraph', text: { _: 'textPlain', text: 'draft body' } }, { _: 'pageBlockPhoto' }],
      },
    })
    expect(draft.richMessage?.photos).toHaveLength(1)
    // The draft holds the upload until it is sent.
    expect(uploads.getStaged(session.platformSessionId, '701')).toBeDefined()
  })

  it('drops media a swept upload can no longer serve from the stored draft', async () => {
    const { rpc, uploads, peer } = await createHarness()
    const photo = await stagePhoto(rpc, uploads, peer)
    await rpc.saveDraft({
      _: 'messages.saveDraft', peer, message: '', richMessage: richDraft(photo),
    })
    expect((await dialogDraft(rpc)).richMessage?.photos).toHaveLength(1)

    // An article draft's upload survives the abandoned-upload sweep while the
    // draft holds it, and the media disappears once it is gone for good.
    await expect(uploads.sweep(0, Date.now() + 1_000, {
      keep: (platformSessionId, fileId) => platformSessionId === session.platformSessionId && fileId === '701',
    })).resolves.toMatchObject({ staged: 0 })
    expect(uploads.getStaged(session.platformSessionId, '701')).toBeDefined()

    await uploads.sweep(0, Date.now() + 1_000)
    expect(uploads.getStaged(session.platformSessionId, '701')).toBeUndefined()

    const draft = await dialogDraft(rpc)
    expect(draft).toMatchObject({
      _: 'draftMessage', message: 'draft body',
      richMessage: { _: 'richMessage', blocks: [{ _: 'pageBlockParagraph' }] },
    })
    expect(draft.richMessage?.photos).toEqual([])
  })
})
