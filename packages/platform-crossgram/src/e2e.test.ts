import { createReadStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PlatformSession } from '@mtproto-relay/bridge'
import sharp from 'sharp'
import { QQNTPlatform } from './index.js'

const enabled = process.env.QQNT_BRIDGE_E2E === '1'
const directTarget = '2426125592'
const groupTargets = ['1084013940'] as const
const platformOptions = {
  endpoint: process.env.QQNT_BRIDGE_URL ?? 'http://127.0.0.1:18767/v1',
  webSocketEndpoint: process.env.QQNT_BRIDGE_WEBSOCKET_URL,
  token: process.env.QQNT_BRIDGE_TOKEN,
}
const platform = new QQNTPlatform(platformOptions)
const nativeMediaPlatform = new QQNTPlatform(platformOptions)
const session: PlatformSession = {
  platformSessionId: 'live-qqnt', platformId: 'qqnt', userId: 'qq-self', credentials: {}, metadata: {},
}

describe.skipIf(!enabled)('QQNTPlatform live E2E', () => {
  it('provisions the current account from protocol 31 bridges', async () => {
    const account = await platform.getAccount()
    expect(account.user.id).toBeTruthy()
    expect(account.user.username).toMatch(/^\d+$/)
  }, 60_000)

  it('walks every recent-dialog page without duplicates', async () => {
    const ids: string[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    do {
      const page = await platform.getDialogs(session, { cursor, limit: 8 })
      ids.push(...page.dialogs.map((dialog) => dialog.conversation.id))
      cursor = page.nextCursor
      expect(cursor ? seenCursors.has(cursor) : false).toBe(false)
      if (cursor) seenCursors.add(cursor)
    } while (cursor && ids.length < 10_000)

    expect(ids.length).toBeGreaterThan(8)
    expect(new Set(ids).size).toBe(ids.length)
  }, 60_000)

  it('loads the full buddy contacts independently from recent dialogs and streams avatars', async () => {
    const contacts = await platform.getContacts(session, { limit: 500 })
    expect(contacts.users).toHaveLength(17)
    expect(new Set(contacts.users.map((user) => user.id)).size).toBe(17)
    expect(contacts.users.filter((user) => !user.firstName.trim())).toEqual([])
    expect(contacts.users.filter((user) => !user.avatar).map((user) => user.id)).toEqual([])
    expect(contacts.users.every((user) =>
      user.avatar?.locator?.avatarUin === user.username)).toBe(true)
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
    // Bridge only advertises standard reactions for which its Telegram catalog
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('reaction WebSocket event timed out')), 20_000)),
      ])).resolves.toMatchObject({ type: 'message-reactions', target: { messageId: sent.id } })
    } finally {
      await unsubscribe()
    }
  }, 90_000)

  it('streams unique images through IMPlatform only to the approved private and group chats', async () => {
    const targets = [
      await platform.client.resolveConversation('direct', directTarget),
      await platform.client.resolveConversation('group', groupTargets[0]),
    ]
    const imagePath = new URL('../../platform-static/src/test-image.png', import.meta.url)
    const image = await stat(imagePath)
    const metadata = await sharp(fileURLToPath(imagePath)).metadata()
    if (!metadata.width || !metadata.height) throw new Error('test PNG dimensions are unavailable')
    for (const target of targets) {
      // A unique trailing payload keeps the PNG decodable while preventing QQ's
      // fast-upload cache from bypassing the real platform-to-Highway stream.
      const suffix = randomBytes(32)
      const size = image.size + suffix.length
      const sent = await platform.sendMessage(session, { id: target.id }, {
        parts: [{ type: 'media', media: {
          kind: 'image', name: `direct-${target.peerUin}-${Date.now()}-${basename(imagePath.pathname)}`,
          mimeType: 'image/png', size, width: metadata.width, height: metadata.height,
          source: {
            size,
            async *stream() {
              for await (const chunk of createReadStream(imagePath)) yield new Uint8Array(chunk)
              yield suffix
            },
          },
        } }],
      })
      expect(sent.conversationId).toBe(target.id)
      expect(sent.content.parts).toMatchObject([{ type: 'media', media: {
        kind: 'image', width: metadata.width, height: metadata.height,
      } }])
    }
  }, 180_000)

  it('streams two images in one IMPlatform message only to MicroBlock', async () => {
    const target = await platform.client.resolveConversation('direct', directTarget)
    const imagePath = new URL('../../platform-static/src/test-image.png', import.meta.url)
    const image = await stat(imagePath)
    const media = (name: string) => ({
      type: 'media' as const,
      media: {
        kind: 'image' as const, name, mimeType: 'image/png', size: image.size,
        source: {
          size: image.size,
          async *stream() { for await (const chunk of createReadStream(imagePath)) yield new Uint8Array(chunk) },
        },
      },
    })
    const sent = await platform.sendMessage(session, { id: target.id }, {
      parts: [media(`first-${basename(imagePath.pathname)}`), media(`second-${basename(imagePath.pathname)}`)],
    })
    expect(sent.conversationId).toBe(target.id)
    expect(sent.content.parts.filter((part) => part.type === 'media')).toHaveLength(2)
  }, 180_000)

  it('sends through the IMPlatform API only to the approved private and group chats', async () => {
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

  it('finds a newly sent message through native QQ search', async () => {
    const target = await platform.client.resolveConversation('direct', directTarget)
    const marker = `qqntsearch${Date.now()}`
    const sent = await platform.sendMessage(session, { id: target.id }, {
      parts: [{ type: 'text', text: marker }],
    })
    let found: Awaited<ReturnType<typeof platform.searchMessages>> | undefined
    for (let attempt = 0; attempt < 20; attempt++) {
      found = await platform.searchMessages(session, { id: target.id }, { query: marker, limit: 20 })
      if (found.messages.some((message) => message.id === sent.id)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(found?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sent.id, content: { parts: [{ type: 'text', text: marker }] } }),
    ]))
  }, 60_000)

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_FILE))('uploads a private file and reads two CDN ranges through its direct URL', async () => {
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
    expect(mediaPart.media.locator).toMatchObject({
      fileUuid: expect.any(String), file10MMd5: expect.any(String),
    })
    const chunkSize = Math.min(4096, info.size)
    const read = async (offset: number) => {
      let bytes = 0
      for await (const chunk of platform.downloadMedia(
        session, mediaPart.media, { offset, limit: chunkSize },
      )) bytes += chunk.length
      return bytes
    }
    await expect(Promise.all([read(0), read(Math.max(0, info.size - chunkSize))]))
      .resolves.toEqual([chunkSize, chunkSize])
  }, 240_000)

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_IMAGE_CONVERSATION))(
    'downloads a native QQ image through a packet-refreshed direct URL',
    async () => {
      const conversationId = process.env.QQNT_BRIDGE_E2E_IMAGE_CONVERSATION!
      const history = await nativeMediaPlatform.getHistory(session, { id: conversationId }, { limit: 100 })
      const requestedMessage = process.env.QQNT_BRIDGE_E2E_IMAGE_MESSAGE
      const image = history.messages
        .filter((message) => !requestedMessage || message.id === requestedMessage)
        .flatMap((message) => message.content.parts)
        .find((part) => part.type === 'media'
          && part.media.kind === 'image'
          && Boolean(part.media.locator?.originImageUrl))
      if (!image || image.type !== 'media') throw new Error('native QQ image with originImageUrl not found')
      expect(image.media.locator).toMatchObject({
        kind: 'image', originImageUrl: expect.stringMatching(/^https?:\/\//),
      })

      const limit = Math.min(4096, image.media.size ?? 4096)
      let bytes = 0
      for await (const chunk of nativeMediaPlatform.downloadMedia(session, image.media, { offset: 0, limit })) {
        bytes += chunk.length
      }
      expect(bytes).toBe(limit)
    },
    180_000,
  )

  it.runIf(Boolean(process.env.QQNT_BRIDGE_E2E_VIDEO_CONVERSATION))(
    'projects a native QQ video and seeks through two independent byte ranges',
    async () => {
      const conversationId = process.env.QQNT_BRIDGE_E2E_VIDEO_CONVERSATION!
      const history = await nativeMediaPlatform.getHistory(session, { id: conversationId }, { limit: 100 })
      const requestedMessage = process.env.QQNT_BRIDGE_E2E_VIDEO_MESSAGE
      const video = history.messages
        .filter((message) => !requestedMessage || message.id === requestedMessage)
        .flatMap((message) => message.content.parts)
        .find((part) => part.type === 'media' && part.media.mimeType?.startsWith('video/'))
      if (!video || video.type !== 'media') throw new Error('native QQ video not found in configured history')
      expect(video.media).toMatchObject({
        kind: 'file', mimeType: expect.stringMatching(/^video\//),
        width: expect.any(Number), height: expect.any(Number), duration: expect.any(Number),
        locator: { videoCodecFormat: expect.any(Number) },
      })
      expect(video.media.size).toBeGreaterThan(1)

      const size = video.media.size!
      const chunkSize = Math.min(4096, size)
      const read = async (offset: number) => {
        let bytes = 0
        for await (const chunk of nativeMediaPlatform.downloadMedia(
          session, video.media, { offset, limit: chunkSize },
        )) bytes += chunk.length
        return bytes
      }
      await expect(Promise.all([read(0), read(size - chunkSize)]))
        .resolves.toEqual([chunkSize, chunkSize])
    },
    180_000,
  )
})
