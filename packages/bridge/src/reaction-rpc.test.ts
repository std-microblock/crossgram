import Long from 'long'
import { describe, expect, it } from 'vitest'
import type {
  IMPlatform, IMReactionContext, IMReactionResource, PlatformSession,
} from './platform.js'
import { ReactionRpc } from './reaction-rpc.js'

const session: PlatformSession = {
  platformSessionId: 'reaction-session', platformId: 'test', userId: 'self', credentials: {}, metadata: {},
}

function fixture(format: 'static' | 'video') {
  const bytes = Uint8Array.from(format === 'video' ? [0x1a, 0x45, 0xdf, 0xa3] : [0x52, 0x49, 0x46, 0x46])
  const resource: IMReactionResource = format === 'video'
    ? { version: 1, format, mimeType: 'video/webm', width: 100, height: 100, size: bytes.length }
    : { version: 1, format, mimeType: 'image/webp', width: 100, height: 100, size: bytes.length }
  const context: IMReactionContext = {
    available: [{
      key: `custom:${format}`,
      presentation: { type: 'custom', alt: '🙂', resource },
    }],
    reactions: [],
    maxSelected: 1,
  }
  const platform = {
    capabilities: { reactions: { read: true, write: true, events: true, actorList: false, maxSelected: 1 } },
    async *downloadReactionResource(
      _session: PlatformSession,
      _resource: IMReactionResource,
      options: { offset?: number, limit?: number } = {},
    ) {
      const start = options.offset ?? 0
      yield bytes.subarray(start, start + (options.limit ?? bytes.length))
    },
  } as unknown as IMPlatform
  const rpc = new ReactionRpc(platform, session)
  const reaction = rpc.toTlReaction('group', context.available[0]!)
  if (reaction._ !== 'reactionCustomEmoji') throw new Error('expected custom reaction')
  return { rpc, documentId: reaction.documentId, resource, bytes }
}

describe('ReactionRpc', () => {
  it.each(['static', 'video'] as const)('describes and serves %s custom reaction resources', async (format) => {
    const { rpc, documentId, resource, bytes } = fixture(format)
    const [document] = rpc.getCustomEmojiDocuments([documentId])
    expect(document).toMatchObject({ mimeType: resource.mimeType, size: bytes.length })
    expect(document?.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ _: 'documentAttributeCustomEmoji', alt: '🙂' }),
      expect.objectContaining({
        _: format === 'video' ? 'documentAttributeVideo' : 'documentAttributeImageSize',
        w: 100,
        h: 100,
      }),
    ]))
    await expect(rpc.getFile(Long.fromValue(documentId).toNumber(), 1, 2)).resolves.toEqual({
      bytes: bytes.subarray(1, 3), mimeType: resource.mimeType,
    })
  })
})
