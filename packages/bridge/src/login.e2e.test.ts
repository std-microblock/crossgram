import { describe, it, expect } from 'vitest'
import { bigint, typed, u8 } from '@fuman/utils'
import { Bytes } from '@fuman/io'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { LogManager, generateKeyAndIvFromNonce, createAesIgeForMessage, findKeyByFingerprints, addPublicKey } from '@mtcute/core/utils.js'
import { NodePlatform } from '@mtcute/node'
import { ObfuscatedPacketCodec } from '@mtcute/core'
import Long from 'long'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import Server from '@cordisjs/plugin-server'
import { Mtproto, AbridgedPacketCodec, generateRsaKeyPair } from '@mtproto-relay/mtproto'
import * as bridge from './index.js'

/** Full bridge login e2e: db + server + mtproto + bridge, real socket client. */

const crypto = new NodeCryptoProvider()
const log = new LogManager('e2e', new NodePlatform())
log.level = LogManager.OFF
const clientLog = log.create('client')
const dbg = (...a: unknown[]) => console.error('[test]', ...a)

function nowSec() { return Math.floor(Date.now() / 1000) }
function makeMsgId(sub: number) { return Long.fromBits((Date.now() % 1000 << 21) | sub, nowSec()) }

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
    sock.write(await client._codec.tag())
    return client
  }

  private _onData(d: Buffer): void {
    this._recv.writeSync(d.length).set(new Uint8Array(d))
    this._processing = this._processing.then(() => this._drain())
  }

  private async _drain(): Promise<void> {
    for (;;) {
      const f = await this._codec.decode(this._recv, false)
      if (f === null) break
      const frame = new Uint8Array(f)
      if (this._waiter) { const w = this._waiter; this._waiter = null; w(frame) } else this._frames.push(frame)
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

async function sendPlain(client: TestClient, obj: { _: string, [k: string]: unknown }, sub: number): Promise<void> {
  const len = TlSerializationCounter.countNeededBytes(__tlWriterMap, obj)
  const w = TlBinaryWriter.alloc(__tlWriterMap, len + 20)
  w.long(Long.ZERO); w.long(makeMsgId(sub)); w.uint(len); w.object(obj)
  await client.send(w.result())
}

async function readPlainObj(client: TestClient): Promise<any> {
  return new TlBinaryReader(__tlReaderMap, await client.read(), 20).object()
}

interface ClientKey { authKey: Uint8Array, authKeyId: Uint8Array, salt: Long }

async function doClientHandshake(client: TestClient, pubKey: any): Promise<ClientKey> {
  const nonce = crypto.randomBytes(16)
  await sendPlain(client, { _: 'mt_req_pq_multi', nonce }, 4)
  const resPq = await readPlainObj(client)
  const serverNonce = resPq.serverNonce
  const [p, q] = await crypto.factorizePQ(resPq.pq)
  const newNonce = crypto.randomBytes(32)
  const pqInner = { _: 'mt_p_q_inner_data_dc', pq: resPq.pq, p, q, nonce, newNonce, serverNonce, dc: 1 }
  const encryptedData = rsaPad(TlBinaryWriter.serializeObject(__tlWriterMap, pqInner), pubKey)
  await sendPlain(client, {
    _: 'mt_req_DH_params', nonce, serverNonce, p, q,
    publicKeyFingerprint: Long.fromString(pubKey.fingerprint, true, 16), encryptedData,
  }, 8)
  const dhParams = await readPlainObj(client)
  const [aesKey, aesIv] = generateKeyAndIvFromNonce(crypto, serverNonce, newNonce)
  const ige = crypto.createAesIge(aesKey, aesIv)
  const dhInner = new TlBinaryReader(__tlReaderMap, ige.decrypt(dhParams.encryptedAnswer), 20).object() as any
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
  iw.pos = 20; iw.object(clientDhInner)
  const hash = crypto.sha1(iw.uint8View.subarray(20, iw.pos))
  iw.pos = 0; iw.raw(hash)
  await sendPlain(client, { _: 'mt_set_client_DH_params', nonce, serverNonce, encryptedData: ige.encrypt(iw.uint8View) }, 12)
  await readPlainObj(client) // dh_gen_ok
  const saltBytes = u8.xor(newNonce.subarray(0, 8), serverNonce.subarray(0, 8))
  const sdv = typed.toDataView(saltBytes)
  return { authKey, authKeyId: crypto.sha1(authKey).subarray(-8), salt: new Long(sdv.getInt32(0, true), sdv.getInt32(4, true)) }
}

function clientEncrypt(key: ClientKey, body: Uint8Array, salt: Long, sessionId: Long, sub: number): Uint8Array {
  const inner = TlBinaryWriter.manual(16 + body.length)
  inner.long(makeMsgId(sub)); inner.uint(1); inner.uint(body.length); inner.raw(body)
  const msg = inner.result()
  let padding = (16 + msg.length + 12) % 16
  padding = 12 + (padding ? 16 - padding : 0)
  const buf = u8.alloc(16 + msg.length + padding)
  const dv = typed.toDataView(buf)
  dv.setInt32(0, salt.low, true); dv.setInt32(4, salt.high, true)
  dv.setInt32(8, sessionId.low, true); dv.setInt32(12, sessionId.high, true)
  buf.set(msg, 16); crypto.randomFill(buf.subarray(16 + msg.length))
  const clientSalt = key.authKey.subarray(88, 120)
  const messageKey = crypto.sha256(u8.concat2(clientSalt, buf)).subarray(8, 24)
  return u8.concat3(key.authKeyId, messageKey, createAesIgeForMessage(crypto, key.authKey, messageKey, true).encrypt(buf))
}

function clientDecrypt(key: ClientKey, data: Uint8Array): TlBinaryReader {
  const messageKey = data.subarray(8, 24)
  let ct = data.subarray(24)
  if (ct.byteLength % 16) ct = ct.subarray(0, ct.byteLength - (ct.byteLength % 16))
  const plain = createAesIgeForMessage(crypto, key.authKey, messageKey, false).decrypt(ct)
  const reader = new TlBinaryReader(__tlReaderMap, plain)
  reader.seek(16); reader.long(true); reader.uint(); reader.uint()
  return reader
}

async function callRpc(client: TestClient, key: ClientKey, sessionId: Long, obj: object, sub: number): Promise<any> {
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, obj as any)
  await client.send(clientEncrypt(key, body, key.salt, sessionId, sub))
  for (let i = 0; i < 12; i++) {
    const reader = clientDecrypt(key, await client.read())
    const saved = reader.pos
    const id = reader.uint()
    if (id === 0xf35c6d01) {
      reader.long(true)
      const rid = reader.uint()
      if (rid === 0x997275b5) return { _: 'boolTrue' }
      if (rid === 0xbc799737) return { _: 'boolFalse' }
      if (rid === 0x1cb5c415) {
        const count = reader.uint()
        return Array.from({ length: count }, () => reader.object())
      }
      reader.pos -= 4
      return reader.object()
    }
    reader.pos = saved
    try { reader.object() } catch { /* service msg */ }
  }
  throw new Error('no rpc_result')
}

async function startApp(options: {
  rsaKey?: ReturnType<typeof generateRsaKeyPair>
  databasePath?: string
  authKeyStorePath?: string
} = {}) {
  const rsaKey = options.rsaKey ?? generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Database),
    ctx.plugin(SQLiteDriver, { path: options.databasePath ?? ':memory:' }),
    ctx.plugin(Server, { port: 0 }),
    ctx.plugin(Mtproto, {
      port: 0, host: '127.0.0.1', rsaKey, log,
      authKeyStorePath: options.authKeyStorePath,
    }),
    ctx.plugin(bridge, {}),
  ]
  await Promise.all(fibers)
  await new Promise((r) => setTimeout(r, 100)) // let fibers settle
  const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
  const stop = async () => { for (const f of fibers.reverse()) await Promise.resolve((f as any).dispose?.()) }
  return { ctx, port: ctx.mtproto.port, pubKey, rsaKey, stop }
}

