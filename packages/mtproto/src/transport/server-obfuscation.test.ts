import { describe, it, expect, beforeAll } from 'vitest'
import { IntermediatePacketCodec, ObfuscatedPacketCodec, PaddedIntermediatePacketCodec } from '@mtcute/core'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { LogManager } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { Bytes } from '@fuman/io'
import { AbridgedPacketCodec, createServerObfuscation } from './server-obfuscation.js'

const crypto = new NodeCryptoProvider()
const log = new LogManager('test', new NodePlatform()).create('test')

beforeAll(async () => {
  await crypto.initialize?.()
})

/** Encode a frame with a client codec into raw bytes. */
async function clientEncode(codec: { encode: (f: Uint8Array, into: Bytes) => unknown }, frame: Uint8Array): Promise<Uint8Array> {
  const into = Bytes.alloc(frame.length + 128)
  await codec.encode(frame, into)
  return new Uint8Array(into.result())
}

/** Feed raw bytes into a server codec and drain all decoded frames. */
async function serverDecodeAll(codec: { decode: (r: Bytes, eof: boolean) => unknown }, raw: Uint8Array): Promise<Uint8Array[]> {
  const reader = Bytes.alloc(raw.length)
  reader.writeSync(raw.length).set(raw)
  const frames: Uint8Array[] = []
  for (;;) {
    const f = await codec.decode(reader, false)
    if (f == null) break
    frames.push(new Uint8Array(f as Uint8Array))
  }
  return frames
}

describe('AbridgedPacketCodec (server side)', () => {
  it('round-trips small and large frames against mtcute abridged inner tag', async () => {
    // mtcute doesn't export a client AbridgedPacketCodec, so exercise our own
    // encode → decode which must be symmetric.
    const server = new AbridgedPacketCodec()
    const client = new AbridgedPacketCodec()

    const small = crypto.randomBytes(60) // < 0x7f words
    const large = crypto.randomBytes(0x7f * 4 + 40) // triggers the 3-byte length header

    for (const frame of [small, large]) {
      const raw = await clientEncode(client, frame)
      const [decoded] = await serverDecodeAll(server, raw)
      expect(decoded).toEqual(frame)
    }
  })

  it('masks the quick-ack bit on short frame lengths', async () => {
    const frame = crypto.randomBytes(74 * 4)
    const raw = new Uint8Array(1 + frame.length)
    raw[0] = 0x80 | 74
    raw.set(frame, 1)

    const [decoded] = await serverDecodeAll(new AbridgedPacketCodec(), raw)
    expect(decoded).toEqual(frame)
  })

  it('accepts the quick-ack bit on a fragmented long frame marker', () => {
    const codec = new AbridgedPacketCodec()
    const frame = crypto.randomBytes(0x7f * 4 + 40)
    const words = frame.length / 4
    const raw = new Uint8Array(4 + frame.length)
    raw[0] = 0xff
    raw[1] = words & 0xff
    raw[2] = (words >> 8) & 0xff
    raw[3] = (words >> 16) & 0xff
    raw.set(frame, 4)

    const reader = Bytes.alloc(raw.length)
    reader.writeSync(3).set(raw.subarray(0, 3))
    expect(codec.decode(reader, false)).toBeNull()
    reader.writeSync(raw.length - 3).set(raw.subarray(3))
    expect(codec.decode(reader, false)).toEqual(frame)
  })
})

describe('createServerObfuscation', () => {
  // Wire a mtcute *client* ObfuscatedPacketCodec to our server obfuscation and
  // verify bytes flow correctly in both directions — this is the exact setup a
  // real Telegram Desktop / TDLib client uses.
  async function makePair(inner: () => { tag: () => unknown }) {
    const clientObf = new ObfuscatedPacketCodec(inner() as never)
    clientObf.setup?.(crypto, log)
    const header = await (clientObf.tag() as Promise<Uint8Array>)
    const { codec: serverObf } = createServerObfuscation(new Uint8Array(header), crypto, log)
    return { clientObf, serverObf }
  }

  it('server decodes what the client (intermediate inner) encodes', async () => {
    const { clientObf, serverObf } = await makePair(() => new IntermediatePacketCodec())

    const f1 = crypto.randomBytes(32)
    const f2 = crypto.randomBytes(128)

    // Two frames sent back-to-back must both decode.
    const raw = new Uint8Array([...await clientEncode(clientObf, f1), ...await clientEncode(clientObf, f2)])
    const frames = await serverDecodeAll(serverObf, raw)
    expect(frames).toEqual([f1, f2])
  })

  it('server decodes padded-intermediate inner', async () => {
    const { clientObf, serverObf } = await makePair(() => new PaddedIntermediatePacketCodec())
    const frame = crypto.randomBytes(96)
    const raw = await clientEncode(clientObf, frame)
    const [decoded] = await serverDecodeAll(serverObf, raw)
    // Padded-intermediate appends 0–15 random padding bytes at the transport
    // layer; the MTProto layer strips them using the real message length. So
    // the decoded frame starts with our payload followed by that padding.
    expect(decoded.length).toBeGreaterThanOrEqual(frame.length)
    expect(decoded.length).toBeLessThanOrEqual(frame.length + 16)
    expect(decoded.slice(0, frame.length)).toEqual(frame)
  })

  it('server → client direction: client decodes what server encodes', async () => {
    // Build the client obfuscation, hand its header to the server, then have
    // the server encode a frame and the client decode it.
    const clientInner = new IntermediatePacketCodec()
    const clientObf = new ObfuscatedPacketCodec(clientInner)
    clientObf.setup?.(crypto, log)
    const header = await (clientObf.tag() as Promise<Uint8Array>)
    const { codec: serverObf } = createServerObfuscation(new Uint8Array(header), crypto, log)

    const frame = crypto.randomBytes(64)
    const serverBytes = await clientEncode(serverObf, frame) // server.encode
    const decoded = await serverDecodeAll(clientObf, serverBytes) // client.decode
    expect(decoded[0]).toEqual(frame)
  })

  it('server → Android-style padded-intermediate client preserves consecutive frames', async () => {
    const clientInner = new PaddedIntermediatePacketCodec()
    const clientObf = new ObfuscatedPacketCodec(clientInner)
    clientObf.setup?.(crypto, log)
    const header = await (clientObf.tag() as Promise<Uint8Array>)
    const { codec: serverObf } = createServerObfuscation(new Uint8Array(header), crypto, log)

    const first = crypto.randomBytes(84)
    const second = crypto.randomBytes(84)
    const raw = new Uint8Array([
      ...await clientEncode(serverObf, first),
      ...await clientEncode(serverObf, second),
    ])
    const decoded = await serverDecodeAll(clientObf, raw)
    expect(decoded).toHaveLength(2)
    expect(decoded[0]!.slice(0, first.length)).toEqual(first)
    expect(decoded[1]!.slice(0, second.length)).toEqual(second)
  })
})
