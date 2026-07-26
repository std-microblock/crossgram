import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { isBareVector } from '@mtproto-relay/mtproto'
import Long from 'long'
import { androidRpcHandlers } from './android-rpc.js'

function roundTrip(object: tl.TlObject): tl.TlObject {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
}

const self = { _: 'inputPeerSelf' as const }
const requests: Record<string, tl.RpcMethod> = {
  'messages.getEmojiKeywords': { _: 'messages.getEmojiKeywords', langCode: 'zh-hans' },
  'messages.getOnlines': { _: 'messages.getOnlines', peer: self },
  'messages.getSavedHistory': {
    _: 'messages.getSavedHistory', peer: self, offsetId: 0, offsetDate: 0,
    addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  },
  'messages.getMessageReadParticipants': {
    _: 'messages.getMessageReadParticipants', peer: self, msgId: 1,
  },
  'messages.getSearchCounters': {
    _: 'messages.getSearchCounters',
    peer: self,
    filters: [{ _: 'inputMessagesFilterPhotos' }, { _: 'inputMessagesFilterVideo' }],
  },
  'messages.reportReadMetrics': { _: 'messages.reportReadMetrics', peer: self, metrics: [] },
  'channels.getChannelRecommendations': { _: 'channels.getChannelRecommendations' },
  'payments.getSavedStarGifts': {
    _: 'payments.getSavedStarGifts', peer: self, offset: '', limit: 100,
  },
  'payments.getStarGiftCollections': {
    _: 'payments.getStarGiftCollections', peer: self, hash: Long.ZERO,
  },
  'stories.getAlbums': { _: 'stories.getAlbums', peer: self, hash: Long.ZERO },
  'stories.getPeerMaxIDs': { _: 'stories.getPeerMaxIDs', id: [self, self] },
  'premium.getBoostsStatus': { _: 'premium.getBoostsStatus', peer: self },
}

describe('Telegram Android optional RPC responses', () => {
  it('covers every METHOD_NOT_IMPLEMENTED method observed in the Android capture', () => {
    expect(Object.keys(androidRpcHandlers).sort()).toEqual(Object.keys(requests).sort())
  })

  it.each(Object.entries(requests))('%s returns serializable TL data', (method, request) => {
    const response = androidRpcHandlers[method](request)
    expect(response._).not.toBe('mt_rpc_error')
    if (isBareVector(response)) {
      for (const item of response.items) expect(roundTrip(item)._).toBe(item._)
    } else if (response._ === 'boolTrue' || response._ === 'boolFalse') {
      // MTProto serializes Bool constructors directly in rpc_result instead of
      // exposing them through mtcute's ordinary TL object writer map.
      expect(response).toEqual({ _: 'boolTrue' })
    } else {
      expect(roundTrip(response as tl.TlObject)._).toBe(response._)
    }
  })

  it('echoes the requested emoji language in an empty keyword difference', () => {
    expect(androidRpcHandlers['messages.getEmojiKeywords'](requests['messages.getEmojiKeywords']))
      .toMatchObject({ _: 'emojiKeywordsDifference', langCode: 'zh-hans', keywords: [] })
  })

  it('returns one zero search counter for every requested filter', () => {
    expect(androidRpcHandlers['messages.getSearchCounters'](requests['messages.getSearchCounters']))
      .toEqual({
        _: 'vector',
        items: [
          { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterPhotos' }, count: 0 },
          { _: 'messages.searchCounter', filter: { _: 'inputMessagesFilterVideo' }, count: 0 },
        ],
      })
  })

  it('returns one empty recent-story marker for every requested peer', () => {
    expect(androidRpcHandlers['stories.getPeerMaxIDs'](requests['stories.getPeerMaxIDs']))
      .toEqual({ _: 'vector', items: [{ _: 'recentStory' }, { _: 'recentStory' }] })
  })
})
