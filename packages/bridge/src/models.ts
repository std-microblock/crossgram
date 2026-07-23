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

export interface RouteBindingRow {
  authKeyId: string
  routeId: string
  createdAt: Date
}

export interface IMConversationRow {
  id: number
  platformSessionId: string
  platformConversationId: string
  kind: IMConversationKind
  title: string
  parentPlatformConversationId: string | null
  spacePlatformId: string | null
  metadata: JsonObject
  unreadCount: number
  updatedAt: Date
}

export interface IMUserRow {
  id: number
  platformSessionId: string
  platformUserId: string
  firstName: string
  lastName: string | null
  username: string | null
  metadata: JsonObject
  updatedAt: Date
}

export interface IMMessageRow {
  id: number
  platformSessionId: string
  conversationId: number
  primaryPlatformMessageId: string
  senderPlatformUserId: string
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

export interface IMMessageAliasRow {
  id: number
  platformSessionId: string
  conversationId: number
  platformMessageId: string
  messageId: number
  ordinal: number
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
  groupedId: string | null
  ordinal: number
}

export interface IdCounterRow {
  scope: string
  nextId: number
}

export interface UpdateStateRow {
  platformSessionId: string
  pts: number
  qts: number
  seq: number
  date: number
}

export interface UpdateDeliveryRow {
  messageId: number
  eventKey: string
  platformSessionId: string
  pts: number
  ptsCount: number
  seq: number
  date: number
  published: boolean
  payload: string
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

export interface IMMessageReactionRow {
  id: number
  messageId: number
  nativeReactionKey: string
  count: number
  selected: boolean
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
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_auth_session: AuthSessionRow
    mtproto_platform_session: PlatformSessionRow
    mtproto_auth_binding: AuthBindingRow
    mtproto_route_binding: RouteBindingRow
    mtproto_im_conversation: IMConversationRow
    mtproto_im_user: IMUserRow
    mtproto_im_message: IMMessageRow
    mtproto_im_message_alias: IMMessageAliasRow
    mtproto_im_media: IMMediaRow
    mtproto_tl_message_part: TlMessagePartRow
    mtproto_id_counter: IdCounterRow
    mtproto_update_state: UpdateStateRow
    mtproto_update_delivery: UpdateDeliveryRow
    mtproto_sticker_recent: StickerRecentRow
    mtproto_sticker_favorite: StickerFavoriteRow
    mtproto_im_message_reaction: IMMessageReactionRow
    mtproto_sticker_set_install: StickerSetInstallRow
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

  ctx.model.extend('mtproto_route_binding', {
    authKeyId: 'string', routeId: 'string', createdAt: 'timestamp',
  }, { primary: 'authKeyId' })

  ctx.model.extend('mtproto_im_conversation', {
    id: 'unsigned', platformSessionId: 'string', platformConversationId: 'text', kind: 'string', title: 'text',
    parentPlatformConversationId: { type: 'text', nullable: true },
    spacePlatformId: { type: 'text', nullable: true }, metadata: 'json', updatedAt: 'timestamp',
    unreadCount: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformConversationId']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_im_user', {
    id: 'unsigned', platformSessionId: 'string', platformUserId: 'text', firstName: 'text',
    lastName: { type: 'text', nullable: true }, username: { type: 'text', nullable: true },
    metadata: 'json', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'platformUserId']],
    indexes: ['platformSessionId'],
  })

  ctx.model.extend('mtproto_im_message', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned',
    primaryPlatformMessageId: 'text', senderPlatformUserId: 'text', text: 'text', content: 'json', timestamp: 'integer',
    outgoing: 'boolean', deleted: 'boolean', platformGroupId: { type: 'text', nullable: true }, metadata: 'json',
    createdAt: 'timestamp', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'conversationId', 'primaryPlatformMessageId']],
    indexes: [['conversationId', 'timestamp']],
  })

  ctx.model.extend('mtproto_im_message_alias', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned', platformMessageId: 'text',
    messageId: 'unsigned', ordinal: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'conversationId', 'platformMessageId']],
    indexes: ['messageId'],
  })

  ctx.model.extend('mtproto_im_media', {
    id: 'unsigned', messageId: 'unsigned', ordinal: 'unsigned', partIndex: 'unsigned', platformMediaId: 'text',
    kind: 'string', name: { type: 'text', nullable: true }, mimeType: { type: 'text', nullable: true },
    size: { type: 'unsigned', nullable: true }, width: { type: 'unsigned', nullable: true },
    height: { type: 'unsigned', nullable: true }, locator: 'json',
  }, {
    primary: 'id', autoInc: true,
    unique: [['messageId', 'ordinal']],
    indexes: ['messageId'],
  })

  ctx.model.extend('mtproto_tl_message_part', {
    id: 'unsigned', platformSessionId: 'string', conversationId: 'unsigned',
    messageId: 'unsigned', mediaId: { type: 'unsigned', nullable: true }, scope: 'string',
    tlMessageId: 'unsigned', groupedId: { type: 'string', nullable: true }, ordinal: 'unsigned',
  }, {
    primary: 'id', autoInc: true,
    unique: [['scope', 'tlMessageId'], ['messageId', 'ordinal']],
    indexes: ['messageId', ['platformSessionId', 'conversationId', 'tlMessageId']],
  })

  ctx.model.extend('mtproto_id_counter', {
    scope: 'string', nextId: 'unsigned',
  }, { primary: 'scope' })

  ctx.model.extend('mtproto_update_state', {
    platformSessionId: 'string', pts: 'unsigned', qts: 'unsigned', seq: 'unsigned', date: 'unsigned',
  }, { primary: 'platformSessionId' })

  ctx.model.extend('mtproto_update_delivery', {
    messageId: 'unsigned', eventKey: 'text', platformSessionId: 'string', pts: 'unsigned', ptsCount: 'unsigned',
    seq: 'unsigned', date: 'unsigned', published: 'boolean', payload: 'text',
  }, {
    primary: 'messageId', autoInc: true,
    unique: ['eventKey'],
    indexes: [
      ['platformSessionId', 'published', 'pts'],
      ['platformSessionId', 'pts'],
    ],
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

  ctx.model.extend('mtproto_im_message_reaction', {
    id: 'unsigned', messageId: 'unsigned', nativeReactionKey: 'text', count: 'unsigned',
    selected: 'boolean', recentActors: 'json', definition: 'json', updatedAt: 'timestamp',
  }, {
    primary: 'id', autoInc: true,
    unique: [['messageId', 'nativeReactionKey']],
    indexes: ['messageId'],
  })

  ctx.model.extend('mtproto_sticker_set_install', {
    id: 'unsigned', platformSessionId: 'string', providerId: 'string', providerPackId: 'text',
    installedAt: 'timestamp', sortOrder: 'integer', archived: 'boolean',
  }, {
    primary: 'id', autoInc: true,
    unique: [['platformSessionId', 'providerId', 'providerPackId']],
    indexes: [['platformSessionId', 'archived', 'sortOrder']],
  })
}
