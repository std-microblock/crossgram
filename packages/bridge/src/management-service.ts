import { Service, type Context } from 'cordis'
import type { CrossGramServerConfig, PlatformAccountView } from './account-dashboard.js'
import type { PlatformSession } from './platform.js'
import type { StickerDashboardAccount, StickerDashboardPack } from './sticker-dashboard.js'

export interface BridgeManagementRuntimeStatus {
  generatedAt: number
  uptimeSeconds: number
  memory: {
    rssBytes: number
    heapUsedBytes: number
    heapTotalBytes: number
    externalBytes: number
  }
  mtproto: {
    host: string
    port: number
    activeConnections: number
    authorizedConnections: number
  }
  platforms: {
    registered: string[]
    activeSessions: number
  }
  storage: {
    platformSessions: number
    activePlatformSessions: number
    identities: number
    authBindings: number
    clientAuthorizations: number
  }
}

export interface BridgeManagementIdentity {
  platformId: string
  platformSessionId: string
  userId: string
  active: boolean
  createdAt: number
  virtualPhone?: string
  loginCode?: string
  loginCodeValidUntil?: number
  authBindingCount: number
  clientAuthorizationCount: number
}

export interface BridgeManagementClientAuthorization {
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

export interface BridgeManagementStickerSnapshot {
  accounts: StickerDashboardAccount[]
  packs: StickerDashboardPack[]
  updatedAt: number
}

export type BridgeManagementErrorCode =
  | 'AUTH_TOKEN_INVALID'
  | 'PLATFORM_ACCOUNT_UNAVAILABLE'
  | 'STICKER_PACK_NOT_FOUND'
  | 'STICKER_ACCOUNT_NOT_FOUND'
  | 'STICKER_ASSIGNMENT_AUTOMATIC'

export class BridgeManagementError extends Error {
  constructor(readonly code: BridgeManagementErrorCode, message: string = code) {
    super(message)
    this.name = 'BridgeManagementError'
  }
}

export interface BridgeManagementSource {
  serverConfig(): CrossGramServerConfig
  accounts(now?: number): PlatformAccountView[]
  registeredPlatformIds(): string[]
  activeSessions(): PlatformSession[]
  refresh(): Promise<void>
  approveLoginToken(platformId: string, token: string): void
  stickers(): BridgeManagementStickerSnapshot
  refreshStickers(): Promise<void>
  setStickerPackAssigned(
    platformSessionId: string,
    providerId: string,
    packId: string,
    assigned: boolean,
  ): Promise<void>
}

/**
 * Stable, provider-neutral management seam shared by the WebUI and optional
 * in-client administration surfaces. Secrets such as platform credentials,
 * TOTP seeds and raw auth keys never leave this service.
 */
export class BridgeManagementService extends Service {
  constructor(ctx: Context, private readonly _source: BridgeManagementSource) {
    super(ctx, 'bridgeManagement')
  }

  async status(): Promise<BridgeManagementRuntimeStatus> {
    await this.ctx.database.prepared()
    const [platformSessions, identities, bindings, clients] = await Promise.all([
      this.ctx.database.get('mtproto_platform_session', {}),
      this.ctx.database.get('mtproto_auth_session', {}),
      this.ctx.database.get('mtproto_auth_binding', {}),
      this.ctx.database.get('mtproto_client_authorization', {}),
    ])
    const memory = process.memoryUsage()
    return {
      generatedAt: Date.now(),
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      mtproto: {
        host: this.ctx.mtproto.config.host ?? '127.0.0.1',
        port: this.ctx.mtproto.port,
        activeConnections: this.ctx.mtproto.activeConnectionCount,
        authorizedConnections: this.ctx.mtproto.authorizedConnectionCount,
      },
      platforms: {
        registered: this._source.registeredPlatformIds().sort(),
        activeSessions: this._source.activeSessions().length,
      },
      storage: {
        platformSessions: platformSessions.length,
        activePlatformSessions: platformSessions.filter(row => row.active).length,
        identities: identities.length,
        authBindings: bindings.length,
        clientAuthorizations: clients.length,
      },
    }
  }

