import { describe, it, expect, vi } from 'vitest'
import { bigint, typed, u8 } from '@fuman/utils'
import { Bytes, write, type ISyncWritable } from '@fuman/io'
import { connect, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, deflateSync, gzipSync } from 'node:zlib'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter, type TlReaderMap } from '@mtcute/tl-runtime'
import { __tlReaderMap, __tlReaderMapWithCompat, __tlWriterMap } from '@mtcute/core/utils.js'
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
import { ObfuscatedPacketCodec, type tl } from '@mtcute/core'
import Long from 'long'
import { Context } from 'cordis'
import { Mtproto } from '../service.js'
import { CURRENT_API_LAYER } from '../rpc/api-layer.js'
import type { MtprotoDebugEvent, MtprotoDebugListener } from '../debug.js'
import { AbridgedPacketCodec } from '../transport/server-obfuscation.js'
import type { ServerConnection } from '../transport/server-connection.js'
import { generateRsaKeyPair, type ServerRsaKey } from '../crypto/rsa-keygen.js'
import { bareVector } from '../rpc/protocol.js'
import { getApiLayerReaderMap } from '../rpc/api-layer.js'
import { FileAuthKeyStore, type AuthKeyStore } from './auth-key-store.js'

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
const GZIP_PACKED_ID = 0x3072CFA1
const INVOKE_WITH_LAYER_ID = 0xDA9B0D0D

function nowSec() { return Math.floor(Date.now() / 1000) }
function makeMsgId(sub: number) { return Long.fromBits((Date.now() % 1000 << 21) | sub, nowSec()) }

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

/** Abridged client codec that can reproduce Android's reportAck length bit. */
class TestAbridgedPacketCodec extends AbridgedPacketCodec {
  requestQuickAck = false

  override encode(frame: Uint8Array, into: ISyncWritable): void {
    const temporary = Bytes.alloc(frame.length + 4)
    super.encode(frame, temporary)
    const encoded = new Uint8Array(temporary.result())
    if (this.requestQuickAck) encoded[0] |= 0x80
    write.bytes(into, encoded)
  }
}

/** A test client speaking obfuscated + abridged transport over a real socket. */
class TestClient {
  private _abridged = new TestAbridgedPacketCodec()
  private _codec = new ObfuscatedPacketCodec(this._abridged)
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

  async send(frame: Uint8Array, requestQuickAck = false): Promise<void> {
    const into = Bytes.alloc(frame.length + 64)
    this._abridged.requestQuickAck = requestQuickAck
    try {
      await this._codec.encode(frame, into)
      this._sock.write(into.result())
    } finally {
      this._abridged.requestQuickAck = false
    }
  }

  async sendBatch(frames: readonly Uint8Array[]): Promise<void> {
    const packets: Buffer[] = []
    for (const frame of frames) {
      const into = Bytes.alloc(frame.length + 64)
      await this._codec.encode(frame, into)
      packets.push(Buffer.from(into.result()))
    }
    this._sock.write(Buffer.concat(packets))
  }

  read(): Promise<Uint8Array> {
    if (this._frames.length > 0) return Promise.resolve(this._frames.shift()!)
    return new Promise((res) => { this._waiter = res })
  }

  close(): void { this._sock.destroy() }
}

/** Serialize a plaintext (auth_key_id=0) message. */
function plainFrame(obj: { _: string, [k: string]: unknown }, sub: number): Uint8Array {
  const len = TlSerializationCounter.countNeededBytes(__tlWriterMap, obj)
  const w = TlBinaryWriter.alloc(__tlWriterMap, len + 20)
  w.long(Long.ZERO)
  w.long(makeMsgId(sub))
  w.uint(len)
  w.object(obj)
  return w.result()
}

async function sendPlain(client: TestClient, obj: { _: string, [k: string]: unknown }, sub: number): Promise<void> {
  await client.send(plainFrame(obj, sub))
}

function serializeInitializedRpc(query: object, layer = CURRENT_API_LAYER): Uint8Array {
  return TlBinaryWriter.serializeObject(__tlWriterMap, {
    _: 'invokeWithLayer',
    layer,
    query: {
      _: 'initConnection',
      apiId: 1,
      deviceModel: 'mtproto-relay test',
      systemVersion: 'test',
      appVersion: 'test',
      systemLangCode: 'en',
      langPack: '',
      langCode: 'en',
      query,
    },
  } as { _: string })
}

function packedObject(body: Uint8Array, compress: (data: Uint8Array) => Uint8Array): Uint8Array {
  const packed = compress(body)
  const writer = TlBinaryWriter.manual(4 + TlSerializationCounter.countBytesOverhead(packed.length) + packed.length)
  writer.uint(GZIP_PACKED_ID)
  writer.bytes(packed)
  return writer.result()
}

function gzipPacked(body: Uint8Array): Uint8Array {
  return packedObject(body, gzipSync)
}

function invokeWithLayerPacked(
  query: { _: string },
  compress: (data: Uint8Array) => Uint8Array,
  layer = CURRENT_API_LAYER,
): Uint8Array {
  const packedQuery = packedObject(TlBinaryWriter.serializeObject(__tlWriterMap, query), compress)
  const writer = TlBinaryWriter.manual(8 + packedQuery.length)
  writer.uint(INVOKE_WITH_LAYER_ID)
  writer.uint(layer)
  writer.raw(packedQuery)
  return writer.result()
}

function invokeWithLayerGzip(query: { _: string }, layer = CURRENT_API_LAYER): Uint8Array {
  return invokeWithLayerPacked(query, gzipSync, layer)
}

/** Telegram Desktop's TCP endpoint probe uses the legacy req_pq constructor. */
async function sendLegacyReqPq(client: TestClient, nonce: Uint8Array, sub: number): Promise<void> {
  const body = TlBinaryWriter.manual(20)
  body.uint(0x60469778)
  body.raw(nonce)

  const w = TlBinaryWriter.manual(40)
  w.long(Long.ZERO)
  w.long(makeMsgId(sub))
  w.uint(20)
  w.raw(body.result())
  await client.send(w.result())
}

async function readPlainObj(client: TestClient): Promise<any> {
  return (await readPlainMessage(client)).object
}

async function readPlainMessage(client: TestClient): Promise<{ messageId: Long, object: any }> {
  const frame = await client.read()
  const reader = new TlBinaryReader(__tlReaderMap, frame, 8)
  const messageId = reader.long()
  reader.uint()
  return { messageId, object: reader.object() }
}

interface ClientKey { authKey: Uint8Array, authKeyId: Uint8Array, salt: Long }
interface PqHandshakeStart {
  nonce: Uint8Array
  resPqMessage: { messageId: Long, object: any }
}

/** Run a full client DH handshake (perm or temp) and return the resulting key. */
async function doClientHandshake(
  client: TestClient,
  pubKey: any,
  temp: boolean,
  tempExpiresIn = 3600,
  acknowledgePlaintextResponses = false,
  batchFirstAcknowledgement = false,
  extraPqProbes = 0,
  initialPq?: PqHandshakeStart,
): Promise<ClientKey> {
  let nonce = initialPq?.nonce ?? crypto.randomBytes(16)
  let resPqMessage: { messageId: Long, object: any }
  if (initialPq) {
    resPqMessage = initialPq.resPqMessage
  } else if (extraPqProbes > 0) {
    await sendLegacyReqPq(client, nonce, 3)
    resPqMessage = await readPlainMessage(client)
    expect(resPqMessage.object._).toBe('mt_resPQ')

    for (let probe = 0; probe < extraPqProbes; probe++) {
      const laterNonce = crypto.randomBytes(16)
      await sendPlain(client, { _: 'mt_req_pq_multi', nonce: laterNonce }, 4 + probe)
      expect((await readPlainMessage(client)).object._).toBe('mt_resPQ')
    }
  } else {
    await sendPlain(client, { _: 'mt_req_pq_multi', nonce }, 4)
    resPqMessage = await readPlainMessage(client)
  }

  const resPq = resPqMessage.object
  expect(resPq._).toBe('mt_resPQ')
  const serverNonce = resPq.serverNonce
  const [p, q] = await crypto.factorizePQ(resPq.pq)

  const newNonce = crypto.randomBytes(32)
  const pqInner = temp
    ? {
      _: 'mt_p_q_inner_data_temp_dc', pq: resPq.pq, p, q, nonce, newNonce, serverNonce,
      dc: 1, expiresIn: tempExpiresIn,
    }
    : { _: 'mt_p_q_inner_data_dc', pq: resPq.pq, p, q, nonce, newNonce, serverNonce, dc: 1 }
  const encryptedData = rsaPad(TlBinaryWriter.serializeObject(__tlWriterMap, pqInner), pubKey)

  const requestDhParams = plainFrame({
    _: 'mt_req_DH_params', nonce, serverNonce, p, q,
    publicKeyFingerprint: Long.fromString(pubKey.fingerprint, true, 16), encryptedData,
  }, 8)
  if (acknowledgePlaintextResponses && batchFirstAcknowledgement) {
    await client.sendBatch([
      plainFrame({ _: 'mt_msgs_ack', msgIds: [resPqMessage.messageId] }, 5),
      requestDhParams,
    ])
  } else {
    if (acknowledgePlaintextResponses) {
      await sendPlain(client, { _: 'mt_msgs_ack', msgIds: [resPqMessage.messageId] }, 5)
    }
    await client.send(requestDhParams)
  }

  const dhParamsMessage = await readPlainMessage(client)
  const dhParams = dhParamsMessage.object
  expect(dhParams._).toBe('mt_server_DH_params_ok')
  if (acknowledgePlaintextResponses) {
    await sendPlain(client, { _: 'mt_msgs_ack', msgIds: [dhParamsMessage.messageId] }, 9)
  }

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

  const dhGenMessage = await readPlainMessage(client)
  const dhGen = dhGenMessage.object
  expect(dhGen._).toBe('mt_dh_gen_ok')
  if (acknowledgePlaintextResponses) {
    await sendPlain(client, { _: 'mt_msgs_ack', msgIds: [dhGenMessage.messageId] }, 13)
  }

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
  return clientEncryptWithMessageId(key, body, salt, sessionId, makeMsgId(sub))
}

