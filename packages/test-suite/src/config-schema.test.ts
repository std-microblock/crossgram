import { describe, expect, it } from 'vitest'
import { Config as bridgeConfig } from '../../bridge/src/index.js'
import { Config as debugConfig } from '../../mtproto-debug/src/index.js'
import { Config as mtprotoConfig } from '../../mtproto/src/index.js'
import { Config as statisticsConfig } from '../../mtproto-statistics/src/index.js'
import { Config as adminBotConfig } from '../../platform-admin-bot/src/index.js'
import { Config as qqntConfig } from '../../platform-crossgram/src/index.js'
import { Config as discordConfig } from '../../platform-discord/src/index.js'
import { Config as matrixConfig } from '../../platform-matrix/src/index.js'
import { Config as staticConfig } from '../../platform-static/src/index.js'
import { Config as satoriConfig } from '../../platform-satori/src/index.js'
import { Config as exporterConfig } from '../../satori-exporter/src/index.js'
import { Config as flashTransferConfig } from '../../qq-flash-transfer-bot/src/index.js'
import { Config as botApiConfig } from '../../telegram-bot-api/src/index.js'
import { Config as resourcesConfig } from '../../telegram-resources/src/index.js'
import { Config as stickerImporterConfig } from '../../telegram-sticker-importer/src/index.js'
import { Config as databaseUpdateStoreConfig } from '../../update-store-database/src/index.js'
import { Config as memoryUpdateStoreConfig } from '../../update-store-memory/src/index.js'

const cases = [
  ['bridge', bridgeConfig, [
    'dcId', 'serverHost', 'serverPort', 'altEndpoints', 'apiPrefix', 'uploadPath', 'autoMuteGroupChats',
    'blockedContentMode', 'voiceWorkerSocketPath', 'voiceWorkerTimeoutMs', 'voiceDirectIce',
    'voiceTurnHost', 'voiceTurnPort', 'voiceTurnSharedSecret', 'voiceTurnTtlSeconds',
  ]],
  ['debug', debugConfig, ['maxEvents', 'initiallyPaused', 'apiPath']],
  ['mtproto', mtprotoConfig, ['port', 'host', 'rsaKeyPath', 'authKeyStorePath']],
  ['mtproto-statistics', statisticsConfig, [
    'sampleIntervalMs', 'slowThresholdMs', 'historySeconds', 'topMethods', 'topIps',
  ]],
  ['platform-admin-bot', adminBotConfig, [
    'allowedPlatformSessionIds', 'crossAccountAccess', 'showLoginCodes', 'webuiUrl', 'pageSize',
  ]],
  ['qqnt', qqntConfig, [
    'endpoint', 'webSocketEndpoint', 'token', 'grayTipFilters',
    'generatePreviews', 'previewConcurrency',
  ]],
  ['discord', discordConfig, ['token', 'includeBots', 'proxy', 'downloadChunkSize']],
  ['matrix', matrixConfig, ['homeserver', 'accessToken', 'userId', 'proxy', 'syncTimeoutMs', 'requestTimeoutMs']],
  ['static', staticConfig, ['instanceId', 'mediaPath', 'transferChunkSize', 'eventIntervalMs', 'historySize']],
  ['satori', satoriConfig, ['bot']],
  ['satori-exporter', exporterConfig, ['platformId', 'platform', 'maxMediaBytes']],
  ['qq-flash-transfer-bot', flashTransferConfig, ['maxFiles', 'maxTotalBytes']],
  ['telegram-bot-api', botApiConfig, ['verifierSecret']],
  ['resources', resourcesConfig, ['assetsPath', 'providerId']],
  ['telegram-sticker-importer', stickerImporterConfig, [
    'botToken', 'apiBase', 'maxImportsPerSession', 'importCooldownMs',
  ]],
  ['update-store-database', databaseUpdateStoreConfig, ['retention']],
  ['update-store-memory', memoryUpdateStoreConfig, ['retention']],
] as const

