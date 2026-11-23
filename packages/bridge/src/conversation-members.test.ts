import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { defineModels } from './models.js'
import {
  ConversationMemberStore, ConversationMemberSyncWorker, displayGroupConversationId,
} from './conversation-members.js'
import type {
  IMConversation, IMConversationMember, IMPlatform, PlatformSession,
} from './platform.js'
import { REQUEST_INBOX_CONVERSATION_ID } from './request-inbox.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length) {
    await disposals.pop()!()
  }
})

async function createTestDb(): Promise<Context> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return ctx
}

const permissions = {
  manageConversation: false,
  manageMembers: false,
  deleteAnyMessage: false,
  editAnyMessage: false,
  pinMessages: false,
  inviteMembers: true,
}

function makeMember(id: string): IMConversationMember {
  return {
    user: { id, firstName: id },
    role: 'member',
    permissions,
  }
}

describe('displayGroupConversationId', () => {
  it('folds subchannels to their parent channel and excludes direct/local-only conversations', () => {
    expect(displayGroupConversationId({ id: 'alice', kind: 'direct' })).toBeUndefined()
    expect(displayGroupConversationId({
      id: REQUEST_INBOX_CONVERSATION_ID, kind: 'group', metadata: { localOnly: true },
    })).toBeUndefined()
    expect(displayGroupConversationId({ id: 'group-1', kind: 'group' })).toBe('group-1')
    expect(displayGroupConversationId({ id: 'guild-1', kind: 'channel' })).toBe('guild-1')
    expect(displayGroupConversationId({
      id: 'topic-1', kind: 'channel', parentId: 'guild-1',
    })).toBe('guild-1')
  })
})

