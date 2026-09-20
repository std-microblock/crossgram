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
  error?: string
}

export interface CrossGramServerConfigDc {
  id: number
  ip: string
  port: number
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
  loginTokenApprovalUrl: string
  updatedAt: number
  refresh(): Promise<void>
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
