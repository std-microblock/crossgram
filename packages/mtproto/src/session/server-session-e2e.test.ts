import { describe, it, expect } from 'vitest'
import { bigint, typed, u8 } from '@fuman/utils'
import { Bytes } from '@fuman/io'
import { connect, type Socket } from 'node:net'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import {
  LogManager,
  type Logger,
  generateKeyAndIvFromNonce,
  createAesIgeForMessage,
  createAesIgeForMessageOld,
  findKeyByFingerprints,
  addPublicKey,
} from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { ObfuscatedPacketCodec } from '@mtcute/core'
import Long from 'long'
import { Context } from 'cordis'
import { Mtproto } from '../service.js'
import { AbridgedPacketCodec } from '../transport/server-obfuscation.js'
import { generateRsaKeyPair } from '../crypto/rsa-keygen.js'
import { bareVector } from '../rpc/dispatcher.js'

/**
 * Full-stack e2e test: drives a real MtprotoServer over a real TCP socket using
 * the exact transport (obfuscated + abridged) and protocol (perm handshake →
 * PFS temp handshake → auth.bindTempAuthKey → encrypted RPC) that Telegram
 * Desktop uses. Deterministic — no client-side key caching.
 */

const crypto = new NodeCryptoProvider()
const log = new LogManager('e2e', new NodePlatform())
log.level = LogManager.OFF
const clientLog = log.create('client')

function nowSec() { return Math.floor(Date.now() / 1000) }
function makeMsgId(sub: number) { return Long.fromBits((Date.now() % 1000 << 21) | sub, nowSec()) }

/** rsaPad (replicated from mtcute — not exported) for the "new" RSA padding. */
function rsaPad(data: Uint8Array, key: { modulus: string, exponent: string }): Uint8Array {
  const keyModulus = BigInt(`0x${key.modulus}`)
  const keyExponent = BigInt(`0x${key.exponent}`)
  const dataPadded = u8.alloc(192)
  dataPadded.set(data, 0)
  crypto.randomFill(dataPadded.subarray(data.length))
  data = dataPadded
  for (;;) {
    const aesIv = u8.alloc(32)
    const aesKey = crypto.randomBytes(32)
    const dataWithHash = u8.concat2(data, crypto.sha256(u8.concat2(aesKey, data)))
    dataWithHash.subarray(0, 192).reverse()
    const aes = crypto.createAesIge(aesKey, aesIv)
    const encrypted = aes.encrypt(dataWithHash)
    u8.xorInPlace(aesKey, crypto.sha256(encrypted))
    const decryptedData = u8.concat2(aesKey, encrypted)
    if (bigint.fromBytes(decryptedData) >= keyModulus) continue
    return bigint.toBytes(bigint.modPowBinary(bigint.fromBytes(decryptedData), keyExponent, keyModulus), 256)
  }
}

/** A test client speaking obfuscated + abridged transport over a real socket. */
class TestClient {
  private _codec = new ObfuscatedPacketCodec(new AbridgedPacketCodec())
  private _recv = Bytes.alloc(65536)
  private _frames: Uint8Array[] = []
  private _waiter: ((f: Uint8Array) => void) | null = null
  private _processing: Promise<void> = Promise.resolve()

  private constructor(private _sock: Socket) {}

  static async connect(port: number): Promise<TestClient> {
    const sock = connect({ host: '127.0.0.1', port })
    await new Promise<void>((res, rej) => { sock.once('connect', res); sock.once('error', rej) })
    const client = new TestClient(sock)
    client._codec.setup(crypto, clientLog)
    sock.on('data', (d: Buffer) => client._onData(d))
    const tag = await client._codec.tag()
    sock.write(tag)
    return client
  }

  private _onData(d: Buffer): void {
    const view = this._recv.writeSync(d.length)
    view.set(new Uint8Array(d))
    // ObfuscatedPacketCodec.decode is async; serialize drains so decrypt state
    // and the receive buffer are never touched concurrently.
    this._processing = this._processing.then(() => this._drain())
  }

