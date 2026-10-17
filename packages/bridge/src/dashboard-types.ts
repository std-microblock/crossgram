/** 供浏览器端直接引用的管理面板数据类型（无服务端依赖）。 */
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
  hasPassword?: boolean
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
  setLoginPassword(platformId: string, password: string | null): Promise<void>
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

export interface SystemBot {
  conversationId: string
  title: string
  /** 不带 `@` 的 Telegram 用户名。 */
  username: string
  sourcePlugin: string
}

export interface BotDashboardData {
  bots: SystemBot[]
  botUpdatedAt: number
  refreshBots(): Promise<void>
}

export interface ImageStorageFilter {
  platformSessionId?: string
  conversationId?: string
  startDate?: string
  endDate?: string
}

export interface ImageStorageQuery extends ImageStorageFilter {
  groupBy?: 'conversation' | 'date'
  /** 从 1 开始，默认 1。 */
  page?: number
  /** 默认 50，最大 100。 */
  pageSize?: number
}

export interface ImageStorageGroup {
  platformSessionId: string
  conversationId?: string
  conversationTitle?: string
  date?: string
  count: number
  bytes: number
}

export interface ImageStorageResult {
  count: number
  bytes: number
  pendingCount: number
  groups: ImageStorageGroup[]
  totalGroups: number
  page: number
  pageSize: number
}

export interface ImageStorageDashboardData {
  imageStorageEnabled: boolean
  getImageStorage(query: ImageStorageQuery, token?: string): Promise<ImageStorageResult>
  deleteImageStorage(filter: ImageStorageFilter, token?: string): Promise<{ count: number, bytes: number }>
}

export type BridgeDashboardData = PlatformAccountDashboardData & StickerPackDashboardData & BotDashboardData & ImageStorageDashboardData
