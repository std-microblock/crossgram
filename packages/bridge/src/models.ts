import type { Context } from 'cordis'
import type {
  IMConversationKind, IMMediaKind, JsonObject, JsonValue,
} from './platform.js'
import type { SrpVerifier } from './login-srp.js'

export interface AuthSessionRow {
  id: string
  virtualPhone: string
  totpSecret: string
  platformId: string
  platformSessionId: string
  passwordSrp?: SrpVerifier | null
}

export interface PlatformSessionRow {
  id: string
  platformId: string
  userId: string
  credentials: JsonValue
  metadata: JsonObject
  active: boolean
  createdAt: Date
}

export interface AuthBindingRow {
  authKeyId: string
  platformId: string
  platformSessionId: string
}

export interface ClientAuthorizationRow {
  authKeyId: string
  platformSessionId: string
  apiId: number
  deviceModel: string
  platform: string
  systemVersion: string
  appName: string
  appVersion: string
  dateCreated: number
  dateActive: number
  ip: string
  country: string
  region: string
  encryptedRequestsDisabled: boolean
  callRequestsDisabled: boolean
  unconfirmed: boolean
}

export interface AuthorizationSettingsRow {
  platformSessionId: string
  ttlDays: number
}

export interface IMConversationRow {
  id: number
  platformSessionId: string
  platformConversationId: string
  kind: IMConversationKind
  title: string
  parentPlatformConversationId: string | null
  spacePlatformId: string | null
  avatar: JsonValue | null
  metadata: JsonObject
  unreadCount: number
  /** 上游报告的已读边界消息（本地消息行 ID）。缺少上游数据时保留旧值，避免把「已读到哪」退化成「一条都没读」。 */
  readInboxMaxMessageId: number | null
  updatedAt: Date
}

export interface IMUserRow {
  id: number
  platformId: string
  platformUserId: string
  firstName: string
  lastName: string | null
  username: string | null
  avatar: JsonValue | null
  metadata: JsonObject
  updatedAt: Date
}

export interface IMMessageRow {
  id: number
  platformSessionId: string
  conversationId: number
  primaryPlatformMessageId: string
  senderUserId: number
  text: string
  content: JsonValue
  timestamp: number
  outgoing: boolean
  deleted: boolean
  platformGroupId: string | null
  metadata: JsonObject
  /** 归一化后的可搜索文本（正文、卡片、文件名、链接），无文本索引，按会话扫描时做子串匹配。 */
  searchText: string
  /** 媒体类别位掩码（见 `SEARCH_KIND`）；`null` 表示旧数据尚未建立搜索字段。 */
  searchKinds: number | null
  createdAt: Date
  updatedAt: Date
}

export interface IMRequestRow {
  id: number
  platformSessionId: string
  platformRequestId: string
  kind: 'friend' | 'group-join'
  state: 'pending' | 'accepted' | 'rejected'
  request: JsonObject
  createdAt: Date
  updatedAt: Date
}

export interface IMMessageAliasRow {
  id: number
  platformSessionId: string
  conversationId: number
  platformMessageId: string
  messageId: number
  ordinal: number
}

export interface MessageMentionRow {
  messageId: number
  platformSessionId: string
  conversationId: number
  tlMessageId: number
  unread: boolean
  updatedAt: Date
}

export interface IMMediaRow {
  id: number
  messageId: number
  ordinal: number
  partIndex: number
  platformMediaId: string
  kind: IMMediaKind
  name: string | null
  mimeType: string | null
  size: number | null
  width: number | null
  height: number | null
  duration: number | null
  voice?: boolean
  preview: {
    mimeType?: string
    size: number
    width: number
    height: number
    locator: JsonValue
  } | null
  strippedThumbnail: ArrayBuffer | null
  locator: JsonValue
}

export interface ImageStorageRow {
  id: string
  platformId: string
  platformSessionId: string
  messageId: number
  platformMediaId: string
  isPreview: boolean
  conversationId: string
  conversationTitle: string
  date: string
  timestamp: number
  media: JsonValue
  state: 'pending' | 'ready' | 'failed' | 'deleting' | 'deleted'
  bytes: number
}

