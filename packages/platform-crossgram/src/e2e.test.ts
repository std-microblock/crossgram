import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import { QQNTPlatform } from './index.js'

const enabled = process.env.QQNT_BRIDGE_E2E === '1'
const directTarget = '1715311957'
const groupTargets = ['1058754719', '1084013940'] as const
const platform = new QQNTPlatform({
  endpoint: process.env.QQNT_BRIDGE_URL ?? 'http://127.0.0.1:18767/v1',
  token: process.env.QQNT_BRIDGE_TOKEN,
})
const session: PlatformSession = {
  platformSessionId: 'live-qqnt', platformId: 'qqnt', userId: 'qq-self', credentials: {}, metadata: {},
}

describe.skipIf(!enabled)('QQNTPlatform live E2E', () => {
  it('loads the full buddy contacts independently from recent dialogs and streams avatars', async () => {
    const contacts = await platform.getContacts(session, { limit: 500 })
    expect(contacts.users).toHaveLength(17)
    expect(new Set(contacts.users.map((user) => user.id)).size).toBe(17)
    expect(contacts.users.filter((user) => !user.firstName.trim())).toEqual([])
    expect(contacts.users.filter((user) => !user.avatar).map((user) => user.id)).toEqual([])
    const withAvatar = contacts.users[0]
    let bytes = 0
    for await (const chunk of platform.downloadMedia(session, withAvatar!.avatar!, { limit: 128 })) bytes += chunk.length
    expect(bytes).toBe(128)
  }, 60_000)

  it('loads QQ cloud reactions, streams a SysFace resource, and writes a group reaction', async () => {
    let context = await platform.getAvailableReactions(session, { conversationId: groupTargets[0] })
    for (let attempt = 0; !context.available.length && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      context = await platform.getAvailableReactions(session, { conversationId: groupTargets[0] })
    }
    const custom = context.available.find((item) => item.key === '1:14'
      && item.presentation.type === 'custom')
    // Relay only advertises standard reactions for which its Telegram catalog
    // has renderer assets. QQ's 128514 maps to the supported 😂 reaction.
    const emoji = context.available.find((item) => item.key === '2:128514')
    expect(custom).toBeTruthy()
    expect(emoji).toBeTruthy()
    if (!custom || custom.presentation.type !== 'custom' || !emoji) return
    let resourceBytes = 0
    for await (const chunk of platform.downloadReactionResource(
      session, custom.presentation.resource, { limit: 128 },
    )) resourceBytes += chunk.length
    expect(resourceBytes).toBe(128)

    const target = await platform.client.resolveConversation('group', groupTargets[0])
    const sent = await platform.sendMessage(session, { id: target.id }, {
      parts: [{ type: 'text', text: `[reaction IMPlatform e2e] ${new Date().toISOString()}` }],
    })
    const received = Promise.withResolvers<Extract<import('@mtproto-relay/bridge').IMEvent, { type: 'message-reactions' }>>()
    const unsubscribe = await platform.subscribe(session, (event) => {
      if (event.type !== 'message-reactions' || event.target.messageId !== sent.id) return
      const selected = new Set(event.context.reactions.filter((item) => item.selected).map((item) => item.key))
      if (selected.has(custom.key) && selected.has(emoji.key)) received.resolve(event)
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const updated = await platform.setMessageReactions(session, {
        conversationId: target.id, messageId: sent.id, targetId: sent.id,
      }, [custom.key, emoji.key])
      expect(updated.reactions.filter((item) => item.selected).map((item) => item.key).sort())
        .toEqual([custom.key, emoji.key].sort())
      await expect(Promise.race([
        received.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('reaction SSE event timed out')), 20_000)),
      ])).resolves.toMatchObject({ type: 'message-reactions', target: { messageId: sent.id } })
    } finally {
      await unsubscribe()
    }
  }, 90_000)

  it('streams an image through IMPlatform only to MicroBlock', async () => {
    const target = await platform.client.resolveConversation('direct', directTarget)
    const imagePath = new URL('../../platform-static/src/test-image.png', import.meta.url)
    const image = await stat(imagePath)
    const sent = await platform.sendMessage(session, { id: target.id }, {
      parts: [{ type: 'media', media: {
        kind: 'image', name: basename(imagePath.pathname), mimeType: 'image/png', size: image.size,
        source: {
          size: image.size,
          async *stream() { for await (const chunk of createReadStream(imagePath)) yield new Uint8Array(chunk) },
        },
      } }],
    })
    expect(sent.conversationId).toBe(target.id)
    expect(sent.content.parts).toMatchObject([{ type: 'media', media: { kind: 'image' } }])
  }, 180_000)

  it('sends through the IMPlatform API only to MicroBlock and the two approved groups', async () => {
    const targets = [
      await platform.client.resolveConversation('direct', directTarget),
      ...await Promise.all(groupTargets.map((id) => platform.client.resolveConversation('group', id))),
    ]
    expect(targets.map((target) => target.peerUin)).toEqual([directTarget, ...groupTargets])
    for (const target of targets) {
      const text = `[IMPlatform QQNT e2e] ${new Date().toISOString()} ${target.peerUin}`
      const sent = await platform.sendMessage(session, { id: target.id }, { parts: [{ type: 'text', text }] })
      expect(sent.id).toBeTruthy()
      const history = await platform.getHistory(session, { id: target.id }, { limit: 20 })
      expect(JSON.stringify(history.messages)).toContain(text)
    }
  }, 180_000)

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_FILE))('streams upload and ranged download via IMPlatform', async () => {
    // The only private recipient permitted by this test suite.
    const target = await platform.client.resolveConversation('direct', directTarget)
    const path = process.env.QQNT_BRIDGE_E2E_FILE!
    const info = await stat(path)
    const progress: number[] = []
    const sent = await platform.sendMessage(session, { id: target.id }, {
      parts: [{ type: 'media', media: {
        kind: 'file', name: basename(path), size: info.size,
        source: {
          size: info.size,
          async *stream() {
            for await (const chunk of createReadStream(path)) yield new Uint8Array(chunk)
          },
        },
      } }],
    }, { onProgress: (item) => { progress.push(item.transferredBytes) } })
    expect(progress.at(-1)).toBe(info.size)
    const mediaPart = sent.content.parts.find((part) => part.type === 'media')
    if (!mediaPart || mediaPart.type !== 'media') throw new Error('QQ did not confirm media')
    let downloaded = 0
    for await (const chunk of platform.downloadMedia(session, mediaPart.media, { offset: 0, limit: 4096 })) {
      downloaded += chunk.length
    }
    expect(downloaded).toBe(Math.min(4096, info.size))
  }, 240_000)
})
