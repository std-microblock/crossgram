import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import Long from 'long'
import { makeConfig, makeUser } from './synthetic.js'

function roundTrip(object: tl.TlObject): tl.TlObject {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
}

describe('bridge MTProto config', () => {
  it('publishes only the configured DC at the default bridge endpoint', () => {
    const config = makeConfig(1) as tl.RawConfig

    expect(config.thisDc).toBe(1)
    expect(config.webfileDcId).toBe(1)
    expect(config.dcOptions).toHaveLength(1)
    expect(config.dcOptions).toEqual([expect.objectContaining({
      _: 'dcOption', id: 1, ipAddress: '127.0.0.1', port: 4430,
      tcpoOnly: true, static: true, ipv6: false, mediaOnly: false, cdn: false,
    })])
  })

  it('advertises a custom endpoint for the selected DC', () => {
    const config = makeConfig(4, '192.168.10.20', 8443) as tl.RawConfig

    expect(config.thisDc).toBe(4)
    expect(config.webfileDcId).toBe(4)
    expect(config.dcOptions.map(option => ({
      id: option.id, host: option.ipAddress, port: option.port,
    }))).toEqual([{ id: 4, host: '192.168.10.20', port: 8443 }])
  })

  it('round-trips the single bridge DC through the Telegram TL codec', () => {
    const decoded = roundTrip(makeConfig(2)) as tl.RawConfig

    expect(decoded.thisDc).toBe(2)
    expect(decoded.dcOptions.map(option => option.id)).toEqual([2])
    expect(decoded.dcOptions.every(option =>
      option.ipAddress === '127.0.0.1' && option.port === 4430 && option.tcpoOnly === true,
    )).toBe(true)
  })
})

describe('bridge synthetic peers', () => {
  it('gives users a non-zero access hash that survives TL serialization', () => {
    const user = makeUser({ id: 42, firstName: 'Alice' })
    const decoded = roundTrip(user) as tl.RawUser

    expect(user.accessHash).toEqual(Long.ONE)
    expect(decoded).toMatchObject({ _: 'user', id: 42, accessHash: Long.ONE })
  })
})