describe('plugin config schemas', () => {
  it.each(cases)('%s exposes every editable field with WebUI metadata', (_name, schema, fields) => {
    const json = schema.toJSON()
    const root = json.refs[json.uid]
    expect(root.type).toBe('object')
    const visibleFields = Object.keys(root.dict ?? {})
    expect(visibleFields).toEqual(fields)
    for (const uid of Object.values(root.dict ?? {})) {
      expect(json.refs[uid as unknown as number].meta.description).toBeTruthy()
    }
  })

  it('applies defaults without dropping programmatic injection options', () => {
    expect(mtprotoConfig({ crypto: 'injected-for-test' })).toMatchObject({
      port: 4430,
      host: '127.0.0.1',
      crypto: 'injected-for-test',
    })
    expect(bridgeConfig({})).toEqual({
      dcId: 1,
      serverHost: '127.0.0.1',
      serverPort: 4430,
      altEndpoints: [],
      apiPrefix: '/api',
      uploadPath: 'data/bridge-uploads',
      autoMuteGroupChats: true,
      blockedContentMode: 'hide-user',
      voiceWorkerSocketPath: '',
      voiceWorkerTimeoutMs: 5_000,
      voiceDirectIce: true,
      voiceTurnHost: '',
      voiceTurnPort: 3478,
      voiceTurnSharedSecret: '',
      voiceTurnTtlSeconds: 3_600,
    })
    expect(exporterConfig({ platformId: 'qqnt', platform: 'qq' })).toEqual({
      platformId: 'qqnt',
      platform: 'qq',
      maxMediaBytes: 8 * 1024 * 1024,
    })
    expect(debugConfig({})).toEqual({
      maxEvents: 2_000,
      initiallyPaused: false,
      apiPath: '/api/mtproto-debug/events',
    })
    expect(qqntConfig({})).toMatchObject({
      grayTipFilters: ['回应了你的消息'],
      generatePreviews: false,
      previewConcurrency: 2,
    })
    expect(discordConfig({ token: 'user-token' })).toMatchObject({
      token: 'user-token', includeBots: true, downloadChunkSize: 256 * 1024,
    })
    expect(statisticsConfig({})).toEqual({
      sampleIntervalMs: 1_000,
      slowThresholdMs: 1_000,
      historySeconds: 900,
      topMethods: 40,
      topIps: 100,
    })
    expect(databaseUpdateStoreConfig({})).toEqual({ retention: 10_000 })
    expect(memoryUpdateStoreConfig({})).toEqual({ retention: 1_000 })
  })

  it('validates and normalizes alternate bridge endpoints', () => {
    expect(bridgeConfig({ altEndpoints: [
      'bridge-backup.example:8443',
      '203.0.113.10:4430',
      '[2001:db8::1]:4430',
    ] }).altEndpoints).toEqual([
      'bridge-backup.example:8443',
      '203.0.113.10:4430',
      '[2001:db8::1]:4430',
    ])
    for (const endpoint of [
      'bridge-backup.example',
      'bridge-backup.example:0',
      'bridge-backup.example:65536',
      '2001:db8::1:4430',
      { host: 'bridge-backup.example', port: 8443 },
    ]) {
      expect(() => bridgeConfig({ altEndpoints: [endpoint] as any })).toThrow(/altEndpoints/)
    }
  })

  it('rejects invalid values at the field path', () => {
    expect(() => bridgeConfig({ serverPort: 65_536 })).toThrow(/serverPort/)
    expect(() => qqntConfig({ previewConcurrency: 0 })).toThrow(/previewConcurrency/)
    expect(() => discordConfig({ token: 'user-token', downloadChunkSize: 0 })).toThrow(/downloadChunkSize/)
    expect(() => matrixConfig({
      homeserver: 'https://matrix.example.org', accessToken: 'token', syncTimeoutMs: 0,
    })).toThrow(/syncTimeoutMs/)
    expect(() => staticConfig({ transferChunkSize: 0 })).toThrow(/transferChunkSize/)
    expect(() => exporterConfig({ platformId: undefined as unknown as string })).toThrow(/platformId/)
    expect(() => exporterConfig({ platformId: 'qqnt', maxMediaBytes: 0 })).toThrow(/maxMediaBytes/)
    expect(() => statisticsConfig({ sampleIntervalMs: 499 })).toThrow(/sampleIntervalMs/)
    expect(() => flashTransferConfig({ maxFiles: 101 })).toThrow(/maxFiles/)
    expect(() => stickerImporterConfig({ botToken: 'token', importCooldownMs: 60_001 })).toThrow(/importCooldownMs/)
    expect(() => databaseUpdateStoreConfig({ retention: 1_000_001 })).toThrow(/retention/)
  })

  it('requires Matrix connection credentials and hides its access token', () => {
    expect(() => matrixConfig({})).toThrow(/homeserver/)
    const json = matrixConfig.toJSON()
    const root = json.refs[json.uid]
    const homeserver = json.refs[root.dict!.homeserver as unknown as number]
    const accessToken = json.refs[root.dict!.accessToken as unknown as number]
    const proxy = json.refs[root.dict!.proxy as unknown as number]
    expect(homeserver.meta.required).toBe(true)
    expect(accessToken.meta.required).toBe(true)
    expect(accessToken.meta.role).toBe('secret')
    expect(proxy.meta.role).toBe('secret')
  })

  it('requires and masks the Discord user token', () => {
    expect(() => discordConfig({})).toThrow(/token/)
    const json = discordConfig.toJSON()
    const root = json.refs[json.uid]
    const token = json.refs[root.dict!.token as unknown as number]
    expect(token.meta.required).toBe(true)
    expect(token.meta.role).toBe('secret')
  })

  it('requires and masks bot credentials', () => {
    expect(() => botApiConfig({} as never)).toThrow(/verifierSecret/)
    expect(() => stickerImporterConfig({} as never)).toThrow(/botToken/)
    for (const [schema, field] of [
      [botApiConfig, 'verifierSecret'],
      [stickerImporterConfig, 'botToken'],
    ] as const) {
      const json = schema.toJSON()
      const root = json.refs[json.uid]
      const credential = json.refs[root.dict![field] as unknown as number]
      expect(credential.meta.required).toBe(true)
      expect(credential.meta.role).toBe('secret')
    }
  })
})
