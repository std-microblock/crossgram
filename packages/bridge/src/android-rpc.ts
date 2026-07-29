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
  'account.getAutoDownloadSettings': () => makeAutoDownloadSettings(),
  'account.getDefaultProfilePhotoEmojis': () => ({
    _: 'emojiList', hash: Long.ZERO, documentId: [],
  } as unknown as tl.TlObject),
  'account.getContactSignUpNotification': () => ({
    _: 'boolFalse',
  }),
  'account.getGlobalPrivacySettings': () => ({
    _: 'globalPrivacySettings',
  } as unknown as tl.TlObject),
  'account.getPassword': () => ({
    _: 'account.password',
    newAlgo: { _: 'passwordKdfAlgoUnknown' },
    newSecureAlgo: { _: 'securePasswordKdfAlgoUnknown' },
    secureRandom: new Uint8Array(),
  } as unknown as tl.TlObject),
  'account.getPrivacy': () => ({
    _: 'account.privacyRules', rules: [{ _: 'privacyValueAllowAll' }], chats: [], users: [],
  } as unknown as tl.TlObject),
  'account.getRecentEmojiStatuses': () => ({
    _: 'account.emojiStatuses', hash: Long.ZERO, statuses: [],
  } as unknown as tl.TlObject),
  'account.getSavedRingtones': () => ({
    _: 'account.savedRingtones', hash: Long.ZERO, ringtones: [],
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
  'contacts.getBirthdays': () => ({
    _: 'contacts.contactBirthdays', contacts: [], users: [],
  } as unknown as tl.TlObject),
  'contacts.getTopPeers': () => ({
    _: 'contacts.topPeers', categories: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'bots.getBotRecommendations': () => ({
    _: 'users.users', users: [],
  } as unknown as tl.TlObject),
  'help.getTimezonesList': () => ({
    _: 'help.timezonesList', timezones: [], hash: 0,
  } as unknown as tl.TlObject),
  'help.getInviteText': () => ({
    _: 'help.inviteText', message: '',
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
  'messages.getEmojiKeywordsDifference': request => {
    const query = request as tl.messages.RawGetEmojiKeywordsDifferenceRequest
    return {
      _: 'emojiKeywordsDifference',
      langCode: query.langCode,
      fromVersion: query.fromVersion,
      version: query.fromVersion,
      keywords: [],
    } as unknown as tl.TlObject
  },
  'messages.getEmojiStatusGroups': () => ({
    _: 'messages.emojiGroups', hash: 0, groups: [],
  } as unknown as tl.TlObject),
  'messages.getOnlines': () => ({
    _: 'chatOnlines', onlines: 0,
  } as unknown as tl.TlObject),
  'messages.getSavedHistory': () => emptyMessages(),
  'messages.getMessageReadParticipants': () => bareVector([]),
  'messages.getMessagesViews': request => ({
    _: 'messages.messageViews',
    views: (request as tl.messages.RawGetMessagesViewsRequest).id.map(() => ({
      _: 'messageViews', views: 0, forwards: 0,
    })),
    chats: [],
    users: [],
  } as unknown as tl.TlObject),
  'messages.getQuickReplies': () => ({
    _: 'messages.quickReplies', quickReplies: [], messages: [], chats: [], users: [],
  } as unknown as tl.TlObject),
  'messages.getSavedDialogs': () => ({
    _: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: [],
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
  'payments.getStarGifts': () => ({
    _: 'payments.starGifts', hash: 0, gifts: [], chats: [], users: [],
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
  'photos.getUserPhotos': () => ({
    _: 'photos.photos', photos: [], users: [],
  } as unknown as tl.TlObject),
}

/** Telegram Android's own fallback presets, returned in layer-228 wire shape. */
function makeAutoDownloadSettings(): tl.account.RawAutoDownloadSettings {
  return {
    _: 'account.autoDownloadSettings',
    low: {
      _: 'autoDownloadSettings',
      phonecallsLessData: true,
      photoSizeMax: 1_048_576,
      videoSizeMax: 512_000,
      fileSizeMax: 512_000,
      videoUploadMaxbitrate: 50,
      smallQueueActiveOperationsMax: 2,
      largeQueueActiveOperationsMax: 1,
    },
    medium: {
      _: 'autoDownloadSettings',
      videoPreloadLarge: true,
      audioPreloadNext: true,
      storiesPreload: true,
      photoSizeMax: 1_048_576,
      videoSizeMax: 10_485_760,
      fileSizeMax: 1_048_576,
      videoUploadMaxbitrate: 100,
      smallQueueActiveOperationsMax: 3,
      largeQueueActiveOperationsMax: 2,
    },
    high: {
      _: 'autoDownloadSettings',
      videoPreloadLarge: true,
      audioPreloadNext: true,
      storiesPreload: true,
      photoSizeMax: 1_048_576,
      videoSizeMax: 15_728_640,
      fileSizeMax: 3_145_728,
      videoUploadMaxbitrate: 100,
      smallQueueActiveOperationsMax: 3,
      largeQueueActiveOperationsMax: 2,
    },
  }
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
