import { describe, expect, it } from 'vitest'
import { canonicalJson, jsonContains, jsonEquals } from './stable-json.js'

describe('stable JSON comparisons', () => {
  it('ignores object key order, including nested payloads', () => {
    const upstream = {
      parts: [
        { type: 'text', text: 'hello', entities: [{ type: 'mention', offset: 0, length: 5 }] },
        { type: 'sticker', sticker: { providerId: 'qqnt:stickers', format: 'static', size: 120 } },
      ],
    }
    // The same payload as returned by a jsonb column: shorter keys first.
    const reordered = {
      parts: [
        { entities: [{ offset: 0, type: 'mention', length: 5 }], text: 'hello', type: 'text' },
        { sticker: { size: 120, format: 'static', providerId: 'qqnt:stickers' }, type: 'sticker' },
      ],
    }

    expect(JSON.stringify(upstream)).not.toEqual(JSON.stringify(reordered))
    expect(jsonEquals(upstream, reordered)).toBe(true)
    expect(canonicalJson(upstream)).toEqual(canonicalJson(reordered))
  })

  it('still reports payloads with different values, lengths, or extra keys', () => {
    const base = { parts: [{ type: 'text', text: 'hello' }] }

    expect(jsonEquals(base, { parts: [{ type: 'text', text: 'hello!' }] })).toBe(false)
    expect(jsonEquals(base, { parts: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'x' }] })).toBe(false)
    expect(jsonEquals(base, { parts: [{ type: 'text', text: 'hello', entities: [] }] })).toBe(false)
    expect(jsonEquals(base, { parts: [{ type: 'text', text: 'hello' }], extra: 1 })).toBe(false)
    expect(jsonEquals(base, { parts: [] })).toBe(false)
    expect(jsonEquals({}, [])).toBe(false)
  })

  it('treats undefined object properties as absent like JSON.stringify does', () => {
    expect(jsonEquals({ text: 'hello' }, { text: 'hello', entities: undefined })).toBe(true)
    expect(canonicalJson({ text: 'hello', entities: undefined })).toEqual('{"text":"hello"}')
    expect(jsonEquals({ text: undefined }, {})).toBe(true)
  })

  it('compares primitives and nullish values structurally', () => {
    expect(jsonEquals('value', 'value')).toBe(true)
    expect(jsonEquals('value', 'other')).toBe(false)
    expect(jsonEquals(0, 0)).toBe(true)
    expect(jsonEquals(0, false)).toBe(false)
    expect(jsonEquals(null, null)).toBe(true)
    expect(jsonEquals(undefined, undefined)).toBe(true)
    expect(jsonEquals(null, undefined)).toBe(false)
    expect(jsonEquals({ value: null }, { value: undefined })).toBe(false)
    expect(jsonEquals([1, undefined], [1, null])).toBe(true)
  })

  it('accepts stored payloads that carry extra durable fields', () => {
    const expected = { qqMsgSeq: '12', text: 'hello' }
    const stored = { text: 'hello', qqMsgSeq: '12', reactionMaxSelected: 20, __mtprotoRelaySenderTitle: 'Alice' }

    expect(jsonContains(stored, expected)).toBe(true)
    expect(jsonEquals(stored, expected)).toBe(false)
    expect(jsonContains(expected, stored)).toBe(false)
    expect(jsonContains(stored, { qqMsgSeq: '13', text: 'hello' })).toBe(false)
    expect(jsonContains(stored, { qqMsgSeq: '12', text: 'hello', extra: 1 })).toBe(false)
  })

  it('requires arrays to match element-wise', () => {
    expect(jsonContains({ parts: [{ type: 'text', text: 'x', extra: 1 }] }, { parts: [{ type: 'text', text: 'x' }] })).toBe(true)
    expect(jsonContains({ parts: [{ type: 'text', text: 'x' }] }, { parts: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] })).toBe(false)
    expect(jsonContains([{ type: 'text', extra: 1 }], [{ type: 'text' }])).toBe(true)
    expect(jsonContains([{ type: 'text' }], [{ type: 'text', extra: 1 }])).toBe(false)
    expect(jsonContains({ parts: [] }, { parts: [] })).toBe(true)
  })

  it('keeps non-plain values in their JSON.stringify form', () => {
    const at = new Date('2026-09-21T00:00:00.000Z')

    expect(canonicalJson({ at })).toEqual('{"at":"2026-09-21T00:00:00.000Z"}')
    expect(jsonEquals({ at }, { at: new Date('2026-09-21T00:00:00.000Z') })).toBe(true)
    expect(jsonEquals({ at }, { at: new Date('2026-09-22T00:00:00.000Z') })).toBe(false)
    // JSON.stringify() also collapses a Date into its ISO string.
    expect(jsonEquals({ at }, { at: '2026-09-21T00:00:00.000Z' })).toBe(true)
  })
})
