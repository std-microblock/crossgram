import type { tl } from '@mtcute/core'
import Long from 'long'

type StartupHandler = () => tl.TlObject

/**
 * Telegram Desktop loads these optional resources as one post-login batch and
 * retries failures with exponential backoff. Bridge accounts do not expose
 * stickers, premium, stories, or cosmetic palettes, so return valid empty TL
 * objects instead of METHOD_NOT_IMPLEMENTED errors.
 */
export const startupRpcHandlers: Readonly<Record<string, StartupHandler>> = {
  'help.getPeerColors': () => ({
    _: 'help.peerColors', hash: 0, colors: [],
  } as unknown as tl.TlObject),
  'help.getPeerProfileColors': () => ({
    _: 'help.peerColors', hash: 0, colors: [],
  } as unknown as tl.TlObject),
  'messages.getAvailableReactions': () => ({
    _: 'messages.availableReactions', hash: 0, reactions: [],
  } as unknown as tl.TlObject),
  'account.getDefaultEmojiStatuses': () => ({
    _: 'account.emojiStatuses', hash: Long.ZERO, statuses: [],
  } as unknown as tl.TlObject),
  'messages.getStickerSet': () => ({
    _: 'messages.stickerSetNotModified',
  } as unknown as tl.TlObject),
  'help.getPromoData': () => ({
    _: 'help.promoDataEmpty', expires: futureDate(),
  } as unknown as tl.TlObject),
  'help.getTermsOfServiceUpdate': () => ({
    _: 'help.termsOfServiceUpdateEmpty', expires: futureDate(),
  } as unknown as tl.TlObject),
  'messages.getEmojiGroups': () => ({
    _: 'messages.emojiGroups', hash: 0, groups: [],
  } as unknown as tl.TlObject),
  'messages.getEmojiStickerGroups': () => ({
    _: 'messages.emojiGroups', hash: 0, groups: [],
  } as unknown as tl.TlObject),
  'messages.getAttachMenuBots': () => ({
    _: 'attachMenuBots', hash: Long.ZERO, bots: [], users: [],
  } as unknown as tl.TlObject),
  'stories.getAllStories': () => ({
    _: 'stories.allStories', count: 0, state: '', peerStories: [], chats: [], users: [],
    stealthMode: { _: 'storiesStealthMode' },
  } as unknown as tl.TlObject),
  'messages.getAllStickers': () => ({
    _: 'messages.allStickers', hash: Long.ZERO, sets: [],
  } as unknown as tl.TlObject),
  'messages.getRecentStickers': () => ({
    _: 'messages.recentStickers', hash: Long.ZERO, packs: [], stickers: [], dates: [],
  } as unknown as tl.TlObject),
  'messages.getFavedStickers': () => ({
    _: 'messages.favedStickers', hash: Long.ZERO, packs: [], stickers: [],
  } as unknown as tl.TlObject),
  'messages.getFeaturedStickers': () => ({
    _: 'messages.featuredStickers', hash: Long.ZERO, count: 0, sets: [], unread: [],
  } as unknown as tl.TlObject),
  'help.getPremiumPromo': () => ({
    _: 'help.premiumPromo', statusText: '', statusEntities: [],
    videoSections: [], videos: [], periodOptions: [], users: [],
  } as unknown as tl.TlObject),
  'messages.getStickers': () => ({
    _: 'messages.stickers', hash: Long.ZERO, stickers: [],
  } as unknown as tl.TlObject),
  'account.getReactionsNotifySettings': () => ({
    _: 'reactionsNotifySettings', sound: { _: 'notificationSoundDefault' }, showPreviews: true,
  } as unknown as tl.TlObject),
}

function futureDate(): number {
  return Math.floor(Date.now() / 1000) + 86400
}
