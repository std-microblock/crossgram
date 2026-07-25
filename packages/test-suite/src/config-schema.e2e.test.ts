import { Loader } from '@cordisjs/plugin-loader'
import { describe, expect, it } from 'vitest'
import * as bridge from '../../bridge/src/index.js'
import * as debug from '../../mtproto-debug/src/index.js'
import * as mtproto from '../../mtproto/src/index.js'
import * as qqnt from '../../platform-crossgram/src/index.js'
import * as discord from '../../platform-discord/src/index.js'
import * as staticPlatform from '../../platform-static/src/index.js'
import * as relay from '../../relay/src/index.js'
import * as resources from '../../telegram-resources/src/index.js'

const modules = { bridge, debug, mtproto, qqnt, discord, staticPlatform, relay, resources }

describe('loader WebUI config discovery', () => {
  it.each(Object.entries(modules))('%s survives the loader export-unwrapping path', (_name, exports) => {
    const plugin = Loader.prototype.unwrapExports(exports)
    expect(plugin?.Config?.['~standard']?.validate).toBeTypeOf('function')
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]
    expect(root.type).toBe('object')
    expect(Object.keys(root.dict ?? {}).length).toBeGreaterThan(0)
  })

  it('serializes the QQNT gray-tip filter list and its reaction-notice default through the loader', () => {
    const plugin = Loader.prototype.unwrapExports(qqnt)
    const serialized = JSON.parse(JSON.stringify({ schema: plugin.Config }))
    const root = serialized.schema.refs[serialized.schema.uid]
    expect(root.dict).toHaveProperty('grayTipFilters')
    expect(plugin.Config({})).toMatchObject({ grayTipFilters: ['回应了你的消息'] })
    expect(plugin.Config({ grayTipFilters: [] })).toMatchObject({ grayTipFilters: [] })
  })
})
