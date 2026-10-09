/** Browser-safe dashboard wire contracts; this module has no server imports. */
export type PlatformAccountStatus = 'ready' | 'loading' | 'error' | 'unsupported'

export interface PlatformAccountView {
  platformId: string
  platformKind: string
  status: PlatformAccountStatus
  displayName?: string
  firstName?: string
  lastName?: string
  username?: string
  userId?: string
  avatarUrl?: string
  virtualPhone?: string
  loginCode?: string
  validUntil?: number
  remainingSeconds?: number
  /** Whether an optional two-step verification password is configured. */
  hasPassword?: boolean
  error?: string
}

export interface CrossGramServerConfigDc {
  id: number
  ip: string
  port: number
}

/** One `host:port` a copied server configuration can point at. */
export interface PlatformAccountServerEndpoint {
  host: string
  port: number
  /** The endpoint the bridge advertises first; also the default selection for a copy. */
  primary: boolean
}

/** One platform entry that describes the same platform account as another entry. */
export interface PlatformAccountDuplicateGroup {
  /** Entry that keeps the account. */
  keep: string
  /** Entries that duplicate `keep`. */
  remove: string[]
  /**
   * `identity`: both entries resolve to the same platform user.
   * `virtual-phone`: the entry lost its deterministic virtual phone to `keep`.
   */
  reason: 'identity' | 'virtual-phone'
}

/** What deleting one platform entry removes, resolved before the confirmation. */
export interface PlatformAccountRemovalTarget {
  platformId: string
  platformKind: string
  displayName?: string
  /** Telegram clients signed in through the entry; deleting it signs them out. */
  clientAuthorizations: number
  /** Whether the Cordis loader owns the entry, so the bridge can delete it. */
  managed: boolean
}

export interface PlatformAccountRemovalPreview {
  targets: PlatformAccountRemovalTarget[]
  /** Sum of `targets[].clientAuthorizations`. */
  clientAuthorizations: number
}

export interface CrossGramServerConfig {
  name: 'CrossGram'
  enable_special_config: false
  host: string
  port: number
  rsa_key: string
  dcs: CrossGramServerConfigDc[]
}

export interface PlatformAccountDashboardData {
  accounts: PlatformAccountView[]
  serverConfig: CrossGramServerConfig
  /** Endpoints `serverConfig` can be copied for; the primary entry comes first. */
  serverEndpoints: PlatformAccountServerEndpoint[]
  loginTokenApprovalUrl: string
  updatedAt: number
  refresh(): Promise<void>
  /** Set, replace, or clear (null/empty) the two-step verification password. */
  setLoginPassword(platformId: string, password: string | null): Promise<void>
  /** Platform entries that describe the same platform account as another entry. */
  findDuplicateAccounts(): Promise<PlatformAccountDuplicateGroup[]>
  /** Resolve what deleting these entries would remove, before the confirmation. */
  describeAccountRemoval(
    platformIds: string[],
  ): Promise<PlatformAccountRemovalPreview>
  /** Delete platform entries together with every login credential they own. */
  deleteAccounts(platformIds: string[]): Promise<void>
}

export interface StickerDashboardAccount {
  platformId: string
  platformSessionId: string
  platformKind: string
  displayName: string
  username?: string
  userId: string
}

export interface StickerDashboardAssignment {
  platformSessionId: string
  assigned: boolean
  automatic: boolean
}

export interface StickerDashboardPack {
  providerId: string
  packId: string
  title: string
  count?: number
  version?: number
  sourcePlatformId?: string
  sourcePlatformSessionId?: string
  assignments: StickerDashboardAssignment[]
}

export interface StickerPackDashboardData {
  stickerAccounts: StickerDashboardAccount[]
  stickerPacks: StickerDashboardPack[]
  stickerUpdatedAt: number
  refreshStickerPacks(): Promise<void>
  setStickerPackAssigned(
    platformSessionId: string,
    providerId: string,
    packId: string,
    assigned: boolean,
  ): Promise<void>
}

/** A bridge-owned bot that can be opened through a Telegram `t.me` link. */
export interface SystemBot {
  /** The conversation ID that the provider resolves for this bot. */
  conversationId: string
  /** Display name exposed to the WebUI and Telegram clients. */
  title: string
  /** Globally unique Telegram-style username, without `@`. */
  username: string
  /** Cordis package which registered the bot. */
  sourcePlugin: string
}

export interface BotDashboardData {
  bots: SystemBot[]
  botUpdatedAt: number
  refreshBots(): Promise<void>
}

export type BridgeDashboardData = PlatformAccountDashboardData & StickerPackDashboardData & BotDashboardData