describe('ConversationMemberStore', () => {
  it('records, deduplicates, reconciles, and removes conversation members', async () => {
    const ctx = await createTestDb()
    let now = 1_700_000_000_000
    const store = new ConversationMemberStore(ctx.database, () => now)

    expect(await store.recordMembers('sess-1', 'group-a', ['alice', 'alice', 'bob', ' '], 'message')).toBe(2)
    // Repeated message records hit in-memory dedup cache without rewriting DB.
    expect(await store.recordMembers('sess-1', 'group-a', ['alice'], 'message')).toBe(0)
    expect(await store.listUserConversations('sess-1', 'alice')).toEqual(['group-a'])
    expect(await store.hasMemberListSync('sess-1', 'group-a')).toBe(false)

    // Full member-list reconciliation upgrades alice, adds carol, and prunes bob who left.
    now += 10_000
    const diff = await store.reconcileConversationMembers('sess-1', 'group-a', ['alice', 'carol'])
    expect(diff).toEqual({ added: 1, removed: 1 })
    expect(await store.hasMemberListSync('sess-1', 'group-a')).toBe(true)
    expect(await store.memberListSyncedAt('sess-1', 'group-a')).toBe(now)
    expect(await store.listUserConversations('sess-1', 'alice')).toEqual(['group-a'])
    expect(await store.listUserConversations('sess-1', 'carol')).toEqual(['group-a'])
    expect(await store.listUserConversations('sess-1', 'bob')).toEqual([])

    // Removing a kicked member takes effect immediately.
    await store.removeMember('sess-1', 'group-a', 'carol')
    expect(await store.listUserConversations('sess-1', 'carol')).toEqual([])
  })

  it('prevents historical/recovery messages from resurrecting departed members after member-list sync while accepting live messages', async () => {
    const ctx = await createTestDb()
    const store = new ConversationMemberStore(ctx.database)
    const group: IMConversation = { id: 'group-a', kind: 'group', title: 'Group A' }
    const subchannel: IMConversation = { id: 'topic-1', kind: 'channel', parentId: 'guild-1', title: 'General' }

    // Before member-list sync, non-live/recovery messages still populate membership.
    await store.recordMessageMembers(
      'sess-1',
      group,
      { senderId: 'bob', content: { parts: [{ type: 'text', text: 'old msg' }] } },
      { live: false },
    )
    expect(await store.listUserConversations('sess-1', 'bob')).toEqual(['group-a'])

    // Full member-list sync removes bob (he left).
    await store.reconcileConversationMembers('sess-1', 'group-a', ['alice'])
    expect(await store.listUserConversations('sess-1', 'bob')).toEqual([])

    // Backfill/recovery seeing bob's old message must NOT resurrect bob.
    expect(await store.recordMessageMembers(
      'sess-1',
      group,
      { senderId: 'bob', content: { parts: [{ type: 'text', text: 'older msg' }] } },
      { live: false },
    )).toBe(0)
    expect(await store.listUserConversations('sess-1', 'bob')).toEqual([])

    // A live message (or live members-joined service action) DOES record current members.
    await store.recordMessageMembers(
      'sess-1',
      group,
      {
        senderId: 'dave',
        content: {
          parts: [],
          serviceAction: {
            type: 'members-joined',
            text: 'dave invited erin',
            actor: { id: 'dave' },
            members: [{ id: 'erin' }],
          },
        },
      },
      { live: true },
    )
    expect(await store.listUserConversations('sess-1', 'dave')).toEqual(['group-a'])
    expect(await store.listUserConversations('sess-1', 'erin')).toEqual(['group-a'])

    // Subchannel messages fold into the parent channel ID.
    await store.recordMessageMembers(
      'sess-1',
      subchannel,
      { senderId: 'alice', content: { parts: [{ type: 'text', text: 'hi' }] } },
      { live: true },
    )
    expect((await store.listUserConversations('sess-1', 'alice')).sort()).toEqual(['group-a', 'guild-1'])
  })

  it('persists synced timestamp across fresh store instances', async () => {
    const ctx = await createTestDb()
    const syncedAt = 1_700_000_123_000
    const writer = new ConversationMemberStore(ctx.database, () => syncedAt)
    await writer.reconcileConversationMembers('sess-1', 'group-a', ['alice'])

    const reader = new ConversationMemberStore(ctx.database)
    expect(await reader.hasMemberListSync('sess-1', 'group-a')).toBe(true)
    expect(await reader.memberListSyncedAt('sess-1', 'group-a')).toBe(syncedAt)
  })
})