  private async _drain(): Promise<void> {
    for (;;) {
      const f = await this._codec.decode(this._recv, false)
      if (f === null) break
      const frame = new Uint8Array(f)
      if (this._waiter) { const w = this._waiter; this._waiter = null; w(frame) }
      else this._frames.push(frame)
    }
    this._recv.reclaim()
  }

  async send(frame: Uint8Array): Promise<void> {
    const into = Bytes.alloc(frame.length + 64)
    await this._codec.encode(frame, into)
    this._sock.write(into.result())
  }

  read(): Promise<Uint8Array> {
    if (this._frames.length > 0) return Promise.resolve(this._frames.shift()!)
    return new Promise((res) => { this._waiter = res })
  }

  close(): void { this._sock.destroy() }
}

/** Send a plaintext (auth_key_id=0) message. */
async function sendPlain(client: TestClient, obj: { _: string, [k: string]: unknown }, sub: number): Promise<void> {
  const len = TlSerializationCounter.countNeededBytes(__tlWriterMap, obj)
  const w = TlBinaryWriter.alloc(__tlWriterMap, len + 20)
  w.long(Long.ZERO)
  w.long(makeMsgId(sub))
  w.uint(len)
  w.object(obj)
  await client.send(w.result())
}

async function readPlainObj(client: TestClient): Promise<any> {
  const frame = await client.read()
  return new TlBinaryReader(__tlReaderMap, frame, 20).object()
}

interface ClientKey { authKey: Uint8Array, authKeyId: Uint8Array, salt: Long }

/** Run a full client DH handshake (perm or temp) and return the resulting key. */
async function doClientHandshake(client: TestClient, pubKey: any, temp: boolean): Promise<ClientKey> {
  const nonce = crypto.randomBytes(16)
  await sendPlain(client, { _: 'mt_req_pq_multi', nonce }, 4)

  const resPq = await readPlainObj(client)
  expect(resPq._).toBe('mt_resPQ')
  const serverNonce = resPq.serverNonce
  const [p, q] = await crypto.factorizePQ(resPq.pq)

  const newNonce = crypto.randomBytes(32)
  const pqInner = temp
    ? { _: 'mt_p_q_inner_data_temp_dc', pq: resPq.pq, p, q, nonce, newNonce, serverNonce, dc: 1, expiresIn: 3600 }
    : { _: 'mt_p_q_inner_data_dc', pq: resPq.pq, p, q, nonce, newNonce, serverNonce, dc: 1 }
  const encryptedData = rsaPad(TlBinaryWriter.serializeObject(__tlWriterMap, pqInner), pubKey)

  await sendPlain(client, {
    _: 'mt_req_DH_params', nonce, serverNonce, p, q,
    publicKeyFingerprint: Long.fromString(pubKey.fingerprint, true, 16), encryptedData,
  }, 8)

  const dhParams = await readPlainObj(client)
  expect(dhParams._).toBe('mt_server_DH_params_ok')

  const [aesKey, aesIv] = generateKeyAndIvFromNonce(crypto, serverNonce, newNonce)
  const ige = crypto.createAesIge(aesKey, aesIv)
  const plain = ige.decrypt(dhParams.encryptedAnswer)
  const dhInner = new TlBinaryReader(__tlReaderMap, plain, 20).object() as any
  const dhPrime = bigint.fromBytes(dhInner.dhPrime)
  const g = BigInt(dhInner.g)
  const gA = bigint.fromBytes(dhInner.gA)

  const b = bigint.fromBytes(crypto.randomBytes(256))
  const gB = bigint.modPowBinary(g, b, dhPrime)
  const authKey = bigint.toBytes(bigint.modPowBinary(gA, b, dhPrime), 256)

  const clientDhInner = { _: 'mt_client_DH_inner_data', nonce, serverNonce, retryId: Long.ZERO, gB: bigint.toBytes(gB, 0) }
  let innerLen = TlSerializationCounter.countNeededBytes(__tlWriterMap, clientDhInner) + 20
  if (innerLen % 16) innerLen += 16 - (innerLen % 16)
  const iw = TlBinaryWriter.alloc(__tlWriterMap, innerLen)
  iw.pos = 20
  iw.object(clientDhInner)
  const hash = crypto.sha1(iw.uint8View.subarray(20, iw.pos))
  iw.pos = 0
  iw.raw(hash)
  const clientDhEnc = ige.encrypt(iw.uint8View)

  await sendPlain(client, { _: 'mt_set_client_DH_params', nonce, serverNonce, encryptedData: clientDhEnc }, 12)

  const dhGen = await readPlainObj(client)
  expect(dhGen._).toBe('mt_dh_gen_ok')

  const saltBytes = u8.xor(newNonce.subarray(0, 8), serverNonce.subarray(0, 8))
  const sdv = typed.toDataView(saltBytes)
  return {
    authKey,
    authKeyId: crypto.sha1(authKey).subarray(-8),
    salt: new Long(sdv.getInt32(0, true), sdv.getInt32(4, true)),
  }
}