  serverConfig(): CrossGramServerConfig {
    const config = this._source.serverConfig()
    return { ...config, dcs: config.dcs.map(dc => ({ ...dc })) }
  }

  accounts(platformSessionId?: string): PlatformAccountView[] {
    const accounts = this._source.accounts().map(account => ({ ...account }))
    if (!platformSessionId) return accounts
    const session = this._source.activeSessions().find(item => item.platformSessionId === platformSessionId)
    return session ? accounts.filter(account => account.platformId === session.platformId) : []
  }

  async identities(platformSessionId?: string): Promise<BridgeManagementIdentity[]> {
    await this.ctx.database.prepared()
    const sessionQuery = platformSessionId ? { id: platformSessionId } : {}
    const relatedQuery = platformSessionId ? { platformSessionId } : {}
    const [sessions, identities, bindings, clients] = await Promise.all([
      this.ctx.database.get('mtproto_platform_session', sessionQuery),
      this.ctx.database.get('mtproto_auth_session', relatedQuery),
      this.ctx.database.get('mtproto_auth_binding', relatedQuery),
      this.ctx.database.get('mtproto_client_authorization', relatedQuery),
    ])
    const identityBySession = new Map(identities.map(identity => [identity.platformSessionId, identity]))
    const accountBySession = new Map(this._source.accounts().flatMap((account) => {
      const session = this._source.activeSessions().find(item => item.platformId === account.platformId)
      return session ? [[session.platformSessionId, account] as const] : []
    }))
    return sessions
      .map((session): BridgeManagementIdentity => {
        const identity = identityBySession.get(session.id)
        const account = accountBySession.get(session.id)
        return {
          platformId: session.platformId,
          platformSessionId: session.id,
          userId: session.userId,
          active: session.active,
          createdAt: session.createdAt.getTime(),
          virtualPhone: identity ? `+${identity.virtualPhone}` : undefined,
          loginCode: account?.loginCode,
          loginCodeValidUntil: account?.validUntil,
          authBindingCount: bindings.filter(binding => binding.platformSessionId === session.id).length,
          clientAuthorizationCount: clients.filter(client => client.platformSessionId === session.id).length,
        }
      })
      .sort((left, right) => left.platformId.localeCompare(right.platformId)
        || left.platformSessionId.localeCompare(right.platformSessionId))
  }

  async clientAuthorizations(platformSessionId?: string): Promise<BridgeManagementClientAuthorization[]> {
    await this.ctx.database.prepared()
    const rows = await this.ctx.database.get('mtproto_client_authorization', platformSessionId
      ? { platformSessionId }
      : {})
    return rows
      .map(row => ({ ...row }))
      .sort((left, right) => right.dateActive - left.dateActive || left.authKeyId.localeCompare(right.authKeyId))
  }

  async refresh(): Promise<void> {
    await this._source.refresh()
  }

  approveLoginToken(platformId: string, token: string): void {
    this._source.approveLoginToken(platformId, token)
  }

  stickers(platformSessionId?: string): BridgeManagementStickerSnapshot {
    const snapshot = this._source.stickers()
    const accounts = snapshot.accounts
      .filter(account => !platformSessionId || account.platformSessionId === platformSessionId)
      .map(account => ({ ...account }))
    const accountIds = new Set(accounts.map(account => account.platformSessionId))
    return {
      accounts,
      packs: snapshot.packs.map(pack => ({
        ...pack,
        assignments: pack.assignments
          .filter(assignment => !platformSessionId || accountIds.has(assignment.platformSessionId))
          .map(assignment => ({ ...assignment })),
      })),
      updatedAt: snapshot.updatedAt,
    }
  }

  async refreshStickers(): Promise<void> {
    await this._source.refreshStickers()
  }

  async setStickerPackAssigned(
    platformSessionId: string,
    providerId: string,
    packId: string,
    assigned: boolean,
  ): Promise<void> {
    await this._source.setStickerPackAssigned(platformSessionId, providerId, packId, assigned)
  }
}
