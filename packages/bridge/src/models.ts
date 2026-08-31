import type { Context } from 'cordis'
import type {
  IMConversationKind, IMMediaKind, JsonObject, JsonValue,
} from './platform.js'

export interface AuthSessionRow {
  id: string
  virtualPhone: string
  totpSecret: string
  platformId: string
  platformSessionId: string
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
  createdAt: Date
  updatedAt: Date
}

/** Canonical platform request, deliberately independent from its inbox projection message. */
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

/** Bridge-owned Telegram unread-mention state for one logical platform message. */
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
  /** Persisted tombstone for provider packs removed from Telegram's installed catalog. */
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

/** Register all bridge models. The project is pre-release, so these are the canonical schemas. */
export function defineModels(ctx: Context): void {
  ctx.model.extend('mtproto_auth_session', {
    id: 'string', virtualPhone: 'string', totpSecret: 'string', platformId: 'string',
    platformSessionId: 'string',
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
    createdAt: 'timestamp', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'conversationId', 'primaryPlatformMessageId']],
    indexes: [['conversationId', 'timestamp'], 'senderUserId'],
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
    unique: [['platformSessionId', 'conversationId', 'platformMessageId']],
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
    // QQNT file sizes can exceed PostgreSQL int4 (for example a 2.77 GB zip).
    // Keep the value lossless as a scale-zero numeric while retaining the
    // number-shaped API exposed by IMMediaRow and Telegram projections.
    size: { type: 'decimal', precision: 20, scale: 0, nullable: true }, width: { type: 'unsigned', nullable: true },
    height: { type: 'unsigned', nullable: true }, duration: { type: 'unsigned', nullable: true }, voice: 'boolean',
    preview: { type: 'json', nullable: true },
    strippedThumbnail: { type: 'binary', nullable: true }, locator: 'json',
  }, {
    primary: 'id', autoInc: true,
    unique: [['messageId', 'ordinal', 'platformMediaId']],
    indexes: ['messageId'],
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
    unique: [['scope', 'tlMessageId'], ['messageId', 'ordinal']],
    indexes: [
      'messageId',
      ['platformSessionId', 'tlMessageId'],
      ['platformSessionId', 'conversationId', 'tlMessageId'],
      ['platformSessionId', 'conversationId', 'nativeSequence'],
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
    indexes: ['messageId'],
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
    folderId: 'unsigned', updatedAt: 'timestamp',
  }, {
    primary: 'id',
    unique: [['platformSessionId', 'platformConversationId']],
    indexes: [['platformSessionId', 'folderId']],
  })
}
