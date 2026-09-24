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
  it('advertises an internal-links prefix the clients resolve on their own', () => {
    const prefix = (makeConfig(1) as tl.RawConfig).meUrlPrefix

    // Clients build "copy link", share, and public link URLs from
    // `me_url_prefix`, but only keep the URLs their own internal-link grammar
    // knows inside themselves: Telegram Desktop's `Core::TryConvertUrlToLocal`
    // and Telegram Android's `Browser.isInternalUri` accept `t.me`,
    // `telegram.me` and `telegram.dog` alone, and Telegram Desktop also
    // requires the trailing slash. Every other domain sends the click to a
    // browser, where a Crossgram link cannot resolve.
    expect(prefix).toMatch(/^https:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/$/u)
    expect(prefix).toBe('https://t.me/')
  })

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

  it('advertises the primary endpoint followed by alternate endpoints for the selected DC', () => {
    const config = makeConfig(4, '192.168.10.20', 8443, [
      '192.168.10.21:9443',
      'bridge-backup.example:10443',
      '[2001:db8::1]:4430',
    ]) as tl.RawConfig

    expect(config.thisDc).toBe(4)
    expect(config.webfileDcId).toBe(4)
    expect(config.dcOptions.map(option => ({
      id: option.id, host: option.ipAddress, port: option.port, ipv6: option.ipv6,
    }))).toEqual([
      { id: 4, host: '192.168.10.20', port: 8443, ipv6: false },
      { id: 4, host: '192.168.10.21', port: 9443, ipv6: false },
      { id: 4, host: 'bridge-backup.example', port: 10443, ipv6: false },
      { id: 4, host: '2001:db8::1', port: 4430, ipv6: true },
    ])
    expect(config.dcOptions.every(option =>
      option.tcpoOnly && option.static && !option.mediaOnly && !option.cdn,
    )).toBe(true)
  })

  it('round-trips primary and alternate bridge endpoints through the Telegram TL codec', () => {
    const decoded = roundTrip(makeConfig(2, '10.0.0.1', 4430, [
      '10.0.0.2:4431',
      '[2001:db8::2]:4432',
    ])) as tl.RawConfig

    expect(decoded.thisDc).toBe(2)
    expect(decoded.dcOptions.map(option => ({
      id: option.id, host: option.ipAddress, port: option.port, ipv6: option.ipv6,
    }))).toEqual([
      { id: 2, host: '10.0.0.1', port: 4430, ipv6: false },
      { id: 2, host: '10.0.0.2', port: 4431, ipv6: false },
      { id: 2, host: '2001:db8::2', port: 4432, ipv6: true },
    ])
    expect(decoded.dcOptions.every(option => option.tcpoOnly && option.static)).toBe(true)
  })
})

describe('bridge synthetic peers', () => {
  it('always reports a userpic state so clients stop refreshing the full user', () => {
    const withoutPhoto = roundTrip(makeUser({ id: 7, firstName: 'NoPhoto', bot: true })) as tl.RawUser
    const withPhoto = roundTrip(makeUser({
      id: 8,
      firstName: 'WithPhoto',
      photo: { _: 'userProfilePhoto', photoId: Long.fromNumber(5), dcId: 1 },
    })) as tl.RawUser

    expect(withoutPhoto.photo).toEqual({ _: 'userProfilePhotoEmpty' })
    expect(withPhoto.photo).toMatchObject({ _: 'userProfilePhoto', photoId: Long.fromNumber(5) })
  })

  it('reports a non-negative bot info version for bots so clients allocate bot state', () => {
    const bot = roundTrip(makeUser({ id: 9, firstName: 'Helper', bot: true })) as tl.RawUser
    const human = roundTrip(makeUser({ id: 10, firstName: 'Alice' })) as tl.RawUser

    // `bot` and `bot_info_version` share bit 14, which carries an int on the
    // wire; clients treat the peer as a bot only for a non-negative version.
    expect(bot.bot).toBe(true)
    expect(bot.botInfoVersion).toBe(0)
    expect(human.bot).toBe(false)
    expect(human.botInfoVersion).toBeUndefined()
  })

  it('gives users a non-zero access hash that survives TL serialization', () => {
    const user = makeUser({ id: 42, firstName: 'Alice' })
    const decoded = roundTrip(user) as tl.RawUser

    expect(user.accessHash).toEqual(Long.ONE)
    expect(decoded).toMatchObject({ _: 'user', id: 42, accessHash: Long.ONE })
  })
})
