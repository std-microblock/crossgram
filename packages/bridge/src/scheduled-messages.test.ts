import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Long from 'long'
import type { tl } from '@mtcute/core'
import { defineModels } from './models.js'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import type { IMMessageInput, IMPlatform } from './platform.js'
import {
  clampScheduleDelay, SCHEDULED_MESSAGE_MAX_DELAY_MS, ScheduledMessageDispatcher,
  ScheduledMessageStore, type ScheduledMessage,
} from './scheduled-messages.js'

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

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

async function createDue(
  store: ScheduledMessageStore,
  options: { dueAt?: number, text?: string, tlMessageId?: number, randomId?: string } = {},
): Promise<ScheduledMessage> {
  return store.create({
    platformSessionId: 'session',
    platformConversationId: 'peer',
    conversationKind: 'direct',
    tlMessageId: options.tlMessageId ?? 1,
    text: options.text ?? 'later',
    dueAt: options.dueAt ?? nowSeconds() + 60,
    randomId: options.randomId ?? String(options.tlMessageId ?? 1),
  })
}

interface ArmedTimer {
  dueMs: number
  fire: () => void
}

function recordingScheduler(): { armed: ArmedTimer[], schedule: (dueMs: number, callback: () => void) => () => void } {
  const armed: ArmedTimer[] = []
  return {
    armed,
    schedule: (dueMs, callback) => {
      armed.push({ dueMs, fire: callback })
      return () => undefined
    },
  }
}

describe('scheduled message store', () => {
  it('creates a message and its scheduling state in one row pair', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const created = await createDue(store, { dueAt: 1_800_000_000 })
    expect(created).toMatchObject({
      platformSessionId: 'session',
      platformConversationId: 'peer',
      tlMessageId: 1,
      status: 'pending',
      attempts: 0,
      dueAt: 1_800_000_000,
    })
    const list = await store.list('session', 'peer')
    expect(list.map((row) => row.text)).toEqual(['later'])
  })

  it('cancels a pending message and hides it from the list', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const created = await createDue(store)
    expect(await store.cancel('session', 'peer', created.tlMessageId)).toBe(true)
    expect(await store.list('session', 'peer')).toHaveLength(0)
    expect(await store.cancel('session', 'peer', created.tlMessageId)).toBe(false)
  })
})

