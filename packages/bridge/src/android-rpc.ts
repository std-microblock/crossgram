import type { tl } from '@mtcute/core'
import { bareVector, type RpcResult } from '@mtproto-relay/mtproto'
import Long from 'long'

type AndroidRpcHandler = (request: tl.RpcMethod) => RpcResult

/**
 * Optional resources requested by Telegram Android after login or while a chat
 * is open. The bridge has no Telegram premium, gifts, stories, saved messages,
 * or read-receipt backend, so these handlers expose valid empty layer-228
 * responses instead of making the client retry METHOD_NOT_IMPLEMENTED errors.
 */
export const androidRpcHandlers: Readonly<Record<string, AndroidRpcHandler>> = {
  'account.getContactSignUpNotification': () => ({
    _: 'boolFalse',
  }),
  'account.getGlobalPrivacySettings': () => ({
    _: 'globalPrivacySettings',
  } as unknown as tl.TlObject),
  'account.getThemes': () => ({
    _: 'account.themes', hash: Long.ZERO, themes: [],
  } as unknown as tl.TlObject),
  'account.getWebBrowserSettings': () => ({
    _: 'account.webBrowserSettings',
    externalExceptions: [], inappExceptions: [], hash: Long.ZERO,
  } as unknown as tl.TlObject),
  'contacts.getBlocked': () => ({
    _: 'contacts.blocked', blocked: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'contacts.getTopPeers': () => ({
    _: 'contacts.topPeers', categories: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'help.getTimezonesList': () => ({
    _: 'help.timezonesList', timezones: [], hash: 0,
  } as unknown as tl.TlObject),
  'messages.getArchivedStickers': () => ({
    _: 'messages.archivedStickers', count: 0, sets: [],
  } as unknown as tl.TlObject),
  'messages.getEmojiKeywordsLanguages': request => bareVector(
    uniqueNonEmpty((request as tl.messages.RawGetEmojiKeywordsLanguagesRequest).langCodes)
      .map(langCode => ({ _: 'emojiLanguage', langCode } as tl.RawEmojiLanguage)),
  ),
  'messages.getEmojiKeywords': request => ({
    _: 'emojiKeywordsDifference',
    langCode: (request as tl.messages.RawGetEmojiKeywordsRequest).langCode,
    fromVersion: 0,
    version: 0,
    keywords: [],
  } as unknown as tl.TlObject),
  'messages.getOnlines': () => ({
    _: 'chatOnlines', onlines: 0,
  } as unknown as tl.TlObject),
  'messages.getSavedHistory': () => emptyMessages(),
  'messages.getMessageReadParticipants': () => bareVector([]),
  'messages.getQuickReplies': () => ({
    _: 'messages.quickReplies', quickReplies: [], messages: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'messages.getSearchCounters': request => bareVector(
    (request as tl.messages.RawGetSearchCountersRequest).filters.map(filter => ({
      _: 'messages.searchCounter', filter, count: 0,
    } as unknown as tl.TlObject)),
  ),
  'messages.getSearchResultsPositions': () => ({
    _: 'messages.searchResultsPositions', count: 0, positions: [],
  } as unknown as tl.TlObject),
  'messages.getSponsoredMessages': () => ({
    _: 'messages.sponsoredMessagesEmpty',
  } as unknown as tl.TlObject),
  'messages.readReactions': () => ({
    _: 'messages.affectedHistory', pts: 0, ptsCount: 0, offset: 0,
  } as unknown as tl.TlObject),
  'messages.reportReadMetrics': () => ({
    _: 'boolTrue',
  } as unknown as tl.TlObject),
  'channels.getChannelRecommendations': () => ({
    _: 'messages.chats', chats: [],
  } as unknown as tl.TlObject),
  'payments.getSavedStarGifts': () => ({
    _: 'payments.savedStarGifts', count: 0, gifts: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'payments.getStarGiftCollections': () => ({
    _: 'payments.starGiftCollections', collections: [],
  } as unknown as tl.TlObject),
  'stories.getAlbums': () => ({
    _: 'stories.albums', hash: Long.ZERO, albums: [],
  } as unknown as tl.TlObject),
  'stories.getAllReadPeerStories': () => ({
    _: 'updates', updates: [], users: [], chats: [], date: unixTime(), seq: 0,
  } as unknown as tl.TlObject),
  'stories.getPinnedStories': () => ({
    _: 'stories.stories', count: 0, stories: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'stories.getPeerMaxIDs': request => bareVector(
    (request as tl.stories.RawGetPeerMaxIDsRequest).id.map(() => ({
      _: 'recentStory',
    } as unknown as tl.TlObject)),
  ),
  'premium.getBoostsStatus': () => ({
    _: 'premium.boostsStatus',
    level: 0,
    currentLevelBoosts: 0,
    boosts: 0,
    boostUrl: '',
  } as unknown as tl.TlObject),
  'premium.getMyBoosts': () => ({
    _: 'premium.myBoosts', myBoosts: [], chats: [], users: [],
  } as unknown as tl.TlObject),
}

function emptyMessages(): tl.messages.RawMessages {
  return {
    _: 'messages.messages', messages: [], topics: [], chats: [], users: [],
  }
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function unixTime(): number {
  return Math.floor(Date.now() / 1000)
}
