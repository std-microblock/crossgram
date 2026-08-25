import { Loader } from '@cordisjs/plugin-loader'
import { describe, expect, it } from 'vitest'
import * as bridge from '../../bridge/src/index.js'
import * as debug from '../../mtproto-debug/src/index.js'
import * as mtproto from '../../mtproto/src/index.js'
import * as statistics from '../../mtproto-statistics/src/index.js'
import * as adminBot from '../../platform-admin-bot/src/index.js'
import * as qqnt from '../../platform-crossgram/src/index.js'
import * as discord from '../../platform-discord/src/index.js'
import * as matrix from '../../platform-matrix/src/index.js'
import * as wechat from '../../platform-wechat/src/index.js'
import * as staticPlatform from '../../platform-static/src/index.js'
import * as satoriPlatform from '../../platform-satori/src/index.js'
import * as satoriExporter from '../../satori-exporter/src/index.js'
import * as flashTransfer from '../../qq-flash-transfer-bot/src/index.js'
import * as botApi from '../../telegram-bot-api/src/index.js'
import * as resources from '../../telegram-resources/src/index.js'
import * as stickerImporter from '../../telegram-sticker-importer/src/index.js'
import * as updateStoreMemory from '../../update-store-memory/src/index.js'
import * as updateStoreDatabase from '../../update-store-database/src/index.js'

const modules = {
  bridge, debug, mtproto, statistics, adminBot, qqnt, discord, matrix, wechat, staticPlatform, satoriPlatform,
  satoriExporter, flashTransfer, botApi, resources, stickerImporter, updateStoreMemory, updateStoreDatabase,
}

describe('loader WebUI config discovery', () => {
  it.each(Object.entries(modules))('%s survives the loader export-unwrapping path', (_name, exports) => {
    const plugin = Loader.prototype.unwrapExports(exports)
    expect(plugin?.Config?.['~standard']?.validate).toBeTypeOf('function')
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]
    expect(root.type).toBe('object')
    expect(Object.keys(root.dict ?? {}).length).toBeGreaterThan(0)
  })

  it('serializes alternate bridge endpoints through the loader', () => {
    const plugin = Loader.prototype.unwrapExports(bridge)
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]
    expect(root.dict).toHaveProperty('altEndpoints')
    expect(plugin.Config({})).toMatchObject({ altEndpoints: [] })
    expect(plugin.Config({ altEndpoints: ['bridge-backup.example:8443'] }))
      .toMatchObject({ altEndpoints: ['bridge-backup.example:8443'] })
  })

  it('serializes the QQNT gray-tip filter list and its reaction-notice default through the loader', () => {
    const plugin = Loader.prototype.unwrapExports(qqnt)
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]
    expect(root.dict).toHaveProperty('grayTipFilters')
    expect(plugin.Config({})).toMatchObject({ grayTipFilters: ['回应了你的消息'] })
    expect(plugin.Config({ grayTipFilters: [] })).toMatchObject({ grayTipFilters: [] })
  })

  it('does not expose a configurable WeChat callback listener host', () => {
    const plugin = Loader.prototype.unwrapExports(wechat)
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]

    expect(root.dict).not.toHaveProperty('callbackHost')
    expect(plugin.Config({})).not.toHaveProperty('callbackHost')
  })
})
