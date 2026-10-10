import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import {
  IMPlatformService, defineModels, type PlatformSession,
} from '@mtproto-relay/bridge'
import { QQNTPlatform } from '../../platform-crossgram/src/index.js'
import { GroupAutoKickRunner, telegramChannelIdFor, type Config } from './index.js'

const GROUP_CODE = '1002974327'
const GROUP_TITLE = '#1 明日方舟·卫戍协议丨 拉特兰'
const CONVERSATION_ROW_ID = 4
const PLATFORM_ID = 'qqnt'

const session: PlatformSession = {
  platformId: PLATFORM_ID,
  platformSessionId: 'qq-e2e',
  userId: 'u_self',
  credentials: {},
  metadata: {},
}

/** The chat id the bridge exposes for this group, as a Telegram client sees it. */
const GROUP_CHAT_ID = String(-1_000_000_000_000 - telegramChannelIdFor(session.platformSessionId, GROUP_CODE))

interface WireMember {
  user: { id: string, numericId?: string, name: string }
  role: 'owner' | 'administrator' | 'member'
}

/** Owner and administrators first, mirroring QQ's own member order. */
const members: WireMember[] = [
  { user: { id: 'u_self', numericId: '10000', name: 'Self' }, role: 'owner' },
  { user: { id: 'u_admin', numericId: '10001', name: 'Admin' }, role: 'administrator' },
  { user: { id: 'u_silent', numericId: '20001', name: 'Silent' }, role: 'member' },
  { user: { id: 'u_old', numericId: '20002', name: 'Old' }, role: 'member' },
  { user: { id: 'u_mid', numericId: '20003', name: 'Mid' }, role: 'member' },
  { user: { id: 'u_new', numericId: '20004', name: 'New' }, role: 'member' },
]

/** Relayed messages, used as the "last spoke" ranking. */
const spoke = [
  { userId: 'u_old', timestamp: 1_700_000_000 },
  { userId: 'u_mid', timestamp: 1_700_001_000 },
  { userId: 'u_new', timestamp: 1_700_002_000 },
]

let server: Server | undefined
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
  if (!server) return
  server.close()
  await once(server, 'close')
  server = undefined
})

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of source) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** Fake QQNT bridge exposing the member page and moderation routes the adapter uses. */
async function startBridge(list: WireMember[] = members): Promise<{ endpoint: string, moderations: Array<{ uid: string, body: unknown }> }> {
  const moderations: Array<{ uid: string, body: unknown }> = []
  server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (/^\/v1\/conversations\/[^/]+\/members$/.test(url.pathname) && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 100)
      const cursor = Number(url.searchParams.get('cursor') ?? 0)
      const page = list.slice(cursor, cursor + limit)
      const next = cursor + page.length < list.length ? String(cursor + page.length) : undefined
      response.end(JSON.stringify({ members: page, total: 2000, nextCursor: next }))
      return
    }
    const moderate = /^\/v1\/conversations\/([^/]+)\/members\/([^/]+)\/moderate$/.exec(url.pathname)
    if (moderate && request.method === 'POST') {
      moderations.push({ uid: decodeURIComponent(moderate[2]!), body: JSON.parse((await collect(request)).toString()) })
      response.end('{}')
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server address')
  return { endpoint: `http://127.0.0.1:${address.port}/v1`, moderations }
}

