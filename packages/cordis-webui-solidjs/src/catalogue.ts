/** Backend packages retain their service/RPC contracts, never their Vue assets. */
export const builtinClients: Record<string, string> = {
  '@cordisjs/plugin-loader-webui': 'loader',
  '@cordisjs/plugin-market': 'market',
  '@cordisjs/plugin-logger-webui': 'logs',
  '@cordisjs/plugin-notifier': 'notifications',
  '@cordisjs/plugin-database-webui': 'database',
  '@cordisjs/plugin-http-webui': 'http',
  '@cordisjs/plugin-server-webui': 'server',
  '@cordisjs/plugin-insight': 'insight',
  '@cordisjs/plugin-webui-sso': 'sso',
  '@mtproto-relay/bridge': 'bridge',
  '@mtproto-relay/mtproto-debug': 'debug',
  '@mtproto-relay/mtproto-statistics': 'statistics',
}