/** Encrypt a client→server message (MTProto v2, client direction). */
function clientEncrypt(key: ClientKey, body: Uint8Array, salt: Long, sessionId: Long, sub: number): Uint8Array {
  const inner = TlBinaryWriter.manual(16 + body.length)
  inner.long(makeMsgId(sub))
  inner.uint(1)
  inner.uint(body.length)
  inner.raw(body)
  const msg = inner.result()

  let padding = (16 + msg.length + 12) % 16
  padding = 12 + (padding ? 16 - padding : 0)
  const buf = u8.alloc(16 + msg.length + padding)
  const dv = typed.toDataView(buf)
  dv.setInt32(0, salt.low, true); dv.setInt32(4, salt.high, true)
  dv.setInt32(8, sessionId.low, true); dv.setInt32(12, sessionId.high, true)
  buf.set(msg, 16)
  crypto.randomFill(buf.subarray(16 + msg.length))

  const clientSalt = key.authKey.subarray(88, 120)
  const messageKey = crypto.sha256(u8.concat2(clientSalt, buf)).subarray(8, 24)
  const ige = createAesIgeForMessage(crypto, key.authKey, messageKey, true)
  return u8.concat3(key.authKeyId, messageKey, ige.encrypt(buf))
}

/** Decrypt a server→client message, returning the inner object reader positioned at the body. */
function clientDecrypt(key: ClientKey, data: Uint8Array): TlBinaryReader {
  expect(typed.equal(data.subarray(0, 8), key.authKeyId)).toBe(true)
  const messageKey = data.subarray(8, 24)
  let ct = data.subarray(24)
  if (ct.byteLength % 16) ct = ct.subarray(0, ct.byteLength - (ct.byteLength % 16))
  const ige = createAesIgeForMessage(crypto, key.authKey, messageKey, false)
  const plain = ige.decrypt(ct)
  const reader = new TlBinaryReader(__tlReaderMap, plain)
  reader.seek(16) // salt(8) + session_id(8)
  reader.long(true) // msg_id
  reader.uint() // seq_no
  reader.uint() // length
  return reader
}