async function openContext(list: WireMember[] = members): Promise<Context> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  await ctx.database.create('mtproto_im_conversation', {
    id: CONVERSATION_ROW_ID,
    platformSessionId: session.platformSessionId,
    platformConversationId: GROUP_CODE,
    kind: 'group',
    title: GROUP_TITLE,
    parentPlatformConversationId: null,
    spacePlatformId: null,
    avatar: null,
    metadata: { qq: GROUP_CODE, participantsCount: 2000 },
    unreadCount: 0,
    updatedAt: new Date(),
  })
  for (const [index, entry] of list.entries()) {
    await ctx.database.create('mtproto_im_user', {
      id: index + 1,
      platformId: PLATFORM_ID,
      platformUserId: entry.user.id,
      firstName: entry.user.name,
      lastName: null,
      username: entry.user.numericId ?? null,
      avatar: null,
      metadata: {},
      updatedAt: new Date(),
    })
  }
  for (const [index, message] of spoke.entries()) {
    await ctx.database.create('mtproto_im_message', {
      id: index + 1,
      platformSessionId: session.platformSessionId,
      conversationId: CONVERSATION_ROW_ID,
      primaryPlatformMessageId: `m-${index}`,
      senderUserId: list.findIndex((entry) => entry.user.id === message.userId) + 1,
      text: 'hello',
      content: {},
      timestamp: message.timestamp,
      outgoing: false,
      deleted: false,
      platformGroupId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }
  return ctx
}

describe('group auto kick E2E', () => {
  it('kicks the longest-silent members through the QQNT bridge protocol', async () => {
    const { endpoint, moderations } = await startBridge()
    const ctx = await openContext()
    const platforms = new IMPlatformService(ctx)
    platforms.activateSession('qqnt', new QQNTPlatform({ endpoint }), session)
    const runner = new GroupAutoKickRunner(ctx, {
      kickIntervalMs: 0,
      groups: [{ conversationId: GROUP_CHAT_ID }],
    } satisfies Config)

    const [result] = await runner.run('e2e')

    expect(result).toMatchObject({
      conversationId: GROUP_CODE,
      title: GROUP_TITLE,
      total: 2000,
      scanned: members.length,
      partial: false,
      dryRun: false,
    })
    expect(result.planned.map((item) => [item.userId, item.account]))
      .toEqual([['u_silent', '20001'], ['u_old', '20002'], ['u_mid', '20003'], ['u_new', '20004']])
    expect(result.failures).toEqual([])
    expect(moderations.map((entry) => entry.uid)).toEqual(['u_silent', 'u_old', 'u_mid', 'u_new'])
    expect(moderations[0]!.body).toEqual({ type: 'kick' })
  })

  it('leaves a member alone once a newer message postdates the cached ranking', async () => {
    const group = [...members]
    const { endpoint, moderations } = await startBridge(group)
    const ctx = await openContext(group)
    const platforms = new IMPlatformService(ctx)
    platforms.activateSession('qqnt', new QQNTPlatform({ endpoint }), session)
    const runner = new GroupAutoKickRunner(ctx, {
      kickIntervalMs: 0,
      groups: [{ conversationId: GROUP_CHAT_ID, maxKicksPerRound: 1 }],
    } satisfies Config)

    const [first] = await runner.run('e2e')
    expect(first!.kicked.map((item) => item.userId)).toEqual(['u_silent'])
    expect(moderations.map((entry) => entry.uid)).toEqual(['u_silent'])

    // u_silent left, and u_old — the next-longest silence — greets the group
    // after the ranking snapshot of the first round was taken.
    group.splice(group.findIndex((entry) => entry.user.id === 'u_silent'), 1)
    await ctx.database.create('mtproto_im_message', {
      id: 100,
      platformSessionId: session.platformSessionId,
      conversationId: CONVERSATION_ROW_ID,
      primaryPlatformMessageId: 'm-rejoin',
      // The user rows were created in the original member order, before the splice.
      senderUserId: members.findIndex((entry) => entry.user.id === 'u_old') + 1,
      text: '我回来了',
      content: {},
      timestamp: 1_795_000_000,
      outgoing: false,
      deleted: false,
      platformGroupId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const [second] = await runner.run('e2e')

    expect(second!.skippedStale.map((item) => item.userId)).toEqual(['u_old'])
    expect(second!.kicked.map((item) => item.userId)).toEqual(['u_mid'])
    expect(moderations.map((entry) => entry.uid)).toEqual(['u_silent', 'u_mid'])
  })

  it('treats a QQ group join notice as the joined member speaking', async () => {
    const { endpoint, moderations } = await startBridge()
    const ctx = await openContext()
    const platforms = new IMPlatformService(ctx)
    platforms.activateSession('qqnt', new QQNTPlatform({ endpoint }), session)
    const runner = new GroupAutoKickRunner(ctx, {
      kickIntervalMs: 0,
      groups: [{ conversationId: GROUP_CHAT_ID, maxKicksPerRound: 1 }],
    } satisfies Config)

    // QQ credits the inviter, not the joiner, so the notice has to be read to see
    // that u_silent — the only member without a message — just joined.
    await ctx.database.create('mtproto_im_message', {
      id: 100,
      platformSessionId: session.platformSessionId,
      conversationId: CONVERSATION_ROW_ID,
      primaryPlatformMessageId: 'm-join',
      senderUserId: members.findIndex((entry) => entry.user.id === 'u_admin') + 1,
      text: '',
      content: {
        parts: [],
        serviceAction: {
          type: 'members-joined',
          text: 'Admin邀请Silent加入了群聊。',
          members: [{ id: 'u_silent', name: 'Silent' }],
        },
      },
      timestamp: 1_795_000_000,
      outgoing: false,
      deleted: false,
      platformGroupId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    const [result] = await runner.run('e2e')

    expect(result.planned.map((item) => [item.userId, item.lastSpokeAt]))
      .toEqual([['u_old', 1_700_000_000]])
    expect(moderations.map((entry) => entry.uid)).toEqual(['u_old'])
  })

  it('leaves the group alone while it is below the trigger', async () => {
    const { endpoint, moderations } = await startBridge()
    const ctx = await openContext()
    const platforms = new IMPlatformService(ctx)
    platforms.activateSession('qqnt', new QQNTPlatform({ endpoint }), session)
    const runner = new GroupAutoKickRunner(ctx, {
      groups: [{ conversationId: GROUP_CHAT_ID, maxMembers: 2500, targetMembers: 2495 }],
    } satisfies Config)

    const [result] = await runner.run('e2e')

    expect(result.skipped).toBe('below-threshold')
    expect(moderations).toEqual([])
  })
})