describe('bridge login e2e', () => {
  it('logs in, resumes on a fresh connection, reads contacts/history, and sends a message', async () => {
    const { ctx, port, pubKey, stop } = await startApp()
    dbg('app started, mtproto port', port)
    try {
      // Seed a virtual phone directly via minato (bypass HTTP).
      await ctx.database.create('mtproto_platform_session', {
        id: 'ps1', platformId: 'static-demo', userId: 'alice',
        credentials: { t: 'x' }, metadata: { firstName: 'Alice' }, active: true, createdAt: new Date(),
      })
      await ctx.database.create('mtproto_auth_session', {
        id: 'as1', virtualPhone: '99900123', loginCode: '123456',
        platformId: 'static-demo', platformSessionId: 'ps1', used: false,
      })
      dbg('seeded phone')

      const client = await TestClient.connect(port)
      const key = await doClientHandshake(client, pubKey)
      dbg('handshake done, authKeyId', Buffer.from(key.authKeyId).toString('hex'))
      const sid = new Long(0x12345678, 0x1abc, false)

      const sent = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: '+99900123', apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      dbg('sendCode result', sent._)
      expect(sent._).toBe('auth.sentCode')

      const auth = await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: '99900123',
        phoneCodeHash: (sent as any).phoneCodeHash, phoneCode: '123456',
      }, 6)
      dbg('signIn result', auth._)
      expect(auth._).toBe('auth.authorization')
      expect((auth as any).user.firstName).toBe('Alice')
      const [binding] = await ctx.database.get('mtproto_auth_binding', {
        authKeyId: Buffer.from(key.authKeyId).toString('hex'),
      })
      expect(binding).toMatchObject({ platformId: 'static-demo', platformSessionId: 'ps1' })

      // Telegram Desktop opens a fresh main connection after login. Reuse only
      // the permanent auth key; all bridge identity and dialog ID maps must
      // follow it to this transport.
      client.close()
      const resumed = await TestClient.connect(port)
      const resumedSid = new Long(0x23456789, 0x2abc, false)

      // Post-login initial-sync calls (must not stall the client).
      const state = await callRpc(resumed, key, resumedSid, { _: 'updates.getState' }, 8)
      expect(state._).toBe('updates.state')
      const status = await callRpc(resumed, key, resumedSid, { _: 'account.updateStatus', offline: false }, 10)
      expect(status._).toBe('boolTrue')
      const filters = await callRpc(resumed, key, resumedSid, { _: 'messages.getDialogFilters' }, 12)
      expect(filters._).toBe('messages.dialogFilters')
      const countries = await callRpc(resumed, key, resumedSid, { _: 'help.getCountriesList', langCode: 'en', hash: 0 }, 14)
      expect(countries._).toBe('help.countriesList')
      dbg('post-login sync ok:', state._, status._, filters._, countries._)

      const contacts = await callRpc(resumed, key, resumedSid, {
        _: 'contacts.getContacts', hash: Long.ZERO,
      }, 16)
      expect(contacts._).toBe('contacts.contacts')
      expect(contacts.users.map((user: any) => user.firstName)).toEqual(['Alice', 'Bob'])
      expect(contacts.users.every((user: any) => user.contact && user.mutualContact)).toBe(true)
      const alice = contacts.users.find((user: any) => user.firstName === 'Alice')

      const users = await callRpc(resumed, key, resumedSid, {
        _: 'users.getUsers',
        id: [{ _: 'inputUser', userId: alice.id, accessHash: Long.ZERO }],
      }, 18)
      expect(users).toMatchObject([{ _: 'user', id: alice.id, firstName: 'Alice' }])

      const fullUser = await callRpc(resumed, key, resumedSid, {
        _: 'users.getFullUser',
        id: { _: 'inputUser', userId: alice.id, accessHash: Long.ZERO },
      }, 20)
      expect(fullUser).toMatchObject({
        _: 'users.userFull',
        fullUser: { _: 'userFull', id: alice.id },
      })

      // Real bridge data: dialog list → peer history → lookup by message ID.
      const dialogs = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
      }, 22)
      expect(dialogs._).toBe('messages.dialogs')
      expect(dialogs.dialogs).toHaveLength(2)
      expect(dialogs.messages.map((message: any) => message.message)).toEqual([
        'Meeting at 3?', 'How are you?',
      ])
      expect(dialogs.users.map((user: any) => user.firstName)).toEqual(['Bob', 'Alice'])

      const history = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 24)
      expect(history._).toBe('messages.messages')
      expect(history.messages.map((message: any) => message.message)).toEqual([
        'How are you?', 'Hey there!',
      ])
      expect(history.users.some((user: any) => user.self && user.firstName === 'Alice')).toBe(true)

      const message = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getMessages',
        id: [{ _: 'inputMessageID', id: history.messages[0].id }],
      }, 26)
      expect(message._).toBe('messages.messages')
      expect(message.messages).toHaveLength(1)
      expect(message.messages[0]).toMatchObject({
        _: 'message', id: history.messages[0].id, message: 'How are you?',
      })
      const sentMessage = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMessage',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        message: 'Sent through MTProto', randomId: Long.fromNumber(987654321),
      }, 28)
      expect(sentMessage).toMatchObject({ _: 'updateShortSentMessage', out: true, ptsCount: 1 })

      const updatedHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 30)
      expect(updatedHistory.messages[0]).toMatchObject({
        _: 'message', id: sentMessage.id, out: true, message: 'Sent through MTProto',
      })
      dbg('bridge contacts/dialogs/history/send ok')

      resumed.close()
    } finally {
      await stop()
    }
  }, 15000)

  it('restores the platform binding from the database after a full service restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mtproto-bridge-e2e-'))
    const databasePath = pathToFileURL(join(directory, 'bridge.db')).href
    const authKeyStorePath = join(directory, 'auth-keys.json')
    const rsaKey = generateRsaKeyPair()
    let first: Awaited<ReturnType<typeof startApp>> | undefined
    let second: Awaited<ReturnType<typeof startApp>> | undefined
    let client: TestClient | undefined

    try {
      first = await startApp({ rsaKey, databasePath, authKeyStorePath })
      await first.ctx.database.create('mtproto_platform_session', {
        id: 'persisted-ps', platformId: 'static-demo', userId: 'persisted-user',
        credentials: { token: 'persisted' }, metadata: { firstName: 'Persisted' },
        active: true, createdAt: new Date(),
      })
      await first.ctx.database.create('mtproto_auth_session', {
        id: 'persisted-auth', virtualPhone: '99900456', loginCode: '654321',
        platformId: 'static-demo', platformSessionId: 'persisted-ps', used: false,
      })

      client = await TestClient.connect(first.port)
      const key = await doClientHandshake(client, first.pubKey)
      const sid = new Long(0x3456789a, 0x3abc, false)
      const sentCode = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: '+99900456', apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      const authorization = await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: '99900456',
        phoneCodeHash: sentCode.phoneCodeHash, phoneCode: '654321',
      }, 6)
      expect(authorization._).toBe('auth.authorization')
      client.close()
      client = undefined
      await first.stop()
      first = undefined

      second = await startApp({ rsaKey, databasePath, authKeyStorePath })
      client = await TestClient.connect(second.port)
      const resumedSid = new Long(0x456789ab, 0x4abc, false)
      const dialogs = await callRpc(client, key, resumedSid, {
        _: 'messages.getDialogs', offsetDate: 0, offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
      }, 8)
      expect(dialogs._).toBe('messages.dialogs')
      expect(dialogs.users.map((user: any) => user.firstName)).toEqual(['Bob', 'Alice'])
    } finally {
      client?.close()
      await second?.stop()
      await first?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
})
