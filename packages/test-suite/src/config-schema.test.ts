import { describe, expect, it } from 'vitest'
import { Config as bridgeConfig } from '../../bridge/src/index.js'
import { Config as debugConfig } from '../../mtproto-debug/src/index.js'
import { Config as mtprotoConfig } from '../../mtproto/src/index.js'
import { Config as qqntConfig } from '../../platform-crossgram/src/index.js'
import { Config as discordConfig } from '../../platform-discord/src/index.js'
import { Config as matrixConfig } from '../../platform-matrix/src/index.js'
import { Config as staticConfig } from '../../platform-static/src/index.js'
import { Config as satoriConfig } from '../../platform-satori/src/index.js'
import { Config as resourcesConfig } from '../../telegram-resources/src/index.js'

const cases = [
  ['bridge', bridgeConfig, [
    'dcId', 'serverHost', 'serverPort', 'apiPrefix', 'uploadPath', 'autoMuteGroupChats',
    'blockedContentMode', 'satori',
    'voiceWorkerSocketPath', 'voiceWorkerTimeoutMs', 'voiceDirectIce',
  ]],
  ['debug', debugConfig, ['maxEvents', 'initiallyPaused', 'apiPath']],
  ['mtproto', mtprotoConfig, ['port', 'host', 'rsaKeyPath', 'authKeyStorePath']],
  ['qqnt', qqntConfig, [
    'endpoint', 'webSocketEndpoint', 'token', 'memberName', 'grayTipFilters',
    'generatePreviews', 'previewConcurrency',
  ]],
  ['discord', discordConfig, ['token', 'includeBots', 'proxy', 'downloadChunkSize']],
  ['matrix', matrixConfig, ['homeserver', 'accessToken', 'userId', 'proxy', 'syncTimeoutMs', 'requestTimeoutMs']],
  ['static', staticConfig, ['instanceId', 'mediaPath', 'transferChunkSize', 'eventIntervalMs', 'historySize']],
  ['satori', satoriConfig, ['bot']],
  ['resources', resourcesConfig, ['assetsPath', 'providerId']],
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
    expect(bridgeConfig({})).not.toHaveProperty('satori')
    expect(bridgeConfig({ satori: { platformId: 'qqnt', platform: 'qq' } }).satori).toEqual({
      platformId: 'qqnt',
      platform: 'qq',
      maxMediaBytes: 8 * 1024 * 1024,
    })
    expect(bridgeConfig({})).toEqual({
      dcId: 1,
      serverHost: '127.0.0.1',
      serverPort: 4430,
      apiPrefix: '/api',
      uploadPath: 'data/bridge-uploads',
      autoMuteGroupChats: true,
      blockedContentMode: 'hide-user',
      voiceWorkerSocketPath: '',
      voiceWorkerTimeoutMs: 5_000,
      voiceDirectIce: true,
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
  })

  it('rejects invalid values at the field path', () => {
    expect(() => bridgeConfig({ serverPort: 65_536 })).toThrow(/serverPort/)
    expect(() => qqntConfig({ memberName: 'invalid' as any })).toThrow(/memberName/)
    expect(() => qqntConfig({ previewConcurrency: 0 })).toThrow(/previewConcurrency/)
    expect(() => discordConfig({ token: 'user-token', downloadChunkSize: 0 })).toThrow(/downloadChunkSize/)
    expect(() => matrixConfig({
      homeserver: 'https://matrix.example.org', accessToken: 'token', syncTimeoutMs: 0,
    })).toThrow(/syncTimeoutMs/)
    expect(() => staticConfig({ transferChunkSize: 0 })).toThrow(/transferChunkSize/)
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
})
