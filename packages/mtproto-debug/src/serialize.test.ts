import { describe, expect, it } from 'vitest'
import Long from 'long'
import { serializeDebugEvent, toDebugJson } from './serialize.js'

describe('MTProto debug serialization', () => {
  it('preserves nested TL data while making Long, bigint, and bytes JSON-safe', () => {
    const bytes = new Uint8Array(600)
    bytes.set([0x00, 0x7f, 0x80, 0xff])
    const event = serializeDebugEvent({
      direction: 'client->server',
      phase: 'message',
      connectionId: 'conn-7',
      timestamp: 1_900_000_000_123,
      messageId: Long.fromString('9223372036854775000'),
      seqNo: 3,
      authKeyId: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      sessionId: Long.fromString('123456789'),
      payload: {
        _: 'messages.sendMessage',
        randomId: Long.fromString('-500'),
        amount: 9007199254740993n,
        bytes,
      },
    }, 42)

    expect(event).toMatchObject({
      id: 42,
      name: 'messages.sendMessage',
      connectionId: 'conn-7',
      messageId: '0x7ffffffffffffcd8',
      authKeyId: 'deadbeef',
      sessionId: '0x75bcd15',
      payload: {
        _: 'messages.sendMessage',
        randomId: { $type: 'Long', decimal: '-500', hex: '-0x1f4' },
        amount: { $type: 'bigint', decimal: '9007199254740993' },
        bytes: {
          $type: 'bytes', length: 600, truncated: true,
        },
      },
    })
    expect((event.payload as any).bytes.hex).toHaveLength(1_024)
    expect(event.searchText).toContain('messages.sendmessage')
    expect(() => JSON.stringify(event)).not.toThrow()
  })

  it('labels RPC results by their decoded result constructor', () => {
    const event = serializeDebugEvent({
      direction: 'server->client', phase: 'message', connectionId: 'conn-1', timestamp: 1,
      payload: { _: 'rpc_result', reqMsgId: Long.ONE, result: { _: 'users.userFull', user: {} } },
    }, 1)
    expect(event.name).toBe('rpc_result -> users.userFull')
  })

  it('terminates circular and excessively deep values', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index < 24; index++) {
      deep.next = {}
      deep = deep.next as Record<string, unknown>
    }

    expect(toDebugJson(circular)).toEqual({ self: '[Circular]' })
    expect(JSON.stringify(toDebugJson(root))).toContain('[Max depth reached]')
  })
})