describe('scheduled message dispatcher', () => {
  it('sends a due message and marks it sent', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const message = await createDue(store, { dueAt: nowSeconds() - 5 })
    const sent: number[] = []
    const timer = recordingScheduler()
    const dispatcher = new ScheduledMessageDispatcher(store, async (row) => {
      sent.push(row.tlMessageId)
      return 900
    }, { schedule: timer.schedule })
    await dispatcher.start()
    await dispatcher.sweep()
    expect(sent).toEqual([message.tlMessageId])
    const [state] = await database.get('mtproto_scheduled_state', { messageId: message.id })
    expect(state.status).toBe('sent')
    expect(state.sentTlMessageId).toBe(900)
    dispatcher.stop()
  })

  it('recovers a message whose sender crashed with an expired lease', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const message = await createDue(store, { dueAt: nowSeconds() - 60 })
    await database.set('mtproto_scheduled_state', { messageId: message.id }, {
      status: 'sending', leaseOwner: 'crashed', leaseUntil: nowSeconds() - 30,
    })
    const sent: number[] = []
    const dispatcher = new ScheduledMessageDispatcher(store, async (row) => {
      sent.push(row.tlMessageId)
      return 1
    }, { schedule: recordingScheduler().schedule })
    await dispatcher.start()
    await dispatcher.sweep()
    expect(sent).toEqual([message.tlMessageId])
    dispatcher.stop()
  })

  it('sends once when two dispatchers race for the same row', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    await createDue(store, { dueAt: nowSeconds() - 5 })
    let sends = 0
    const send = async () => {
      sends++
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 7
    }
    const first = new ScheduledMessageDispatcher(store, send, {
      owner: 'first', schedule: recordingScheduler().schedule,
    })
    const second = new ScheduledMessageDispatcher(store, send, {
      owner: 'second', schedule: recordingScheduler().schedule,
    })
    await Promise.all([first.sweep(), second.sweep()])
    expect(sends).toBe(1)
    first.stop()
    second.stop()
  })

  it('does not send a cancelled message', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const message = await createDue(store, { dueAt: nowSeconds() - 5 })
    await store.cancel('session', 'peer', message.tlMessageId)
    let sends = 0
    const dispatcher = new ScheduledMessageDispatcher(store, async () => {
      sends++
      return 1
    }, { schedule: recordingScheduler().schedule })
    await dispatcher.start()
    await dispatcher.sweep()
    expect(sends).toBe(0)
    dispatcher.stop()
  })

  it('keeps the current timer when a later message is added', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const timer = recordingScheduler()
    const dispatcher = new ScheduledMessageDispatcher(store, async () => 1, {
      schedule: timer.schedule,
    })
    await createDue(store, { dueAt: nowSeconds() + 120, tlMessageId: 10, randomId: '10' })
    await dispatcher.start()
    expect(timer.armed).toHaveLength(1)

    await createDue(store, { dueAt: nowSeconds() + 300, tlMessageId: 11, randomId: '11' })
    await dispatcher.rescan()
    expect(timer.armed).toHaveLength(1)

    await createDue(store, { dueAt: nowSeconds() + 30, tlMessageId: 12, randomId: '12' })
    await dispatcher.rescan()
    expect(timer.armed).toHaveLength(2)
    dispatcher.stop()
  })

  it('parks a message after repeated send failures', async () => {
    const database = await createDatabase()
    const store = new ScheduledMessageStore(database)
    const message = await createDue(store, { dueAt: nowSeconds() - 5 })
    const dispatcher = new ScheduledMessageDispatcher(store, async () => {
      throw new Error('platform offline')
    }, { schedule: recordingScheduler().schedule })
    await dispatcher.start()
    for (let attempt = 0; attempt < 7; attempt++) {
      await database.set('mtproto_scheduled_state', { messageId: message.id }, {
        status: 'pending', nextAttemptAt: nowSeconds() - 1,
      })
      await dispatcher.sweep()
    }
    const [state] = await database.get('mtproto_scheduled_state', { messageId: message.id })
    expect(state.status).toBe('failed')
    expect(state.lastError).toBe('platform offline')
    dispatcher.stop()
  })
})

describe('scheduled timer cap', () => {
  it('never asks a timer to wait longer than the 24 day cap', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1_000
    expect(clampScheduleDelay(thirtyDays)).toBe(SCHEDULED_MESSAGE_MAX_DELAY_MS)
    expect(clampScheduleDelay(-5)).toBe(0)
    expect(clampScheduleDelay(Number.POSITIVE_INFINITY)).toBe(SCHEDULED_MESSAGE_MAX_DELAY_MS)
    expect(SCHEDULED_MESSAGE_MAX_DELAY_MS).toBeLessThan(2 ** 31 - 1)
  })
})

async function createRpcFixture(platformSessionId: string) {
  const database = await createDatabase()
  const store = new MessageStore(database)
  const scheduled = new ScheduledMessageStore(database)
  const session = {
    platformSessionId, platformId: 'rpc-platform', userId: 'self',
    credentials: {}, metadata: { firstName: 'Self' },
  }
  const sent: IMMessageInput[] = []
  const control = { failNext: false }
  const platform: IMPlatform = {
    capabilities: {
      history: true,
      send: { text: true, images: false, files: false, mixed: false, maxTextLength: 4096, maxMedia: 0 },
      conversations: { groups: false, channels: false, subchannels: false },
    },
    async subscribe() { return () => {} },
    async sendMessage(_session, conversation, content) {
      if (control.failNext) {
        control.failNext = false
        throw new Error('platform offline')
      }
      sent.push(content)
      return {
        id: `sent-${sent.length}`, conversationId: conversation.id, senderId: 'self',
        timestamp: Math.floor(Date.now() / 1_000), outgoing: true, content,
      }
    },
    async getDialogs() {
      return {
        dialogs: [{
          conversation: { id: 'alice', kind: 'direct' as const, title: 'Alice' },
          unreadCount: 0,
        }],
      }
    },
    async getHistory() { return { messages: [] } },
    async getUser(_session, id) {
      return id === 'alice' ? { id, firstName: 'Alice' } : null
    },
    async getContacts() { return { users: [{ id: 'alice', firstName: 'Alice' }] } },
  } as unknown as IMPlatform
  const rpc = new DialogRpc(platform, session, store, {
        dcId: 1,
        authenticatedSelfId: 1,
        scheduled: scheduled,
    }
  )
  await rpc.getContacts()
  const peer = { _: 'inputPeerUser' as const, userId: rpc.peerTlId('alice'), accessHash: Long.ZERO }
  const listScheduled = async (): Promise<tl.RawMessage[]> => {
    const listed = await rpc.getScheduledHistory({
      _: 'messages.getScheduledHistory', peer, hash: Long.ZERO,
    })
    return ('messages' in listed ? listed.messages : []) as tl.RawMessage[]
  }
  return { database, scheduled, session, sent, control, rpc, peer, listScheduled }
}

