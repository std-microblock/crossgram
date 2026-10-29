import { describe, expect, it, vi } from 'vitest'
import type { IMEvent } from '@mtproto-relay/bridge'
import type { LarkClient } from './client.js'
import { LarkPoller } from './poller.js'

describe('LarkPoller', () => {
  it('seeds a recovery baseline first, then emits only new messages', async () => {
    const gates: Array<() => void> = []
    const harness = createPollerHarness({
      chats: [{ chat_id: 'oc_1', name: '群一', chat_type: 'group' }],
      // 第一轮：基线 2 条（Desc 返回倒序）；第二轮：旧消息重复 + 1 条同秒新消息 + 1 条更新消息
      rounds: [
        [message('om_a', '1700000000'), message('om_b', '1700000001')],
        [message('om_b', '1700000001'), message('om_c', '1700000001'), message('om_d', '1700000005')],
      ],
    })
    const events: IMEvent[] = []
    const poller = new LarkPoller({
      client: harness.client,
      getToken: async () => 'u-token',
      selfId: 'ou_self',
      pollIntervalMs: 60_000,
      sleep: () => new Promise<void>((resolve) => gates.push(resolve)),
    })
    await poller.start((event) => {
      events.push(event)
    })
    // 第一轮（基线）完成 → sleep 被挂起
    await vi.waitFor(() => expect(gates.length).toBe(1))
    expect(events.map((event) => (event as { message: { id: string } }).message.id)).toEqual(['om_a', 'om_b'])
    expect(events.every((event) => (event as { delivery?: string }).delivery === 'recovery')).toBe(true)

    gates[0]!()
    await vi.waitFor(() => expect(gates.length).toBe(2))
    // 同秒已见的 om_b 不重发；同秒新消息 om_c 与更新的 om_d 各发一次，且不标 recovery
    expect(events.map((event) => (event as { message: { id: string } }).message.id))
      .toEqual(['om_a', 'om_b', 'om_c', 'om_d'])
    expect(events.slice(2).every((event) => (event as { delivery?: string }).delivery === undefined)).toBe(true)

    await poller.close()
  })

  it('marks own messages outgoing and skips deleted', async () => {
    const harness = createPollerHarness({
      chats: [{ chat_id: 'oc_1', chat_type: 'group' }],
      rounds: [
        [
          message('om_mine', '1700000000', 'ou_self'),
          { ...message('om_gone', '1700000001'), deleted: true },
        ],
      ],
    })
    const events: IMEvent[] = []
    const poller = new LarkPoller({
      client: harness.client,
      getToken: async () => 'u-token',
      selfId: 'ou_self',
      pollIntervalMs: 60_000,
      sleep: () => new Promise<void>(() => {}),
    })
    await poller.start((event) => {
      events.push(event)
    })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    expect(events[0]).toMatchObject({
      message: { id: 'om_mine', outgoing: true, senderId: 'ou_self' },
      conversation: { id: 'oc_1', kind: 'group' },
    })
    await poller.close()
  })
})

function message(id: string, createTime: string, senderOpenId = 'ou_peer') {
  return {
    message_id: id,
    chat_id: 'oc_1',
    msg_type: 'text',
    create_time: createTime,
    deleted: false,
    body: { content: JSON.stringify({ text: `text-${id}` }) },
    sender: { id: senderOpenId, id_type: 'open_id', sender_type: 'user' },
  }
}

function createPollerHarness(options: {
  chats: Array<{ chat_id: string, name?: string, chat_type?: 'p2p' | 'group' }>
  rounds: Array<ReturnType<typeof message>[]>
}) {
  let round = -1
  const client = {
    getChats: async () => ({ items: options.chats, has_more: false }),
    listMessages: async (_token: string, request: { sortType?: string }) => {
      round++
      const items = options.rounds[round] ?? []
      // 基线轮（Desc）返回倒序，增量轮（Asc）返回正序
      return { items: request.sortType === 'ByCreateTimeDesc' ? [...items].reverse() : items, has_more: false }
    },
  } as unknown as LarkClient
  return { client }
}
