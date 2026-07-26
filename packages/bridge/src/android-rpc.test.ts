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
  'account.getContactSignUpNotification': { _: 'account.getContactSignUpNotification' },
  'account.getGlobalPrivacySettings': { _: 'account.getGlobalPrivacySettings' },
  'account.getThemes': { _: 'account.getThemes', format: 'android', hash: Long.ZERO },
  'account.getWebBrowserSettings': { _: 'account.getWebBrowserSettings', hash: Long.ZERO },
  'account.updateNotifySettings': {
    _: 'account.updateNotifySettings',
    peer: { _: 'inputNotifyPeer', peer: self },
    settings: { _: 'inputPeerNotifySettings' },
  },
  'contacts.getBlocked': { _: 'contacts.getBlocked', offset: 0, limit: 100 },
  'contacts.getTopPeers': {
    _: 'contacts.getTopPeers', correspondents: true, botsInline: true,
    offset: 0, limit: 20, hash: Long.ZERO,
  },
  'help.getTimezonesList': { _: 'help.getTimezonesList', hash: 0 },
  'messages.getArchivedStickers': {
    _: 'messages.getArchivedStickers', offsetId: Long.ZERO, limit: 0,
  },
  'messages.getEmojiKeywordsLanguages': {
    _: 'messages.getEmojiKeywordsLanguages', langCodes: ['', 'en', 'en', 'zh-CN'],
  },
  'messages.getEmojiKeywords': { _: 'messages.getEmojiKeywords', langCode: 'zh-hans' },
  'messages.getOnlines': { _: 'messages.getOnlines', peer: self },
  'messages.getSavedHistory': {
    _: 'messages.getSavedHistory', peer: self, offsetId: 0, offsetDate: 0,
    addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  },
  'messages.getMessageReadParticipants': {
    _: 'messages.getMessageReadParticipants', peer: self, msgId: 1,
  },
  'messages.getQuickReplies': { _: 'messages.getQuickReplies', hash: Long.ZERO },
  'messages.getSearchCounters': {
    _: 'messages.getSearchCounters',
    peer: self,
    filters: [{ _: 'inputMessagesFilterPhotos' }, { _: 'inputMessagesFilterVideo' }],
  },
  'messages.getSearchResultsPositions': {
    _: 'messages.getSearchResultsPositions', peer: self,
    filter: { _: 'inputMessagesFilterPhotoVideo' }, offsetId: 0, limit: 100,
  },
  'messages.getSponsoredMessages': { _: 'messages.getSponsoredMessages', peer: self },
  'messages.readReactions': { _: 'messages.readReactions', peer: self },
  'messages.reportReadMetrics': { _: 'messages.reportReadMetrics', peer: self, metrics: [] },
  'channels.getChannelRecommendations': { _: 'channels.getChannelRecommendations' },
  'payments.getSavedStarGifts': {
    _: 'payments.getSavedStarGifts', peer: self, offset: '', limit: 100,
  },
  'payments.getStarGiftCollections': {
    _: 'payments.getStarGiftCollections', peer: self, hash: Long.ZERO,
  },
  'stories.getAlbums': { _: 'stories.getAlbums', peer: self, hash: Long.ZERO },
  'stories.getAllReadPeerStories': { _: 'stories.getAllReadPeerStories' },
  'stories.getPinnedStories': {
    _: 'stories.getPinnedStories', peer: self, offsetId: 0, limit: 30,
  },
  'stories.getPeerMaxIDs': { _: 'stories.getPeerMaxIDs', id: [self, self] },
  'premium.getBoostsStatus': { _: 'premium.getBoostsStatus', peer: self },
  'premium.getMyBoosts': { _: 'premium.getMyBoosts' },
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
      expect(response).toEqual({ _: response._ })
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

  it('deduplicates requested emoji keyword languages and ignores empty codes', () => {
    expect(androidRpcHandlers['messages.getEmojiKeywordsLanguages'](
      requests['messages.getEmojiKeywordsLanguages'],
    )).toEqual({
      _: 'vector',
      items: [{ _: 'emojiLanguage', langCode: 'en' }, { _: 'emojiLanguage', langCode: 'zh-CN' }],
    })
  })

  it('returns stable empty containers for optional account and content resources', () => {
    expect(androidRpcHandlers['premium.getMyBoosts'](requests['premium.getMyBoosts']))
      .toEqual({ _: 'premium.myBoosts', myBoosts: [], chats: [], users: [] })
    expect(androidRpcHandlers['messages.getSponsoredMessages'](requests['messages.getSponsoredMessages']))
      .toEqual({ _: 'messages.sponsoredMessagesEmpty' })
    expect(androidRpcHandlers['stories.getPinnedStories'](requests['stories.getPinnedStories']))
      .toEqual({ _: 'stories.stories', count: 0, stories: [], chats: [], users: [] })
  })

  it('acknowledges harmless state updates without inventing unread state', () => {
    expect(androidRpcHandlers['account.updateNotifySettings'](requests['account.updateNotifySettings']))
      .toEqual({ _: 'boolTrue' })
    expect(androidRpcHandlers['messages.readReactions'](requests['messages.readReactions']))
      .toEqual({ _: 'messages.affectedHistory', pts: 0, ptsCount: 0, offset: 0 })
    expect(androidRpcHandlers['stories.getAllReadPeerStories'](requests['stories.getAllReadPeerStories']))
      .toMatchObject({ _: 'updates', updates: [], users: [], chats: [], seq: 0 })
  })
})