export interface TlMessagePartRow {
  id: number
  platformSessionId: string
  conversationId: number
  messageId: number
  mediaId: number | null
  scope: string
  tlMessageId: number
  nativeSequence: number | null
  nativeOrderKey: string | null
  allocationVersion: number | null
  groupedId: string | null
  ordinal: number
}

export interface IdCounterRow {
  scope: string
  nextId: number
}

export interface MessageIdEpochRow {
  scope: string
  epoch: number
}

export interface UpdateStateRow {
  platformSessionId: string
  pts: number
  qts: number
  seq: number
  date: number
}

export interface ChannelUpdateStateRow {
  id: string
  platformSessionId: string
  channelId: string
  pts: number
  date: number
}

export interface StickerRecentRow {
  id: number
  platformSessionId: string
  providerId: string
  providerStickerId: string
  attached: boolean
  useCount: number
  lastUsedAt: Date
}

export interface StickerFavoriteRow {
  id: number
  platformSessionId: string
  providerId: string
  providerStickerId: string
  createdAt: Date
}

export interface ReactionRecentRow {
  id: number
  platformSessionId: string
  reactionType: 'emoji' | 'custom'
  reactionValue: string
  definitionKey?: string | null
  lastUsedAt: Date
}

export interface IMMessageReactionRow {
  id: number
  messageId: number
  nativeReactionKey: string
  count: number
  selected: boolean
  selectedOrder: number
  recentActors: Record<string, unknown>[]
  definition: Record<string, unknown>
  updatedAt: Date
}

export interface StickerSetInstallRow {
  id: number
  platformSessionId: string
  providerId: string
  providerPackId: string
  installedAt: Date
  sortOrder: number
  archived: boolean
  /** 标记已被用户从 Telegram 已安装列表中移除的贴纸包。 */
  uninstalled: boolean
}

export interface DraftRow {
  id: number
  platformSessionId: string
  platformConversationId: string
  topMsgId: number
  payload: ArrayBuffer
  date: number
}

export interface NotificationSettingsRow {
  id: string
  platformSessionId: string
  scope: string
  settings: JsonObject
  updatedAt: Date
}

export interface BlockedPeerRow {
  id: number
  platformSessionId: string
  platformUserId: string
  blockedAt: Date
}

export interface DialogFilterRow {
  id: string
  platformSessionId: string
  filterId: number
  sortOrder: number
  payload: JsonObject | null
  updatedAt: Date
}

export interface DialogFolderPeerRow {
  id: string
  platformSessionId: string
  platformConversationId: string
  folderId: number
  /** 置顶顺序（升序），未置顶时为 null */
  pinnedOrder: number | null
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_auth_session: AuthSessionRow
    mtproto_platform_session: PlatformSessionRow
    mtproto_auth_binding: AuthBindingRow
    mtproto_client_authorization: ClientAuthorizationRow
    mtproto_authorization_settings: AuthorizationSettingsRow
    mtproto_im_conversation: IMConversationRow
    mtproto_im_user: IMUserRow
    mtproto_im_message: IMMessageRow
    mtproto_im_request: IMRequestRow
    mtproto_im_message_alias: IMMessageAliasRow
    mtproto_message_mention: MessageMentionRow
    mtproto_im_media: IMMediaRow
    mtproto_image_storage: ImageStorageRow
    mtproto_tl_message_part: TlMessagePartRow
    mtproto_id_counter: IdCounterRow
    mtproto_message_id_epoch: MessageIdEpochRow
    mtproto_update_state: UpdateStateRow
    mtproto_channel_update_state: ChannelUpdateStateRow
    mtproto_sticker_recent: StickerRecentRow
    mtproto_sticker_favorite: StickerFavoriteRow
    mtproto_reaction_recent: ReactionRecentRow
    mtproto_im_message_reaction: IMMessageReactionRow
    mtproto_sticker_set_install: StickerSetInstallRow
    mtproto_draft: DraftRow
    mtproto_notification_settings: NotificationSettingsRow
    mtproto_blocked_peer: BlockedPeerRow
    mtproto_dialog_filter: DialogFilterRow
    mtproto_dialog_folder_peer: DialogFolderPeerRow
  }
}