async function startServer(): Promise<{ port: number, pubKey: any, stop: () => Promise<void> }> {
  const rsaKey = generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)

  const ctx = new Context()
  const fiber = ctx.plugin(Mtproto, { port: 0, host: '127.0.0.1', rsaKey, log })
  await fiber

  ctx.mtproto.register('help.getConfig', async () => ({
    _: 'config', flags: 0, defaultP2pContacts: false, preloadFeaturedStickers: false,
    revokePmInbox: false, blockedMode: false, forceTryIpv6: false, date: nowSec(), expires: 0,
    testMode: false, thisDc: 1, dcOptions: [], dcTxtDomainName: '', chatSizeMax: 200,
    megagroupSizeMax: 200000, forwardedCountMax: 100, onlineUpdatePeriodMs: 120000,
    offlineBlurTimeoutMs: 5000, offlineIdleTimeoutMs: 30000, onlineCloudTimeoutMs: 300000,
    notifyCloudDelayMs: 30000, notifyDefaultDelayMs: 1500, pushChatPeriodMs: 60000, pushChatLimit: 2,
    editTimeLimit: 172800, revokeTimeLimit: 172800, revokePmTimeLimit: 172800, ratingEDecay: 1000,
    stickersRecentLimit: 200, channelsReadMediaPeriod: 86400, tmpSessions: 0, callReceiveTimeoutMs: 30000,
    callRingTimeoutMs: 90000, callConnectTimeoutMs: 30000, callPacketTimeoutMs: 10000,
    meUrlPrefix: 'https://my.telegram.org/', captionLengthMax: 1024, messageLengthMax: 4096,
    webfileDcId: 1, suggestedLangCode: '', langPackVersion: 0, baseLangPackVersion: 0,
    reactionsDefault: { _: 'reactionEmpty' }, autologinToken: '',
  }))

  // A handler returning a bare Vector<X> (0x1cb5c415 + count + items) — the shape
  // users.getUsers and the legacy messages.getDialogFilters return.
  ctx.mtproto.register('users.getUsers', async () => bareVector([
    { _: 'userEmpty', id: 1 },
    { _: 'userEmpty', id: 2 },
  ]))

  // Backend data must follow the permanent auth key, not an individual TCP
  // connection. The reconnect test below observes this counter from a fresh
  // transport using the same key.
  ctx.mtproto.register('help.getAppConfig', async (rpc) => {
    const state = rpc.getPlatformData<{ calls: number } | null>() ?? { calls: 0 }
    state.calls += 1
    rpc.setPlatformData(state)
    return {
      _: 'help.appConfig', hash: state.calls,
      config: { _: 'jsonObject', value: [] },
    }
  })

  const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
  return { port: ctx.mtproto.port, pubKey, stop: () => Promise.resolve(fiber.dispose()) }
}

