import type { SystemBot } from './system-peer.js'

/** Reactive WebUI data for all bridge-owned Telegram-style bots. */
export interface BotDashboardData {
  bots: SystemBot[]
  botUpdatedAt: number
  refreshBots(): Promise<void>
}