describe('ConversationMemberSyncWorker', () => {
  it('syncs unsynced groups across pages, backs off failed groups, and refreshes stale groups when idle', async () => {
    const ctx = await createTestDb()
    let now = 1_700_000_000_000
    const members = new ConversationMemberStore(ctx.database, () => now)

    const session: PlatformSession = {
      platformSessionId: 'sess-1',
      platformId: 'qq',
      userId: 'self',
      credentials: {},
      metadata: {},
    }
    const conversations: IMConversation[] = [
      { id: 'alice', kind: 'direct', title: 'Alice' },
      { id: 'group-fail', kind: 'group', title: 'Failing Group' },
      { id: 'group-1', kind: 'group', title: 'Group 1' },
      { id: 'group-2', kind: 'group', title: 'Group 2' },
      { id: 'topic-1', kind: 'channel', parentId: 'group-2', title: 'Topic' },
    ]
    let group1Members = ['self', 'alice', 'bob']
    const getConversationMembers = vi.fn(async (_session, conv, query) => {
      if (conv.id === 'group-fail') throw new Error('temporary failure')
      if (conv.id === 'group-1') {
        if (!query?.cursor) {
          return {
            members: group1Members.slice(0, 2).map(makeMember),
            nextCursor: 'p2',
          }
        }
        return {
          members: group1Members.slice(2).map(makeMember),
        }
      }
      if (conv.id === 'group-2') {
        return { members: ['self', 'alice'].map(makeMember) }
      }
      return { members: [] }
    })

    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: true, subchannels: true },
        members: { list: true, administrators: false, permissions: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      getConversationMembers,
    }

    let lastActivity: number | undefined = now
    const worker = new ConversationMemberSyncWorker(
      () => [{ platform, session }],
      { listConversations: async () => conversations },
      members,
      () => lastActivity,
      {
        intervalMs: 1_000,
        idleIntervalMs: 10_000,
        pageIntervalMs: 0,
        refreshIntervalMs: 60_000,
        idleAfterMs: 10_000,
        retryCooldownMs: 300_000,
        now: () => now,
      },
    )

    // Tick 1: group-fail errors and enters cooldown, so subsequent ticks move on to healthy groups.
    const r1 = await worker.tick()
    expect(r1).toMatchObject({ status: 'failed', conversationId: 'group-fail' })
    expect(worker.nextDelay()).toBe(1_000)

    // Tick 2: group-1 syncs across 2 pages even while client is active (initial unsynced pass).
    const r2 = await worker.tick()
    expect(r2).toMatchObject({ status: 'synced', conversationId: 'group-1', members: 3, partial: false })

    // Tick 3: group-2 syncs (direct chat and subchannel topic-1 are skipped).
    const r3 = await worker.tick()
    expect(r3).toMatchObject({ status: 'synced', conversationId: 'group-2', members: 2, partial: false })
    expect((await members.listUserConversations('sess-1', 'alice')).sort()).toEqual(['group-1', 'group-2'])
    expect(await members.listUserConversations('sess-1', 'bob')).toEqual(['group-1'])

    // Tick 4: all healthy groups synced; client still active -> idle.
    expect(await worker.tick()).toEqual({ status: 'idle' })
    expect(worker.nextDelay()).toBe(10_000)

    // Advance past refreshIntervalMs while client is STILL recently active -> still idle.
    now += 65_000
    lastActivity = now - 2_000
    expect(await worker.tick()).toEqual({ status: 'idle' })

    // Once client is idle, refresh picks up group-1 and prunes bob who left!
    group1Members = ['self', 'alice', 'carol']
    lastActivity = now - 20_000
    const rRefresh = await worker.tick()
    expect(rRefresh).toMatchObject({
      status: 'synced', conversationId: 'group-1', members: 3, added: 1, removed: 1,
    })
    expect(await members.listUserConversations('sess-1', 'bob')).toEqual([])
    expect(await members.listUserConversations('sess-1', 'carol')).toEqual(['group-1'])
  })

  it('does not prune existing members when a scan is partial due to repeated cursor', async () => {
    const ctx = await createTestDb()
    const members = new ConversationMemberStore(ctx.database)
    await members.reconcileConversationMembers('sess-1', 'group-1', ['self', 'alice', 'bob'])

    const session: PlatformSession = {
      platformSessionId: 'sess-1', platformId: 'qq', userId: 'self', credentials: {}, metadata: {},
    }
    const platform: IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
        members: { list: true, administrators: false, permissions: false },
      },
      async subscribe() { return () => {} },
      async sendMessage() { throw new Error('unused') },
      async getConversationMembers() {
        return { members: [makeMember('self'), makeMember('carol')], nextCursor: 'stuck' }
      },
    }

    const worker = new ConversationMemberSyncWorker(
      () => [{ platform, session }],
      { listConversations: async () => [{ id: 'group-1', kind: 'group', title: 'Group 1' }] },
      members,
      undefined,
      { pageIntervalMs: 0, refreshIntervalMs: 0 },
    )
    const result = await worker.tick()
    expect(result).toMatchObject({ status: 'synced', conversationId: 'group-1', partial: true })
    // Partial scan adds carol without deleting alice/bob.
    expect(await members.listUserConversations('sess-1', 'alice')).toEqual(['group-1'])
    expect(await members.listUserConversations('sess-1', 'bob')).toEqual(['group-1'])
    expect(await members.listUserConversations('sess-1', 'carol')).toEqual(['group-1'])
  })
})
