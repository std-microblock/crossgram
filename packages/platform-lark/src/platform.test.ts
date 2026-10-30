import { describe, expect, it, vi } from 'vitest'
import type { IMEvent, PlatformSession } from '@mtproto-relay/bridge'
import { LarkClient } from './client.js'
import type { LarkReceiveEventData } from './events.js'
import { LarkPlatform } from './index.js'
import { TokenStore, type LarkCredentialBackend } from './token-store.js'

const SELF_OPEN_ID = 'ou_self'
const BOT_OPEN_ID = 'ou_bot'

const session: PlatformSession = {
  platformSessionId: 'lark-session',
  platformId: 'lark',
  userId: SELF_OPEN_ID,
  credentials: {},
  metadata: {},
}

describe('LarkPlatform', () => {
  it('bot mode: subscribes via WS pump, resolves conversations, marks own messages outgoing', async () => {
    const harness = await createBotHarness(async (url) => {
      if (url.pathname === '/open-apis/im/v1/chats/oc_group') {
        return json({ code: 0, data: { chat_id: 'oc_group', name: '测试群', chat_type: 'group', member_count: 3 } })
      }
      return defaultBotRoutes(url)
    })
    const events: IMEvent[] = []
    const unsubscribe = await harness.platform.subscribe(session, (event) => {
      events.push(event)
    })
    await harness.dispatchReceive(receiveEvent({
      message: {
        message_id: 'om_1', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: 'hello @_user_1' }),
        create_time: '1700000000',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: '我自己' }],
      },
      sender: { sender_id: { open_id: BOT_OPEN_ID } },
    }))
    await harness.dispatchReceive(receiveEvent({
      message: {
        message_id: 'om_2', chat_id: 'oc_group', chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: 'from peer' }), create_time: '1700000001',
      },
      sender: { sender_id: { open_id: 'ou_peer' } },
    }))
    await vi.waitFor(() => expect(events).toHaveLength(2))
    await unsubscribe()

    expect(events[0]).toMatchObject({
      type: 'message',
      conversation: { id: 'oc_group', kind: 'group', title: '测试群' },
      message: {
        id: 'om_1', senderId: BOT_OPEN_ID, outgoing: true,
        content: { parts: [{ type: 'text', text: 'hello @我自己' }] },
      },
    })
    expect(events[1]).toMatchObject({ type: 'message', message: { id: 'om_2', outgoing: false } })
  })

  it('bot mode: emits message-delete on recall events', async () => {
    const harness = await createBotHarness((url) => defaultBotRoutes(url))
    const events: IMEvent[] = []
    const unsubscribe = await harness.platform.subscribe(session, (event) => {
      events.push(event)
    })
    await harness.dispatchRecalled({ event_id: 'ev_1', message_id: 'om_1', chat_id: 'oc_group' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await unsubscribe()
    expect(events[0]).toMatchObject({
      type: 'message-delete',
      eventId: 'ev_1',
      messageIds: ['om_1'],
      conversation: { id: 'oc_group' },
    })
  })

  it('bot mode: getAccount reports the bot identity', async () => {
    const harness = await createBotHarness((url) => defaultBotRoutes(url))
    await expect(harness.platform.getAccount()).resolves.toMatchObject({
      credentials: {},
      user: { id: BOT_OPEN_ID, firstName: 'TestBot' },
    })
  })

  it('bot mode: warns at-bot-only visibility when group_msg is not granted', async () => {
    const warnings: string[] = []
    const harness = await createBotHarness((url) => {
      if (url.pathname === '/open-apis/im/v1/chats') {
        return json({ code: 0, data: { items: [{ chat_id: 'oc_1', chat_type: 'group' }], has_more: false } })
      }
      if (url.pathname === '/open-apis/im/v1/messages' && url.searchParams.get('container_id')) {
        return json({ code: 230027, msg: 'no permission' }, { status: 403 })
      }
      return defaultBotRoutes(url)
    }, {
      info: () => {},
      warn: (format: string) => {
        warnings.push(format)
      },
    })
    const unsubscribe = await harness.platform.subscribe(session, () => {})
    await vi.waitFor(() => expect(warnings.join('\n')).toContain('仅 @机器人'))
    await unsubscribe()
  })

  it('user mode: sends mixed content with uploads first and reply on the first message', async () => {
    const calls: Array<{ path: string, method: string, body?: unknown }> = []
    const harness = await createUserHarness(async (url, init) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
      calls.push({ path: url.pathname, method: init?.method ?? 'GET', body })
      if (url.pathname === '/open-apis/authen/v1/user_info') return json({ code: 0, data: { open_id: SELF_OPEN_ID, name: '我' } })
      if (url.pathname.endsWith('/im/v1/images')) return json({ code: 0, data: { image_key: 'img_v2_up' } })
      if (url.pathname.endsWith('/im/v1/messages')) {
        return json({ code: 0, data: { message_id: `om_sent_${calls.length}` } })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const sent = await harness.platform.sendMessage(session, { id: 'oc_group' }, {
      parts: [
        { type: 'text', text: '看图' },
        { type: 'media', media: { kind: 'image', source: byteSource(4) } },
        { type: 'text', text: '收尾' },
      ],
      replyToId: 'om_0',
    })
    expect(sent.outgoing).toBe(true)
    expect(sent.sourceIds).toHaveLength(3)
    expect(sent.id).toBe(sent.sourceIds![0])
    const sendCalls = calls.filter((call) => call.path.endsWith('/im/v1/messages') && call.method === 'POST')
    expect(sendCalls).toHaveLength(3)
    expect(sendCalls[0]!.body).toMatchObject({ reply_to_message_id: 'om_0', msg_type: 'text' })
    expect(sendCalls[1]!.body).toMatchObject({ msg_type: 'image', content: JSON.stringify({ image_key: 'img_v2_up' }) })
    expect(sendCalls[2]!.body).toMatchObject({ msg_type: 'text', content: JSON.stringify({ text: '收尾' }) })
    // 回复引用只挂在第一条消息上
    expect(sendCalls[1]!.body).not.toHaveProperty('reply_to_message_id')
    // user 模式发送携带 user_access_token
    expect(sent.senderId).toBe(SELF_OPEN_ID)
  })

  it('user mode: pages dialogs and history in descending order by default', async () => {
    const harness = await createUserHarness(async (url) => {
      if (url.pathname === '/open-apis/authen/v1/user_info') return json({ code: 0, data: { open_id: SELF_OPEN_ID, name: '我' } })
      if (url.pathname.endsWith('/im/v1/chats')) {
        return json({
          code: 0,
          data: {
            items: [{ chat_id: 'oc_1', name: '群一', chat_type: 'group' }],
            has_more: true,
            page_token: 'pt_1',
          },
        })
      }
      if (url.pathname.endsWith('/im/v1/messages') && url.searchParams.get('container_id')) {
        expect(url.searchParams.get('sort_type')).toBe('ByCreateTimeDesc')
        expect(url.searchParams.get('container_id_type')).toBe('chat')
        return json({
          code: 0,
          data: {
            items: [{
              message_id: 'om_h1', chat_id: 'oc_1', msg_type: 'text',
              create_time: '1700000000000', body: { content: JSON.stringify({ text: '旧消息' }) },
              sender: { id: 'ou_peer', id_type: 'open_id', sender_type: 'user' },
            }],
            has_more: false,
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const dialogs = await harness.platform.getDialogs(session)
    expect(dialogs.nextCursor).toBe('pt_1')
    expect(dialogs.dialogs[0]).toMatchObject({ conversation: { id: 'oc_1', title: '群一', kind: 'group' } })
    const history = await harness.platform.getHistory(session, { id: 'oc_1' }, { limit: 20 })
    expect(history.nextCursor).toBeUndefined()
    expect(history.messages[0]).toMatchObject({
      id: 'om_h1',
      content: { parts: [{ type: 'text', text: '旧消息' }] },
      outgoing: false,
    })
  })

  it('user mode: slices media downloads by offset and limit', async () => {
    const harness = await createUserHarness(async (url) => {
      if (url.pathname === '/open-apis/authen/v1/user_info') return json({ code: 0, data: { open_id: SELF_OPEN_ID, name: '我' } })
      if (url.pathname.includes('/resources/')) {
        expect(url.searchParams.get('type')).toBe('image')
        return new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const chunks: number[] = []
    for await (const chunk of harness.platform.downloadMedia(session, {
      id: 'img_v2_1',
      kind: 'image',
      locator: { messageId: 'om_1', fileKey: 'img_v2_1', type: 'image' },
    }, { offset: 2, limit: 3 })) {
      chunks.push(...chunk)
    }
    expect(chunks).toEqual([2, 3, 4])
  })
})

interface Harness {
  platform: LarkPlatform
  dispatchReceive(data: LarkReceiveEventData): Promise<void>
  dispatchRecalled(data: { event_id?: string, message_id: string, chat_id: string }): Promise<void>
}

function basePlatform(
  client: LarkClient,
  deps: ConstructorParameters<typeof LarkPlatform>[1],
  logger?: ConstructorParameters<typeof LarkPlatform>[2],
) {
  let handlers: Record<string, (data: never) => unknown> = {}
  const platform = new LarkPlatform(client, {
    ...deps,
    createWsClient: () => ({
      start: async () => {},
      close: () => {},
    }),
    createEventDispatcher: () => ({
      register: (map: Record<string, (data: never) => unknown>) => {
        handlers = map
        return {}
      },
    }),
  }, logger)
  return {
    platform,
    dispatchReceive: async (data: LarkReceiveEventData) => {
      await handlers['im.message.receive_v1']!(data as never)
    },
    dispatchRecalled: async (data: { event_id?: string, message_id: string, chat_id: string }) => {
      await handlers['im.message.message-recalled_v1']!(data as never)
    },
  }
}

/** bot 模式：tenant token + botInfo 公共路由（未匹配路径兜底抛错）。 */
function defaultBotRoutes(url: URL): Response {
  if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
    return json({ tenant_access_token: 't-tenant', expire: 7200 })
  }
  if (url.pathname === '/open-apis/bot/v3/info') {
    return json({ code: 0, bot: { open_id: BOT_OPEN_ID, app_name: 'TestBot' } })
  }
  if (url.pathname.startsWith('/open-apis/im/v1/chats/')) {
    return json({ code: 230002, msg: 'Bot is not in the chat' }, { status: 400 })
  }
  throw new Error(`unexpected request: ${url}`)
}

async function createBotHarness(
  handler: (url: URL) => Response | Promise<Response>,
  logger?: ConstructorParameters<typeof LarkPlatform>[2],
): Promise<Harness> {
  const client = new LarkClient({
    baseUrl: 'https://open.feishu.cn',
    appId: 'cli_test',
    appSecret: 'secret',
    fetch: async (input) => handler(new URL(String(input))),
  })
  return basePlatform(client, {
    mode: 'bot',
    appId: 'cli_test',
    appSecret: 'secret',
    baseUrl: 'https://open.feishu.cn',
    pollIntervalMs: 60_000,
    getToken: () => client.getTenantAccessToken(),
  }, logger)
}

async function createUserHarness(fetch: typeof globalThis.fetch): Promise<Harness> {
  const client = new LarkClient({ baseUrl: 'https://open.feishu.cn', appId: 'cli_test', appSecret: 'secret', fetch })
  const backend: LarkCredentialBackend = {
    load: async () => ({
      userAccessToken: 'u-self',
      userAccessTokenExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'r-self',
      refreshTokenExpiresAt: Date.now() + 3_600_000,
      openId: SELF_OPEN_ID,
    }),
    persist: async () => {},
  }
  const tokens = new TokenStore(backend, { client })
  return basePlatform(client, {
    mode: 'user',
    appId: 'cli_test',
    appSecret: 'secret',
    baseUrl: 'https://open.feishu.cn',
    pollIntervalMs: 60_000,
    getToken: () => tokens.getFreshUserToken(),
    tokens,
  })
}

function receiveEvent(overrides: Partial<LarkReceiveEventData> = {}): LarkReceiveEventData {
  return {
    sender: { sender_id: { open_id: BOT_OPEN_ID }, sender_type: 'user' },
    message: {
      message_id: 'om_default',
      chat_id: 'oc_group',
      chat_type: 'group',
      message_type: 'text',
      content: '{}',
      create_time: '1700000000',
    },
    ...overrides,
  } as LarkReceiveEventData
}

function byteSource(length: number): { size: number, stream: () => AsyncIterable<Uint8Array> } {
  return {
    size: length,
    stream: async function* () {
      yield new Uint8Array(length)
    },
  }
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init)
}