describe('e2e: obfuscated transport + PFS + RPC', () => {
  it('completes perm handshake and answers an RPC over the perm key', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)

      const sessionId = crypto.randomBytes(8)
      const sdv = typed.toDataView(sessionId)
      const sessionLong = new Long(sdv.getInt32(0, true), sdv.getInt32(4, true))

      const req = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getConfig' })
      await client.send(clientEncrypt(perm, req, perm.salt, sessionLong, 4))

      const config = await readRpcResult(client, perm)
      expect(config._).toBe('config')
      expect(config.thisDc).toBe(1)

      const getUsers = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'users.getUsers',
        id: [{ _: 'inputUserSelf' }],
      })
      await client.send(clientEncrypt(perm, getUsers, perm.salt, sessionLong, 6))

      const users = await readRpcResult(client, perm)
      expect(users).toEqual([
        { _: 'userEmpty', id: 1 },
        { _: 'userEmpty', id: 2 },
      ])
      client.close()
    } finally {
      await stop()
    }
  })

  it('completes perm + temp (PFS) handshake, binds, and answers an RPC over the temp key', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const temp = await doClientHandshake(client, pubKey, true)

      const sessionId = crypto.randomBytes(8)
      const sdv = typed.toDataView(sessionId)
      const sessionLong = new Long(sdv.getInt32(0, true), sdv.getInt32(4, true))

      // Build auth.bindTempAuthKey exactly as mtcute/tdesktop do.
      const bindInner = {
        _: 'mt_bind_auth_key_inner',
        nonce: Long.fromBytesLE(Array.from(crypto.randomBytes(8))),
        tempAuthKeyId: Long.fromBytesLE(Array.from(temp.authKeyId)),
        permAuthKeyId: Long.fromBytesLE(Array.from(perm.authKeyId)),
        tempSessionId: sessionLong,
        expiresAt: nowSec() + 3600,
      }
      const bw = TlBinaryWriter.alloc(__tlWriterMap, 80)
      bw.raw(crypto.randomBytes(16))
      const bindMsgId = makeMsgId(4)
      bw.long(bindMsgId)
      bw.int(0)
      bw.int(40)
      bw.object(bindInner)
      const msgNoPad = bw.result()
      bw.raw(crypto.randomBytes(8))
      const msgWithPad = bw.result()
      const msgKey = crypto.sha1(msgNoPad).subarray(4, 20)
      const encInner = createAesIgeForMessageOld(crypto, perm.authKey, msgKey, true).encrypt(msgWithPad)
      const encryptedMessage = u8.concat3(perm.authKeyId, msgKey, encInner)

      const bindReq = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'auth.bindTempAuthKey',
        permAuthKeyId: bindInner.permAuthKeyId,
        nonce: bindInner.nonce,
        expiresAt: bindInner.expiresAt,
        encryptedMessage,
      } as unknown as { _: string })
      await client.send(clientEncrypt(temp, bindReq, temp.salt, sessionLong, 4))
      const bindResult = await readRpcResult(client, temp)
      expect(bindResult._).toBe('boolTrue')

      // Now a real RPC over the temp key.
      const req = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getConfig' })
      await client.send(clientEncrypt(temp, req, temp.salt, sessionLong, 6))
      const config = await readRpcResult(client, temp)
      expect(config._).toBe('config')
      client.close()
    } finally {
      await stop()
    }
  })

  it('resumes a returning client from the stored auth key without re-handshaking', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      // Connection 1: full handshake — the server persists the perm key.
      const c1 = await TestClient.connect(port)
      const perm = await doClientHandshake(c1, pubKey, false)
      const firstSession = new Long(0x11111111, 0x11111111)
      const appConfigReq = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getAppConfig', hash: 0 })
      await c1.send(clientEncrypt(perm, appConfigReq, perm.salt, firstSession, 4))
      const firstConfig = await readRpcResult(c1, perm)
      expect(firstConfig).toMatchObject({ _: 'help.appConfig', hash: 1 })
      c1.close()

      // Connection 2: a fresh transport, but reuse the perm key from c1 and send
      // encrypted traffic directly — the server should load the key and skip the
      // handshake entirely.
      const c2 = await TestClient.connect(port)
      const sessionId = crypto.randomBytes(8)
      const sdv = typed.toDataView(sessionId)
      const sessionLong = new Long(sdv.getInt32(0, true), sdv.getInt32(4, true))

      await c2.send(clientEncrypt(perm, appConfigReq, perm.salt, sessionLong, 4))
      const config = await readRpcResult(c2, perm)
      expect(config).toMatchObject({ _: 'help.appConfig', hash: 2 })
      c2.close()
    } finally {
      await stop()
    }
  })
})

/** Read encrypted frames until an rpc_result is found; return the inner result object. */
async function readRpcResult(client: TestClient, key: ClientKey): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const frame = await client.read()
    const reader = clientDecrypt(key, frame)
    const saved = reader.pos
    const id = reader.uint()
    if (id === 0xf35c6d01) { // rpc_result
      reader.long(true) // req_msg_id
      const resultId = reader.uint()
      // Bool results aren't in mtcute's reader map (it models Bool as a JS boolean).
      if (resultId === 0x997275b5) return { _: 'boolTrue' }
      if (resultId === 0xbc799737) return { _: 'boolFalse' }
      if (resultId === 0x1cb5c415) return reader.vector(reader.object, true)
      reader.pos -= 4
      return reader.object()
    }
    reader.pos = saved
    try { reader.object() } catch { /* service message we don't model; keep reading */ }
  }
  throw new Error('no rpc_result received')
}
