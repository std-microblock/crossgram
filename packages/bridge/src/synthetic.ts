import type { tl } from '@mtcute/core'
import { isIP } from 'node:net'
import Long from 'long'

export interface Endpoint {
  host: string
  port: number
}

/** Parse an endpoint in `host:port` or `[IPv6]:port` form. */
export function parseEndpoint(endpoint: string): Endpoint {
  const match = /^(?:\[([^\]]+)\]|([^:\[\]\s]+)):(\d+)$/u.exec(endpoint)
  if (!match) throw new Error('expected host:port or [IPv6]:port')

  const host = match[1] ?? match[2]
  const port = Number(match[3])
  if (match[1] && isIP(host) !== 6) throw new Error('bracketed host must be IPv6')
  if (port < 1 || port > 65_535) throw new Error('port must be between 1 and 65535')
  return { host, port }
}

/**
 * `me_url_prefix`: the domain clients build "copy link", share, and public
 * link URLs from.
 *
 * This value only decides how a client *writes* a link: whether the client
 * keeps the resulting URL inside itself is decided by the internal-link grammar
 * each client hard-codes (`t.me`, `telegram.me` and `telegram.dog` in
 * Telegram Desktop's `Core::TryConvertUrlToLocal` and Telegram Android's
 * `Browser.isInternalUri`; Telegram Desktop also requires the trailing slash).
 * For any other domain — `https://my.telegram.org/`, as this bridge used to
 * advertise — every "copy link" URL opens in a browser instead of resolving to
 * the linked message through this relay.
 */
export const meUrlPrefix = 'https://t.me/'

/** Synthesized `config` advertising this bridge's configured DC endpoints. */
export function makeConfig(
  dcId: number,
  host = '127.0.0.1',
  port = 4430,
  altEndpoints: string[] = [],
): tl.TlObject {
  const now = Math.floor(Date.now() / 1000)
  return {
    _: 'config', flags: 0, defaultP2pContacts: false, preloadFeaturedStickers: false,
    revokePmInbox: false, blockedMode: false, forceTryIpv6: false, date: now, expires: now + 3600,
    testMode: false, thisDc: dcId,
    dcOptions: [{ host, port }, ...altEndpoints.map(parseEndpoint)].map(({ host, port }) => ({
      _: 'dcOption', flags: 0, ipv6: isIP(host) === 6, mediaOnly: false, tcpoOnly: true, cdn: false, static: true,
      id: dcId, ipAddress: host, port,
    })),
    dcTxtDomainName: '', chatSizeMax: 200, megagroupSizeMax: 200000, forwardedCountMax: 100,
    onlineUpdatePeriodMs: 120000, offlineBlurTimeoutMs: 5000, offlineIdleTimeoutMs: 30000,
    onlineCloudTimeoutMs: 300000, notifyCloudDelayMs: 30000, notifyDefaultDelayMs: 1500,
    pushChatPeriodMs: 60000, pushChatLimit: 2, editTimeLimit: 172800, revokeTimeLimit: 172800,
    revokePmTimeLimit: 172800, ratingEDecay: 1000, stickersRecentLimit: 200, channelsReadMediaPeriod: 86400,
    tmpSessions: 0, callReceiveTimeoutMs: 30000, callRingTimeoutMs: 90000, callConnectTimeoutMs: 30000,
    callPacketTimeoutMs: 10000, meUrlPrefix, captionLengthMax: 1024, messageLengthMax: 4096,
    webfileDcId: dcId, suggestedLangCode: '', langPackVersion: 0,
    baseLangPackVersion: 0, reactionsDefault: { _: 'reactionEmpty' }, autologinToken: '',
  } as unknown as tl.TlObject
}

export function makeAppConfig(): tl.TlObject {
  return { _: 'help.appConfig', hash: 0, config: { _: 'jsonObject', value: [] } } as unknown as tl.TlObject
}

/**
 * Build a `user`. Optional string fields MUST be `undefined` (omitted) — mtcute's
 * TL writer treats `null` as present and tries to serialize it as a string.
 */
export function makeUser(opts: {
  id: number
  self?: boolean
  bot?: boolean
  botInfoVersion?: number
  contact?: boolean
  mutualContact?: boolean
  firstName: string
  lastName?: string | null
  username?: string | null
  phone?: string | null
  premium?: boolean
  photo?: tl.TypeUserProfilePhoto
}): tl.RawUser {
  return {
    _: 'user',
    flags: 0,
    self: opts.self,
    bot: opts.bot,
    // `bot` and `bot_info_version` share bit 14 of `user.flags`: the bit always
    // carries an int on the wire, and clients only allocate their bot info (and
    // therefore show bot UI and stop treating the peer as a plain user) when
    // that value is non-negative. Report version 0 like Telegram does for a bot
    // whose info the client has not cached yet.
    botInfoVersion: opts.bot ? (opts.botInfoVersion ?? 0) : undefined,
    premium: opts.premium,
    contact: opts.contact,
    mutualContact: opts.mutualContact,
    id: opts.id,
    accessHash: Long.ONE,
    firstName: opts.firstName,
    lastName: opts.lastName ?? undefined,
    username: opts.username ?? undefined,
    phone: opts.phone ?? undefined,
    // Telegram always reports this slot: a missing `photo` flag leaves the
    // client's userpic state unknown, and desktop clients then re-request the
    // full user in a loop while any userpic button is on screen.
    photo: opts.photo ?? { _: 'userProfilePhotoEmpty' },
    status: { _: 'userStatusRecently' },
  } as unknown as tl.RawUser
}
