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
