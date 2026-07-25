import { describe, expect, it } from 'vitest'
import { Config as bridgeConfig } from '../../bridge/src/index.js'
import { Config as debugConfig } from '../../mtproto-debug/src/index.js'
import { Config as mtprotoConfig } from '../../mtproto/src/index.js'
import { Config as qqntConfig } from '../../platform-crossgram/src/index.js'
import { Config as discordConfig } from '../../platform-discord/src/index.js'
import { Config as matrixConfig } from '../../platform-matrix/src/index.js'
import { Config as staticConfig } from '../../platform-static/src/index.js'
import { Config as relayConfig } from '../../relay/src/index.js'
import { Config as resourcesConfig } from '../../telegram-resources/src/index.js'

const cases = [
  ['bridge', bridgeConfig, ['routeId', 'dcId', 'serverHost', 'serverPort', 'apiPrefix', 'uploadPath']],
  ['debug', debugConfig, ['maxEvents', 'initiallyPaused']],
  ['mtproto', mtprotoConfig, ['port', 'host', 'rsaKeyPath', 'authKeyStorePath']],
  ['qqnt', qqntConfig, [
    'endpoint', 'webSocketEndpoint', 'token', 'memberName', 'mediaCachePath', 'generatePreviews',
    'previewMaxDimension', 'ffmpegPath', 'grayTipFilters',
  ]],
  ['discord', discordConfig, ['token', 'includeBots', 'downloadChunkSize']],
  ['matrix', matrixConfig, ['homeserver', 'accessToken', 'userId', 'syncTimeoutMs', 'requestTimeoutMs']],
  ['static', staticConfig, ['instanceId', 'mediaPath', 'transferChunkSize', 'eventIntervalMs', 'historySize']],
  ['relay', relayConfig, ['apiId', 'apiHash', 'storagePath', 'disableUpdates', 'routeId']],
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
    const clientFactory = () => undefined
    expect(mtprotoConfig({ crypto: 'injected-for-test' })).toMatchObject({
      port: 4430,
      host: '127.0.0.1',
      crypto: 'injected-for-test',
    })
    expect(relayConfig({ apiId: 12345, apiHash: 'hash', clientFactory })).toEqual({
      apiId: 12345,
      apiHash: 'hash',
      storagePath: 'data/relay',
      disableUpdates: true,
      routeId: 'relay:official',
      clientFactory,
    })
    expect(qqntConfig({})).toMatchObject({ grayTipFilters: ['回应了你的消息'] })
    expect(discordConfig({ token: 'user-token' })).toMatchObject({
      token: 'user-token', includeBots: true, downloadChunkSize: 256 * 1024,
    })
  })

  it('rejects invalid values at the field path', () => {
    expect(() => bridgeConfig({ serverPort: 65_536 })).toThrow(/serverPort/)
    expect(() => qqntConfig({ previewMaxDimension: 0 })).toThrow(/previewMaxDimension/)
    expect(() => discordConfig({ token: 'user-token', downloadChunkSize: 0 })).toThrow(/downloadChunkSize/)
    expect(() => matrixConfig({
      homeserver: 'https://matrix.example.org', accessToken: 'token', syncTimeoutMs: 0,
    })).toThrow(/syncTimeoutMs/)
    expect(() => staticConfig({ transferChunkSize: 0 })).toThrow(/transferChunkSize/)
    expect(() => relayConfig({ apiId: 0, apiHash: '' })).toThrow(/apiId/)
  })

  it('requires Matrix connection credentials and hides its access token', () => {
    expect(() => matrixConfig({})).toThrow(/homeserver/)
    const json = matrixConfig.toJSON()
    const root = json.refs[json.uid]
    const homeserver = json.refs[root.dict!.homeserver as unknown as number]
    const accessToken = json.refs[root.dict!.accessToken as unknown as number]
    expect(homeserver.meta.required).toBe(true)
    expect(accessToken.meta.required).toBe(true)
    expect(accessToken.meta.role).toBe('secret')
  })

  it('marks relay credentials required and hides its API hash input', () => {
    expect(() => relayConfig({})).toThrow(/apiId/)
    const json = relayConfig.toJSON()
    const root = json.refs[json.uid]
    const apiId = json.refs[root.dict!.apiId as unknown as number]
    const apiHash = json.refs[root.dict!.apiHash as unknown as number]
    expect(apiId.meta.required).toBe(true)
    expect(apiHash.meta.required).toBe(true)
    expect(apiHash.meta.role).toBe('secret')
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
