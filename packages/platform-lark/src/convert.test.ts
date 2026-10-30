import { describe, expect, it } from 'vitest'
import type { IMMessageInput } from '@mtproto-relay/bridge'
import { buildSendPlan, parseLarkMessage, toConversation } from './convert.js'
import type { LarkMessage } from './types.js'

describe('parseLarkMessage', () => {
  it('resolves text mentions into entities with correct offsets', () => {
    const { parts, replyToId } = parseLarkMessage(message('text', JSON.stringify({
      text: '你好 @_user_1 看这个',
    }), {
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_alice' }, name: '张三' }],
      parent_id: 'om_parent',
    }))
    expect(replyToId).toBe('om_parent')
    expect(parts).toEqual([{
      type: 'text',
      text: '你好 @张三 看这个',
      entities: [{ type: 'mention', offset: 3, length: 3, userId: 'ou_alice' }],
    }])
  })

  it('maps post rich text with links, mentions and images', () => {
    const { parts } = parseLarkMessage(message('post', JSON.stringify({
      title: '标题',
      content: [
        [
          { tag: 'text', text: '看 ' },
          { tag: 'a', text: '文档', href: 'https://example.com' },
          { tag: 'at', user_id: 'ou_bob', user_name: '李四' },
        ],
        [{ tag: 'img', image_key: 'img_v2_1' }],
      ],
    })))
    expect(parts[0]).toMatchObject({
      type: 'text',
      text: '标题\n看 文档@李四\n',
    })
    const entities = (parts[0] as { entities: Array<Record<string, unknown>> }).entities
    expect(entities).toEqual([
      { type: 'text-link', offset: 5, length: 2, url: 'https://example.com' },
      { type: 'mention', offset: 7, length: 3, userId: 'ou_bob' },
    ])
    expect(parts[1]).toEqual({
      type: 'media',
      media: { id: 'img_v2_1', kind: 'image', locator: { messageId: 'om_1', fileKey: 'img_v2_1', type: 'image' } },
    })
  })

  it('maps single-media message types to media parts', () => {
    expect(parseLarkMessage(message('image', '{"image_key":"img_v2_2"}')).parts).toEqual([{
      type: 'media',
      media: { id: 'img_v2_2', kind: 'image', locator: { messageId: 'om_1', fileKey: 'img_v2_2', type: 'image' } },
    }])
    expect(parseLarkMessage(message('file', '{"file_key":"file_v2_3","file_name":"a.pdf"}')).parts).toEqual([{
      type: 'media',
      media: {
        id: 'file_v2_3', kind: 'file', name: 'a.pdf',
        locator: { messageId: 'om_1', fileKey: 'file_v2_3', type: 'file' },
      },
    }])
    const audio = parseLarkMessage(message('audio', '{"file_key":"file_v2_4","duration":1500}')).parts
    expect(audio[0]).toMatchObject({
      type: 'media',
      media: { voice: true, duration: 2 },
    })
  })

  it('falls back to a placeholder for unknown message types and broken JSON', () => {
    expect(parseLarkMessage(message('interactive', '{}')).parts)
      .toEqual([{ type: 'text', text: '[飞书消息:interactive]' }])
    expect(parseLarkMessage(message('text', 'not-json')).parts)
      .toEqual([{ type: 'text', text: '[飞书消息:text]' }])
  })
})

