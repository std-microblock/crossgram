import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { defineModels } from './models.js'
import { DraftStore } from './draft-store.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
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
    const rpc = new DialogRpc(
      platform, session, store, undefined, undefined, 1, undefined, undefined, undefined, undefined,
      'source-auth-key', undefined, drafts, publish,
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

    const resumed = new DialogRpc(
      platform, session, store, undefined, undefined, 1, undefined, undefined, undefined, undefined,
      'resumed-auth-key', undefined, drafts,
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