function clientEncryptWithMessageId(
  key: ClientKey,
  body: Uint8Array,
  salt: Long,
  sessionId: Long,
  messageId: Long,
): Uint8Array {
  const inner = TlBinaryWriter.manual(16 + body.length)
  inner.long(messageId)
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

async function bindTempAuthKey(
  client: TestClient,
  perm: ClientKey,
  temp: ClientKey,
  sessionId: Long,
  expiresIn = 3600,
  wrapper: 'bare' | 'initialized' | 'gzip' = 'bare',
): Promise<void> {
  const bindInner = {
    _: 'mt_bind_auth_key_inner',
    nonce: Long.fromBytesLE(Array.from(crypto.randomBytes(8))),
    tempAuthKeyId: Long.fromBytesLE(Array.from(temp.authKeyId)),
    permAuthKeyId: Long.fromBytesLE(Array.from(perm.authKeyId)),
    tempSessionId: sessionId,
    expiresAt: nowSec() + expiresIn,
  }
  const bw = TlBinaryWriter.alloc(__tlWriterMap, 80)
  bw.raw(crypto.randomBytes(16))
  bw.long(makeMsgId(4))
  bw.int(0)
  bw.int(40)
  bw.object(bindInner)
  const msgNoPad = bw.result()
  bw.raw(crypto.randomBytes(8))
  const msgKey = crypto.sha1(msgNoPad).subarray(4, 20)
  const encInner = createAesIgeForMessageOld(crypto, perm.authKey, msgKey, true).encrypt(bw.result())
  const bindRequest = {
    _: 'auth.bindTempAuthKey',
    permAuthKeyId: bindInner.permAuthKeyId,
    nonce: bindInner.nonce,
    expiresAt: bindInner.expiresAt,
    encryptedMessage: u8.concat3(perm.authKeyId, msgKey, encInner),
  }
  const bindReq = wrapper === 'initialized'
    ? serializeInitializedRpc(bindRequest)
    : wrapper === 'gzip'
      ? invokeWithLayerPacked(bindRequest, gzipSync)
      : TlBinaryWriter.serializeObject(__tlWriterMap, bindRequest as unknown as { _: string })
  await client.send(clientEncrypt(temp, bindReq, temp.salt, sessionId, 4))
  expect(await readRpcResult(client, temp)).toEqual({ _: 'boolTrue' })
}

async function sendForgedBindTempAuthKey(
  client: TestClient,
  victim: ClientKey,
  attacker: ClientKey,
  temp: ClientKey,
  sessionId: Long,
  wrapper: 'bare' | 'initialized' | 'gzip',
): Promise<void> {
  const bindRequest = {
    _: 'auth.bindTempAuthKey',
    permAuthKeyId: Long.fromBytesLE(Array.from(victim.authKeyId)),
    nonce: Long.fromBytesLE(Array.from(crypto.randomBytes(8))),
    expiresAt: nowSec() + 3600,
    // This claims the victim's permanent identity, but is sealed by the
    // attacker's key and therefore cannot prove possession of the victim key.
    encryptedMessage: u8.concat3(attacker.authKeyId, crypto.randomBytes(16), crypto.randomBytes(16)),
  }
  const request = wrapper === 'initialized'
    ? serializeInitializedRpc(bindRequest)
    : wrapper === 'gzip'
      ? invokeWithLayerPacked(bindRequest, gzipSync)
      : TlBinaryWriter.serializeObject(__tlWriterMap, bindRequest as { _: string })
  await client.send(clientEncrypt(temp, request, temp.salt, sessionId, 4))
}

/** Decrypt a server→client message, returning the inner object reader positioned at the body. */
function clientDecrypt(key: ClientKey, data: Uint8Array, readerMap: TlReaderMap = __tlReaderMap): TlBinaryReader {
  expect(typed.equal(data.subarray(0, 8), key.authKeyId)).toBe(true)
  const messageKey = data.subarray(8, 24)
  let ct = data.subarray(24)
  if (ct.byteLength % 16) ct = ct.subarray(0, ct.byteLength - (ct.byteLength % 16))
  const ige = createAesIgeForMessage(crypto, key.authKey, messageKey, false)
  const plain = ige.decrypt(ct)
  const reader = new TlBinaryReader(readerMap, plain)
  reader.seek(16) // salt(8) + session_id(8)
  const msgId = reader.long(true)
  // Telegram Desktop rejects server messages whose low bits retain the
  // client's 0 mod 4 parity, even when their timestamp and encryption are valid.
  expect(msgId.getLowBitsUnsigned() & 3).toBe(1)
  reader.uint() // seq_no
  reader.uint() // length
  return reader
}

function serverSessionId(key: ClientKey, data: Uint8Array): Long {
  expect(typed.equal(data.subarray(0, 8), key.authKeyId)).toBe(true)
  const messageKey = data.subarray(8, 24)
  let ciphertext = data.subarray(24)
  if (ciphertext.byteLength % 16) ciphertext = ciphertext.subarray(0, ciphertext.byteLength - (ciphertext.byteLength % 16))
  const plain = createAesIgeForMessage(crypto, key.authKey, messageKey, false).decrypt(ciphertext)
  return new TlBinaryReader(__tlReaderMap, plain, 8).long(true)
}

async function startServer(
  onDebug?: MtprotoDebugListener,
  options: { rsaKey?: ServerRsaKey, authKeyStore?: AuthKeyStore } = {},
): Promise<{
  ctx: Context
  port: number
  pubKey: any
  uploadedParts: Uint8Array[]
  transferAuthKeyIds: Uint8Array[]
  downloadBytes: Uint8Array
  register: Mtproto['register']
  broadcastUpdate: (update: tl.TypeUpdates) => void
  sendUpdateToAuthKey: (
    authKeyId: Uint8Array,
    update: tl.TypeUpdates,
    excludeConnection?: ServerConnection,
  ) => number
  stop: () => Promise<void>
}> {
  const rsaKey = options.rsaKey ?? generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)

  const ctx = new Context()
  const fiber = ctx.plugin(Mtproto, {
    port: 0, host: '127.0.0.1', rsaKey, log, authKeyStore: options.authKeyStore,
  })
  await fiber
  const disposeDebug = onDebug ? ctx.on('mtproto/debug', onDebug) : undefined

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

  ctx.mtproto.register('updates.getState', async () => ({
    _: 'updates.state', pts: 1, qts: 0, date: nowSec(), seq: 0, unreadCount: 0,
  }))

  // A handler returning a bare Vector<X> (0x1cb5c415 + count + items) — the shape
  // users.getUsers and the legacy messages.getDialogFilters return.
  ctx.mtproto.register('users.getUsers', async () => bareVector([
    { _: 'userEmpty', id: 1 },
    { _: 'userEmpty', id: 2 },
  ]))

  ctx.mtproto.register('messages.getDialogs', async (rpc) => ({
    _: 'messages.dialogs',
    dialogs: [{
      _: 'dialog', peer: { _: 'peerUser', userId: 42 }, topMessage: 7,
      readInboxMaxId: 7, readOutboxMaxId: 7, unreadCount: 0,
      unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    }],
    messages: [{
      _: 'message', id: 7, fromId: { _: 'peerUser', userId: 42 },
      peerId: { _: 'peerUser', userId: 42 }, date: nowSec(),
      message: `layer:${rpc.apiLayer ?? 0}`,
    }],
    chats: [],
    users: [{ _: 'user', id: 42, firstName: 'Alice', contact: true, mutualContact: true }],
  }))

  ctx.mtproto.register('users.getFullUser', async () => ({
    _: 'users.userFull',
    fullUser: {
      _: 'userFull', id: 42,
      settings: { _: 'peerSettings' },
      notifySettings: { _: 'peerNotifySettings' },
      commonChatsCount: 0,
    },
    chats: [],
    users: [{ _: 'user', id: 42, firstName: 'Alice', contact: true, mutualContact: true }],
  }))

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

  const uploadedParts: Uint8Array[] = []
  const transferAuthKeyIds: Uint8Array[] = []
  ctx.mtproto.register('upload.saveFilePart', async (rpc, req) => {
    const input = req as tl.upload.RawSaveFilePartRequest
    uploadedParts.push(new Uint8Array(input.bytes))
    transferAuthKeyIds.push(new Uint8Array(rpc.authKeyId!))
    return { _: 'boolTrue' } as unknown as tl.TlObject
  })
  const downloadBytes = new TextEncoder().encode('media connection download')
  ctx.mtproto.register('upload.getFile', async (rpc) => {
    transferAuthKeyIds.push(new Uint8Array(rpc.authKeyId!))
    return { _: 'upload.file', type: { _: 'storage.fileUnknown' }, mtime: nowSec(), bytes: downloadBytes }
  })

  const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
  return {
    ctx,
    port: ctx.mtproto.port, pubKey, uploadedParts, transferAuthKeyIds, downloadBytes,
    register: ctx.mtproto.register.bind(ctx.mtproto),
    broadcastUpdate: (update) => ctx.mtproto.broadcastUpdate(update),
    sendUpdateToAuthKey: (authKeyId, update, excludeConnection) =>
      ctx.mtproto.sendUpdateToAuthKey(authKeyId, update, excludeConnection),
    stop: async () => {
      disposeDebug?.()
      await fiber.dispose()
    },
  }
}

