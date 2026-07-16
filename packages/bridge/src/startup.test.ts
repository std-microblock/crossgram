import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { startupRpcHandlers } from './startup.js'

function roundTrip(object: tl.TlObject): tl.TlObject {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
}

describe('post-login startup responses', () => {
  it('covers every optional RPC repeatedly requested by Telegram Desktop', () => {
    expect(Object.keys(startupRpcHandlers).sort()).toEqual([
      'account.getDefaultEmojiStatuses',
      'account.getReactionsNotifySettings',
      'help.getPeerColors',
      'help.getPeerProfileColors',
      'help.getPremiumPromo',
      'help.getPromoData',
      'help.getTermsOfServiceUpdate',
      'messages.getAllStickers',
      'messages.getAttachMenuBots',
      'messages.getAvailableReactions',
      'messages.getEmojiGroups',
      'messages.getEmojiStickerGroups',
      'messages.getFavedStickers',
      'messages.getFeaturedStickers',
      'messages.getRecentStickers',
      'messages.getStickerSet',
      'messages.getStickers',
      'stories.getAllStories',
    ])
  })

  it.each(Object.entries(startupRpcHandlers))('%s returns a serializable non-error TL object', (_method, handler) => {
    const response = handler()
    expect(response._).not.toBe('mt_rpc_error')
    expect(roundTrip(response)._).toBe(response._)
  })
})