describe('buildSendPlan', () => {
  it('maps post node styles into entities on receive', () => {
    const { parts } = parseLarkMessage(message('post', JSON.stringify({
      content: [[
        { tag: 'text', text: '加粗', style: { bold: [0, 2] } },
        { tag: 'text', text: '普通' },
        { tag: 'text', text: '斜体', style: { italic: [0, 2] } },
      ]],
    })))
    expect(parts[0]).toMatchObject({ type: 'text', text: '加粗普通斜体\n' })
    const entities = (parts[0] as { entities: Array<Record<string, unknown>> }).entities
    expect(entities).toEqual([
      { type: 'bold', offset: 0, length: 2 },
      { type: 'italic', offset: 4, length: 2 },
    ])
  })

  it('builds a post plan when style entities are present', () => {
    const plan = buildSendPlan({
      parts: [{
        type: 'text',
        text: '链接和加粗',
        entities: [
          { type: 'text-link', offset: 0, length: 2, url: 'https://example.com' },
          { type: 'bold', offset: 3, length: 2 },
        ],
      }],
    } as IMMessageInput)
    expect(plan).toHaveLength(1)
    const item = plan[0] as { kind: string, content: string }
    expect(item.kind).toBe('post')
    const post = JSON.parse(item.content) as { content: unknown[][] }
    expect(post.content[0]).toEqual([
      { tag: 'a', text: '链接', href: 'https://example.com' },
      { tag: 'text', text: '和' },
      { tag: 'text', text: '加粗', style: { bold: [0, 2] } },
    ])
  })

  it('keeps plain mention-only text on the text message path', () => {
    const plan = buildSendPlan({
      parts: [{
        type: 'text',
        text: '你好 @张三',
        entities: [{ type: 'mention', offset: 3, length: 3, userId: 'ou_alice' }],
      }],
    } as IMMessageInput)
    expect(plan[0]!.kind).toBe('text')
  })

  it('merges consecutive text parts and renders mention entities as <at>', () => {
    const plan = buildSendPlan({
      parts: [
        { type: 'text', text: '你好 @张三', entities: [{ type: 'mention', offset: 3, length: 3, userId: 'ou_alice' }] },
        { type: 'text', text: '第二行' },
      ],
    } as IMMessageInput)
    expect(plan).toEqual([{
      kind: 'text',
      content: JSON.stringify({ text: '你好 <at user_id="ou_alice"></at>\n第二行' }),
    }])
  })

  it('emits one plan item per media part between text runs', () => {
    const plan = buildSendPlan({
      parts: [
        { type: 'text', text: 'a' },
        { type: 'media', media: { kind: 'image', source: streamOf() } },
        { type: 'media', media: { kind: 'file', name: 'b.pdf', source: streamOf() } },
        { type: 'text', text: 'c' },
      ],
    } as unknown as IMMessageInput)
    expect(plan.map((item) => item.kind)).toEqual(['text', 'image', 'file', 'text'])
  })

  it('rejects sticker parts', () => {
    expect(() => buildSendPlan({
      parts: [{ type: 'sticker', sticker: {} as never }],
    })).toThrow(/sticker/)
  })
})

describe('toConversation', () => {
  it('uses chat details for groups and falls back for p2p', () => {
    expect(toConversation({
      chat_id: 'oc_1', name: '群名', chat_type: 'group', member_count: 5, avatar: 'https://cdn.example/a.jpg',
    }, 'oc_1', { kind: 'group' })).toMatchObject({
      id: 'oc_1', kind: 'group', title: '群名', selfRole: 'member', metadata: { memberCount: 5 },
      avatar: { kind: 'image', locator: { url: 'https://cdn.example/a.jpg' } },
    })
    expect(toConversation(null, 'oc_2', { kind: 'direct', title: 'ou_peer' })).toEqual({
      id: 'oc_2', kind: 'direct', title: 'ou_peer',
    })
    expect(toConversation(null, 'oc_3', { kind: 'group' })).toMatchObject({
      id: 'oc_3', kind: 'group', title: 'oc_3',
    })
  })
})

function message(messageType: string, content: string, extra: Partial<LarkMessage> = {}): LarkMessage {
  return {
    message_id: 'om_1',
    chat_id: 'oc_1',
    messageType,
    content,
    create_time: '1700000000',
    sender: { sender_id: { open_id: 'ou_alice' } },
    ...extra,
  }
}

function streamOf(): { stream: () => AsyncIterable<Uint8Array> } {
  return { stream: async function* () { yield new Uint8Array([1]) } }
}
