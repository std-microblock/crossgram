import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import { PlatformRegistry, PlatformSubscriptionManager } from './platform-manager.js'
import type {
  IMEvent, IMMessage, IMMessageInput, IMPlatform, PlatformCapabilities, PlatformSession, Unsubscribe,
} from './platform.js'
import { REQUEST_INBOX_CONVERSATION_ID } from './request-inbox.js'
import { UpdateManager } from './update-manager.js'

const session: PlatformSession = {
  platformSessionId: 'request-timestamp-e2e', platformId: 'qqnt-e2e', userId: 'self',
  credentials: {}, metadata: {},
}

const capabilities: PlatformCapabilities = {
  history: true,
  send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
  conversations: { groups: true, channels: true, subchannels: false },
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

/** Minimal qqnt-shaped adapter: the platform request event is the only producer under test. */
class RequestPlatform implements IMPlatform {
  readonly capabilities = capabilities
  private _handler?: (event: IMEvent) => void | Promise<void>

  async subscribe(
    _session: PlatformSession,
    handler: (event: IMEvent) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    this._handler = handler
    return async () => { this._handler = undefined }
  }

  async emit(event: IMEvent): Promise<void> {
    if (!this._handler) throw new Error('platform is not subscribed')
    await this._handler(event)
  }

  async sendMessage(
    _session: PlatformSession,
    conversation: { id: string },
    content: IMMessageInput,
  ): Promise<IMMessage> {
    return {
      id: 'sent', conversationId: conversation.id, senderId: 'self',
      content: content as IMMessage['content'], timestamp: 1, outgoing: true,
    }
  }

  async getDialogs() { return { dialogs: [], total: 0 } }
  async getHistory() { return { messages: [] } }
}

describe('undated request inbox delivery e2e', () => {
  it('pushes and serves an undated QQ group request at ingestion time instead of the Unix epoch', async () => {
    const ctx = new Context()
    const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
    await Promise.all(fibers)
    await new Promise((resolve) => setTimeout(resolve, 25))
    defineModels(ctx)
    await ctx.database.prepared()
    disposals.push(async () => {
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    })

    const platform = new RequestPlatform()
    const registry = new PlatformRegistry([[session.platformId, platform]])
    const store = new MessageStore(ctx.database)
    const updates = new UpdateManager(ctx.database, registry, store, () => 1)
    const pushed: tl.RawUpdates[] = []
    const subscriptions = new PlatformSubscriptionManager(
      ctx.database, registry, store, undefined,
      async (activeSession, event, options) => {
        const payload = await updates.publish(activeSession, event, options)
        if (payload?._ === 'updates') pushed.push(payload)
        return payload
      },
    )
    await subscriptions.ensure(session)

    const before = Math.floor(Date.now() / 1_000) - 5
    // QQNT reports `actionTime: "0"` for every group admission notify.
    await platform.emit({
      type: 'request',
      request: {
        id: 'qq/group-join', kind: 'group-join', state: 'pending', createdAt: '0',
        requester: { id: 'alice', firstName: 'Alice' },
        group: { id: 'group', kind: 'group', title: 'Group' },
      },
    })

    // The push a connected client receives must carry a usable message date.
    expect(pushed).toHaveLength(1)
    const pushedMessage = pushed[0]!.updates
      .find((update) => update._ === 'updateNewMessage') as tl.RawUpdateNewMessage
    expect(pushedMessage.message._).toBe('message')
    expect((pushedMessage.message as tl.RawMessage).date).toBeGreaterThanOrEqual(before)

    const dialogs = new DialogRpc(platform, session, store)
    const page = await dialogs.getDialogs({
      _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
      offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
    }) as tl.messages.RawDialogs
    const inboxPeerId = dialogs.peerTlId(REQUEST_INBOX_CONVERSATION_ID)
    const inboxDialog = page.dialogs.find((dialog) =>
      dialog.peer._ === 'peerUser' && dialog.peer.userId === inboxPeerId)
    expect(inboxDialog).toBeDefined()
    const preview = page.messages.find((message) =>
      message._ === 'message' && message.id === inboxDialog!.topMessage) as tl.RawMessage
    expect(preview.date).toBeGreaterThanOrEqual(before)

    const history = await dialogs.getHistory({
      _: 'messages.getHistory', peer: { _: 'inputPeerUser', userId: inboxPeerId, accessHash: Long.ONE },
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10, maxId: 0, minId: 0, hash: Long.ZERO,
    }) as tl.messages.RawMessages
    expect(history.messages).toHaveLength(1)
    expect((history.messages[0] as tl.RawMessage).date).toBeGreaterThanOrEqual(before)

    await subscriptions.stop()
  })
})
