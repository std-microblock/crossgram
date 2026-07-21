import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { makeConfig, RELAY_DC_IDS } from './synthetic.js'

function roundTrip(object: tl.TlObject): tl.TlObject {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
}

describe('relay MTProto config', () => {
  it('publishes DC 1 through 6 at the default relay endpoint', () => {
    const config = makeConfig(1) as tl.RawConfig

    expect(config.thisDc).toBe(1)
    expect(config.webfileDcId).toBe(1)
    expect(config.dcOptions).toHaveLength(6)
    expect(config.dcOptions.map(option => option.id)).toEqual([...RELAY_DC_IDS])
    expect(config.dcOptions).toEqual(RELAY_DC_IDS.map(id => expect.objectContaining({
      _: 'dcOption', id, ipAddress: '127.0.0.1', port: 4430,
      tcpoOnly: true, static: true, ipv6: false, mediaOnly: false, cdn: false,
    })))
  })

  it('routes every logical DC to a custom relay without changing thisDc', () => {
    const config = makeConfig(4, '192.168.10.20', 8443) as tl.RawConfig

    expect(config.thisDc).toBe(4)
    expect(config.webfileDcId).toBe(4)
    expect(config.dcOptions.map(option => ({
      id: option.id, host: option.ipAddress, port: option.port,
    }))).toEqual(RELAY_DC_IDS.map(id => ({ id, host: '192.168.10.20', port: 8443 })))
  })

  it('round-trips all relay routes through the Telegram TL codec', () => {
    const decoded = roundTrip(makeConfig(2)) as tl.RawConfig

    expect(decoded.thisDc).toBe(2)
    expect(decoded.dcOptions.map(option => option.id)).toEqual([...RELAY_DC_IDS])
    expect(decoded.dcOptions.every(option =>
      option.ipAddress === '127.0.0.1' && option.port === 4430 && option.tcpoOnly === true,
    )).toBe(true)
  })
})