describe('e2e: obfuscated transport + PFS + RPC', () => {
  it('routes a real encrypted RPC through packet and RPC derived-context fibers', async () => {
    await crypto.initialize?.()
    const { ctx, port, pubKey, stop } = await startServer()
    const packetSequences: number[] = []
    const rpcFibers: string[] = []
    const disposePacket = ctx.on('mtproto/packet', async function (packet, next) {
      expect(Context.is(this)).toBe(true)
      expect(this.mtprotoPacket).toBe(packet)
      expect(this.mtprotoConnection.id).toBe(packet.connection.id)
      packetSequences.push(packet.sequence)
      await next()
    })
    const disposeRpc = ctx.on('mtproto/rpc', async function (request, next) {
      if (request._ === 'help.getConfig') {
        expect(Context.is(this)).toBe(true)
        expect(this.mtprotoRpc.request).toBe(request)
        expect(this.mtprotoRpc.connection).toBe(this.mtprotoConnection)
        expect(this.mtprotoPacket.connection).toBe(this.mtprotoConnection)
        rpcFibers.push(this.fiber.name)
      }
      return next()
    })
    const client = await TestClient.connect(port)
    try {
      const key = await doClientHandshake(client, pubKey, false)
      const clientSessionId = new Long(0x31313131, 0x31313131)
      await client.send(clientEncrypt(
        key,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        key.salt,
        clientSessionId,
        4,
      ))

      expect(await readRpcResult(client, key)).toMatchObject({ _: 'config', thisDc: 1 })
      expect(packetSequences.length).toBeGreaterThan(1)
      expect(packetSequences).toEqual([...packetSequences].sort((left, right) => left - right))
      expect(rpcFibers).toEqual(['rpcInvocationFiber'])
    } finally {
      disposeRpc()
      disposePacket()
      client.close()
      await stop()
    }
  })

  it('continues req_DH_params on a different TCP connection than req_pq', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const probe = await TestClient.connect(port)
      const nonce = crypto.randomBytes(16)
      await sendLegacyReqPq(probe, nonce, 3)
      const resPqMessage = await readPlainMessage(probe)
      expect(resPqMessage.object._).toBe('mt_resPQ')
      probe.close()

      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(
        client,
        pubKey,
        false,
        3600,
        false,
        false,
        0,
        { nonce, resPqMessage },
      )
      const sessionId = new Long(0x72727272, 0x72727272)
      await client.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        sessionId,
        16,
      ))
      expect(await readRpcResult(client, perm)).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await stop()
    }
  })

  it('continues a TDLib handshake from the first resPQ after many later probes', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false, 3600, false, false, 12)
      const sessionId = new Long(0x71717171, 0x71717171)

      await client.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        sessionId,
        16,
      ))
      expect(await readRpcResult(client, perm)).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await stop()
    }
  })

  it('accepts a coalesced Android acknowledgement and next handshake frame', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false, 3600, true, true)
      const sessionId = crypto.randomBytes(8)
      const sessionView = typed.toDataView(sessionId)
      const sessionLong = new Long(sessionView.getInt32(0, true), sessionView.getInt32(4, true))

      const request = serializeInitializedRpc({ _: 'help.getConfig' })
      await client.send(clientEncrypt(perm, request, perm.salt, sessionLong, 14))

      const config = await readRpcResult(client, perm)
      expect(config).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await stop()
    }
  })

  it('completes perm handshake and answers an RPC over the perm key', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)

      const sessionId = crypto.randomBytes(8)
      const sdv = typed.toDataView(sessionId)
      const sessionLong = new Long(sdv.getInt32(0, true), sdv.getInt32(4, true))

      const req = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getConfig' })
      await client.send(clientEncrypt(perm, req, perm.salt, sessionLong, 4))

      const notInitialized = await readRpcResult(client, perm)
      expect(notInitialized).toMatchObject({
        _: 'mt_rpc_error', errorCode: 400, errorMessage: 'CONNECTION_NOT_INITED',
      })

      const initializedReq = serializeInitializedRpc({ _: 'help.getConfig' })
      await client.send(clientEncrypt(perm, initializedReq, perm.salt, sessionLong, 5))

      const config = await readRpcResult(client, perm)
      expect(config._).toBe('config')
      expect(config.thisDc).toBe(1)

      expect(debugEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          direction: 'client->server', phase: 'connection',
          connectionId: 'conn-1', payload: expect.objectContaining({ _: 'connection_opened' }),
        }),
        expect.objectContaining({
          direction: 'client->server', phase: 'handshake', connectionId: 'conn-1',
          messageId: expect.any(Long), payload: expect.objectContaining({ _: 'mt_req_pq_multi' }),
        }),
        expect.objectContaining({
          direction: 'server->client', phase: 'handshake', connectionId: 'conn-1',
          messageId: expect.any(Long), payload: expect.objectContaining({ _: 'mt_resPQ' }),
        }),
        expect.objectContaining({
          direction: 'client->server', phase: 'message', connectionId: 'conn-1',
          messageId: expect.any(Long), seqNo: expect.any(Number),
          payload: expect.objectContaining({ _: 'help.getConfig' }),
        }),
        expect.objectContaining({
          direction: 'server->client', phase: 'message', connectionId: 'conn-1',
          messageId: expect.any(Long), seqNo: expect.any(Number),
          payload: expect.objectContaining({
            _: 'rpc_result', result: expect.objectContaining({ _: 'config' }),
          }),
        }),
      ]))

      const getUsers = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'users.getUsers',
        id: [{ _: 'inputUserSelf' }],
      } as { _: string })
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

  it('executes an Android-style invokeAfterMsg only after its referenced RPC completes', async () => {
    await crypto.initialize?.()
    const { port, pubKey, register, stop } = await startServer()
    const order: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    register('help.getAppConfig', async () => {
      order.push('first:start')
      markFirstStarted()
      await firstGate
      order.push('first:end')
      return { _: 'help.appConfig', hash: 1, config: { _: 'jsonObject', value: [] } }
    })
    register('help.getNearestDc', async () => {
      order.push('second:run')
      return { _: 'nearestDc', country: 'test', thisDc: 1, nearestDc: 1 } as unknown as tl.TlObject
    })

    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x51515151, 0x51515151)
      const firstMessageId = makeMsgId(40)
      const secondMessageId = firstMessageId.add(4)
      const first = serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 })
      await client.send(clientEncryptWithMessageId(perm, first, perm.salt, sessionId, firstMessageId))
      await firstStarted

      const second = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'invokeAfterMsg',
        msgId: firstMessageId,
        query: {
          _: 'invokeWithLayer',
          layer: CURRENT_API_LAYER,
          query: {
            _: 'initConnection', apiId: 1, deviceModel: 'Android', systemVersion: 'test',
            appVersion: 'test', systemLangCode: 'en', langPack: 'android', langCode: 'en',
            query: { _: 'help.getNearestDc' },
          },
        },
      } as { _: string })
      await client.send(clientEncryptWithMessageId(perm, second, perm.salt, sessionId, secondMessageId))

      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      expect(order).toEqual(['first:start'])

      releaseFirst()
      const firstResult = await readRpcResultEnvelope(client, perm)
      const secondResult = await readRpcResultEnvelope(client, perm)
      expect(firstResult.requestMessageId.toString()).toBe(firstMessageId.toString())
      expect(firstResult.result).toMatchObject({ _: 'help.appConfig', hash: 1 })
      expect(secondResult.requestMessageId.toString()).toBe(secondMessageId.toString())
      expect(secondResult.result).toMatchObject({ _: 'nearestDc', thisDc: 1 })
      expect(order).toEqual(['first:start', 'first:end', 'second:run'])
      client.close()
    } finally {
      releaseFirst()
      await stop()
    }
  })

  it('answers an independent RPC while an earlier ordinary handler is blocked', async () => {
    await crypto.initialize?.()
    const { port, pubKey, register, stop } = await startServer()
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    let markSlowStarted!: () => void
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve })
    register('help.getAppConfig', async () => {
      markSlowStarted()
      await slowGate
      return { _: 'help.appConfig', hash: 9, config: { _: 'jsonObject', value: [] } }
    })
    register('help.getNearestDc', async () => ({
      _: 'nearestDc', country: 'test', thisDc: 1, nearestDc: 1,
    } as unknown as tl.TlObject))

    let client: TestClient | undefined
    try {
      client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x71717171, 0x71717171)
      const slowMessageId = makeMsgId(52)
      const fastMessageId = slowMessageId.add(4)

      await client.send(clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        perm.salt,
        sessionId,
        slowMessageId,
      ))
      await slowStarted

      const fast = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getNearestDc' })
      await client.send(clientEncryptWithMessageId(
        perm,
        fast,
        perm.salt,
        sessionId,
        fastMessageId,
      ))

      const fastResult = await within(
        readRpcResultEnvelope(client, perm),
        3_000,
        'independent RPC response',
      )
      expect(fastResult.requestMessageId.toString()).toBe(fastMessageId.toString())
      expect(fastResult.result).toMatchObject({ _: 'nearestDc', thisDc: 1 })

      releaseSlow()
      const slowResult = await readRpcResultEnvelope(client, perm)
      expect(slowResult.requestMessageId.toString()).toBe(slowMessageId.toString())
      expect(slowResult.result).toMatchObject({ _: 'help.appConfig', hash: 9 })
    } finally {
      releaseSlow()
      client?.close()
      await stop()
    }
  })

  it('acks a slow RPC immediately and executes a retransmitted message id only once', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, register, stop } = await startServer(event => debugEvents.push(event))
    let calls = 0
    let releaseSlow!: () => void
    const slowGate = new Promise<void>(resolve => { releaseSlow = resolve })
    let markSlowStarted!: () => void
    const slowStarted = new Promise<void>(resolve => { markSlowStarted = resolve })
    register('help.getAppConfig', async () => {
      calls += 1
      markSlowStarted()
      await slowGate
      return { _: 'help.appConfig', hash: calls, config: { _: 'jsonObject', value: [] } }
    })

    let client: TestClient | undefined
    try {
      client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x72727272, 0x72727272)
      const messageId = makeMsgId(56)
      const encrypted = clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        perm.salt,
        sessionId,
        messageId,
      )

      await client.send(encrypted)
      await slowStarted
      await vi.waitFor(() => expect(debugEvents.some((event) => {
        if (event.direction !== 'server->client') return false
        const payload = event.payload as { _?: string, msgIds?: Long[] }
        return payload._ === 'mt_msgs_ack'
          && Boolean(payload.msgIds?.some(id => id.toString() === messageId.toString()))
      })).toBe(true))

      await client.send(encrypted)
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      expect(calls).toBe(1)

      releaseSlow()
      const first = await readRpcResultEnvelope(client, perm)
      const second = await readRpcResultEnvelope(client, perm)
      expect(first.requestMessageId.toString()).toBe(messageId.toString())
      expect(second.requestMessageId.toString()).toBe(messageId.toString())
      expect(first.result).toMatchObject({ _: 'help.appConfig', hash: 1 })
      expect(second.result).toMatchObject({ _: 'help.appConfig', hash: 1 })
      expect(calls).toBe(1)
    } finally {
      releaseSlow()
      client?.close()
      await stop()
    }
  })

  it('answers a fast RPC from the same Android-style container while a sibling is blocked', async () => {
    await crypto.initialize?.()
    const { port, pubKey, register, stop } = await startServer()
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    let markSlowStarted!: () => void
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve })
    register('help.getAppConfig', async () => {
      markSlowStarted()
      await slowGate
      return { _: 'help.appConfig', hash: 11, config: { _: 'jsonObject', value: [] } }
    })
    register('help.getNearestDc', async () => ({
      _: 'nearestDc', country: 'test', thisDc: 1, nearestDc: 1,
    } as unknown as tl.TlObject))

    let client: TestClient | undefined
    try {
      client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x72727272, 0x72727272)
      const slowMessageId = makeMsgId(54)
      const fastMessageId = slowMessageId.add(4)
      const containerMessageId = fastMessageId.add(4)
      const slow = serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 })
      const fast = serializeInitializedRpc({ _: 'help.getNearestDc' })
      const container = TlBinaryWriter.manual(8 + 16 + slow.length + 16 + fast.length)
      container.uint(0x73f1f8dc)
      container.uint(2)
      container.long(slowMessageId)
      container.uint(1)
      container.uint(slow.length)
      container.raw(slow)
      container.long(fastMessageId)
      container.uint(3)
      container.uint(fast.length)
      container.raw(fast)

      await client.send(clientEncryptWithMessageId(
        perm, container.result(), perm.salt, sessionId, containerMessageId,
      ))
      await slowStarted

      const fastResult = await within(
        readRpcResultEnvelope(client, perm),
        3_000,
        'same-container independent RPC response',
      )
      expect(fastResult.requestMessageId.toString()).toBe(fastMessageId.toString())
      expect(fastResult.result).toMatchObject({ _: 'nearestDc', thisDc: 1 })

      releaseSlow()
      const slowResult = await readRpcResultEnvelope(client, perm)
      expect(slowResult.requestMessageId.toString()).toBe(slowMessageId.toString())
      expect(slowResult.result).toMatchObject({ _: 'help.appConfig', hash: 11 })
    } finally {
      releaseSlow()
      client?.close()
      await stop()
    }
  })

  it('echoes every ping message id and keeps accepting RPCs on the same socket', async () => {
    await crypto.initialize?.()
    const { port, pubKey, register, stop } = await startServer()
    register('help.getNearestDc', async () => ({
      _: 'nearestDc', country: 'test', thisDc: 1, nearestDc: 1,
    } as unknown as tl.TlObject))
    let client: TestClient | undefined
    try {
      client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x60606060, 0x10101010)

      const ordinaryMessageId = makeMsgId(60)
      const ordinaryPingId = Long.fromInt(701)
      const ordinaryPing = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: ordinaryPingId,
      } as { _: string })
      await client.send(clientEncryptWithMessageId(
        perm, ordinaryPing, perm.salt, sessionId, ordinaryMessageId,
      ))
      const ordinaryPong = await within(
        readEncryptedObject(client, perm, 'mt_pong'), 3_000, 'ordinary pong',
      )
      expect(ordinaryPong.msgId.eq(ordinaryMessageId)).toBe(true)
      expect(ordinaryPong.pingId.eq(ordinaryPingId)).toBe(true)

      const delayedMessageId = ordinaryMessageId.add(4)
      const delayedPingId = Long.fromInt(702)
      const delayedPing = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping_delay_disconnect', pingId: delayedPingId, disconnectDelay: 10,
      } as { _: string })
      await client.send(clientEncryptWithMessageId(
        perm, delayedPing, perm.salt, sessionId, delayedMessageId,
      ))
      const delayedPong = await within(
        readEncryptedObject(client, perm, 'mt_pong'), 3_000, 'delayed pong',
      )
      expect(delayedPong.msgId.eq(delayedMessageId)).toBe(true)
      expect(delayedPong.pingId.eq(delayedPingId)).toBe(true)

      const innerMessageId = delayedMessageId.add(4)
      const containerMessageId = innerMessageId.add(4)
      const containerPingId = Long.fromInt(703)
      const containerPing = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: containerPingId,
      } as { _: string })
      const container = TlBinaryWriter.manual(8 + 16 + containerPing.length)
      container.uint(0x73f1f8dc)
      container.uint(1)
      container.long(innerMessageId)
      container.uint(0)
      container.uint(containerPing.length)
      container.raw(containerPing)
      await client.send(clientEncryptWithMessageId(
        perm, container.result(), perm.salt, sessionId, containerMessageId,
      ))
      const containerPong = await within(
        readEncryptedObject(client, perm, 'mt_pong'), 3_000, 'container pong',
      )
      expect(containerPong.msgId.eq(innerMessageId)).toBe(true)
      expect(containerPong.pingId.eq(containerPingId)).toBe(true)

      const rpcMessageId = containerMessageId.add(4)
      await client.send(clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getNearestDc' }),
        perm.salt,
        sessionId,
        rpcMessageId,
      ))
      const response = await within(
        readRpcResultEnvelope(client, perm), 3_000, 'RPC after pings',
      )
      expect(response.requestMessageId.eq(rpcMessageId)).toBe(true)
      expect(response.result).toMatchObject({ _: 'nearestDc', thisDc: 1 })
    } finally {
      client?.close()
      await stop()
    }
  })

  it('keeps a queued RPC response on its request session after a later ping', async () => {
    await crypto.initialize?.()
    const { port, pubKey, register, stop } = await startServer()
    let releaseRpc!: () => void
    const rpcBlocked = new Promise<void>((resolve) => { releaseRpc = resolve })
    let markRpcStarted!: () => void
    const rpcStarted = new Promise<void>((resolve) => { markRpcStarted = resolve })
    register('help.getAppConfig', async () => {
      markRpcStarted()
      await rpcBlocked
      return { _: 'help.appConfig', hash: 7, config: { _: 'jsonObject', value: [] } }
    })

    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionA = new Long(0x61616161, 0x11111111)
      const sessionB = new Long(0x62626262, 0x22222222)
      const requestMessageId = makeMsgId(60)
      await client.send(clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        perm.salt,
        sessionA,
        requestMessageId,
      ))
      await rpcStarted

      const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: Long.fromInt(7),
      } as { _: string })
      await client.send(clientEncrypt(perm, ping, perm.salt, sessionB, 64))
      const pong = await readServerObject(
        client,
        perm,
        value => value._ === 'mt_pong',
      )
      expect(pong.sessionId.toString()).toBe(sessionB.toString())
      expect(pong.value).toMatchObject({ _: 'mt_pong', pingId: Long.fromInt(7) })

      releaseRpc()
      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'help.appConfig', hash: 7 })
      expect(response.sessionId.toString()).toBe(sessionA.toString())
      client.close()
    } finally {
      releaseRpc()
      await stop()
    }
  })

  it('returns MSG_WAIT_FAILED when invokeAfterMsg references an unknown message id', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x52525252, 0x52525252)
      const requestMessageId = makeMsgId(44)
      const unknownDependency = requestMessageId.subtract(4000)
      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'invokeAfterMsg',
        msgId: unknownDependency,
        query: {
          _: 'invokeWithLayer', layer: CURRENT_API_LAYER,
          query: {
            _: 'initConnection', apiId: 1, deviceModel: 'Android', systemVersion: 'test',
            appVersion: 'test', systemLangCode: 'en', langPack: 'android', langCode: 'en',
            query: { _: 'help.getConfig' },
          },
        },
      } as { _: string })
      await client.send(clientEncryptWithMessageId(perm, request, perm.salt, sessionId, requestMessageId))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({
        _: 'mt_rpc_error', errorCode: 500, errorMessage: 'MSG_WAIT_FAILED',
      })
      const debugResponse = debugEvents.find((event) => (
        event.direction === 'server->client'
        && (event.payload as { _?: string })._ === 'rpc_result'
        && ((event.payload as { result?: { errorMessage?: string } }).result?.errorMessage === 'MSG_WAIT_FAILED')
      ))
      expect(debugResponse).toBeDefined()
      expect((debugResponse!.payload as { reqMsgId: Long }).reqMsgId.toString()).toBe(requestMessageId.toString())
      client.close()
    } finally {
      await stop()
    }
  })

  it('honors a completed invokeAfterMsg dependency from a previous connection', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const first = await TestClient.connect(port)
      const perm = await doClientHandshake(first, pubKey, false)
      const firstSession = new Long(0x56565656, 0x56565656)
      const dependencyMessageId = makeMsgId(45)
      await first.send(clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        firstSession,
        dependencyMessageId,
      ))
      expect(await readRpcResult(first, perm)).toMatchObject({ _: 'config', thisDc: 1 })
      first.close()

      const resumed = await TestClient.connect(port)
      const resumedSession = new Long(0x57575757, 0x57575757)
      const requestMessageId = dependencyMessageId.add(4)
      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'invokeAfterMsg',
        msgId: dependencyMessageId,
        query: {
          _: 'invokeWithLayer', layer: CURRENT_API_LAYER,
          query: {
            _: 'initConnection', apiId: 1, deviceModel: 'Android', systemVersion: 'test',
            appVersion: 'test', systemLangCode: 'en', langPack: 'android', langCode: 'en',
            query: { _: 'help.getConfig' },
          },
        },
      } as { _: string })
      await resumed.send(clientEncryptWithMessageId(
        perm,
        request,
        perm.salt,
        resumedSession,
        requestMessageId,
      ))

      const response = await readRpcResultEnvelope(resumed, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'config', thisDc: 1 })
      resumed.close()
    } finally {
      await stop()
    }
  })

  it('resumes an invokeAfterMsg wrapper whose dependency predates a server restart', async () => {
    await crypto.initialize?.()
    const rsaKey = generateRsaKeyPair()
    const storePath = join(mkdtempSync(join(tmpdir(), 'mtproto-invoke-after-restart-')), 'auth-keys.json')
    const dependencyMessageId = Long.fromBits(45, nowSec() - 10)
    let perm!: ClientKey

    const first = await startServer(undefined, {
      rsaKey, authKeyStore: new FileAuthKeyStore(storePath),
    })
    try {
      const client = await TestClient.connect(first.port)
      perm = await doClientHandshake(client, first.pubKey, false)
      const sessionId = new Long(0x58585858, 0x58585858)
      await client.send(clientEncryptWithMessageId(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        sessionId,
        dependencyMessageId,
      ))
      expect(await readRpcResult(client, perm)).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await first.stop()
    }

    const second = await startServer(undefined, {
      rsaKey, authKeyStore: new FileAuthKeyStore(storePath),
    })
    try {
      const client = await TestClient.connect(second.port)
      const sessionId = new Long(0x59595959, 0x59595959)
      const requestMessageId = makeMsgId(49)
      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'invokeAfterMsg',
        msgId: dependencyMessageId,
        query: {
          _: 'invokeWithLayer', layer: CURRENT_API_LAYER,
          query: {
            _: 'initConnection', apiId: 1, deviceModel: 'Android', systemVersion: 'test',
            appVersion: 'test', systemLangCode: 'en', langPack: 'android', langCode: 'en',
            query: { _: 'help.getConfig' },
          },
        },
      } as { _: string })
      await client.send(clientEncryptWithMessageId(
        perm,
        request,
        perm.salt,
        sessionId,
        requestMessageId,
      ))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await second.stop()
    }
  })

  it('returns an explicit rpc_error for an unhandled content-related TL message', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x53535353, 0x53535353)
      const requestMessageId = makeMsgId(48)
      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_msg_resend_req', msgIds: [Long.ONE],
      } as { _: string })
      await client.send(clientEncryptWithMessageId(perm, request, perm.salt, sessionId, requestMessageId))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({
        _: 'mt_rpc_error', errorCode: 500,
        errorMessage: 'METHOD_NOT_IMPLEMENTED: mt_msg_resend_req',
      })
      const debugResponse = debugEvents.find((event) => (
        event.direction === 'server->client'
        && (event.payload as { _?: string })._ === 'rpc_result'
        && ((event.payload as { result?: { errorMessage?: string } }).result?.errorMessage
          === 'METHOD_NOT_IMPLEMENTED: mt_msg_resend_req')
      ))
      expect(debugResponse).toBeDefined()
      expect((debugResponse!.payload as { reqMsgId: Long }).reqMsgId.toString()).toBe(requestMessageId.toString())
      client.close()
    } finally {
      await stop()
    }
  })

  it('answers rpc_drop_answer with a valid MTProto drop status', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x54545454, 0x54545454)
      const requestMessageId = makeMsgId(52)
      const droppedRequestMessageId = requestMessageId.subtract(4000)
      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_rpc_drop_answer', reqMsgId: droppedRequestMessageId,
      } as { _: string })
      await client.send(clientEncryptWithMessageId(perm, request, perm.salt, sessionId, requestMessageId))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toEqual({ _: 'mt_rpc_answer_unknown' })
      const debugResponse = debugEvents.find((event) => (
        event.direction === 'server->client'
        && (event.payload as { _?: string })._ === 'rpc_result'
        && (event.payload as { result?: { _?: string } }).result?._ === 'mt_rpc_answer_unknown'
      ))
      expect(debugResponse).toBeDefined()
      client.close()
    } finally {
      await stop()
    }
  })

  it('unwraps gzip_packed RPC requests before dispatch', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x55555555, 0x55555555)
      const request = gzipPacked(serializeInitializedRpc({ _: 'help.getConfig' }))
      await client.send(clientEncrypt(perm, request, perm.salt, sessionId, 56))

      const response = await readRpcResult(client, perm)
      expect(response).toMatchObject({ _: 'config', thisDc: 1 })
      expect(debugEvents.some((event) => (
        event.direction === 'client->server'
        && (event.payload as { _?: string })._ === 'invokeWithLayer'
      ))).toBe(true)
      expect(debugEvents.some((event) => (
        (event.payload as { _?: string })._ === 'unparsed'
        && (event.payload as { constructorId?: number }).constructorId === GZIP_PACKED_ID
      ))).toBe(false)
      client.close()
    } finally {
      await stop()
    }
  })

  it('unwraps nested gzip_packed RPC requests inside a message container', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x56565656, 0x56565656)
      const request = gzipPacked(gzipPacked(serializeInitializedRpc({ _: 'help.getConfig' })))
      const requestMessageId = makeMsgId(60)
      const container = TlBinaryWriter.manual(8 + 16 + request.length)
      container.uint(0x73f1f8dc)
      container.uint(1)
      container.long(requestMessageId)
      container.uint(1)
      container.uint(request.length)
      container.raw(request)

      await client.send(clientEncrypt(perm, container.result(), perm.salt, sessionId, 64))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'config', thisDc: 1 })
      expect(debugEvents.some((event) => (
        event.direction === 'client->server'
        && (event.payload as { _?: string })._ === 'invokeWithLayer'
      ))).toBe(true)
      expect(debugEvents.some((event) => (
        (event.payload as { _?: string })._ === 'unparsed'
        && (event.payload as { constructorId?: number }).constructorId === GZIP_PACKED_ID
      ))).toBe(false)
      client.close()
    } finally {
      await stop()
    }
  })

  it('unwraps a gzip_packed invokeWithLayer query inside a message container', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x57575757, 0x57575757)
      const request = invokeWithLayerGzip({ _: 'help.getConfig' })
      const requestMessageId = makeMsgId(68)
      const container = TlBinaryWriter.manual(8 + 16 + request.length)
      container.uint(0x73f1f8dc)
      container.uint(1)
      container.long(requestMessageId)
      container.uint(1)
      container.uint(request.length)
      container.raw(request)

      await client.send(clientEncrypt(perm, container.result(), perm.salt, sessionId, 72))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'config', thisDc: 1 })
      expect(debugEvents.some((event) => (
        event.direction === 'client->server'
        && (event.payload as { _?: string })._ === 'invokeWithLayer'
      ))).toBe(true)
      expect(debugEvents.some((event) => (
        (event.payload as { _?: string })._ === 'unparsed'
        && (event.payload as { constructorId?: number }).constructorId === GZIP_PACKED_ID
      ))).toBe(false)
      client.close()
    } finally {
      await stop()
    }
  })

  it.each([
    ['zlib', deflateSync],
    ['raw DEFLATE', deflateRawSync],
  ])('unwraps a %s-packed invokeWithLayer query inside a message container', async (_format, compress) => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop } = await startServer((event) => debugEvents.push(event))
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x58585858, 0x58585858)
      const request = invokeWithLayerPacked({ _: 'help.getConfig' }, compress)
      const requestMessageId = makeMsgId(76)
      const container = TlBinaryWriter.manual(8 + 16 + request.length)
      container.uint(0x73f1f8dc)
      container.uint(1)
      container.long(requestMessageId)
      container.uint(1)
      container.uint(request.length)
      container.raw(request)

      await client.send(clientEncrypt(perm, container.result(), perm.salt, sessionId, 80))

      const response = await readRpcResultEnvelope(client, perm)
      expect(response.requestMessageId.toString()).toBe(requestMessageId.toString())
      expect(response.result).toMatchObject({ _: 'config', thisDc: 1 })
      expect(debugEvents.some((event) => (
        event.direction === 'client->server'
        && (event.payload as { _?: string })._ === 'invokeWithLayer'
      ))).toBe(true)
      expect(debugEvents.some((event) => (
        (event.payload as { _?: string })._ === 'unparsed'
        && (event.payload as { constructorId?: number }).constructorId === GZIP_PACKED_ID
      ))).toBe(false)
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

      await bindTempAuthKey(client, perm, temp, sessionLong)

      // Now a real RPC over the temp key.
      const req = serializeInitializedRpc({ _: 'help.getConfig' })
      await client.send(clientEncrypt(temp, req, temp.salt, sessionLong, 6))
      const config = await readRpcResult(client, temp)
      expect(config._).toBe('config')
      client.close()
    } finally {
      await stop()
    }
  })

  it.each([
    ['bare', 'bare'],
    ['initConnection', 'initialized'],
    ['gzip_packed', 'gzip'],
  ] as const)('rejects a forged %s temp-key bind without persisting it or switching to the victim identity', async (_name, wrapper) => {
    await crypto.initialize?.()
    const storePath = join(mkdtempSync(join(tmpdir(), 'mtproto-forged-bind-')), 'auth-keys.json')
    const store = new FileAuthKeyStore(storePath)
    const { port, pubKey, register, stop } = await startServer(undefined, { authKeyStore: store })
    const rpcAuthKeyIds: Array<Uint8Array | null> = []
    register('help.getAppConfig', async (rpc) => {
      rpcAuthKeyIds.push(rpc.authKeyId ? new Uint8Array(rpc.authKeyId) : null)
      return { _: 'help.appConfig', hash: 1, config: { _: 'jsonObject', value: [] } }
    })
    try {
      const victimClient = await TestClient.connect(port)
      const victim = await doClientHandshake(victimClient, pubKey, false)
      const victimSessionId = new Long(0x45454545, 0x45454545)
      await victimClient.send(clientEncrypt(
        victim,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        victim.salt,
        victimSessionId,
        4,
      ))
      expect(await readRpcResult(victimClient, victim)).toMatchObject({ _: 'config', thisDc: 1 })
      expect(store.get(victim.authKeyId)).toMatchObject({ key: victim.authKey })
      victimClient.close()

      const attackerClient = await TestClient.connect(port)
      const attacker = await doClientHandshake(attackerClient, pubKey, false)
      const temp = await doClientHandshake(attackerClient, pubKey, true)
      const sessionId = new Long(0x56565656, 0x56565656)
      await sendForgedBindTempAuthKey(attackerClient, victim, attacker, temp, sessionId, wrapper)

      expect(await readRpcResult(attackerClient, temp)).toEqual({
        _: 'mt_rpc_error', errorCode: 400, errorMessage: 'ENCRYPTED_MESSAGE_INVALID',
      })
      expect(store.get(temp.authKeyId)).toBeUndefined()

      const bareRequest = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'help.getAppConfig', hash: 0,
      } as { _: string })
      await attackerClient.send(clientEncrypt(temp, bareRequest, temp.salt, sessionId, 8))
      expect(await readRpcResult(attackerClient, temp)).toEqual({
        _: 'mt_rpc_error', errorCode: 400, errorMessage: 'CONNECTION_NOT_INITED',
      })

      await attackerClient.send(clientEncrypt(
        temp,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        temp.salt,
        sessionId,
        12,
      ))
      expect(await readRpcResult(attackerClient, temp)).toMatchObject({ _: 'help.appConfig', hash: 1 })
      expect(rpcAuthKeyIds).toHaveLength(1)
      expect(rpcAuthKeyIds[0]).not.toBeNull()
      expect(typed.equal(rpcAuthKeyIds[0]!, victim.authKeyId)).toBe(false)
      expect(typed.equal(rpcAuthKeyIds[0]!, attacker.authKeyId)).toBe(true)
      attackerClient.close()
    } finally {
      await stop()
    }
  })

  it.each([
    ['initConnection', 'initialized'],
    ['gzip_packed', 'gzip'],
  ] as const)('binds a PFS key when TDLib sends auth.bindTempAuthKey through %s', async (_name, wrapper) => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const temp = await doClientHandshake(client, pubKey, true)
      const sessionId = new Long(0x59595959, 0x59595959)

      await bindTempAuthKey(client, perm, temp, sessionId, 3600, wrapper)

      const request = serializeInitializedRpc({ _: 'help.getConfig' })
      await client.send(clientEncrypt(temp, request, temp.salt, sessionId, 84))
      expect(await readRpcResult(client, temp)).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await stop()
    }
  })

  it('uses the complete AyuGram layer 224 profile and retains it for later calls', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop, broadcastUpdate } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionLong = new Long(0x22302230, 0x22302230)
      const ayugramReaderMap = getApiLayerReaderMap(224)
      expect(ayugramReaderMap).not.toBeNull()
      const getDialogs = {
        _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' }, limit: 20, hash: Long.ZERO,
      }

      // Authorization can complete before the first invokeWithLayer request.
      // An update delivered in this window must be held until the server knows
      // that this client expects the layer-224 Message constructor.
      broadcastUpdate({
        _: 'updates',
        updates: [{
          _: 'updateNewMessage',
          message: {
            _: 'message', id: 99,
            fromId: { _: 'peerUser', userId: 42 },
            peerId: { _: 'peerUser', userId: 42 },
            date: nowSec(), message: 'queued before layer negotiation',
          },
          pts: 1, ptsCount: 1,
        }],
        users: [], chats: [], date: nowSec(), seq: 1,
      } as unknown as tl.TypeUpdates)

      const wrapped = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'invokeWithLayer', layer: 224, query: getDialogs,
      } as { _: string })
      await client.send(clientEncrypt(perm, wrapped, perm.salt, sessionLong, 8))
      const queued = (await readServerObject(
        client,
        perm,
        value => value._ === 'updates',
        ayugramReaderMap!,
      )).value as any
      expect(queued.updates).toMatchObject([{ message: { _: 'message', id: 99, message: 'queued before layer negotiation' } }])
      const first = await readRpcResult(client, perm, ayugramReaderMap!)
      expect(first.messages).toMatchObject([{ _: 'message', message: 'layer:224' }])
      expect(first.users).toMatchObject([{ _: 'user', firstName: 'Alice' }])

      const unwrapped = TlBinaryWriter.serializeObject(__tlWriterMap, getDialogs)
      await client.send(clientEncrypt(perm, unwrapped, perm.salt, sessionLong, 12))
      const second = await readRpcResult(client, perm, ayugramReaderMap!)
      expect(second.messages).toMatchObject([{ _: 'message', message: 'layer:224' }])

      const getFullUser = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'users.getFullUser', id: { _: 'inputUserSelf' },
      } as { _: string })
      await client.send(clientEncrypt(perm, getFullUser, perm.salt, sessionLong, 16))
      const fullUser = await readRpcResult(client, perm, ayugramReaderMap!)
      expect(fullUser).toMatchObject({
        _: 'users.userFull', fullUser: { _: 'userFull', id: 42, commonChatsCount: 0 },
      })

      // Media connections reuse the permanent auth key but normally do not send
      // invokeWithLayer themselves. They must inherit the layer negotiated by
      // the main connection before receiving the same account update.
      const media = await TestClient.connect(port)
      const mediaSession = new Long(0x24242424, 0x24242424)
      const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: Long.fromNumber(224),
      } as unknown as { _: string })
      await media.send(clientEncrypt(perm, ping, perm.salt, mediaSession, 20))
      await readEncryptedObject(media, perm, 'mt_pong')
      broadcastUpdate({
        _: 'updates',
        updates: [{
          _: 'updateNewMessage',
          message: {
            _: 'message', id: 100,
            fromId: { _: 'peerUser', userId: 42 },
            peerId: { _: 'peerUser', userId: 42 },
            date: nowSec(), message: 'shared layer update',
          },
          pts: 2, ptsCount: 1,
        }],
        users: [], chats: [], date: nowSec(), seq: 2,
      } as unknown as tl.TypeUpdates)
      let mediaUpdate: any
      for (;;) {
        const frame = await media.read()
        const probe = clientDecrypt(perm, frame, __tlReaderMap)
        const constructor = probe.uint()
        if (constructor === 0x62d6b459) continue // msgs_ack emitted for the ping
        mediaUpdate = clientDecrypt(perm, frame, ayugramReaderMap!).object()
        break
      }
      expect(mediaUpdate.updates).toMatchObject([{ message: { _: 'message', id: 100, message: 'shared layer update' } }])
      media.close()
      client.close()
    } finally {
      await stop()
    }
  })

  it('targets account updates to the main update session instead of media connections', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop, sendUpdateToAuthKey } = await startServer((event) => debugEvents.push(event))
    try {
      const main = await TestClient.connect(port)
      const perm = await doClientHandshake(main, pubKey, false)
      const mainSession = new Long(0x31313131, 0x31313131)
      await main.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'updates.getState' }),
        perm.salt,
        mainSession,
        4,
      ))
      expect(await readRpcResult(main, perm)).toMatchObject({ _: 'updates.state', pts: 1 })

      // A media-style service frame can use another MTProto session on the same
      // TCP connection. It must not retarget external account updates away from
      // the session that established updates.getState above.
      const transientSession = new Long(0x33333333, 0x33333333)
      const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: Long.fromInt(31337),
      } as { _: string })
      await main.send(clientEncrypt(perm, ping, perm.salt, transientSession, 6))
      let pong: { sessionId: Long, payload: any } | undefined
      for (let i = 0; i < 10; i++) {
        const frame = await main.read()
        const sessionId = serverSessionId(perm, frame)
        const reader = clientDecrypt(perm, frame)
        try {
          const payload = reader.object() as { _: string }
          if (payload._ === 'mt_pong') {
            pong = { sessionId, payload }
            break
          }
        } catch { /* Ignore acknowledgements from the update RPC. */ }
      }
      expect(pong).toBeDefined()
      expect(pong!.sessionId.toString()).toBe(transientSession.toString())
      expect(pong!.payload).toMatchObject({ _: 'mt_pong', pingId: Long.fromInt(31337) })

      const media = await TestClient.connect(port)
      const mediaSession = new Long(0x32323232, 0x32323232)
      await media.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        mediaSession,
        8,
      ))
      expect(await readRpcResult(media, perm)).toMatchObject({ _: 'config', thisDc: 1 })

      debugEvents.length = 0
      const delivered = sendUpdateToAuthKey(perm.authKeyId, {
        _: 'updates',
        updates: [{
          _: 'updateNewMessage',
          message: {
            _: 'message', id: 101,
            fromId: { _: 'peerUser', userId: 42 },
            peerId: { _: 'peerUser', userId: 42 },
            date: nowSec(), message: 'main only',
          },
          pts: 2, ptsCount: 1,
        }],
        users: [], chats: [], date: nowSec(), seq: 1,
      } as unknown as tl.TypeUpdates)

      expect(delivered).toBe(1)
      let pushed: { sessionId: Long, update: any } | undefined
      for (let i = 0; i < 10; i++) {
        const frame = await main.read()
        const sessionId = serverSessionId(perm, frame)
        const reader = clientDecrypt(perm, frame)
        try {
          const update = reader.object() as { _: string }
          if (update._ === 'updates') {
            pushed = { sessionId, update }
            break
          }
        } catch { /* Ignore the ping acknowledgement. */ }
      }
      expect(pushed).toBeDefined()
      expect(pushed!.sessionId.toString()).toBe(mainSession.toString())
      expect(pushed!.update).toMatchObject({
        updates: [{ _: 'updateNewMessage', message: { message: 'main only' } }],
      })
      expect(debugEvents.filter((event) => (
        event.direction === 'server->client'
        && (event.payload as { _?: string })._ === 'updates'
      )).map((event) => event.connectionId)).toEqual(['conn-1'])
      main.close()
      media.close()
    } finally {
      await stop()
    }
  })

  it('fans a local RPC update out to another connection using the same auth key', async () => {
    await crypto.initialize?.()
    const debugEvents: MtprotoDebugEvent[] = []
    const { port, pubKey, stop, register, sendUpdateToAuthKey } = await startServer(
      (event) => debugEvents.push(event),
    )
    try {
      const sender = await TestClient.connect(port)
      const perm = await doClientHandshake(sender, pubKey, false)
      const senderSession = new Long(0x41414141, 0x41414141)
      await sender.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'updates.getState' }),
        perm.salt,
        senderSession,
        4,
      ))
      expect(await readRpcResult(sender, perm)).toMatchObject({ _: 'updates.state', pts: 1 })

      const observer = await TestClient.connect(port)
      const observerSession = new Long(0x42424242, 0x42424242)
      await observer.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'updates.getState' }),
        perm.salt,
        observerSession,
        8,
      ))
      expect(await readRpcResult(observer, perm)).toMatchObject({ _: 'updates.state', pts: 1 })

      let delivered = 0
      register('help.getNearestDc', async (rpc) => {
        delivered = sendUpdateToAuthKey(rpc.authKeyId!, {
          _: 'updates',
          updates: [{
            _: 'updateNewMessage',
            message: {
              _: 'message', id: 2026,
              fromId: { _: 'peerUser', userId: 42 },
              peerId: { _: 'peerUser', userId: 42 },
              date: nowSec(), message: 'visible on B',
            },
            pts: 2, ptsCount: 1,
          }],
          users: [], chats: [], date: nowSec(), seq: 1,
        } as unknown as tl.TypeUpdates, rpc.connection)
        return { _: 'nearestDc', country: 'US', thisDc: 1, nearestDc: 1 }
      })

      debugEvents.length = 0
      await sender.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getNearestDc' }),
        perm.salt,
        senderSession,
        12,
      ))
      expect(await readRpcResult(sender, perm)).toMatchObject({ _: 'nearestDc', thisDc: 1 })

      let pushed: any
      for (let i = 0; i < 10; i++) {
        const frame = await within(observer.read(), 2_000, 'observer update')
        const reader = clientDecrypt(perm, frame)
        try {
          const update = reader.object() as { _: string }
          if (update._ === 'updates') {
            pushed = update
            break
          }
        } catch { /* Ignore acknowledgements from updates.getState. */ }
      }
      expect(delivered).toBe(1)
      expect(pushed).toMatchObject({
        updates: [{ _: 'updateNewMessage', message: { id: 2026, message: 'visible on B' } }],
      })
      expect(debugEvents.filter((event) => (
        event.direction === 'server->client'
        && (event.payload as { _?: string })._ === 'updates'
      )).map((event) => event.connectionId)).toEqual(['conn-2'])
      sender.close()
      observer.close()
    } finally {
      await stop()
    }
  })

  it('decodes an Android short abridged RPC with the quick-ack bit over TCP', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      const perm = await doClientHandshake(client, pubKey, false)
      const sessionId = new Long(0x17171717, 0x17171717)

      await client.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        perm.salt,
        sessionId,
        4,
      ))
      expect(await readRpcResult(client, perm)).toMatchObject({ _: 'help.appConfig', hash: 1 })

      const request = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'help.getAppConfig', hash: 0,
      } as { _: string })
      const frame = clientEncrypt(perm, request, perm.salt, sessionId, 8)
      expect(frame.length / 4).toBeLessThan(0x7f)
      await client.send(frame, true)
      expect(await within(readRpcResult(client, perm), 1_000, 'quick-ack RPC response'))
        .toMatchObject({ _: 'help.appConfig', hash: 2 })
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
      const appConfigReq = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getAppConfig', hash: 0 } as { _: string })
      const initializedAppConfigReq = serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 })
      await c1.send(clientEncrypt(perm, initializedAppConfigReq, perm.salt, firstSession, 4))
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

  it('restores a negotiated API layer for an Android temporary key after a full server restart', async () => {
    await crypto.initialize?.()
    const rsaKey = generateRsaKeyPair()
    const storePath = join(mkdtempSync(join(tmpdir(), 'mtproto-restart-')), 'auth-keys.json')
    let temp!: ClientKey

    const first = await startServer(undefined, {
      rsaKey, authKeyStore: new FileAuthKeyStore(storePath),
    })
    try {
      const client = await TestClient.connect(first.port)
      const perm = await doClientHandshake(client, first.pubKey, false)
      temp = await doClientHandshake(client, first.pubKey, true)
      const sessionId = new Long(0x31313131, 0x31313131)
      await bindTempAuthKey(client, perm, temp, sessionId)
      await client.send(clientEncrypt(
        temp,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        temp.salt,
        sessionId,
        8,
      ))
      expect(await readRpcResult(client, temp)).toMatchObject({ _: 'config', thisDc: 1 })
      client.close()
    } finally {
      await first.stop()
    }

    const persisted = new FileAuthKeyStore(storePath)
    let tempKeyLookups = 0
    let releaseLookup!: () => void
    const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve })
    const delayedStore: AuthKeyStore = {
      get: async (id) => {
        if (typed.equal(id, temp.authKeyId)) {
          tempKeyLookups += 1
          await lookupGate
        }
        return persisted.get(id)
      },
      save: (id, record) => persisted.save(id, record),
      delete: id => persisted.delete(id),
      beginRevocation: id => persisted.beginRevocation(id),
      finishRevocation: id => persisted.finishRevocation(id),
      recoverPendingRevocations: () => persisted.recoverPendingRevocations(),
    }
    const second = await startServer(undefined, {
      rsaKey, authKeyStore: delayedStore,
    })
    try {
      const client = await TestClient.connect(second.port)
      const sessionId = new Long(0x32323232, 0x32323232)
      const bareRequest = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getConfig' } as { _: string })
      const firstFrame = clientEncrypt(temp, bareRequest, temp.salt, sessionId, 4)
      const secondFrame = clientEncrypt(temp, bareRequest, temp.salt, sessionId, 8)
      await Promise.all([client.send(firstFrame), client.send(secondFrame)])
      await vi.waitFor(() => expect(tempKeyLookups).toBe(1))
      releaseLookup()
      expect(await readRpcResult(client, temp)).toMatchObject({ _: 'config', thisDc: 1 })
      expect(await readRpcResult(client, temp)).toMatchObject({ _: 'config', thisDc: 1 })
      expect(tempKeyLookups).toBeGreaterThan(1)
      client.close()
    } finally {
      releaseLookup()
      await second.stop()
    }
  })

  it('binds an Android reconnect temp key to the requested stored key after a fresh perm handshake', async () => {
    await crypto.initialize?.()
    const { port, pubKey, stop } = await startServer()
    try {
      // The login connection establishes the durable account key and attaches
      // backend state to it.
      const login = await TestClient.connect(port)
      const accountKey = await doClientHandshake(login, pubKey, false)
      const loginSession = new Long(0x21212121, 0x21212121)
      await login.send(clientEncrypt(
        accountKey,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        accountKey.salt,
        loginSession,
        4,
      ))
      expect(await readRpcResult(login, accountKey)).toMatchObject({ _: 'help.appConfig', hash: 1 })
      login.close()

      // Android's next API connection performs a fresh permanent handshake,
      // then a PFS handshake, but bindTempAuthKey names the durable account key
      // from the previous connection. The fresh key must not become the RPC
      // identity after that bind.
      const resumed = await TestClient.connect(port)
      const freshKey = await doClientHandshake(resumed, pubKey, false)
      expect(typed.equal(freshKey.authKeyId, accountKey.authKeyId)).toBe(false)
      const tempKey = await doClientHandshake(resumed, pubKey, true)
      const resumedSession = new Long(0x23232323, 0x23232323)
      await bindTempAuthKey(resumed, accountKey, tempKey, resumedSession)

      await resumed.send(clientEncrypt(
        tempKey,
        serializeInitializedRpc({ _: 'help.getAppConfig', hash: 0 }),
        tempKey.salt,
        resumedSession,
        8,
      ))
      expect(await readRpcResult(resumed, tempKey)).toMatchObject({ _: 'help.appConfig', hash: 2 })
      resumed.close()
    } finally {
      await stop()
    }
  })

  it('resumes a bound PFS key after a req_pq probe for upload and download', async () => {
    await crypto.initialize?.()
    const { port, pubKey, uploadedParts, transferAuthKeyIds, downloadBytes, stop } = await startServer()
    try {
      // Establish the account's permanent key on the main API connection.
      const api = await TestClient.connect(port)
      const perm = await doClientHandshake(api, pubKey, false)
      const apiSession = new Long(0x33333333, 0x33333333)
      const configReq = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'help.getConfig' })
      await api.send(clientEncrypt(perm, serializeInitializedRpc({ _: 'help.getConfig' }), perm.salt, apiSession, 4))
      await readRpcResult(api, perm)
      api.close()

      // Desktop's config-enumeration connection creates p_q_inner_data_temp_dc
      // directly, then binds that key to the permanent key from another socket.
      const config = await TestClient.connect(port)
      const temp = await doClientHandshake(config, pubKey, true)
      const configSession = new Long(0x35353535, 0x35353535)
      await bindTempAuthKey(config, perm, temp, configSession)
      await config.send(clientEncrypt(temp, configReq, temp.salt, configSession, 8))
      await readRpcResult(config, temp)
      config.close()

      // Desktop media sockets probe TCP with legacy req_pq before sending an
      // encrypted ping using the bound PFS key on the same connection.
      const media = await TestClient.connect(port)
      await sendLegacyReqPq(media, crypto.randomBytes(16), 8)
      expect((await readPlainObj(media))._).toBe('mt_resPQ')

      const mediaSession = new Long(0x44444444, 0x44444444)
      const pingId = new Long(0x55667788, 0x11223344)
      const ping = TlBinaryWriter.serializeObject(__tlWriterMap, { _: 'mt_ping', pingId } as unknown as { _: string })
      await media.send(clientEncrypt(temp, ping, temp.salt, mediaSession, 12))
      const pong = await readEncryptedObject(media, temp, 'mt_pong')
      expect(pong.pingId.eq(pingId)).toBe(true)

      const bytes = new Uint8Array([0, 1, 2, 3, 0xfe, 0xff])
      const savePart = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(9001), filePart: 0, bytes,
      } as { _: string })
      await media.send(clientEncrypt(temp, savePart, temp.salt, mediaSession, 16))
      expect(await readRpcResult(media, temp)).toEqual({ _: 'boolTrue' })
      expect(uploadedParts).toEqual([bytes])

      const getFile = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'upload.getFile', offset: Long.ZERO, limit: 1024,
        location: {
          _: 'inputDocumentFileLocation', id: Long.fromNumber(42), accessHash: Long.ZERO,
          fileReference: new Uint8Array(), thumbSize: '',
        },
      } as { _: string })
      await media.send(clientEncrypt(temp, getFile, temp.salt, mediaSession, 20))
      const downloaded = await readRpcResult(media, temp) as tl.upload.RawFile
      expect(downloaded._).toBe('upload.file')
      expect(downloaded.bytes).toEqual(downloadBytes)
      expect(transferAuthKeyIds).toHaveLength(2)
      expect(transferAuthKeyIds.every(id => typed.equal(id, perm.authKeyId))).toBe(true)
      media.close()
    } finally {
      await stop()
    }
  })

  it('persists a temp key when desktop bind lifetime differs from handshake lifetime', async () => {
    await crypto.initialize?.()
    const { port, pubKey, uploadedParts, transferAuthKeyIds, stop } = await startServer()
    try {
      const api = await TestClient.connect(port)
      const perm = await doClientHandshake(api, pubKey, false)
      const apiSession = new Long(0x46464646, 0x46464646)
      await api.send(clientEncrypt(
        perm,
        serializeInitializedRpc({ _: 'help.getConfig' }),
        perm.salt,
        apiSession,
        4,
      ))
      expect((await readRpcResult(api, perm))._).toBe('config')
      api.close()

      const config = await TestClient.connect(port)
      // Desktop may request a short PFS handshake but bind that key for the
      // account's standard one-day transfer lifetime.
      const temp = await doClientHandshake(config, pubKey, true, 3600)
      const sessionId = new Long(0x45454545, 0x45454545)
      await bindTempAuthKey(config, perm, temp, sessionId, 24 * 3600)
      config.close()

      const media = await TestClient.connect(port)
      await sendLegacyReqPq(media, crypto.randomBytes(16), 8)
      expect((await readPlainObj(media))._).toBe('mt_resPQ')
      const savePart = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(9002), filePart: 0,
        bytes: new Uint8Array([9, 8, 7]),
      } as { _: string })
      await media.send(clientEncrypt(temp, savePart, temp.salt, sessionId, 12))
      expect(await readRpcResult(media, temp)).toEqual({ _: 'boolTrue' })
      expect(uploadedParts).toEqual([new Uint8Array([9, 8, 7])])
      expect(transferAuthKeyIds).toHaveLength(1)
      expect(typed.equal(transferAuthKeyIds[0], perm.authKeyId)).toBe(true)
      media.close()
    } finally {
      await stop()
    }
  })

  it('returns -404 after a probe when the cached key is unknown', async () => {
    await crypto.initialize?.()
    const { port, stop } = await startServer()
    try {
      const client = await TestClient.connect(port)
      await sendLegacyReqPq(client, crypto.randomBytes(16), 4)
      expect((await readPlainObj(client))._).toBe('mt_resPQ')

      const authKey = crypto.randomBytes(256)
      const stale: ClientKey = {
        authKey,
        authKeyId: crypto.sha1(authKey).subarray(-8),
        salt: Long.ZERO,
      }
      const ping = TlBinaryWriter.serializeObject(__tlWriterMap, {
        _: 'mt_ping', pingId: Long.fromNumber(404),
      } as unknown as { _: string })
      await client.send(clientEncrypt(stale, ping, Long.ZERO, Long.ONE, 8))

      const error = await client.read()
      expect(error).toHaveLength(4)
      expect(new DataView(error.buffer, error.byteOffset, 4).getInt32(0, true)).toBe(-404)
      client.close()
    } finally {
      await stop()
    }
  })
})

