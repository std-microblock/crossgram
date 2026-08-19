import type { tl } from '@mtcute/core'
import Long from 'long'
import { describe, expect, it } from 'vitest'
import { updateFromJson, updateToJson } from './update-json.js'

describe('Telegram update JSON codec', () => {
  it('stores the update object as readable JSON and restores Long and bytes values', () => {
    const update = {
      _: 'updates',
      updates: [{
        _: 'updateMessageID', id: 7, randomId: Long.fromString('987654321012345678'),
        opaque: Uint8Array.of(1, 2, 255), optional: undefined,
      }],
      users: [], chats: [], date: 123, seq: 4,
    } as unknown as tl.RawUpdates

    const json = updateToJson(update)
    expect(json).toMatchObject({
      _: 'updates',
      updates: [{
        _: 'updateMessageID',
        randomId: { $mtprotoRelayType: 'long', value: '987654321012345678', unsigned: false },
        opaque: { $mtprotoRelayType: 'bytes', value: 'AQL/' },
      }],
    })
    expect(JSON.stringify(json)).toContain('updateMessageID')
    expect(JSON.stringify(json)).not.toContain('optional')

    const restored = updateFromJson(json) as unknown as {
      updates: Array<{ randomId: Long, opaque: Uint8Array }>
    }
    expect(Long.isLong(restored.updates[0].randomId)).toBe(true)
    expect(restored.updates[0].randomId.toString()).toBe('987654321012345678')
    expect(restored.updates[0].opaque).toEqual(Uint8Array.of(1, 2, 255))
  })
})
