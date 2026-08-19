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
  'account.getAutoDownloadSettings': { _: 'account.getAutoDownloadSettings' },
  'account.getDefaultProfilePhotoEmojis': { _: 'account.getDefaultProfilePhotoEmojis', hash: Long.ZERO },
  'account.getContactSignUpNotification': { _: 'account.getContactSignUpNotification' },
  'account.getGlobalPrivacySettings': { _: 'account.getGlobalPrivacySettings' },
  'account.getPassword': { _: 'account.getPassword' },
  'account.getPrivacy': { _: 'account.getPrivacy', key: { _: 'inputPrivacyKeyStatusTimestamp' } },
  'account.getRecentEmojiStatuses': { _: 'account.getRecentEmojiStatuses', hash: Long.ZERO },
  'account.getSavedRingtones': { _: 'account.getSavedRingtones', hash: Long.ZERO },
  'account.getThemes': { _: 'account.getThemes', format: 'android', hash: Long.ZERO },
  'account.getWebBrowserSettings': { _: 'account.getWebBrowserSettings', hash: Long.ZERO },
  'contacts.getBirthdays': { _: 'contacts.getBirthdays' },
  'contacts.getTopPeers': {
    _: 'contacts.getTopPeers', correspondents: true, botsInline: true,
    offset: 0, limit: 20, hash: Long.ZERO,
  },
  'bots.getBotRecommendations': {
    _: 'bots.getBotRecommendations', bot: { _: 'inputUserSelf' },
  },
  'help.getInviteText': { _: 'help.getInviteText' },
  'help.getTimezonesList': { _: 'help.getTimezonesList', hash: 0 },
  'messages.getArchivedStickers': {
    _: 'messages.getArchivedStickers', offsetId: Long.ZERO, limit: 0,
  },
  'messages.getEmojiKeywordsLanguages': {
    _: 'messages.getEmojiKeywordsLanguages', langCodes: ['', 'en', 'en', 'zh-CN'],
  },
  'messages.getEmojiKeywords': { _: 'messages.getEmojiKeywords', langCode: 'zh-hans' },
  'messages.getEmojiKeywordsDifference': {
    _: 'messages.getEmojiKeywordsDifference', langCode: 'zh-hans', fromVersion: 42,
  },
  'messages.getEmojiStatusGroups': { _: 'messages.getEmojiStatusGroups', hash: 0 },
  'messages.getOnlines': { _: 'messages.getOnlines', peer: self },
  'messages.getSavedHistory': {
    _: 'messages.getSavedHistory', peer: self, offsetId: 0, offsetDate: 0,
    addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
  },
  'messages.getMessageReadParticipants': {
    _: 'messages.getMessageReadParticipants', peer: self, msgId: 1,
  },
  'messages.getMessagesViews': {
    _: 'messages.getMessagesViews', peer: self, id: [11, 22, 33], increment: true,
  },
  'messages.getQuickReplies': { _: 'messages.getQuickReplies', hash: Long.ZERO },
  'messages.getSavedDialogs': {
    _: 'messages.getSavedDialogs', offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
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
  'payments.getStarGifts': { _: 'payments.getStarGifts', hash: 0 },
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
  'photos.getUserPhotos': {
    _: 'photos.getUserPhotos', userId: { _: 'inputUserSelf' },
    offset: 0, maxId: Long.ZERO, limit: 80,
  },
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
    expect(androidRpcHandlers['messages.getEmojiKeywordsDifference'](
      requests['messages.getEmojiKeywordsDifference'],
    )).toMatchObject({
      _: 'emojiKeywordsDifference', langCode: 'zh-hans', fromVersion: 42, version: 42, keywords: [],
    })
  })

  it('returns one zeroed view record for every requested message id', () => {
    expect(androidRpcHandlers['messages.getMessagesViews'](requests['messages.getMessagesViews']))
      .toEqual({
        _: 'messages.messageViews',
        views: [
          { _: 'messageViews', views: 0, forwards: 0 },
          { _: 'messageViews', views: 0, forwards: 0 },
          { _: 'messageViews', views: 0, forwards: 0 },
        ],
        chats: [],
        users: [],
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
    expect(androidRpcHandlers['account.getAutoDownloadSettings'](
      requests['account.getAutoDownloadSettings'],
    )).toEqual({
      _: 'account.autoDownloadSettings',
      low: expect.objectContaining({
        _: 'autoDownloadSettings',
        phonecallsLessData: true,
        photoSizeMax: 1_048_576,
        videoSizeMax: 512_000,
        fileSizeMax: 512_000,
      }),
      medium: expect.objectContaining({
        _: 'autoDownloadSettings',
        videoPreloadLarge: true,
        audioPreloadNext: true,
        photoSizeMax: 1_048_576,
        videoSizeMax: 10_485_760,
        fileSizeMax: 1_048_576,
      }),
      high: expect.objectContaining({
        _: 'autoDownloadSettings',
        videoPreloadLarge: true,
        audioPreloadNext: true,
        photoSizeMax: 1_048_576,
        videoSizeMax: 15_728_640,
        fileSizeMax: 3_145_728,
      }),
    })
    expect(androidRpcHandlers['account.getDefaultProfilePhotoEmojis'](
      requests['account.getDefaultProfilePhotoEmojis'],
    )).toEqual({ _: 'emojiList', hash: Long.ZERO, documentId: [] })
    expect(androidRpcHandlers['account.getPrivacy'](requests['account.getPrivacy']))
      .toEqual({ _: 'account.privacyRules', rules: [{ _: 'privacyValueAllowAll' }], chats: [], users: [] })
    expect(androidRpcHandlers['account.getPassword'](requests['account.getPassword']))
      .toMatchObject({
        _: 'account.password',
        newAlgo: { _: 'passwordKdfAlgoUnknown' },
        newSecureAlgo: { _: 'securePasswordKdfAlgoUnknown' },
      })
    expect(androidRpcHandlers['premium.getMyBoosts'](requests['premium.getMyBoosts']))
      .toEqual({ _: 'premium.myBoosts', myBoosts: [], chats: [], users: [] })
    expect(androidRpcHandlers['messages.getSavedDialogs'](requests['messages.getSavedDialogs']))
      .toEqual({ _: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: [] })
    expect(androidRpcHandlers['messages.getSponsoredMessages'](requests['messages.getSponsoredMessages']))
      .toEqual({ _: 'messages.sponsoredMessagesEmpty' })
    expect(androidRpcHandlers['bots.getBotRecommendations'](requests['bots.getBotRecommendations']))
      .toEqual({ _: 'users.users', users: [] })
    expect(androidRpcHandlers['photos.getUserPhotos'](requests['photos.getUserPhotos']))
      .toEqual({ _: 'photos.photos', photos: [], users: [] })
    expect(androidRpcHandlers['payments.getStarGifts'](requests['payments.getStarGifts']))
      .toEqual({ _: 'payments.starGifts', hash: 0, gifts: [], chats: [], users: [] })
    expect(androidRpcHandlers['stories.getPinnedStories'](requests['stories.getPinnedStories']))
      .toEqual({ _: 'stories.stories', count: 0, stories: [], chats: [], users: [] })
  })

  it('acknowledges harmless state updates without inventing unread state', () => {
    expect(androidRpcHandlers['messages.readReactions'](requests['messages.readReactions']))
      .toEqual({ _: 'messages.affectedHistory', pts: 0, ptsCount: 0, offset: 0 })
    expect(androidRpcHandlers['stories.getAllReadPeerStories'](requests['stories.getAllReadPeerStories']))
      .toMatchObject({ _: 'updates', updates: [], users: [], chats: [], seq: 0 })
  })
})