export function defineModels(ctx: Context): void {
  ctx.model.extend('mtproto_auth_session', {
    id: 'string', virtualPhone: 'string', totpSecret: 'string', platformId: 'string',
    platformSessionId: 'string', passwordSrp: 'json',
  }, { primary: 'id', unique: ['virtualPhone', 'platformId'] })

  ctx.model.extend('mtproto_platform_session', {
    id: 'string', platformId: 'string', userId: 'string', credentials: 'json', metadata: 'json',
    active: 'boolean', createdAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('mtproto_auth_binding', {
    authKeyId: 'string', platformId: 'string', platformSessionId: 'string',
  }, { primary: 'authKeyId' })

  ctx.model.extend('mtproto_client_authorization', {
    authKeyId: 'string', platformSessionId: 'string', apiId: 'integer', deviceModel: 'string',
    platform: 'string', systemVersion: 'string', appName: 'string', appVersion: 'string',
    dateCreated: 'unsigned', dateActive: 'unsigned', ip: 'string', country: 'string', region: 'string',
    encryptedRequestsDisabled: 'boolean', callRequestsDisabled: 'boolean', unconfirmed: 'boolean',
  }, { primary: 'authKeyId', indexes: ['platformSessionId'] })

  ctx.model.extend('mtproto_authorization_settings', {
    platformSessionId: 'string', ttlDays: 'unsigned',
  }, { primary: 'platformSessionId' })

  ctx.model.extend('mtproto_im_conversation', {
    id: 'unsigned', platformSessionId: 'string', platformConversationId: 'text', kind: 'string', title: 'text',
    parentPlatformConversationId: { type: 'text', nullable: true },
    spacePlatformId: { type: 'text', nullable: true }, avatar: { type: 'json', nullable: true },
    metadata: 'json', updatedAt: 'timestamp',
    unreadCount: 'unsigned',
    readInboxMaxMessageId: { type: 'unsigned', nullable: true },
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformConversationId']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_im_user', {
    id: 'unsigned', platformId: 'string', platformUserId: 'text', firstName: 'text',
    lastName: { type: 'text', nullable: true }, username: { type: 'text', nullable: true },
    avatar: { type: 'json', nullable: true }, metadata: 'json', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformId', 'platformUserId']],
    indexes: ['platformId'],
  })

  ctx.model.extend('mtproto_im_message', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned',
    primaryPlatformMessageId: 'text', senderUserId: 'unsigned', text: 'text', content: 'json', timestamp: 'integer',
    outgoing: 'boolean', deleted: 'boolean', platformGroupId: { type: 'text', nullable: true }, metadata: 'json',
    searchText: 'text', searchKinds: { type: 'unsigned', nullable: true },
    createdAt: 'timestamp', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    // conversationId 是本表的全局唯一自增行号，已隐含 platformSessionId；
    // 判重键不再重复携带 32 字节的会话 id，索引键从 55 字节降到 23 字节。
    unique: [['conversationId', 'primaryPlatformMessageId']],
    // senderUserId 只在会话扫描中作为附加过滤条件（from: 搜索），不单独建索引。
    // 搜索不建文本索引：会话内搜索沿 (conversationId, timestamp) 倒序扫描，
    // 全局搜索沿 (platformSessionId, timestamp) 倒序扫描，searchText 子串匹配，凑够一页即停。
    indexes: [['conversationId', 'timestamp'], ['platformSessionId', 'timestamp']],
  })

  ctx.model.extend('mtproto_im_request', {
    id: 'unsigned', platformSessionId: 'string', platformRequestId: 'text', kind: 'string', state: 'string',
    request: 'json', createdAt: 'timestamp', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformRequestId']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_im_message_alias', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned', platformMessageId: 'text',
    messageId: 'unsigned', ordinal: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    // 同上：conversationId 已隐含 platformSessionId，平台消息 id 只需在会话内唯一。
    unique: [['conversationId', 'platformMessageId']],
    indexes: ['messageId'],
  })

  ctx.model.extend('mtproto_message_mention', {
    messageId: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned',
    tlMessageId: 'unsigned', unread: 'boolean', updatedAt: 'timestamp',
  }, {
    primary: 'messageId',
    unique: [['platformSessionId', 'conversationId', 'tlMessageId']],
    indexes: [['platformSessionId', 'conversationId', 'unread', 'tlMessageId']],
  })

  ctx.model.extend('mtproto_im_media', {
    id: 'unsigned', messageId: 'unsigned', ordinal: 'unsigned', partIndex: 'unsigned', platformMediaId: 'text',
    kind: 'string', name: { type: 'text', nullable: true }, mimeType: { type: 'text', nullable: true },
    // QQNT 文件大小可能超过 PostgreSQL int4 上限（如 >2GB 压缩包），使用 scale=0 的 decimal 存储。
    size: { type: 'decimal', precision: 20, scale: 0, nullable: true }, width: { type: 'unsigned', nullable: true },
    height: { type: 'unsigned', nullable: true }, duration: { type: 'unsigned', nullable: true }, voice: 'boolean',
    preview: { type: 'json', nullable: true },
    strippedThumbnail: { type: 'binary', nullable: true }, locator: 'json',
  }, {
    primary: 'id', autoInc: true,
    unique: [['messageId', 'ordinal', 'platformMediaId']],
    // 媒体查询一律是 messageId = / IN (...)，unique 的左前缀已经覆盖，无需单列索引。
  })

  ctx.model.extend('mtproto_image_storage', {
    id: 'string', platformId: 'string', platformSessionId: 'string', messageId: 'unsigned',
    platformMediaId: 'text', isPreview: { type: 'boolean', initial: false },
    conversationId: 'text', conversationTitle: 'text', date: 'string',
    timestamp: 'integer', media: 'json', state: 'string',
    bytes: { type: 'decimal', precision: 20, scale: 0 },
  }, {
    primary: 'id',
    indexes: [
      ['platformSessionId', 'messageId'], ['platformSessionId', 'state'],
      ['platformSessionId', 'conversationId', 'date'], ['date', 'state'],
    ],
  })

  ctx.model.extend('mtproto_tl_message_part', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned',
    messageId: 'unsigned', mediaId: { type: 'unsigned', nullable: true }, scope: 'string',
    tlMessageId: 'unsigned', nativeSequence: { type: 'unsigned', nullable: true },
    nativeOrderKey: { type: 'string', nullable: true },
    allocationVersion: { type: 'unsigned', nullable: true },
    groupedId: { type: 'string', nullable: true }, ordinal: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    // 唯一性的语义是 (scope, tlMessageId) 这一对值；把 tlMessageId 放到首位不改变判重结果，
    // 但投影按 tlMessageId 递增写入，这样可以近似追加写，叶子页填充率从约 60% 回到 90%。
    unique: [['tlMessageId', 'scope'], ['messageId', 'ordinal']],
    indexes: [
      // 话题 id 的取法已改为按 messageId 取回首条分片后在内存比较，
      // 因此不再需要 (platformSessionId, conversationId, tlMessageId)。
      ['platformSessionId', 'tlMessageId'],
      // conversationId 全局唯一，省略前缀可避免生成的索引名超出 PostgreSQL 63 字节上限导致冲突。
      ['conversationId', 'nativeSequence'],
      ['scope', 'nativeOrderKey'],
    ],
  })

  ctx.model.extend('mtproto_id_counter', {
    scope: 'string', nextId: 'unsigned',
  }, { primary: 'scope' })

  ctx.model.extend('mtproto_message_id_epoch', {
    scope: 'string', epoch: 'integer',
  }, { primary: 'scope' })

  ctx.model.extend('mtproto_update_state', {
    platformSessionId: 'string', pts: 'unsigned', qts: 'unsigned', seq: 'unsigned', date: 'unsigned',
  }, { primary: 'platformSessionId' })

  ctx.model.extend('mtproto_channel_update_state', {
    id: 'string', platformSessionId: 'string', channelId: 'string', pts: 'unsigned', date: 'unsigned',
  }, {
    primary: 'id',
    unique: [['platformSessionId', 'channelId']],
  })

  ctx.model.extend('mtproto_sticker_recent', {
    id: 'unsigned', platformSessionId: 'string', providerId: 'string', providerStickerId: 'text',
    attached: 'boolean', useCount: 'unsigned', lastUsedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'providerId', 'providerStickerId', 'attached']],
    indexes: [['platformSessionId', 'attached', 'lastUsedAt']],
  })

  ctx.model.extend('mtproto_sticker_favorite', {
    id: 'unsigned', platformSessionId: 'string', providerId: 'string', providerStickerId: 'text',
    createdAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'providerId', 'providerStickerId']],
    indexes: [['platformSessionId', 'createdAt']],
  })

  ctx.model.extend('mtproto_reaction_recent', {
    id: 'unsigned', platformSessionId: 'string', reactionType: 'string', reactionValue: 'text',
    definitionKey: { type: 'text', nullable: true },
    lastUsedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'reactionType', 'reactionValue']],
    indexes: [['platformSessionId', 'lastUsedAt']],
  })

  ctx.model.extend('mtproto_im_message_reaction', {
    id: 'unsigned', messageId: 'unsigned', nativeReactionKey: 'text', count: 'unsigned',
    selected: 'boolean', selectedOrder: 'unsigned', recentActors: 'json', definition: 'json', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['messageId', 'nativeReactionKey']],
    // 回应查询只按 messageId 过滤，unique 的左前缀已经覆盖。
  })

  ctx.model.extend('mtproto_sticker_set_install', {
    id: 'unsigned', platformSessionId: 'string', providerId: 'string', providerPackId: 'text',
    installedAt: 'timestamp', sortOrder: 'integer', archived: 'boolean', uninstalled: 'boolean',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'providerId', 'providerPackId']],
    indexes: [['platformSessionId', 'archived', 'sortOrder']],
  })

  ctx.model.extend('mtproto_draft', {
    id: 'unsigned', platformSessionId: 'string', platformConversationId: 'text',
    topMsgId: 'unsigned', payload: 'binary', date: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformConversationId', 'topMsgId']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_notification_settings', {
    id: 'string', platformSessionId: 'string', scope: 'text', settings: 'json', updatedAt: 'timestamp',
  }, {
    primary: 'id',
    unique: [['platformSessionId', 'scope']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_blocked_peer', {
    id: 'unsigned', platformSessionId: 'string', platformUserId: 'text', blockedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformUserId']],
    indexes: [['platformSessionId', 'blockedAt']],
  })

  ctx.model.extend('mtproto_dialog_filter', {
    id: 'string', platformSessionId: 'string', filterId: 'unsigned', sortOrder: 'integer',
    payload: { type: 'json', nullable: true }, updatedAt: 'timestamp',
  }, {
    primary: 'id',
    unique: [['platformSessionId', 'filterId']],
    indexes: [['platformSessionId', 'sortOrder']],
  })

  ctx.model.extend('mtproto_dialog_folder_peer', {
    id: 'string', platformSessionId: 'string', platformConversationId: 'text',
    folderId: 'unsigned', pinnedOrder: { type: 'integer', nullable: true }, updatedAt: 'timestamp',
  }, {
    primary: 'id',
    unique: [['platformSessionId', 'platformConversationId']],
    indexes: [['platformSessionId', 'folderId'], ['platformSessionId', 'pinnedOrder']],
  })
}
