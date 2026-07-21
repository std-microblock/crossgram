import { afterEach, describe, expect, it, vi } from 'vitest'
import Long from 'long'
import { ServerMessageIdGenerator } from './message-id.js'

describe('ServerMessageIdGenerator', () => {
  afterEach(() => vi.restoreAllMocks())

  it('generates strictly increasing server-parity ids while time is frozen', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const generator = new ServerMessageIdGenerator()

    const first = generator.getMessageId()
    const second = generator.getMessageId()

    expect(first.getLowBitsUnsigned() & 3).toBe(1)
    expect(second.getLowBitsUnsigned() & 3).toBe(1)
    expect(second.greaterThan(first)).toBe(true)
    expect(second.subtract(first).toNumber()).toBe(4)
  })

  it('realigns after observing a newer client-parity id', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const generator = new ServerMessageIdGenerator()
    const clientId = new Long(0xfffffff0, 1_700_000_000, false)

    generator.observeClientMsgId(clientId)
    const responseId = generator.getMessageId()

    expect(responseId.greaterThan(clientId)).toBe(true)
    expect(responseId.getLowBitsUnsigned() & 3).toBe(1)
    expect(responseId.subtract(clientId).toNumber()).toBe(1)
  })

  it('keeps server parity for every possible observed low-bit remainder', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    for (let remainder = 0; remainder < 4; remainder++) {
      const generator = new ServerMessageIdGenerator()
      const observed = new Long(0xfffffff0 + remainder, 1_700_000_000, false)
      generator.observeClientMsgId(observed)

      const responseId = generator.getMessageId()
      expect(responseId.greaterThan(observed)).toBe(true)
      expect(responseId.getLowBitsUnsigned() & 3).toBe(1)
    }
  })
})
