import { beforeAll, describe, expect, it } from 'vitest'
import { Bytes } from '@fuman/io'
import { typed } from '@fuman/utils'
import { IntermediatePacketCodec, PaddedIntermediatePacketCodec, type IPacketCodec } from '@mtcute/core'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { AbridgedPacketCodec, ServerObfuscatedCodec } from './server-obfuscation.js'
import { MAX_RETAINED_RECEIVE_BYTES } from './receive-buffer.js'

const crypto = new NodeCryptoProvider()
beforeAll(() => crypto.initialize())
const identity = () => ({ process: (bytes: Uint8Array) => new Uint8Array(bytes) })
const bufferOf = (codec: ServerObfuscatedCodec) => (codec as unknown as { _decodeBuf: Bytes })._decodeBuf
async function encode(codec: IPacketCodec, frame: Uint8Array): Promise<Uint8Array> {
  const into = Bytes.alloc(frame.length + 32)
  await codec.encode(frame, into)
  return into.result()
}

describe('obfuscated receive memory', () => {
  it.each(['abridged', 'intermediate', 'padded'] as const)('bounds lifetime traffic for %s without losing frames', async (kind) => {
    const inner = kind === 'abridged' ? new AbridgedPacketCodec()
      : kind === 'padded' ? new PaddedIntermediatePacketCodec() : new IntermediatePacketCodec()
    if (inner instanceof PaddedIntermediatePacketCodec) inner.setup(crypto)
    const codec = new ServerObfuscatedCodec(identity(), identity(), inner)
    const input = Bytes.alloc()
    for (let sequence = 0; sequence < 96; sequence++) {
      const expected = new Uint8Array(32 * 1024).fill(sequence)
      const encoded = await encode(inner, expected)
      input.writeSync(encoded.length).set(encoded)
      const decoded = await codec.decode(input, false)
      expect(typed.equal(decoded!.subarray(0, expected.length), expected)).toBe(true)
      expect(bufferOf(codec).written).toBe(0)
      expect(bufferOf(codec).capacity).toBeLessThanOrEqual(MAX_RETAINED_RECEIVE_BYTES)
      input.reclaim()
    }
  })

  it('preserves an incomplete suffix and previously returned frames during compaction', async () => {
    const inner = new IntermediatePacketCodec()
    const codec = new ServerObfuscatedCodec(identity(), identity(), inner)
    const first = new Uint8Array(128).fill(1)
    const second = new Uint8Array(256).fill(2)
    const a = await encode(inner, first), b = await encode(inner, second)
    const input = Bytes.alloc(1024)
    input.writeSync(a.length).set(a)
    input.writeSync(6).set(b.subarray(0, 6))
    const decodedFirst = await codec.decode(input, false)
    expect(decodedFirst).toEqual(first)
    expect(bufferOf(codec).available).toBe(6)
    expect(await codec.decode(input, false)).toBeNull()
    input.reclaim()
    input.writeSync(b.length - 6).set(b.subarray(6))
    expect(await codec.decode(input, false)).toEqual(second)
    expect(decodedFirst).toEqual(first)
    expect(bufferOf(codec).written).toBe(0)
  })

  it.each([false, true])('owns borrowed frames before reclaiming (async=%s)', async (asyncDecode) => {
    const inner: IPacketCodec = {
      tag: () => new Uint8Array(), reset() {}, encode() {},
      decode(reader) {
        const frame = reader.available ? reader.readSync(reader.available) : null
        return asyncDecode ? Promise.resolve(frame) : frame
      },
    }
    const codec = new ServerObfuscatedCodec(identity(), identity(), inner)
    const reader = Bytes.from(Uint8Array.of(1, 2, 3, 4))
    const first = await codec.decode(reader, false)
    expect(await codec.decode(Bytes.from(Uint8Array.of(9, 8, 7, 6)), false)).toEqual(Uint8Array.of(9, 8, 7, 6))
    expect(first).toEqual(Uint8Array.of(1, 2, 3, 4))
    expect(bufferOf(codec).written).toBe(0)
  })

  it('drains a coalesced batch without moving its unread suffix on every frame', async () => {
    const inner = new IntermediatePacketCodec()
    const codec = new ServerObfuscatedCodec(identity(), identity(), inner)
    const frames = Array.from({ length: 100 }, (_, index) => new Uint8Array(128).fill(index))
    const encoded = await Promise.all(frames.map(frame => encode(inner, frame)))
    const input = Bytes.alloc(20000)
    for (const bytes of encoded) input.writeSync(bytes.length).set(bytes)
    const total = input.available
    for (const [index, expected] of frames.entries()) {
      expect(await codec.decode(input, false)).toEqual(expected)
      if (index < frames.length - 1) expect(bufferOf(codec).written).toBe(total)
    }
    expect(bufferOf(codec).written).toBe(0)
    expect(await codec.decode(input, false)).toBeNull()
  })

  it('shrinks an oversized completed frame and releases storage on reset', async () => {
    const inner = new IntermediatePacketCodec()
    const codec = new ServerObfuscatedCodec(identity(), identity(), inner)
    const expected = new Uint8Array(MAX_RETAINED_RECEIVE_BYTES + 4096).fill(17)
    const frame = await codec.decode(Bytes.from(await encode(inner, expected)), false)
    expect(typed.equal(frame!, expected)).toBe(true)
    expect(bufferOf(codec).capacity).toBe(16 * 1024)
    const held = new Uint8Array(512 * 1024).fill(23)
    await codec.decode(Bytes.from(await encode(inner, held)), false)
    expect(bufferOf(codec).capacity).toBeGreaterThan(16 * 1024)
    codec.reset()
    expect(bufferOf(codec).capacity).toBe(16 * 1024)
    expect(typed.equal(frame!, expected)).toBe(true)
  })
})
