import type { tl } from '@mtcute/core'
import Long from 'long'

/**
 * Telegram Desktop starts new accounts on DC 2, while config enumeration and
 * media sessions may use other IDs. Every logical DC terminates at this relay.
 */
export const RELAY_DC_IDS = [1, 2, 3, 4, 5, 6] as const

/** Synthesized `config` pointing every logical DC at this server. */
export function makeConfig(dcId: number, host = '127.0.0.1', port = 4430): tl.TlObject {
  const now = Math.floor(Date.now() / 1000)
  return {
    _: 'config', flags: 0, defaultP2pContacts: false, preloadFeaturedStickers: false,
    revokePmInbox: false, blockedMode: false, forceTryIpv6: false, date: now, expires: now + 3600,
    testMode: false, thisDc: dcId,
    dcOptions: RELAY_DC_IDS.map(id => ({
      _: 'dcOption', flags: 0, ipv6: false, mediaOnly: false, tcpoOnly: true, cdn: false, static: true,
      id, ipAddress: host, port,
    })),
    dcTxtDomainName: '', chatSizeMax: 200, megagroupSizeMax: 200000, forwardedCountMax: 100,
    onlineUpdatePeriodMs: 120000, offlineBlurTimeoutMs: 5000, offlineIdleTimeoutMs: 30000,
    onlineCloudTimeoutMs: 300000, notifyCloudDelayMs: 30000, notifyDefaultDelayMs: 1500,
    pushChatPeriodMs: 60000, pushChatLimit: 2, editTimeLimit: 172800, revokeTimeLimit: 172800,
    revokePmTimeLimit: 172800, ratingEDecay: 1000, stickersRecentLimit: 200, channelsReadMediaPeriod: 86400,
    tmpSessions: 0, callReceiveTimeoutMs: 30000, callRingTimeoutMs: 90000, callConnectTimeoutMs: 30000,
    callPacketTimeoutMs: 10000, meUrlPrefix: 'https://my.telegram.org/', captionLengthMax: 1024,
    messageLengthMax: 4096, webfileDcId: dcId, suggestedLangCode: '', langPackVersion: 0,
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
  contact?: boolean
  mutualContact?: boolean
  firstName: string
  lastName?: string | null
  username?: string | null
  phone?: string | null
}): tl.RawUser {
  return {
    _: 'user',
    flags: 0,
    self: opts.self,
    contact: opts.contact,
    mutualContact: opts.mutualContact,
    id: opts.id,
    accessHash: Long.ZERO,
    firstName: opts.firstName,
    lastName: opts.lastName ?? undefined,
    username: opts.username ?? undefined,
    phone: opts.phone ?? undefined,
    status: { _: 'userStatusRecently' },
  } as unknown as tl.RawUser
}
