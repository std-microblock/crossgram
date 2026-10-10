import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import {
  IMPlatformService, defineModels,
  type IMConversationMember, type IMConversationMemberModeration, type IMConversationRef,
  type IMPlatform, type PlatformSession,
} from '@mtproto-relay/bridge'
import { GroupAutoKickRunner, telegramChannelIdFor, type Config } from './index.js'

const PLATFORM_ID = 'qqnt'
const GROUP_CODE = '1002974327'
const GROUP_TITLE = '#1 测试群'
const CONVERSATION_ROW_ID = 7

const session: PlatformSession = {
  platformId: PLATFORM_ID,
  platformSessionId: 'qq-session',
  userId: 'u_self',
  credentials: {},
  metadata: {},
}

const GROUP_CHAT_ID = String(-1_000_000_000_000 - telegramChannelIdFor(session.platformSessionId, GROUP_CODE))

interface MemberSpec {
  id: string
  role?: IMConversationMember['role']
  name?: string
}

interface Kick {
  userId: string
  conversationId: string
  action: IMConversationMemberModeration
}

interface FixtureOptions {
  config?: Config
  members?: MemberSpec[]
  /** Omit `total` from the member page to force the counting fallback. */
  total?: number | null
  messages?: Array<{ userId: string, timestamp: number, deleted?: boolean }>
  kickError?: (userId: string) => Error | undefined
  session?: PlatformSession
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

function memberOf(spec: MemberSpec): IMConversationMember<unknown> {
  return {
    user: {
      id: spec.id,
      firstName: spec.name ?? spec.id,
      username: spec.id.replace('u_', ''),
    },
    role: spec.role ?? 'member',
    permissions: {
      manageConversation: false, manageMembers: false, deleteAnyMessage: false,
      editAnyMessage: false, pinMessages: false, inviteMembers: false,
    },
  }
}

async function fixture(options: FixtureOptions = {}) {
  const activeSession = options.session ?? session
  const members = options.members ?? []
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })

  const kicks: Kick[] = []
  const platform: IMPlatform = {
    platformKind: 'qq',
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
      conversations: { groups: true, channels: false, subchannels: false },
      members: { list: true, administrators: true, permissions: true },
    },
    async subscribe() {
      return () => {}
    },
    async sendMessage() {
      throw new Error('not used')
    },
    async getConversationMembers(_session, _conversation, query = {}) {
      const limit = query.limit ?? 100
      const offset = Number(query.cursor ?? 0)
      const page = members.slice(offset, offset + limit).map(memberOf)
      const next = offset + page.length < members.length ? String(offset + page.length) : undefined
      return {
        members: page,
        ...(options.total === null ? {} : { total: options.total ?? members.length }),
        ...(next ? { nextCursor: next } : {}),
      }
    },
    async moderateConversationMember(
      _session: PlatformSession,
      conversation: IMConversationRef,
      userId: string,
      action: IMConversationMemberModeration,
    ) {
      const failure = options.kickError?.(userId)
      if (failure) throw failure
      kicks.push({ userId, conversationId: conversation.id, action })
    },
  }
  const platforms = new IMPlatformService(ctx)
  platforms.activateSession(activeSession.platformSessionId, platform, activeSession)

  const userIds = new Map<string, number>()
  await ctx.database.create('mtproto_im_conversation', {
    id: CONVERSATION_ROW_ID,
    platformSessionId: activeSession.platformSessionId,
    platformConversationId: GROUP_CODE,
    kind: 'group',
    title: GROUP_TITLE,
    parentPlatformConversationId: null,
    spacePlatformId: null,
    avatar: null,
    metadata: {},
    unreadCount: 0,
    updatedAt: new Date(),
  })
  for (const [index, spec] of members.entries()) {
    const id = index + 1
    userIds.set(spec.id, id)
    await ctx.database.create('mtproto_im_user', {
      id,
      platformId: PLATFORM_ID,
      platformUserId: spec.id,
      firstName: spec.name ?? spec.id,
      lastName: null,
      username: null,
      avatar: null,
      metadata: {},
      updatedAt: new Date(),
    })
  }
  for (const [index, message] of (options.messages ?? []).entries()) {
    const senderUserId = userIds.get(message.userId)
    if (!senderUserId) throw new Error(`unknown message sender ${message.userId}`)
    await ctx.database.create('mtproto_im_message', {
      id: index + 1,
      platformSessionId: activeSession.platformSessionId,
      conversationId: CONVERSATION_ROW_ID,
      primaryPlatformMessageId: `m-${index}`,
      senderUserId,
      text: 'hello',
      content: {},
      timestamp: message.timestamp,
      outgoing: false,
      deleted: message.deleted ?? false,
      platformGroupId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  const config: Config = { kickIntervalMs: 0, ...options.config }
  config.groups ??= [{ conversationId: GROUP_CODE }]
  const runner = new GroupAutoKickRunner(ctx, config)
  return { ctx, runner, kicks, platforms, userIds }
}

/** Store one more relayed message, as a member speaking between two rounds would. */
async function addMessage(
  ctx: Context,
  senderUserId: number,
  id: number,
  timestamp: number,
): Promise<void> {
  await ctx.database.create('mtproto_im_message', {
    id,
    platformSessionId: session.platformSessionId,
    conversationId: CONVERSATION_ROW_ID,
    primaryPlatformMessageId: `extra-${id}`,
    senderUserId,
    text: 'hello',
    content: {},
    timestamp,
    outgoing: false,
    deleted: false,
    platformGroupId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

/** Store a QQ join notice: `actorUserId` invited the listed members. */
async function addJoinNotice(
  ctx: Context,
  actorUserId: number,
  id: number,
  timestamp: number,
  members: Array<{ id: string, name?: string }>,
): Promise<void> {
  await ctx.database.create('mtproto_im_message', {
    id,
    platformSessionId: session.platformSessionId,
    conversationId: CONVERSATION_ROW_ID,
    primaryPlatformMessageId: `join-${id}`,
    senderUserId: actorUserId,
    text: '',
    content: { parts: [], serviceAction: { type: 'members-joined', text: '加入了群聊。', members } },
    timestamp,
    outgoing: false,
    deleted: false,
    platformGroupId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

describe('group auto kick', () => {
  it('keeps the group untouched while it is below the trigger', async () => {
    const { runner, kicks } = await fixture({
      total: 1999,
      members: [{ id: 'u_a' }, { id: 'u_b' }],
    })

    const [result] = await runner.run('test')

    expect(result).toMatchObject({ skipped: 'below-threshold', total: 1999, planned: [], kicked: [] })
    expect(kicks).toEqual([])
  })

  it('kicks the longest-silent members down to the target', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [
        { id: 'u_self' },
        { id: 'u_owner', role: 'owner' },
        { id: 'u_admin', role: 'administrator' },
        { id: 'u_silent' },
        { id: 'u_old', name: 'old speaker' },
        { id: 'u_mid' },
        { id: 'u_new' },
        { id: 'u_newest' },
      ],
      messages: [
        { userId: 'u_old', timestamp: 1_700_000_000 },
        { userId: 'u_mid', timestamp: 1_750_000_000 },
        { userId: 'u_new', timestamp: 1_790_000_000 },
        { userId: 'u_newest', timestamp: 1_795_000_000 },
      ],
    })

    const [result] = await runner.run('test')

    expect(result).toMatchObject({ total: 2000, scanned: 8, partial: false, dryRun: false })
    expect(result.planned.map((item) => item.userId)).toEqual(['u_silent', 'u_old', 'u_mid', 'u_new', 'u_newest'])
    expect(result.planned[0]).toMatchObject({ lastSpokeAt: 0, account: 'silent' })
    expect(result.planned[1]).toMatchObject({ lastSpokeAt: 1_700_000_000, name: 'old speaker' })
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_silent', 'u_old', 'u_mid', 'u_new', 'u_newest'])
    expect(kicks[0]).toEqual({
      userId: 'u_silent',
      conversationId: GROUP_CODE,
      action: { type: 'kick' },
    })
  })

  it('ignores deleted and zero-timestamp messages when ranking', async () => {
    const { runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_deleted' }, { id: 'u_kept' }],
      messages: [
        { userId: 'u_deleted', timestamp: 1_790_000_000, deleted: true },
        { userId: 'u_deleted', timestamp: 1_780_000_000 },
        { userId: 'u_kept', timestamp: 0 },
      ],
    })

    const [result] = await runner.run('test')

    expect(result.planned.map((item) => [item.userId, item.lastSpokeAt]))
      .toEqual([['u_kept', 0], ['u_deleted', 1_780_000_000]])
  })

  it('plans without kicking in dry-run mode', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }],
      config: { dryRun: true, groups: [{ conversationId: GROUP_CODE }] },
    })

    const [result] = await runner.run('test')

    expect(result.dryRun).toBe(true)
    expect(result.planned).toHaveLength(3)
    expect(result.kicked).toEqual([])
    expect(kicks).toEqual([])
  })

  it('honours maxKicksPerRound', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }, { id: 'u_d' }],
      config: { groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 2 }] },
    })

    const [result] = await runner.run('test')

    expect(result.planned).toHaveLength(2)
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a', 'u_b'])
  })

  it('walks every member page', async () => {
    const members = Array.from({ length: 250 }, (_value, index) => ({ id: `u_${String(index).padStart(4, '0')}` }))
    const { runner } = await fixture({
      total: 2000,
      members,
      config: { memberPageSize: 100, groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 1 }] },
    })

    const [result] = await runner.run('test')

    expect(result.scanned).toBe(250)
    expect(result.partial).toBe(false)
    expect(result.planned.map((item) => item.userId)).toEqual(['u_0000'])
  })

  it('stops at maxMemberScan and reports a partial scan', async () => {
    const members = Array.from({ length: 250 }, (_value, index) => ({ id: `u_${index}` }))
    const { runner } = await fixture({
      total: 2000,
      members,
      config: {
        memberPageSize: 100,
        maxMemberScan: 150,
        groups: [{ conversationId: GROUP_CODE }],
      },
    })

    const [result] = await runner.run('test')

    expect(result.partial).toBe(true)
    expect(result.scanned).toBe(150)
  })

  it('counts members itself when the platform does not report a total', async () => {
    const { runner, kicks } = await fixture({
      total: null,
      members: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }],
      config: { groups: [{ conversationId: GROUP_CODE, maxMembers: 3, targetMembers: 1 }] },
    })

    const [result] = await runner.run('test')

    expect(result).toMatchObject({ total: 3, scanned: 3 })
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a', 'u_b'])
  })

  it('resolves the group from its Telegram chat id', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: GROUP_CHAT_ID }] },
    })

    const [result] = await runner.run('test')

    expect(result.conversationId).toBe(GROUP_CODE)
    expect(result.skipped).toBeUndefined()
    expect(kicks).toHaveLength(1)
  })

  it('reports an unknown group without failing the round', async () => {
    const { runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: '999999999' }] },
    })

    const [result] = await runner.run('test')

    expect(result).toMatchObject({ skipped: 'unresolved', planned: [] })
  })

  it('drops rules whose target sits above the threshold', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: GROUP_CODE, maxMembers: 100, targetMembers: 200 }] },
    })

    expect(await runner.run('test')).toEqual([])
    expect(kicks).toEqual([])
  })

  it('holds the group at the threshold when targetMembers equals maxMembers', async () => {
    const { runner, kicks } = await fixture({
      total: 1990,
      members: [{ id: 'u_a' }, { id: 'u_b' }],
      config: {
        groups: [{ conversationId: GROUP_CODE, maxMembers: 1990, targetMembers: 1990 }],
        kickIntervalMs: 0,
      },
    })

    const [result] = await runner.run('test')

    // Exactly at the floor there is nothing to trim: the round stays idle
    // instead of pushing the group below the size it is meant to hold.
    expect(result.total).toBe(1990)
    expect(result.planned).toEqual([])
    expect(result.kicked).toEqual([])
    expect(result.skipped).toBeUndefined()
    expect(kicks).toEqual([])
  })

  it('trims exactly what joined past the threshold when targetMembers equals maxMembers', async () => {
    const { runner, kicks } = await fixture({
      total: 1993,
      members: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }],
      config: {
        groups: [{ conversationId: GROUP_CODE, maxMembers: 1990, targetMembers: 1990 }],
        kickIntervalMs: 0,
      },
    })

    const [result] = await runner.run('test')

    // Three members past the floor, three removals — never a full step down.
    expect(result.planned.map((item) => item.userId)).toEqual(['u_a', 'u_b', 'u_c'])
    expect(result.kicked.map((item) => item.userId)).toEqual(['u_a', 'u_b', 'u_c'])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a', 'u_b', 'u_c'])
  })

  it('drops rules without a conversation id', async () => {
    const { runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: '' }, { conversationId: GROUP_CODE }] },
    })

    const results = await runner.run('test')

    expect(results).toHaveLength(1)
    expect(results[0]!.conversationId).toBe(GROUP_CODE)
  })

  it('restricts a rule to one platform session', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: GROUP_CODE, platformSessionId: 'other-session' }] },
    })

    const [result] = await runner.run('test')

    expect(result).toMatchObject({ skipped: 'no-session', planned: [] })
    expect(kicks).toEqual([])
  })

  it('keeps kicking after one removal fails', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }],
      kickError: (userId) => (userId === 'u_a' ? new Error('kick rejected') : undefined),
    })

    const [result] = await runner.run('test')

    expect(result.failures).toEqual([{ userId: 'u_a', error: 'kick rejected' }])
    expect(result.kicked.map((item) => item.userId)).toEqual(['u_b', 'u_c'])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_b', 'u_c'])
  })

  it('never runs two rounds at the same time', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }, { id: 'u_b' }],
    })

    const [first, second] = await Promise.all([runner.run('first'), runner.run('second')])

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(kicks).toHaveLength(2)
  })

  it('reports a removal the platform rejected at error level', async () => {
    const { ctx, runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      kickError: () => new Error('kick rejected'),
    })
    const messages: Array<{ type: string, args: unknown[] }> = []
    ctx.logger.exporter({
      export: (message: { type: string, args: unknown[] }) => {
        messages.push({ type: message.type, args: message.args })
      },
    })

    const [result] = await runner.run('test')

    expect(result.failures).toEqual([{ userId: 'u_a', error: 'kick rejected' }])
    // The production console exporter drops `warn`, so failures must be `error`.
    expect(messages).toContainEqual({
      type: 'error',
      args: expect.arrayContaining([expect.stringContaining('踢出')]),
    })
  })

  it('reuses the cached ranking until it is invalidated', async () => {
    const { ctx, runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }, { id: 'u_b' }],
      messages: [{ userId: 'u_b', timestamp: 1_700_000_000 }],
    })
    const select = vi.spyOn(ctx.database, 'select')
    // Only the ranking aggregate reads the whole conversation; the per-candidate
    // freshness probe narrows the query to one sender and the join scan to the
    // notices that name joined members.
    const aggregations = () => select.mock.calls.filter(([table, query]) => {
      const filter = query as { senderUserId?: number, content?: unknown } | undefined
      return table === 'mtproto_im_message' && !filter?.senderUserId && !filter?.content
    }).length

    await runner.run('first')
    const afterFirst = aggregations()
    expect(afterFirst).toBeGreaterThan(0)
    await runner.run('second')
    expect(aggregations()).toBe(afterFirst)

    runner.invalidate()
    await runner.run('third')
    expect(aggregations()).toBeGreaterThan(afterFirst)
  })

  it('skips a member whose newest message postdates the cached ranking', async () => {
    const members: MemberSpec[] = [{ id: 'u_a' }, { id: 'u_b' }]
    const { ctx, runner, kicks, userIds } = await fixture({
      total: 2000,
      members,
      config: { groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 1 }] },
    })

    // The first round removes the longest silence and caches the ranking.
    const [first] = await runner.run('first')
    expect(first!.kicked.map((item) => item.userId)).toEqual(['u_a'])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a'])

    // u_a is gone, and u_b rejoins the group and says hello after the snapshot.
    members.shift()
    await addMessage(ctx, userIds.get('u_b')!, 1_001, 1_795_000_000)

    const [second] = await runner.run('second')

    // The cached ranking still calls u_b silent, so it is planned; the round has
    // to notice the newer message and leave them alone.
    expect(second!.planned.map((item) => item.userId)).toEqual(['u_b'])
    expect(second!.kicked).toEqual([])
    expect(second!.skippedStale.map((item) => [item.userId, item.lastSpokeAt])).toEqual([['u_b', 0]])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a'])
  })

  it('hands the round to the next-longest silence when a candidate is stale', async () => {
    const members: MemberSpec[] = [{ id: 'u_a' }, { id: 'u_b' }, { id: 'u_c' }]
    const { ctx, runner, kicks, userIds } = await fixture({
      total: 2000,
      members,
      config: { groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 1 }] },
    })

    await runner.run('first')
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a'])

    members.shift()
    await addMessage(ctx, userIds.get('u_b')!, 1_002, 1_795_000_001)

    const [second] = await runner.run('second')

    expect(second!.skippedStale.map((item) => [item.userId, item.lastSpokeAt])).toEqual([['u_b', 0]])
    expect(second!.kicked.map((item) => item.userId)).toEqual(['u_c'])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_a', 'u_c'])
  })

  it('counts a join notice credited to the inviter as the joined member speaking', async () => {
    const { ctx, runner, kicks, userIds } = await fixture({
      total: 2000,
      members: [{ id: 'u_stale' }, { id: 'u_joined' }, { id: 'u_inviter' }],
      messages: [
        { userId: 'u_stale', timestamp: 1_700_000_000 },
        { userId: 'u_inviter', timestamp: 1_710_000_000 },
      ],
      config: { groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 1 }] },
    })
    // QQ stores `A邀请B加入了群聊` with A as the sender, so without reading the
    // notice itself u_joined would look like a member who never spoke at all.
    await addJoinNotice(ctx, userIds.get('u_inviter')!, 1_003, 1_795_000_000, [
      { id: 'u_joined', name: 'joined' },
    ])

    const [result] = await runner.run('test')

    expect(result.planned.map((item) => [item.userId, item.lastSpokeAt]))
      .toEqual([['u_stale', 1_700_000_000]])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_stale'])
  })

  it('lets a member who rejoined after the cached ranking hand the round on', async () => {
    const members: MemberSpec[] = [{ id: 'u_a' }, { id: 'u_back' }, { id: 'u_inviter' }]
    const { ctx, runner, kicks, userIds } = await fixture({
      total: 2000,
      members,
      messages: [
        { userId: 'u_a', timestamp: 1_700_000_000 },
        { userId: 'u_inviter', timestamp: 1_710_000_000 },
      ],
      config: { groups: [{ conversationId: GROUP_CODE, maxKicksPerRound: 1 }] },
    })

    // u_back never spoke here, so the first round removes them — and caches the
    // ranking that says exactly that.
    const [first] = await runner.run('first')
    expect(first!.kicked.map((item) => item.userId)).toEqual(['u_back'])

    // They are invited back after the snapshot was taken.
    await addJoinNotice(ctx, userIds.get('u_inviter')!, 1_004, 1_795_000_001, [
      { id: 'u_back', name: 'back' },
    ])

    const [second] = await runner.run('second')

    // Joining counted as speech, so the round takes the next-longest silence
    // instead of removing the member who just came back.
    expect(second!.planned.map((item) => [item.userId, item.lastSpokeAt]))
      .toEqual([['u_a', 1_700_000_000]])
    expect(second!.kicked.map((item) => item.userId)).toEqual(['u_a'])
    expect(kicks.map((kick) => kick.userId)).toEqual(['u_back', 'u_a'])
  })

  it('applies rejectAddRequest when the rule asks for it', async () => {
    const { runner, kicks } = await fixture({
      total: 2000,
      members: [{ id: 'u_a' }],
      config: { groups: [{ conversationId: GROUP_CODE, rejectAddRequest: true }] },
    })

    await runner.run('test')

    expect(kicks[0]!.action).toEqual({ type: 'kick', rejectAddRequest: true })
  })

  it('can leave members without a relayed message alone', async () => {
    const { runner } = await fixture({
      total: 2000,
      members: [{ id: 'u_silent' }, { id: 'u_old' }, { id: 'u_new' }],
      messages: [
        { userId: 'u_old', timestamp: 1_700_000_000 },
        { userId: 'u_new', timestamp: 1_800_000_000 },
      ],
      config: { groups: [{ conversationId: GROUP_CODE, unknownLastSpoke: 'newest' }] },
    })

    const [result] = await runner.run('test')

    expect(result.planned.map((item) => item.userId)).toEqual(['u_old', 'u_new', 'u_silent'])
  })
})