async function readEncryptedObject(client: TestClient, key: ClientKey, type: string): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const reader = clientDecrypt(key, await client.read())
    try {
      const obj = reader.object() as { _: string }
      if (obj._ === type) return obj
    } catch { /* Ignore service messages not represented by the test reader. */ }
  }
  throw new Error(`no ${type} received`)
}

async function readServerObject(
  client: TestClient,
  key: ClientKey,
  predicate: (value: any) => boolean,
  readerMap: TlReaderMap = __tlReaderMap,
): Promise<{ value: any, sessionId: Long }> {
  for (let index = 0; index < 10; index++) {
    const frame = await client.read()
    const sessionId = serverSessionId(key, frame)
    let value: any
    try {
      value = clientDecrypt(key, frame, readerMap).object()
    } catch {
      // Layer-specific API readers do not include MTProto service objects such
      // as msgs_ack. Decode those with the base transport map and keep scanning.
      value = clientDecrypt(key, frame, __tlReaderMap).object()
    }
    if (predicate(value)) return { value, sessionId }
  }
  throw new Error('no matching MTProto server object received')
}

/** Read encrypted frames until an rpc_result is found; return the inner result object. */
async function readRpcResult(client: TestClient, key: ClientKey, readerMap: TlReaderMap = __tlReaderMap): Promise<any> {
  return (await readRpcResultEnvelope(client, key, readerMap)).result
}

async function readRpcResultEnvelope(
  client: TestClient,
  key: ClientKey,
  readerMap: TlReaderMap = __tlReaderMap,
): Promise<{ requestMessageId: Long, result: any, sessionId: Long }> {
  for (let i = 0; i < 10; i++) {
    const frame = await client.read()
    const sessionId = serverSessionId(key, frame)
    const reader = clientDecrypt(key, frame, readerMap)
    const saved = reader.pos
    const id = reader.uint()
    if (id === 0xf35c6d01) { // rpc_result
      const requestMessageId = reader.long(true)
      const resultId = reader.uint()
      // Bool results aren't in mtcute's reader map (it models Bool as a JS boolean).
      if (resultId === 0x997275b5) return { requestMessageId, result: { _: 'boolTrue' }, sessionId }
      if (resultId === 0xbc799737) return { requestMessageId, result: { _: 'boolFalse' }, sessionId }
      if (resultId === 0x1cb5c415) return { requestMessageId, result: reader.vector(reader.object, true), sessionId }
      reader.pos -= 4
      return { requestMessageId, result: reader.object(), sessionId }
    }
    reader.pos = saved
    try { reader.object() } catch { /* service message we don't model; keep reading */ }
  }
  throw new Error('no rpc_result received')
}