describe('scheduled message RPCs', () => {
  it('creates, lists, delivers and deletes a scheduled text message', async () => {
    const { scheduled, session, sent, rpc, peer, listScheduled } = await createRpcFixture('rpc-session')
    const created = await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'send this later',
      randomId: Long.fromNumber(41), scheduleDate: nowSeconds() + 120,
    })
    expect(created).toMatchObject({
      _: 'updates',
      updates: [
        { _: 'updateMessageID', randomId: Long.fromNumber(41) },
        { _: 'updateNewScheduledMessage', message: { message: 'send this later' } },
      ],
    })

    const listedMessages = await listScheduled()
    expect(listedMessages).toHaveLength(1)
    const scheduledMessage = listedMessages[0]
    expect(scheduledMessage).toMatchObject({ message: 'send this later', out: true })
    expect((created as tl.RawUpdates).updates[0]).toMatchObject({ id: scheduledMessage.id })

    const row = (await scheduled.list(session.platformSessionId, 'alice'))[0]
    const delivered = await rpc.deliverScheduled(row)
    expect(sent.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'send this later' })
    expect(delivered.sentTlMessageId).toBeGreaterThan(0)

    const deleted = await rpc.deleteScheduledMessages({
      _: 'messages.deleteScheduledMessages', peer, id: [scheduledMessage.id],
    })
    expect(deleted).toMatchObject({
      _: 'updates',
      updates: [{ _: 'updateDeleteScheduledMessages', messages: [scheduledMessage.id] }],
    })
    expect(await scheduled.list(session.platformSessionId, 'alice')).toHaveLength(0)
  })

  it('sends a scheduled message immediately when asked', async () => {
    const { scheduled, session, sent, rpc, peer, listScheduled } = await createRpcFixture('rpc-session-2')
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'right now',
      randomId: Long.fromNumber(77), scheduleDate: nowSeconds() + 600,
    })
    const scheduledId = (await listScheduled())[0].id
    const result = await rpc.sendScheduledMessages({
      _: 'messages.sendScheduledMessages', peer, id: [scheduledId],
    })
    expect(sent.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'right now' })
    const resultUpdates = result._ === 'updates' ? result.updates : []
    expect(resultUpdates.some((update) => update._ === 'updateDeleteScheduledMessages')).toBe(true)
    // randomId 已在定时时确认，不能再对普通历史发一次 updateMessageID。
    expect(resultUpdates.some((update) => update._ === 'updateMessageID')).toBe(false)
    expect(await scheduled.list(session.platformSessionId, 'alice')).toHaveLength(0)
  })

  it('points a scheduled reply at the ordinary message it quotes', async () => {
    const { rpc, peer, listScheduled } = await createRpcFixture('rpc-session-reply')
    const created = await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'reply later',
      randomId: Long.fromNumber(91), scheduleDate: nowSeconds() + 300,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: 1234 },
    })
    const update = (created._ === 'updates' ? created.updates : [])
      .find((item) => item._ === 'updateNewScheduledMessage') as tl.RawUpdateNewScheduledMessage
    const listed = (await listScheduled())[0]
    for (const message of [update.message as tl.RawMessage, listed]) {
      expect(message.replyTo).toMatchObject({ _: 'messageReplyHeader', replyToMsgId: 1234 })
      expect((message.replyTo as tl.RawMessageReplyHeader).replyToScheduled).toBeFalsy()
    }
  })

  it('does not send again a row the dispatcher is already sending', async () => {
    const { scheduled, session, sent, rpc, peer, listScheduled } = await createRpcFixture('rpc-session-race')
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'due now',
      randomId: Long.fromNumber(101), scheduleDate: nowSeconds() - 1,
    })
    const scheduledId = (await listScheduled())[0].id
    const [row] = await scheduled.list(session.platformSessionId, 'alice')
    expect(await scheduled.claim(row.id, 'dispatcher', nowSeconds())).toBe(true)

    const result = await rpc.sendScheduledMessages({
      _: 'messages.sendScheduledMessages', peer, id: [scheduledId],
    })
    expect(sent).toHaveLength(0)
    expect(result).toMatchObject({
      _: 'updates',
      updates: [{ _: 'updateDeleteScheduledMessages', messages: [] }],
    })
    expect(await scheduled.get(row.id)).toMatchObject({ status: 'sending', leaseOwner: 'dispatcher' })
  })

  it('leaves nothing for the dispatcher after sending now', async () => {
    const { scheduled, session, sent, rpc, peer, listScheduled } = await createRpcFixture('rpc-session-sent')
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'only once',
      randomId: Long.fromNumber(102), scheduleDate: nowSeconds() + 1,
    })
    const scheduledId = (await listScheduled())[0].id
    const [row] = await scheduled.list(session.platformSessionId, 'alice')
    const result = await rpc.sendScheduledMessages({
      _: 'messages.sendScheduledMessages', peer, id: [scheduledId],
    })
    const deleteUpdate = (result._ === 'updates' ? result.updates : [])
      .find((update) => update._ === 'updateDeleteScheduledMessages') as tl.RawUpdateDeleteScheduledMessages
    expect(deleteUpdate.messages).toEqual([scheduledId])
    expect(deleteUpdate.sentMessages).toHaveLength(1)
    expect(await scheduled.get(row.id)).toMatchObject({ status: 'sent' })

    const dispatched: ScheduledMessage[] = []
    const dispatcher = new ScheduledMessageDispatcher(scheduled, async (message) => {
      dispatched.push(message)
      return 1
    }, { now: () => (nowSeconds() + 10) * 1_000, schedule: recordingScheduler().schedule })
    await dispatcher.sweep()
    dispatcher.stop()
    expect(dispatched).toHaveLength(0)
    expect(sent).toHaveLength(1)
  })

  it('releases the row when sending now fails', async () => {
    const { scheduled, session, control, rpc, peer, listScheduled } = await createRpcFixture('rpc-session-fail')
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'retry me',
      randomId: Long.fromNumber(103), scheduleDate: nowSeconds() + 600,
    })
    const scheduledId = (await listScheduled())[0].id
    const [row] = await scheduled.list(session.platformSessionId, 'alice')
    control.failNext = true
    await expect(rpc.sendScheduledMessages({
      _: 'messages.sendScheduledMessages', peer, id: [scheduledId],
    })).rejects.toThrow()
    expect(await scheduled.get(row.id)).toMatchObject({
      status: 'pending', attempts: 0, leaseOwner: null, lastError: 'platform offline',
    })
    expect(await listScheduled()).toHaveLength(1)
  })

  it('lets the user resend a parked failed row by hand', async () => {
    const { scheduled, session, sent, rpc, peer, listScheduled } = await createRpcFixture('rpc-session-parked')
    await rpc.sendMessage({
      _: 'messages.sendMessage', peer, message: 'gave up',
      randomId: Long.fromNumber(104), scheduleDate: nowSeconds() - 60,
    })
    const scheduledId = (await listScheduled())[0].id
    const [row] = await scheduled.list(session.platformSessionId, 'alice')
    await scheduled.reschedule(row.id, 7, nowSeconds(), 'failed', 'platform offline')

    await rpc.sendScheduledMessages({
      _: 'messages.sendScheduledMessages', peer, id: [scheduledId],
    })
    expect(sent.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'gave up' })
    expect(await scheduled.get(row.id)).toMatchObject({ status: 'sent', lastError: null })
  })
})
