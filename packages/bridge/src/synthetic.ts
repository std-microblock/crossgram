import type { tl } from '@mtcute/core'
import { isIP } from 'node:net'
import Long from 'long'

export interface Endpoint {
  host: string
  port: number
}

export function parseEndpoint(endpoint: string): Endpoint {
  const match = /^(?:\[([^\]]+)\]|([^:\[\]\s]+)):(\d+)$/u.exec(endpoint)
  if (!match) throw new Error('expected host:port or [IPv6]:port')

  const host = match[1] ?? match[2]
  const port = Number(match[3])
  if (match[1] && isIP(host) !== 6) throw new Error('bracketed host must be IPv6')
  if (port < 1 || port > 65_535) throw new Error('port must be between 1 and 65535')
  return { host, port }
}

// 必须使用客户端硬编码识别的内部链接域名（t.me 等，Telegram Desktop 还要求末尾带斜杠），
// 否则复制的链接会被当成外部网页打开，无法通过本服务解析跳转。
export const meUrlPrefix = 'https://t.me/'

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

/** 可选字符串字段缺省时必须传 `undefined`，mtcute 会把 `null` 当作有效字段按字符串序列化。 */
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
  botAttachMenu?: boolean
  attachMenuEnabled?: boolean
  photo?: tl.TypeUserProfilePhoto
}): tl.RawUser {
  return {
    _: 'user',
    flags: 0,
    self: opts.self,
    bot: opts.bot,
    // `bot` 与 `bot_info_version` 共用 `user.flags` 的 bit 14，线上始终带一个 int；
    // 客户端仅在该值非负时初始化 bot 信息并展示 bot UI。
    botInfoVersion: opts.bot ? (opts.botInfoVersion ?? 0) : undefined,
    premium: opts.premium,
    // 附件菜单 bot 的两个标记：`bot_attach_menu` 声明 bot 提供附件菜单条目，
    // `attach_menu_enabled` 表示该条目已为用户安装。桌面端解析 `attachMenuBots`
    // 时按前者过滤，缺了就把条目整条丢掉。
    botAttachMenu: opts.botAttachMenu,
    attachMenuEnabled: opts.attachMenuEnabled,
    contact: opts.contact,
    mutualContact: opts.mutualContact,
    id: opts.id,
    accessHash: Long.ONE,
    firstName: opts.firstName,
    lastName: opts.lastName ?? undefined,
    username: opts.username ?? undefined,
    phone: opts.phone ?? undefined,
    // 缺少 `photo` 会导致客户端将头像状态视为未知，桌面端只要界面上有头像按钮就会死循环拉取完整用户信息。
    photo: opts.photo ?? { _: 'userProfilePhotoEmpty' },
    status: { _: 'userStatusRecently' },
  } as unknown as tl.RawUser
}
