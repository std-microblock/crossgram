import { describe, it, expect } from 'vitest'
import { bigint, Emitter, typed, u8 } from '@fuman/utils'
import { Bytes } from '@fuman/io'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TlBinaryReader, TlBinaryWriter, TlSerializationCounter } from '@mtcute/tl-runtime'
import type { tl } from '@mtcute/core'
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
import WebUI from '@cordisjs/plugin-webui'
import { Mtproto, AbridgedPacketCodec, CURRENT_API_LAYER, generateRsaKeyPair } from '@mtproto-relay/mtproto'
import * as bridge from '@mtproto-relay/bridge'
import * as relay from '@mtproto-relay/relay'
import * as staticPlatformPlugin from '@mtproto-relay/platform-static'
import * as telegramResourcesPlugin from '@mtproto-relay/telegram-resources'

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

const initializedApiKeys = new Set<string>()

function initializedRpc(query: object): object {
  return {
    _: 'invokeWithLayer',
    layer: CURRENT_API_LAYER,
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
  }
}

async function sendRpc(
  client: TestClient,
  key: ClientKey,
  sessionId: Long,
  obj: object,
  sub: number,
): Promise<any> {
  const body = TlBinaryWriter.serializeObject(__tlWriterMap, obj as any)
  await client.send(clientEncrypt(key, body, key.salt, sessionId, sub))
  for (let i = 0; i < 12; i++) {
    const reader = clientDecrypt(key, await readRpcFrame(client, String((obj as any)._)))
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

async function readRpcFrame(client: TestClient, method: string): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), 5_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function callRpc(client: TestClient, key: ClientKey, sessionId: Long, obj: object, sub: number): Promise<any> {
  const keyId = Buffer.from(key.authKeyId).toString('hex')
  if (!initializedApiKeys.has(keyId)) {
    const result = await sendRpc(client, key, sessionId, initializedRpc(obj), sub)
    initializedApiKeys.add(keyId)
    return result
  }

  const result = await sendRpc(client, key, sessionId, obj, sub)
  if (result?._ !== 'mt_rpc_error' || result.errorMessage !== 'CONNECTION_NOT_INITED') return result

  const retried = await sendRpc(client, key, sessionId, initializedRpc(obj), sub + 1)
  initializedApiKeys.add(keyId)
  return retried
}

async function readPush(client: TestClient, key: ClientKey): Promise<any> {
  for (let index = 0; index < 12; index++) {
    const reader = clientDecrypt(key, await client.read())
    const saved = reader.pos
    if (reader.uint() === 0xf35c6d01) continue
    reader.pos = saved
    try {
      const object = reader.object() as any
      if (object._ === 'updates' || object._ === 'updateShort') return object
    } catch { /* service message */ }
  }
  throw new Error('no pushed update')
}

async function startApp(options: {
  rsaKey?: ReturnType<typeof generateRsaKeyPair>
  databasePath?: string
  authKeyStorePath?: string
  bridgeConfig?: bridge.BridgeConfig
  relayConfig?: relay.RelayConfig
  platform?: { id: string, adapter: bridge.IMPlatform }
} = {}) {
  const rsaKey = options.rsaKey ?? generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Database),
    ctx.plugin(SQLiteDriver, { path: options.databasePath ?? ':memory:' }),
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(WebUI, { devMode: false, uiPath: '', apiPath: '/api', selfUrl: '' }),
    ctx.plugin(Mtproto, {
      port: 0, host: '127.0.0.1', rsaKey, log,
      authKeyStorePath: options.authKeyStorePath,
    }),
    ctx.plugin(bridge, options.bridgeConfig ?? {}),
    ctx.plugin(telegramResourcesPlugin),
    ...(options.relayConfig ? [ctx.plugin(relay, options.relayConfig)] : []),
    options.platform
      ? ctx.plugin(makePlatformPlugin(options.platform.id, options.platform.adapter))
      : ctx.plugin(staticPlatformPlugin, { eventIntervalMs: 0, historySize: 10_000 }),
  ]
  await Promise.all(fibers)
  await new Promise((r) => setTimeout(r, 100)) // let fibers settle
  const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
  const stop = async () => { for (const f of fibers.reverse()) await Promise.resolve((f as any).dispose?.()) }
  return { ctx, port: ctx.mtproto.port, pubKey, rsaKey, stop }
}

async function waitForPlatformLogin(ctx: Context, platformId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [auth] = await ctx.database.get('mtproto_auth_session', { platformId })
    if (auth) {
      const [session] = await ctx.database.get('mtproto_platform_session', { id: auth.platformSessionId })
      if (session) return { auth, session }
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`platform login was not provisioned: ${platformId}`)
}

function makePlatformPlugin(id: string, platform: bridge.IMPlatform) {
  const plugin = (ctx: Context) => { ctx.imPlatform.register(platform, id) }
  plugin.inject = ['imPlatform']
  return plugin
}

describe('bridge login e2e', () => {
  it('logs in, resumes on a fresh connection, reads contacts/history, and sends a message', async () => {
    const { ctx, port, pubKey, stop } = await startApp()
    dbg('app started, mtproto port', port)
    try {
      const platformLogin = await waitForPlatformLogin(ctx, 'static')
      const phone = platformLogin.auth.virtualPhone
      dbg('platform supplied identity and bridge provisioned phone', phone)
      const accountEntry = Object.values(ctx.webui.entries)
        .find(entry => entry.files.routes?.includes('/platform-accounts'))
      expect(accountEntry?.data).toMatchObject({
        accounts: [{
          platformId: 'static', platformKind: 'static', status: 'ready',
          displayName: 'Static User', username: 'static_user', userId: 'self',
          virtualPhone: `+${phone}`, loginCode: expect.stringMatching(/^\d{6}$/),
        }],
      })
      expect(JSON.stringify(accountEntry?.data)).not.toContain(platformLogin.auth.totpSecret)

      const avatarResponse = await fetch(`http://127.0.0.1:${ctx.server.port}/api/platforms/static/avatar`)
      expect(avatarResponse.status).toBe(200)
      expect(avatarResponse.headers.get('content-type')).toBe('image/png')
      expect([...new Uint8Array(await avatarResponse.arrayBuffer()).subarray(0, 8)])
        .toEqual([137, 80, 78, 71, 13, 10, 26, 10])

      const client = await TestClient.connect(port)
      const key = await doClientHandshake(client, pubKey)
      dbg('handshake done, authKeyId', Buffer.from(key.authKeyId).toString('hex'))
      const sid = new Long(0x12345678, 0x1abc, false)

      const loginToken = await callRpc(client, key, sid, {
        _: 'auth.exportLoginToken', apiId: 1, apiHash: 'x', exceptIds: [],
      }, 2)
      expect(loginToken).toMatchObject({ _: 'auth.loginToken' })
      expect(loginToken.token).toHaveLength(32)

      const sent = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: `+${phone}`, apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      dbg('sendCode result', sent._)
      expect(sent._).toBe('auth.sentCode')

      const auth = await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: phone,
        phoneCodeHash: (sent as any).phoneCodeHash,
        phoneCode: bridge.generateLoginCode(platformLogin.auth.totpSecret),
      }, 6)
      dbg('signIn result', auth._)
      expect(auth._).toBe('auth.authorization')
      expect((auth as any).user.firstName).toBe('Static User')
      const [binding] = await ctx.database.get('mtproto_auth_binding', {
        authKeyId: Buffer.from(key.authKeyId).toString('hex'),
      })
      expect(binding).toMatchObject({
        platformId: 'static', platformSessionId: platformLogin.session.id,
      })

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
      const config = await callRpc(resumed, key, resumedSid, { _: 'help.getConfig' }, 15)
      expect(config).toMatchObject({
        _: 'config', thisDc: 1,
      })
      expect((config as any).dcOptions).toEqual([1, 2, 3, 4, 5, 6].map(id => expect.objectContaining({
        id, ipAddress: '127.0.0.1', port: 4430, tcpoOnly: true, static: true,
      })))
      dbg('post-login sync ok:', state._, status._, filters._, countries._)

      // Media and auxiliary DC connections use distinct permanent auth keys.
      // Copy the logged-in bridge identity to a newly handshaken key exactly as
      // Telegram Desktop does after reading the six logical DCs above.
      const exported = await callRpc(resumed, key, resumedSid, {
        _: 'auth.exportAuthorization', dcId: 2,
      }, 15)
      expect(exported).toMatchObject({ _: 'auth.exportedAuthorization' })
      expect(Long.isLong(exported.id)).toBe(true)
      expect(exported.bytes).toHaveLength(32)

      const mediaClient = await TestClient.connect(port)
      const mediaKey = await doClientHandshake(mediaClient, pubKey)
      const mediaSid = new Long(0x34567890, 0x3abc, false)
      expect(await callRpc(mediaClient, mediaKey, mediaSid, {
        _: 'auth.importAuthorization', id: exported.id, bytes: exported.bytes,
      }, 16)).toMatchObject({
        _: 'auth.authorization', user: { self: true, firstName: 'Static User' },
      })
      expect(await callRpc(mediaClient, mediaKey, mediaSid, {
        _: 'contacts.getContacts', hash: Long.ZERO,
      }, 17)).toMatchObject({
        _: 'contacts.contacts', users: expect.arrayContaining([
          expect.objectContaining({ firstName: 'Alice' }),
          expect.objectContaining({ firstName: 'Bob' }),
        ]),
      })
      const [mediaBinding] = await ctx.database.get('mtproto_auth_binding', {
        authKeyId: Buffer.from(mediaKey.authKeyId).toString('hex'),
      })
      expect(mediaBinding).toMatchObject({
        platformId: 'static', platformSessionId: platformLogin.session.id,
      })
      mediaClient.close()

      const contacts = await callRpc(resumed, key, resumedSid, {
        _: 'contacts.getContacts', hash: Long.ZERO,
      }, 18)
      expect(contacts._).toBe('contacts.contacts')
      expect(contacts.users.map((user: any) => user.firstName)).toEqual(['Alice', 'Bob'])
      expect(contacts.users.every((user: any) => user.contact && user.mutualContact)).toBe(true)
      const alice = contacts.users.find((user: any) => user.firstName === 'Alice')
      expect(alice.photo).toMatchObject({ _: 'userProfilePhoto', dcId: 1 })
      const avatar = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 1024,
        location: {
          _: 'inputPeerPhotoFileLocation',
          peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
          photoId: alice.photo.photoId,
        },
      }, 17)
      expect([...avatar.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

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

      // Real reference-adapter data: every conversation kind, grouped media,
      // range download, direct history, and sends over the MTProto socket.
      const dialogs = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getDialogs', excludePinned: true, folderId: 0,
        offsetDate: 0, offsetId: 0,
        offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
      }, 22)
      expect(dialogs._).toBe('messages.dialogs')
      expect(dialogs.dialogs).toHaveLength(9)
      expect(dialogs.dialogs.map((dialog: any) => dialog.peer._)).toEqual([
        'peerChannel', 'peerChannel', 'peerChannel', 'peerChannel',
        'peerChannel', 'peerUser', 'peerUser', 'peerChannel', 'peerChannel',
      ])
      expect(new Set(dialogs.users.map((user: any) => user.firstName)))
        .toEqual(new Set(['Carol', 'Mirror User', 'Alice', 'Bob']))
      expect(dialogs.chats.map((chat: any) => chat.title)).toEqual([
        'Group A - Live Mutations', 'Static QQ Group', 'Group C - Mirror Target',
        'Group B - Mirror Source', 'general', 'Reaction & Sticker Lab', 'Group D - Long History',
      ])
      const group = dialogs.chats.find((chat: any) => chat.title === 'Static QQ Group')
      expect(group).toMatchObject({ _: 'channel', megagroup: true })
      expect(group.photo).toMatchObject({ _: 'chatPhoto', dcId: 1 })
      const mirrorSourceGroup = dialogs.chats.find((chat: any) => chat.title === 'Group B - Mirror Source')
      const mirrorTargetGroup = dialogs.chats.find((chat: any) => chat.title === 'Group C - Mirror Target')
      const longHistoryGroup = dialogs.chats.find((chat: any) => chat.title === 'Group D - Long History')
      const reactionStickerLab = dialogs.chats.find((chat: any) => chat.title === 'Reaction & Sticker Lab')
      const generalChannel = dialogs.chats.find((chat: any) => chat.title === 'general')
      expect(generalChannel).toMatchObject({ _: 'channel', megagroup: true, forum: true })
      const [supportConversation] = await ctx.database.get('mtproto_im_conversation', {
        platformSessionId: platformLogin.session.id, platformConversationId: 'discord-support',
      })
      expect(supportConversation).toMatchObject({
        kind: 'channel', parentPlatformConversationId: 'discord-general', spacePlatformId: 'discord-guild',
      })

      const pinned = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getPinnedDialogs', folderId: 0,
      }, 24)
      expect(pinned).toMatchObject({
        _: 'messages.peerDialogs', dialogs: [], messages: [], chats: [], users: [],
        state: { _: 'updates.state', pts: 1 },
      })

      const aliceDialog = dialogs.dialogs.find((dialog: any) =>
        dialog.peer._ === 'peerUser' && dialog.peer.userId === alice.id)
      expect(aliceDialog).toMatchObject({ unreadCount: 1 })
      const peerDialogs = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getPeerDialogs',
        peers: [{
          _: 'inputDialogPeer',
          peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        }],
      }, 25)
      expect(peerDialogs).toMatchObject({
        _: 'messages.peerDialogs',
        dialogs: [{ peer: { _: 'peerUser', userId: alice.id }, unreadCount: 1 }],
        messages: [{ _: 'message', message: 'How are you?' }],
        users: expect.arrayContaining([
          expect.objectContaining({ _: 'user', id: alice.id, firstName: 'Alice' }),
        ]),
        state: { _: 'updates.state', pts: 1 },
      })
      const unreadWindow = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: aliceDialog.readInboxMaxId, offsetDate: 0, addOffset: -25, limit: 50,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 26)
      expect(unreadWindow.messages.map((message: any) => message.message)).toEqual([
        'How are you?', 'Hey there!',
      ])

      const history = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 27)
      expect(history._).toBe('messages.messages')
      expect(history.messages.map((message: any) => message.message)).toEqual([
        'How are you?', 'Hey there!',
      ])
      expect(history.users.some((user: any) => user.self && user.firstName === 'Static User')).toBe(true)

      const message = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getMessages',
        id: [{ _: 'inputMessageID', id: history.messages[0].id }],
      }, 28)
      expect(message._).toBe('messages.messages')
      expect(message.messages).toHaveLength(1)
      expect(message.messages[0]).toMatchObject({
        _: 'message', id: history.messages[0].id, message: 'How are you?',
      })

      const groupHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 2,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 30)
      expect(groupHistory._).toBe('messages.messagesSlice')
      expect(groupHistory.messages.map((item: any) => item.message)).toEqual(['', 'Seeded image and file'])
      expect(groupHistory.messages.map((item: any) => item.media?._)).toEqual([
        'messageMediaDocument', 'messageMediaPhoto',
      ])
      expect(groupHistory.messages.map((item: any) => item.groupedId)).toEqual([undefined, undefined])
      const reactionHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 31)
      const reactionMessage = reactionHistory.messages.find((item: any) => item.message === 'Group history works')
      expect(reactionMessage.reactions).toMatchObject({
        _: 'messageReactions',
        results: [{ reaction: { _: 'reactionEmoji', emoticon: '👍' }, count: 2 }],
      })
      const seededDocument = groupHistory.messages[0].media.document
      const seededPhoto = groupHistory.messages[1].media.photo
      const seededFile = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 64,
        location: {
          _: 'inputDocumentFileLocation', id: seededDocument.id, accessHash: seededDocument.accessHash,
          fileReference: seededDocument.fileReference, thumbSize: '',
        },
      }, 32)
      expect(new TextDecoder().decode(seededFile.bytes)).toBe('static seeded file')
      const seededImage = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 1024,
        location: {
          _: 'inputPhotoFileLocation', id: seededPhoto.id, accessHash: seededPhoto.accessHash,
          fileReference: seededPhoto.fileReference, thumbSize: 'x',
        },
      }, 34)
      expect([...seededImage.bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])

      const longHistoryFirst = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: longHistoryGroup.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 33)
      expect(longHistoryFirst.messages).toHaveLength(100)
      expect(longHistoryFirst.messages[0].message).toBe('Group D history message 10000')
      const longHistorySecond = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: longHistoryGroup.id, accessHash: Long.ZERO },
        offsetId: longHistoryFirst.messages.at(-1).id,
        offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 35)
      expect(longHistorySecond.messages).toHaveLength(100)
      expect(longHistorySecond.messages[0].message).toBe('Group D history message 9900')
      expect(new Set([
        ...longHistoryFirst.messages.map((item: any) => item.id),
        ...longHistorySecond.messages.map((item: any) => item.id),
      ]).size).toBe(200)
      const [longConversation] = await ctx.database.get('mtproto_im_conversation', {
        platformSessionId: platformLogin.session.id, platformConversationId: 'group-d',
      })
      const persistedLongHistory = await ctx.database.get('mtproto_im_message', {
        conversationId: longConversation.id,
      })
      expect(persistedLongHistory.length).toBeGreaterThanOrEqual(200)
      expect(persistedLongHistory.length).toBeLessThanOrEqual(205)

      const sentMessage = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMessage',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        message: 'Sent through MTProto', randomId: Long.fromNumber(987654321),
      }, 37)
      expect(sentMessage).toMatchObject({ _: 'updateShortSentMessage', out: true, ptsCount: 1 })

      const updatedHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 39)
      expect(updatedHistory.messages[0]).toMatchObject({
        _: 'message', id: sentMessage.id, out: true, message: 'Sent through MTProto',
      })

      const socketPng = new Uint8Array(24)
      socketPng.set([0x89, 0x50, 0x4e, 0x47], 0)
      socketPng.set([0x49, 0x48, 0x44, 0x52], 12)
      new DataView(socketPng.buffer).setUint32(16, 640)
      new DataView(socketPng.buffer).setUint32(20, 480)
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(800), filePart: 0,
        bytes: socketPng,
      }, 41)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(801), filePart: 0,
        bytes: new TextEncoder().encode('static socket file'),
      }, 43)).toEqual({ _: 'boolTrue' })
      const sentAlbum = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMultiMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        multiMedia: [
          {
            _: 'inputSingleMedia', randomId: Long.fromNumber(800), message: 'socket album',
            media: {
              _: 'inputMediaUploadedPhoto',
              file: { _: 'inputFile', id: Long.fromNumber(800), parts: 1, name: 'socket.png', md5Checksum: '' },
            },
          },
          {
            _: 'inputSingleMedia', randomId: Long.fromNumber(801), message: '',
            media: {
              _: 'inputMediaUploadedDocument',
              file: { _: 'inputFile', id: Long.fromNumber(801), parts: 1, name: 'socket.txt', md5Checksum: '' },
              mimeType: 'text/plain', attributes: [{ _: 'documentAttributeFilename', fileName: 'socket.txt' }],
            },
          },
        ],
      }, 45)
      expect(sentAlbum.updates.filter((update: any) => update._ === 'updateMessageID')).toMatchObject([
        { randomId: Long.fromNumber(800) },
        { randomId: Long.fromNumber(801) },
      ])
      const sentAlbumMessages = sentAlbum.updates
        .filter((update: any) => update._ === 'updateNewChannelMessage')
        .map((update: any) => update.message)
      expect(sentAlbumMessages.map((item: any) => item.message)).toEqual(['socket album', ''])
      expect(sentAlbumMessages.map((item: any) => item.media?._)).toEqual([
        'messageMediaPhoto', 'messageMediaDocument',
      ])
      expect(sentAlbumMessages.map((item: any) => item.groupedId)).toEqual([undefined, undefined])
      const sentPhoto = sentAlbumMessages[0].media.photo
      expect(sentPhoto.sizes).toMatchObject([{ _: 'photoSize', w: 640, h: 480, size: socketPng.length }])
      const downloadedPhoto = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 64,
        location: {
          _: 'inputPhotoFileLocation', id: sentPhoto.id, accessHash: sentPhoto.accessHash,
          fileReference: sentPhoto.fileReference, thumbSize: 'x',
        },
      }, 46)
      expect(downloadedPhoto.bytes).toEqual(socketPng)

      const sentToMirrorSource = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMessage',
        peer: { _: 'inputPeerChannel', channelId: mirrorSourceGroup.id, accessHash: Long.ZERO },
        message: 'bridge mirror check', randomId: Long.fromNumber(802),
      }, 47)
      expect(sentToMirrorSource).toMatchObject({ _: 'updateShortSentMessage', out: true })
      const mirroredHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: mirrorTargetGroup.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 49)
      expect(mirroredHistory.messages).toMatchObject([{
        _: 'message', message: 'bridge mirror check',
        peerId: { _: 'peerChannel', channelId: mirrorTargetGroup.id },
      }])
      expect(mirroredHistory.users).toContainEqual(expect.objectContaining({
        firstName: 'Mirror User',
      }))

      expect(await callRpc(resumed, key, resumedSid, {
        _: 'upload.saveBigFilePart', fileId: Long.fromNumber(803), filePart: 0, fileTotalParts: 2,
        bytes: new TextEncoder().encode('desktop-'),
      }, 51)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'upload.saveBigFilePart', fileId: Long.fromNumber(803), filePart: 1, fileTotalParts: 2,
        bytes: new TextEncoder().encode('upload'),
      }, 53)).toEqual({ _: 'boolTrue' })
      const stagedMedia = await callRpc(resumed, key, resumedSid, {
        _: 'messages.uploadMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        media: {
          _: 'inputMediaUploadedDocument',
          file: { _: 'inputFileBig', id: Long.fromNumber(803), parts: 2, name: 'desktop.txt' },
          mimeType: 'text/plain',
          attributes: [{ _: 'documentAttributeFilename', fileName: 'desktop.txt' }],
        },
      }, 55)
      expect(stagedMedia).toMatchObject({
        _: 'messageMediaDocument', document: { _: 'document', mimeType: 'text/plain', size: 14 },
      })
      const stagedDocument = stagedMedia.document
      expect(stagedDocument.accessHash).not.toEqual(Long.ZERO)
      const stagedPreview = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 8, limit: 6,
        location: {
          _: 'inputDocumentFileLocation', id: stagedDocument.id, accessHash: stagedDocument.accessHash,
          fileReference: stagedDocument.fileReference, thumbSize: '',
        },
      }, 57)
      expect(new TextDecoder().decode(stagedPreview.bytes)).toBe('upload')
      const stagedSent = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        randomId: Long.fromNumber(803), message: 'desktop two-stage',
        media: {
          _: 'inputMediaDocument',
          id: {
            _: 'inputDocument', id: stagedDocument.id, accessHash: stagedDocument.accessHash,
            fileReference: stagedDocument.fileReference,
          },
        },
      }, 59)
      expect(stagedSent).toMatchObject({
        _: 'updates',
        updates: [
          { _: 'updateMessageID', randomId: Long.fromNumber(803) },
          {
            _: 'updateNewChannelMessage',
            message: { message: 'desktop two-stage', media: { _: 'messageMediaDocument' } },
          },
        ],
      })
      const finalDocument = stagedSent.updates[1].message.media.document
      expect(finalDocument.accessHash).not.toEqual(Long.ZERO)
      const finalFile = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 64,
        location: {
          _: 'inputDocumentFileLocation', id: finalDocument.id, accessHash: finalDocument.accessHash,
          fileReference: finalDocument.fileReference, thumbSize: '',
        },
      }, 61)
      expect(new TextDecoder().decode(finalFile.bytes)).toBe('desktop-upload')

      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.setTyping',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        action: { _: 'sendMessageUploadDocumentAction', progress: 0 },
      }, 62)).toEqual({ _: 'boolTrue' })

      const peerSettings = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getPeerSettings',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
      }, 63)
      expect(peerSettings).toMatchObject({
        _: 'messages.peerSettings', chats: [{ _: 'channel', id: generalChannel.id }],
      })
      const channelHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 1,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 64)
      expect(channelHistory.messages).toMatchObject([{
        _: 'message', message: 'General channel message',
        peerId: { _: 'peerChannel', channelId: generalChannel.id },
      }])
      const fullChannel = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getFullChannel',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
      }, 65)
      expect(fullChannel).toMatchObject({
        _: 'messages.chatFull', fullChat: { _: 'channelFull', id: generalChannel.id },
      })
      const channelMessages = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getMessages',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        id: [{ _: 'inputMessageID', id: channelHistory.messages[0].id }],
      }, 66)
      expect(channelMessages).toMatchObject({
        _: 'messages.channelMessages',
        messages: [{ _: 'message', message: 'General channel message' }],
        chats: [{ _: 'channel', id: generalChannel.id }],
      })
      const participant = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getParticipant',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        participant: { _: 'inputPeerSelf' },
      }, 67)
      expect(participant).toMatchObject({
        _: 'channels.channelParticipant', participant: { _: 'channelParticipantCreator' },
      })
      const channelMembers = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getParticipants',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        filter: { _: 'channelParticipantsRecent' }, offset: 0, limit: 100, hash: Long.ZERO,
      }, 68)
      expect(channelMembers).toMatchObject({
        _: 'channels.channelParticipants', count: 4,
        participants: [
          { _: 'channelParticipantCreator' },
          { _: 'channelParticipantAdmin', adminRights: { deleteMessages: true } },
          { _: 'channelParticipant' },
          { _: 'channelParticipant' },
        ],
      })
      const sendAs = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getSendAs',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
      }, 69)
      expect(sendAs).toMatchObject({ _: 'channels.sendAsPeers', peers: [{ peer: { _: 'peerUser' } }] })
      const channels = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getChannels',
        id: [
          { _: 'inputChannel', channelId: group.id, accessHash: Long.ZERO },
          { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        ],
      }, 70)
      expect(channels).toMatchObject({
        _: 'messages.chats',
        chats: [
          { _: 'channel', id: group.id },
          { _: 'channel', id: generalChannel.id },
        ],
      })

      const forum = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getForumTopics',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        offsetDate: 0, offsetId: 0, offsetTopic: 0, limit: 100,
      }, 71)
      expect(forum).toMatchObject({
        _: 'messages.forumTopics', count: 1,
        topics: [{ _: 'forumTopic', title: 'support thread' }],
        messages: [{ _: 'message', peerId: { _: 'peerChannel', channelId: generalChannel.id } }],
      })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'channels.readHistory',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        maxId: channelHistory.messages[0].id,
      }, 72)).toEqual({ _: 'boolTrue' })
      const topic = forum.topics[0]
      const topicHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getReplies',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        msgId: topic.id, offsetId: 0, offsetDate: 0, addOffset: 0,
        limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
      }, 73)
      expect(topicHistory).toMatchObject({
        _: 'messages.channelMessages', topics: [{ id: topic.id, title: 'support thread' }],
        messages: [{ message: 'Support thread message' }],
      })
      await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMessage',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        replyTo: { _: 'inputReplyToMessage', replyToMsgId: topic.id, topMsgId: topic.id },
        message: 'sent to Discord thread', randomId: Long.fromNumber(804),
      }, 75)
      const updatedTopic = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getReplies',
        peer: { _: 'inputPeerChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        msgId: topic.id, offsetId: 0, offsetDate: 0, addOffset: 0,
        limit: 1, maxId: 0, minId: 0, hash: Long.ZERO,
      }, 77)
      expect(updatedTopic.messages[0]).toMatchObject({
        message: 'sent to Discord thread',
        replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToTopId: topic.id },
      })

      const documentSearch = await callRpc(resumed, key, resumedSid, {
        _: 'messages.search',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO }, q: '',
        filter: { _: 'inputMessagesFilterDocument' }, minDate: 0, maxDate: 0,
        offsetId: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
      }, 79)
      expect(documentSearch.messages).toEqual(expect.arrayContaining([expect.objectContaining({
        _: 'message',
        media: expect.objectContaining({
          _: 'messageMediaDocument',
          document: expect.objectContaining({
            mimeType: 'text/plain',
            attributes: [expect.objectContaining({ fileName: 'seed.txt' })],
          }),
        }),
      })]))
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.readHistory',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO }, maxId: 0x40000010,
      }, 81)).toMatchObject({ _: 'messages.affectedMessages', ptsCount: 0 })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.getScheduledHistory',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO }, hash: Long.ZERO,
      }, 83)).toMatchObject({ _: 'messages.messages', messages: [] })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'updates.getChannelDifference', force: true,
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        filter: { _: 'channelMessagesFilterEmpty' }, pts: 1, limit: 100,
      }, 85)).toMatchObject({ _: 'updates.channelDifferenceEmpty', final: true })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'channels.toggleViewForumAsMessages',
        channel: { _: 'inputChannel', channelId: generalChannel.id, accessHash: Long.ZERO },
        enabled: false,
      }, 87)).toMatchObject({ _: 'updates', updates: [] })

      const desktopStartupBatch: Array<[object, string]> = [
        [{ _: 'help.getPeerColors', hash: 0 }, 'help.peerColors'],
        [{ _: 'help.getPeerProfileColors', hash: 0 }, 'help.peerColors'],
        [{ _: 'messages.getAvailableReactions', hash: 0 }, 'messages.availableReactions'],
        [{ _: 'account.getDefaultEmojiStatuses', hash: Long.ZERO }, 'account.emojiStatuses'],
        [{ _: 'messages.getStickerSet', stickerset: { _: 'inputStickerSetAnimatedEmoji' }, hash: 0 }, 'messages.stickerSet'],
        [{ _: 'help.getPromoData' }, 'help.promoDataEmpty'],
        [{ _: 'help.getTermsOfServiceUpdate' }, 'help.termsOfServiceUpdateEmpty'],
        [{ _: 'messages.getEmojiGroups', hash: 0 }, 'messages.emojiGroups'],
        [{ _: 'messages.getEmojiStickerGroups', hash: 0 }, 'messages.emojiGroups'],
        [{ _: 'messages.getAttachMenuBots', hash: Long.ZERO }, 'attachMenuBots'],
        [{ _: 'stories.getAllStories' }, 'stories.allStories'],
        [{ _: 'messages.getAllStickers', hash: Long.ZERO }, 'messages.allStickers'],
        [{ _: 'messages.getEmojiStickers', hash: Long.ZERO }, 'messages.allStickers'],
        [{ _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO }, 'messages.recentStickers'],
        [{ _: 'messages.getFavedStickers', hash: Long.ZERO }, 'messages.favedStickers'],
        [{ _: 'messages.getFeaturedStickers', hash: Long.ZERO }, 'messages.featuredStickers'],
        [{ _: 'messages.getFeaturedEmojiStickers', hash: Long.ZERO }, 'messages.featuredStickers'],
        [{ _: 'messages.getSavedGifs', hash: Long.ZERO }, 'messages.savedGifs'],
        [{ _: 'help.getPremiumPromo' }, 'help.premiumPromo'],
        [{ _: 'messages.getStickers', emoticon: '🙂', hash: Long.ZERO }, 'messages.stickers'],
        [{ _: 'account.getReactionsNotifySettings' }, 'reactionsNotifySettings'],
        [{ _: 'messages.getTopReactions', limit: 100, hash: Long.ZERO }, 'messages.reactions'],
        [{ _: 'messages.getRecentReactions', limit: 100, hash: Long.ZERO }, 'messages.reactions'],
        [{ _: 'messages.getSavedReactionTags', hash: Long.ZERO }, 'messages.savedReactionTags'],
        [{ _: 'messages.getDefaultTagReactions', hash: Long.ZERO }, 'messages.reactions'],
        [{ _: 'messages.getAvailableEffects', hash: 0 }, 'messages.availableEffects'],
        [{ _: 'payments.getStarGiftActiveAuctions', hash: Long.ZERO }, 'payments.starGiftActiveAuctions'],
        [{
          _: 'stories.getStoriesArchive', peer: { _: 'inputPeerSelf' }, offsetId: 0, limit: 100,
        }, 'stories.stories'],
      ]
      let startupSub = 100
      for (const [request, expected] of desktopStartupBatch) {
        const response = await callRpc(resumed, key, resumedSid, request, startupSub)
        expect(response._).toBe(expected)
        startupSub += 2
      }

      // Sticker providers are aggregated by bridge: static exposes one native
      // provider and one standalone/plugin provider in the same account.
      const allStickers = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getAllStickers', hash: Long.ZERO,
      }, 170)
      expect(allStickers).toMatchObject({
        _: 'messages.allStickers',
        sets: expect.arrayContaining([
          expect.objectContaining({ title: 'Static Native Stickers', count: 2 }),
          expect.objectContaining({ title: 'Static Plugin Stickers', count: 2 }),
        ]),
      })
      const nativeSet = allStickers.sets.find((set: any) => set.title === 'Static Native Stickers')
      const pluginSet = allStickers.sets.find((set: any) => set.title === 'Static Plugin Stickers')
      expect(nativeSet).toBeTruthy()
      expect(pluginSet).toBeTruthy()

      const nativePack = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getStickerSet',
        stickerset: { _: 'inputStickerSetID', id: nativeSet.id, accessHash: nativeSet.accessHash },
        hash: 0,
      }, 172)
      const pluginPack = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getStickerSet',
        stickerset: { _: 'inputStickerSetID', id: pluginSet.id, accessHash: pluginSet.accessHash },
        hash: 0,
      }, 174)
      expect(nativePack).toMatchObject({
        _: 'messages.stickerSet',
        set: { title: 'Static Native Stickers' },
        documents: [
          expect.objectContaining({
            _: 'document', date: 1_700_000_000, mimeType: 'image/webp',
            attributes: expect.arrayContaining([expect.objectContaining({ _: 'documentAttributeSticker' })]),
          }),
          expect.anything(),
        ],
      })
      expect(pluginPack).toMatchObject({
        _: 'messages.stickerSet',
        set: {
          title: 'Static Plugin Stickers', installedDate: undefined,
          thumbs: [expect.objectContaining({ _: 'photoSize' })],
          thumbDcId: 1,
          thumbVersion: 3,
          thumbDocumentId: expect.any(Long),
        },
        documents: expect.arrayContaining([expect.objectContaining({ _: 'document', mimeType: 'image/webp' })]),
      })
      const packThumb = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 1024 * 1024,
        location: {
          _: 'inputStickerSetThumb',
          stickerset: { _: 'inputStickerSetID', id: pluginSet.id, accessHash: pluginSet.accessHash },
          thumbVersion: pluginPack.set.thumbVersion,
        },
      }, 175)
      expect([...packThumb.bytes.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46])
      const availableReactions = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getAvailableReactions', hash: 0,
      }, 176)
      expect(availableReactions).toMatchObject({
        _: 'messages.availableReactions',
        reactions: expect.arrayContaining([
          expect.objectContaining({
            reaction: '👍', title: 'Thumbs Up',
            staticIcon: expect.objectContaining({ mimeType: 'image/webp' }),
            appearAnimation: expect.objectContaining({ mimeType: 'application/x-tgsticker' }),
          }),
          expect.objectContaining({ reaction: '❤', title: 'Red Heart' }),
          expect.objectContaining({ reaction: '😂', title: 'Face with Tears of Joy' }),
          expect.objectContaining({ reaction: '😢', title: 'Crying Face' }),
          expect.objectContaining({ reaction: '🔥', title: 'Fire' }),
          expect.objectContaining({ reaction: '🎉', title: 'Party Popper' }),
          expect.objectContaining({ reaction: '👏', title: 'Clapping Hands' }),
          expect.objectContaining({ reaction: '🤔', title: 'Thinking Face' }),
          expect.objectContaining({ reaction: '🤯', title: 'Exploding Head' }),
        ]),
      })
      const topReactions = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getTopReactions', limit: 100, hash: Long.ZERO,
      }, 177)
      expect(topReactions).toMatchObject({
        _: 'messages.reactions',
        reactions: [
          { _: 'reactionEmoji', emoticon: '👍' },
          { _: 'reactionEmoji', emoticon: '❤️' },
          { _: 'reactionEmoji', emoticon: '😂' },
          { _: 'reactionEmoji', emoticon: '😢' },
          { _: 'reactionEmoji', emoticon: '🔥' },
          { _: 'reactionEmoji', emoticon: '🎉' },
          { _: 'reactionEmoji', emoticon: '👏' },
          { _: 'reactionEmoji', emoticon: '🤔' },
          { _: 'reactionEmoji', emoticon: '🤯' },
        ],
      })
      await callRpc(resumed, key, resumedSid, {
        _: 'channels.getFullChannel',
        channel: { _: 'inputChannel', channelId: reactionStickerLab.id, accessHash: Long.ZERO },
      }, 178)
      const emojiStickerSets = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getEmojiStickers', hash: Long.ZERO,
      }, 179)
      expect(emojiStickerSets).toMatchObject({
        _: 'messages.allStickers',
        sets: [expect.objectContaining({ emojis: true, title: 'Platform Reactions', count: 2 })],
      })
      const customReactionPack = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getStickerSet',
        stickerset: {
          _: 'inputStickerSetID',
          id: emojiStickerSets.sets[0].id,
          accessHash: emojiStickerSets.sets[0].accessHash,
        },
        hash: 0,
      }, 180)
      expect(customReactionPack).toMatchObject({
        _: 'messages.stickerSet',
        documents: expect.arrayContaining([
          expect.objectContaining({
            date: 1_700_000_000, mimeType: 'image/webp',
            attributes: expect.arrayContaining([
              expect.objectContaining({ _: 'documentAttributeCustomEmoji', alt: 'lab-static' }),
            ]),
          }),
          expect.objectContaining({
            date: 1_700_000_000, mimeType: 'video/webm',
            attributes: expect.arrayContaining([
              expect.objectContaining({ _: 'documentAttributeCustomEmoji', alt: 'lab-video' }),
            ]),
          }),
        ]),
      })

      const emojiStickers = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getStickers', emoticon: '🙂', hash: Long.ZERO,
      }, 182)
      expect(emojiStickers).toMatchObject({ _: 'messages.stickers', stickers: { length: 1 } })

      const pluginDocument = pluginPack.documents[0]
      const customReactionDocument = customReactionPack.documents[0]
      const initialFavorites = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getFavedStickers', hash: Long.ZERO,
      }, 187)
      const looseStickerDocument = initialFavorites.stickers.find((document: any) =>
        document.attributes.some((attribute: any) =>
          attribute._ === 'documentAttributeSticker'
          && attribute.stickerset._ === 'inputStickerSetEmpty'))
      expect(looseStickerDocument).toMatchObject({
        _: 'document',
        mimeType: 'image/webp',
        attributes: expect.arrayContaining([
          expect.objectContaining({
            _: 'documentAttributeSticker',
            stickerset: { _: 'inputStickerSetEmpty' },
          }),
        ]),
      })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.getCustomEmojiDocuments',
        documentId: [customReactionDocument.id],
      }, 184)).toMatchObject([
        expect.objectContaining({ id: customReactionDocument.id }),
      ])
      const customReactionBytes = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 1024 * 1024,
        location: {
          _: 'inputDocumentFileLocation',
          id: customReactionDocument.id,
          accessHash: customReactionDocument.accessHash,
          fileReference: customReactionDocument.fileReference,
          thumbSize: '',
        },
      }, 185)
      expect(customReactionBytes.bytes.length).toBeGreaterThan(100)
      const stickerBytes = await callRpc(resumed, key, resumedSid, {
        _: 'upload.getFile', offset: 0, limit: 1024 * 1024,
        location: {
          _: 'inputDocumentFileLocation',
          id: pluginDocument.id,
          accessHash: pluginDocument.accessHash,
          fileReference: pluginDocument.fileReference,
          thumbSize: '',
        },
      }, 186)
      expect(stickerBytes).toMatchObject({ _: 'upload.file' })
      expect(stickerBytes.bytes.length).toBeGreaterThan(100)

      const reacted = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendReaction',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        msgId: reactionMessage.id,
        reaction: [
          { _: 'reactionEmoji', emoticon: '👍' },
        ],
      }, 188)
      expect(reacted).toMatchObject({
        _: 'updates',
        updates: [{
          _: 'updateMessageReactions',
          msgId: reactionMessage.id,
          reactions: {
            results: expect.arrayContaining([
              expect.objectContaining({ reaction: { _: 'reactionEmoji', emoticon: '👍' }, count: 3 }),
            ]),
          },
        }],
      })
      const reactionList = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getMessageReactionsList',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        id: reactionMessage.id,
        offset: '', limit: 100,
      }, 190)
      expect(reactionList).toMatchObject({
        _: 'messages.messageReactionsList',
        reactions: expect.arrayContaining([
          expect.objectContaining({ my: true, reaction: { _: 'reactionEmoji', emoticon: '👍' } }),
        ]),
      })
      const staticAdapter = ctx.imPlatform.require('static') as staticPlatformPlugin.StaticPlatform
      const adapterSession = bridge.sessionFromRow(platformLogin.session)
      const pushedContext = await staticAdapter.getAvailableReactions(
        adapterSession,
        { conversationId: 'qq-group', messageId: 'group:2', targetId: 'group:2' },
      )
      await staticAdapter.emitReactions(
        adapterSession,
        { id: 'qq-group', kind: 'group', title: 'Static QQ Group' },
        'group:2',
        {
          ...pushedContext,
          reactions: [{
            key: 'heart', count: 4,
            recentActors: [{ userId: 'bob', timestamp: 1_700_000_500 }],
          }],
        },
        'static-reaction-event-1',
      )
      const pushedReaction = await readPush(resumed, key)
      expect(pushedReaction).toMatchObject({
        _: 'updates',
        updates: [{
          _: 'updateMessageReactions',
          msgId: reactionMessage.id,
          reactions: {
            results: [{
              reaction: { _: 'reactionEmoji', emoticon: '❤️' },
              count: 4,
            }],
          },
        }],
      })

      const inputSticker = (document: any) => ({
        _: 'inputMediaDocument',
        id: {
          _: 'inputDocument', id: document.id,
          accessHash: document.accessHash, fileReference: document.fileReference,
        },
      })
      const sentNativeSticker = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        media: inputSticker(nativePack.documents[0]),
        message: '',
        randomId: Long.fromNumber(901),
      }, 192)
      expect(sentNativeSticker._).toBe('updates')
      const nativeStickerUpdate = sentNativeSticker.updates
        .find((update: any) => update._ === 'updateNewChannelMessage')
      expect(nativeStickerUpdate.message.media._).toBe('messageMediaDocument')
      expect(nativeStickerUpdate.message.media.document.attributes)
        .toEqual(expect.arrayContaining([expect.objectContaining({ _: 'documentAttributeSticker' })]))
      const sentPluginSticker = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        media: inputSticker(pluginDocument),
        message: '',
        randomId: Long.fromNumber(902),
      }, 194)
      expect(sentPluginSticker._).toBe('updates')
      expect(sentPluginSticker.updates.find((update: any) => update._ === 'updateNewChannelMessage'))
        .toMatchObject({ message: { media: { _: 'messageMediaDocument' } } })
      const sentLooseSticker = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
        media: inputSticker(looseStickerDocument),
        message: '',
        randomId: Long.fromNumber(903),
      }, 195)
      expect(sentLooseSticker.updates.find((update: any) => update._ === 'updateNewChannelMessage'))
        .toMatchObject({
          message: {
            media: {
              document: {
                attributes: expect.arrayContaining([
                  expect.objectContaining({ stickerset: { _: 'inputStickerSetEmpty' } }),
                ]),
              },
            },
          },
        })

      const recentStickers = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO,
      }, 196)
      expect(recentStickers).toMatchObject({
        _: 'messages.recentStickers',
        stickers: expect.arrayContaining([
          expect.objectContaining({ id: nativePack.documents[0].id }),
          expect.objectContaining({ id: pluginDocument.id }),
          expect.objectContaining({ id: looseStickerDocument.id }),
        ]),
      })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.faveSticker',
        id: {
          _: 'inputDocument', id: pluginDocument.id,
          accessHash: pluginDocument.accessHash, fileReference: pluginDocument.fileReference,
        },
        unfave: false,
      }, 198)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.getFavedStickers', hash: Long.ZERO,
      }, 200)).toMatchObject({
        _: 'messages.favedStickers',
        stickers: expect.arrayContaining([
          expect.objectContaining({ id: pluginDocument.id }),
          expect.objectContaining({ id: looseStickerDocument.id }),
        ]),
      })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.clearRecentStickers', attached: false,
      }, 202)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO,
      }, 204)).toMatchObject({ _: 'messages.recentStickers', stickers: [] })

      const labFull = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getFullChannel',
        channel: { _: 'inputChannel', channelId: reactionStickerLab.id, accessHash: Long.ZERO },
      }, 206)
      expect(labFull).toMatchObject({
        _: 'messages.chatFull',
        fullChat: {
          availableReactions: {
            _: 'chatReactionsSome',
            reactions: { length: 11 },
          },
        },
      })
      const qqFull = await callRpc(resumed, key, resumedSid, {
        _: 'channels.getFullChannel',
        channel: { _: 'inputChannel', channelId: group.id, accessHash: Long.ZERO },
      }, 207)
      expect(qqFull.fullChat.availableReactions).toMatchObject({
        _: 'chatReactionsSome',
        reactions: [
          { _: 'reactionEmoji', emoticon: '👍' },
          { _: 'reactionEmoji', emoticon: '❤️' },
          { _: 'reactionEmoji', emoticon: '😂' },
        ],
      })
      const labHistory = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: reactionStickerLab.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 208)
      expect(labHistory.messages.map((item: any) => item.message)).toEqual([
        'This message only allows ❤️ and 👏',
        'Custom reactions: static / video',
        'Standard reactions: 👍 ❤️ 😂 😢 🔥 🎉 👏 🤔 🤯',
        '', '', '',
      ])
      expect(labHistory.messages[0].reactions).toBeUndefined()
      expect(labHistory.messages[1].reactions.results).toHaveLength(2)
      expect(labHistory.messages[2].reactions.results).toHaveLength(9)
      const customLabReaction = labHistory.messages[1].reactions.results
        .find((item: any) => item.reaction._ === 'reactionCustomEmoji').reaction
      const customReacted = await callRpc(resumed, key, resumedSid, {
        _: 'messages.sendReaction',
        peer: { _: 'inputPeerChannel', channelId: reactionStickerLab.id, accessHash: Long.ZERO },
        msgId: labHistory.messages[1].id,
        reaction: [customLabReaction],
      }, 209)
      expect(customReacted).toMatchObject({
        _: 'updates',
        updates: [{
          _: 'updateMessageReactions',
          msgId: labHistory.messages[1].id,
          reactions: {
            results: expect.arrayContaining([
              expect.objectContaining({ reaction: customLabReaction, chosenOrder: 0 }),
            ]),
          },
        }],
      })
      const labStickerDocuments = labHistory.messages.slice(3).map((item: any) => item.media.document)
      expect(labStickerDocuments.map((document: any) => document.mimeType)).toEqual([
        'video/webm', 'image/webp', 'image/webp',
      ])
      expect(labStickerDocuments[0].attributes)
        .toEqual(expect.arrayContaining([expect.objectContaining({ _: 'documentAttributeVideo' })]))
      expect(labStickerDocuments[1].attributes)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ stickerset: { _: 'inputStickerSetEmpty' } }),
        ]))
      const labAssetHeaders: number[][] = []
      for (const [index, document] of labStickerDocuments.entries()) {
        const file = await callRpc(resumed, key, resumedSid, {
          _: 'upload.getFile', offset: 0, limit: 16,
          location: {
            _: 'inputDocumentFileLocation', id: document.id, accessHash: document.accessHash,
            fileReference: document.fileReference, thumbSize: '',
          },
        }, 210 + index)
        labAssetHeaders.push([...file.bytes.subarray(0, 4)])
      }
      expect(labAssetHeaders).toEqual([
        [0x1a, 0x45, 0xdf, 0xa3],
        [0x52, 0x49, 0x46, 0x46],
        [0x52, 0x49, 0x46, 0x46],
      ])
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.installStickerSet',
        stickerset: { _: 'inputStickerSetID', id: pluginSet.id, accessHash: pluginSet.accessHash },
        archived: false,
      }, 214)).toEqual({ _: 'messages.stickerSetInstallResultSuccess' })
      const installedPluginPack = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getStickerSet',
        stickerset: { _: 'inputStickerSetID', id: pluginSet.id, accessHash: pluginSet.accessHash },
        hash: 0,
      }, 216)
      expect(installedPluginPack.set.installedDate).toBeGreaterThan(0)
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.reorderStickerSets',
        order: [pluginSet.id],
      }, 218)).toEqual({ _: 'boolTrue' })

      const edited = await callRpc(resumed, key, resumedSid, {
        _: 'messages.editMessage',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        id: sentMessage.id, message: 'Edited through MTProto',
      }, 220)
      expect(edited).toMatchObject({
        _: 'updates',
        updates: [{
          _: 'updateEditMessage', ptsCount: 1,
          message: { id: sentMessage.id, message: 'Edited through MTProto' },
        }],
      })
      const forwarded = await callRpc(resumed, key, resumedSid, {
        _: 'messages.forwardMessages',
        fromPeer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        id: [sentMessage.id], randomId: [Long.fromNumber(900)],
        toPeer: { _: 'inputPeerChannel', channelId: group.id, accessHash: Long.ZERO },
      }, 222)
      expect(forwarded).toMatchObject({
        _: 'updates',
        updates: [
          { _: 'updateMessageID', randomId: Long.fromNumber(900) },
          { _: 'updateNewChannelMessage', message: { message: 'Edited through MTProto' }, ptsCount: 1 },
        ],
      })
      expect(await callRpc(resumed, key, resumedSid, {
        _: 'messages.deleteMessages', revoke: true, id: [sentMessage.id],
      }, 224)).toMatchObject({ _: 'messages.affectedMessages', ptsCount: 1 })
      const afterDelete = await callRpc(resumed, key, resumedSid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerUser', userId: alice.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100,
        maxId: 0, minId: 0, hash: Long.ZERO,
      }, 226)
      expect(afterDelete.messages.some((item: any) => item.id === sentMessage.id)).toBe(false)
      dbg('bridge contacts/dialogs/history/send ok')

      resumed.close()
    } finally {
      await stop()
    }
  }, 30000)

  it('opens a merged-forward preview through a virtual basic chat on a fresh socket', async () => {
    const parent: bridge.IMConversation = {
      id: 'parent-room', kind: 'group', title: 'Parent room',
    }
    const virtual: bridge.IMConversation = {
      id: 'virtual-forward', kind: 'group', title: 'Alice 和 Bob 的聊天记录',
      metadata: { virtual: true },
    }
    const merged: bridge.IMMessage = {
      id: 'merged-root', conversationId: parent.id, senderId: 'alice', timestamp: 1_700_001_000,
      sender: { id: 'alice', firstName: 'Alice' },
      content: { parts: [{
        type: 'text', text: '\u200b',
        entities: [{ type: 'conversation-link', offset: 0, length: 1, conversation: virtual }],
      }] },
    }
    const nested: bridge.IMMessage = {
      id: 'nested-1', conversationId: virtual.id, senderId: 'bob', timestamp: 1_700_000_999,
      sender: { id: 'bob', firstName: 'Bob' },
      content: { parts: [{ type: 'text', text: 'nested over a fresh socket' }] },
    }
    let virtualMemberCalls = 0
    let virtualReactionCalls = 0
    const platform: bridge.IMPlatform = {
      capabilities: {
        history: true,
        send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
        conversations: { groups: true, channels: false, subchannels: false },
        members: { list: true, administrators: true, permissions: true },
        reactions: { read: true, write: false, events: false, actorList: false, maxSelected: 0 },
      },
      async getAccount() {
        return { credentials: {}, user: { id: 'self', firstName: 'Virtual Test User' } }
      },
      async subscribe() { return () => {} },
      async getDialogs() {
        return { dialogs: [{ conversation: parent, unreadCount: 0, lastMessage: merged }] }
      },
      async getHistory(_session, conversation) {
        return { messages: conversation.id === virtual.id ? [nested] : [merged] }
      },
      async getUser(_session, id) {
        return id === 'alice' ? { id, firstName: 'Alice' }
          : id === 'bob' ? { id, firstName: 'Bob' }
            : null
      },
      async sendMessage() {
        throw new Error('sending is disabled for the virtual preview e2e platform')
      },
      async getConversationMembers() {
        virtualMemberCalls++
        throw new Error('virtual conversation must not query upstream members')
      },
      async getAvailableReactions() {
        virtualReactionCalls++
        throw new Error('virtual conversation must not query upstream reactions')
      },
    }
    const platformId = 'virtual-preview-e2e'
    const { ctx, port, pubKey, stop } = await startApp({ platform: { id: platformId, adapter: platform } })
    try {
      const platformLogin = await waitForPlatformLogin(ctx, platformId)
      const client = await TestClient.connect(port)
      const key = await doClientHandshake(client, pubKey)
      const sid = new Long(0x34567890, 0x3abc, false)
      const sent = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: `+${platformLogin.auth.virtualPhone}`, apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 2)
      await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: platformLogin.auth.virtualPhone,
        phoneCodeHash: sent.phoneCodeHash,
        phoneCode: bridge.generateLoginCode(platformLogin.auth.totpSecret),
      }, 4)
      const dialogs = await callRpc(client, key, sid, {
        _: 'messages.getDialogs', excludePinned: true, folderId: 0,
        offsetDate: 0, offsetId: 0, offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
      }, 6)
      const parentChat = dialogs.chats.find((chat: any) => chat.title === parent.title)
      const parentHistory = await callRpc(client, key, sid, {
        _: 'messages.getHistory',
        peer: { _: 'inputPeerChannel', channelId: parentChat.id, accessHash: Long.ZERO },
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
      }, 8)
      const preview = parentHistory.messages[0]
      const virtualChat = parentHistory.chats.find((chat: any) => chat.title === virtual.title)
      expect(preview).toMatchObject({
        _: 'message',
        media: {
          _: 'messageMediaWebPage', safe: true,
          webpage: {
            _: 'webPage', type: 'telegram_message', title: virtual.title,
            url: `tg://resolve?domain=bridgechat_${virtualChat.id}`,
          },
        },
      })

      client.close()
      const fresh = await TestClient.connect(port)
      const freshSid = new Long(0x45678901, 0x4abc, false)
      const peer = { _: 'inputPeerChat', chatId: virtualChat.id }
      expect(await callRpc(fresh, key, freshSid, {
        _: 'contacts.resolveUsername', username: `bridgechat_${virtualChat.id}`,
      }, 10)).toMatchObject({
        _: 'contacts.resolvedPeer', peer: { _: 'peerChat', chatId: virtualChat.id },
        chats: [{ _: 'chat', id: virtualChat.id }],
      })
      expect(await callRpc(fresh, key, freshSid, {
        _: 'messages.getFullChat', chatId: virtualChat.id,
      }, 12)).toMatchObject({
        _: 'messages.chatFull',
        fullChat: { _: 'chatFull', id: virtualChat.id, participants: { _: 'chatParticipants' } },
        chats: [{ _: 'chat', id: virtualChat.id }],
      })
      expect(await callRpc(fresh, key, freshSid, {
        _: 'messages.getScheduledHistory', peer, hash: Long.ZERO,
      }, 14)).toMatchObject({ _: 'messages.messages', messages: [] })
      expect(await callRpc(fresh, key, freshSid, {
        _: 'messages.getHistory', peer,
        offsetId: 0, offsetDate: 0, addOffset: 0, limit: 100, maxId: 0, minId: 0, hash: Long.ZERO,
      }, 16)).toMatchObject({ messages: [{ message: 'nested over a fresh socket' }] })
      expect(virtualMemberCalls).toBe(0)
      expect(virtualReactionCalls).toBe(0)
      fresh.close()
    } finally {
      await stop()
    }
  }, 30000)

  it('persists a push-only platform event and delivers it only after commit', async () => {
    let handler: ((event: bridge.IMEvent) => void | Promise<void>) | undefined
    let remoteBytes = new Uint8Array()
    const transferProgress: bridge.IMTransferProgress[] = []
    const platformId = 'push-e2e'
    const platform: bridge.IMPlatform = {
      capabilities: {
        history: false,
        send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 10 },
        conversations: { groups: true, channels: true, subchannels: true },
      },
      async subscribe(_session, next) {
        handler = next
        return () => { handler = undefined }
      },
      async sendMessage(_session, target, content, options) {
        const output: bridge.IMMessagePart[] = []
        for (const part of content.parts) {
          if (part.type === 'text') {
            output.push(part)
            continue
          }
          if (part.type !== 'media') throw new Error('sticker input is not supported by this harness')
          const chunks: Uint8Array[] = []
          let size = 0
          for await (const chunk of part.media.source.stream({ signal: options?.signal })) {
            chunks.push(chunk)
            size += chunk.length
            await options?.onProgress?.({
              phase: 'upload', mediaIndex: 0, transferredBytes: size, totalBytes: part.media.source.size,
            })
          }
          remoteBytes = new Uint8Array(size)
          let offset = 0
          for (const chunk of chunks) {
            remoteBytes.set(chunk, offset)
            offset += chunk.length
          }
          output.push({
            type: 'media',
            media: {
              id: 'remote-file', kind: part.media.kind, name: part.media.name,
              mimeType: part.media.mimeType, size, locator: { id: 'remote-file' },
            },
          })
        }
        return {
          id: 'sent-media', conversationId: target.id, senderId: 'self', outgoing: true,
          timestamp: 1_800_000_101, content: { parts: output },
        }
      },
      async *downloadMedia(_session, _media, options) {
        const offset = options?.offset ?? 0
        const bytes = remoteBytes.subarray(offset, offset + (options?.limit ?? remoteBytes.length))
        await options?.onProgress?.({
          phase: 'download', mediaIndex: 0, transferredBytes: bytes.length, totalBytes: bytes.length,
        })
        yield bytes
      },
      async getUser(_session, id) { return { id, firstName: id === 'sender' ? 'Sender' : id } },
    }
    const uploadPath = await mkdtemp(join(tmpdir(), 'mtproto-bridge-upload-e2e-'))
    const { ctx, port, pubKey, stop } = await startApp({
      bridgeConfig: {
        uploadPath,
        onTransferProgress: (_session, progress) => { transferProgress.push(progress) },
      },
      platform: { id: platformId, adapter: platform },
    })
    let client: TestClient | undefined
    try {
      await ctx.database.create('mtproto_platform_session', {
        id: 'push-ps', platformId, userId: 'self', credentials: {},
        metadata: { firstName: 'Push User' }, active: true, createdAt: new Date(),
      })
      await ctx.database.create('mtproto_auth_session', {
        id: 'push-auth', virtualPhone: '99900777', totpSecret: '22'.repeat(20),
        platformId, platformSessionId: 'push-ps',
      })
      client = await TestClient.connect(port)
      const key = await doClientHandshake(client, pubKey)
      const sid = new Long(0x56789abc, 0x5abc, false)
      const code = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: '+99900777', apiId: 1, apiHash: 'x', settings: { _: 'codeSettings' },
      }, 4)
      const authorization = await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: '99900777', phoneCodeHash: code.phoneCodeHash,
        phoneCode: bridge.generateLoginCode('22'.repeat(20)),
      }, 6)
      expect(authorization._).toBe('auth.authorization')
      expect(handler).toBeTypeOf('function')
      expect(await callRpc(client, key, sid, { _: 'updates.getState' }, 8)).toMatchObject({ pts: 1, seq: 0 })

      const conversation: bridge.IMConversation = { id: 'push-group', kind: 'group', title: 'Push Group' }
      const message: bridge.IMMessage = {
        id: `opaque:${'x'.repeat(8_192)}`, conversationId: conversation.id, senderId: 'sender',
        timestamp: 1_800_000_100, content: { parts: [{ type: 'text', text: 'arrived by subscribe' }] },
      }
      await handler!({ type: 'message', conversation, message })

      const pushed = await readPush(client, key)
      expect(pushed).toMatchObject({
        _: 'updates', seq: 1,
        updates: [{
          _: 'updateNewChannelMessage', pts: 2, ptsCount: 1,
          message: { peerId: { _: 'peerChannel' }, message: 'arrived by subscribe' },
        }],
        chats: [{ _: 'channel', megagroup: true, title: 'Push Group' }],
      })
      const [stored] = await ctx.database.get('mtproto_im_message', {})
      expect(stored).toMatchObject({ primaryPlatformMessageId: message.id, text: 'arrived by subscribe' })

      const editedMessage: bridge.IMMessage = {
        ...message,
        content: { parts: [{ type: 'text', text: 'edited by subscribe' }] },
        metadata: { revision: 2 },
      }
      await handler!({
        type: 'message-edit', eventId: 'push-edit-2', conversation, message: editedMessage,
      })
      const editedPush = await readPush(client, key)
      expect(editedPush).toMatchObject({
        _: 'updates', seq: 2,
        updates: [{
          _: 'updateEditChannelMessage', pts: 3, ptsCount: 1,
          message: { id: pushed.updates[0].message.id, message: 'edited by subscribe' },
        }],
      })
      const [editedStored] = await ctx.database.get('mtproto_im_message', { id: stored.id })
      expect(editedStored).toMatchObject({ text: 'edited by subscribe', deleted: false })

      await handler!({
        type: 'message-delete', eventId: 'push-delete-1', conversation,
        messageIds: [message.id], timestamp: 1_800_000_102,
      })
      const deletedPush = await readPush(client, key)
      expect(deletedPush).toMatchObject({
        _: 'updates', seq: 3,
        updates: [{
          _: 'updateDeleteChannelMessages', pts: 4, ptsCount: 1,
          messages: [pushed.updates[0].message.id],
        }],
      })
      const [deletedStored] = await ctx.database.get('mtproto_im_message', { id: stored.id })
      expect(deletedStored.deleted).toBe(true)
      expect(await callRpc(client, key, sid, { _: 'updates.getState' }, 10)).toMatchObject({ pts: 1, seq: 3 })
      expect(await callRpc(client, key, sid, {
        _: 'updates.getDifference', pts: 1, date: 0, qts: 0,
      }, 11)).toMatchObject({ _: 'updates.differenceEmpty', seq: 3 })
      const chatId = pushed.chats[0].id
      const channelDifference = await callRpc(client, key, sid, {
        _: 'updates.getChannelDifference', force: true,
        channel: { _: 'inputChannel', channelId: chatId, accessHash: Long.ZERO },
        filter: { _: 'channelMessagesFilterEmpty' }, pts: 1, limit: 100,
      }, 12)
      expect(channelDifference).toMatchObject({
        _: 'updates.channelDifference', final: true, pts: 4,
        newMessages: [{ _: 'message', message: 'arrived by subscribe' }],
        otherUpdates: [
          { _: 'updateEditChannelMessage', message: { message: 'edited by subscribe' } },
          { _: 'updateDeleteChannelMessages', messages: [pushed.updates[0].message.id] },
        ],
      })
      expect(await ctx.database.get('mtproto_update_delivery', {})).toEqual([])

      expect(await callRpc(client, key, sid, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(700), filePart: 0,
        bytes: new TextEncoder().encode('stream-'),
      }, 14)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(client, key, sid, {
        _: 'upload.saveFilePart', fileId: Long.fromNumber(700), filePart: 1,
        bytes: new TextEncoder().encode('through'),
      }, 16)).toEqual({ _: 'boolTrue' })
      const sentMedia = await callRpc(client, key, sid, {
        _: 'messages.sendMedia',
        peer: { _: 'inputPeerChannel', channelId: chatId, accessHash: Long.ZERO },
        randomId: Long.fromNumber(700),
        message: 'file caption',
        media: {
          _: 'inputMediaUploadedDocument',
          file: { _: 'inputFile', id: Long.fromNumber(700), parts: 2, name: 'stream.txt', md5Checksum: '' },
          mimeType: 'text/plain', attributes: [{ _: 'documentAttributeFilename', fileName: 'stream.txt' }],
        },
      }, 18)
      expect(sentMedia).toMatchObject({
        _: 'updates',
        updates: [
          { _: 'updateMessageID', randomId: Long.fromNumber(700) },
          {
            _: 'updateNewChannelMessage',
            message: { message: 'file caption', media: { _: 'messageMediaDocument' } },
          },
        ],
      })
      expect(new TextDecoder().decode(remoteBytes)).toBe('stream-through')
      const sentDocument = sentMedia.updates[1].message.media.document
      const downloaded = await callRpc(client, key, sid, {
        _: 'upload.getFile', offset: 7, limit: 7,
        location: {
          _: 'inputDocumentFileLocation', id: sentDocument.id, accessHash: sentDocument.accessHash,
          fileReference: sentDocument.fileReference, thumbSize: '',
        },
      }, 20)
      expect(new TextDecoder().decode(downloaded.bytes)).toBe('through')
      expect(transferProgress).toMatchObject([
        { phase: 'upload', transferredBytes: 7, totalBytes: 14 },
        { phase: 'upload', transferredBytes: 14, totalBytes: 14 },
        { phase: 'download', transferredBytes: 7, totalBytes: 7 },
      ])
    } finally {
      client?.close()
      await stop()
      await rm(uploadPath, { recursive: true, force: true })
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
      const platformLogin = await waitForPlatformLogin(first.ctx, 'static')

      client = await TestClient.connect(first.port)
      const key = await doClientHandshake(client, first.pubKey)
      const sid = new Long(0x3456789a, 0x3abc, false)
      const sentCode = await callRpc(client, key, sid, {
        _: 'auth.sendCode', phoneNumber: `+${platformLogin.auth.virtualPhone}`, apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      const authorization = await callRpc(client, key, sid, {
        _: 'auth.signIn', phoneNumber: platformLogin.auth.virtualPhone,
        phoneCodeHash: sentCode.phoneCodeHash,
        phoneCode: bridge.generateLoginCode(platformLogin.auth.totpSecret),
      }, 6)
      expect(authorization._).toBe('auth.authorization')
      const stickerSets = await callRpc(client, key, sid, {
        _: 'messages.getAllStickers', hash: Long.ZERO,
      }, 7)
      const persistedSet = stickerSets.sets.find((set: any) => set.title === 'Static Plugin Stickers')
      const persistedPack = await callRpc(client, key, sid, {
        _: 'messages.getStickerSet',
        stickerset: {
          _: 'inputStickerSetID', id: persistedSet.id, accessHash: persistedSet.accessHash,
        },
        hash: 0,
      }, 9)
      const persistedDocument = persistedPack.documents[0]
      const persistedInputDocument = {
        _: 'inputDocument', id: persistedDocument.id,
        accessHash: persistedDocument.accessHash, fileReference: persistedDocument.fileReference,
      }
      expect(await callRpc(client, key, sid, {
        _: 'messages.saveRecentSticker', attached: false,
        id: persistedInputDocument, unsave: false,
      }, 11)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(client, key, sid, {
        _: 'messages.faveSticker', id: persistedInputDocument, unfave: false,
      }, 13)).toEqual({ _: 'boolTrue' })
      expect(await callRpc(client, key, sid, {
        _: 'messages.installStickerSet',
        stickerset: {
          _: 'inputStickerSetID', id: persistedSet.id, accessHash: persistedSet.accessHash,
        },
        archived: false,
      }, 15)).toEqual({ _: 'messages.stickerSetInstallResultSuccess' })
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
      expect(new Set(dialogs.users.map((user: any) => user.firstName)))
        .toEqual(new Set(['Carol', 'Mirror User', 'Alice', 'Bob']))
      expect(await callRpc(client, key, resumedSid, {
        _: 'messages.getRecentStickers', attached: false, hash: Long.ZERO,
      }, 10)).toMatchObject({
        _: 'messages.recentStickers',
        stickers: [expect.objectContaining({ id: persistedDocument.id })],
      })
      expect(await callRpc(client, key, resumedSid, {
        _: 'messages.getFavedStickers', hash: Long.ZERO,
      }, 12)).toMatchObject({
        _: 'messages.favedStickers',
        stickers: expect.arrayContaining([
          expect.objectContaining({ id: persistedDocument.id }),
          expect.objectContaining({
            attributes: expect.arrayContaining([
              expect.objectContaining({ stickerset: { _: 'inputStickerSetEmpty' } }),
            ]),
          }),
        ]),
      })
      expect(await callRpc(client, key, resumedSid, {
        _: 'messages.getStickerSet',
        stickerset: {
          _: 'inputStickerSetID', id: persistedSet.id, accessHash: persistedSet.accessHash,
        },
        hash: 0,
      }, 14)).toMatchObject({
        _: 'messages.stickerSet',
        set: { installedDate: expect.any(Number) },
      })
    } finally {
      client?.close()
      await second?.stop()
      await first?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
})

describe('relay e2e', () => {
  it('forwards raw RPCs and upstream updates over the downstream socket', async () => {
    const rsaKey = generateRsaKeyPair()
    addPublicKey(crypto, rsaKey.publicKeyPem, false)
    const ctx = new Context()
    const calls: tl.RpcMethod[] = []
    const upstreams: Array<{
      onServerUpdate: Emitter<tl.TypeUpdates>
      destroyed: boolean
    }> = []
    const fibers = [
      ctx.plugin(Database),
      ctx.plugin(SQLiteDriver, { path: ':memory:' }),
      ctx.plugin(Mtproto, { port: 0, host: '127.0.0.1', rsaKey, log }),
      ctx.plugin(relay, {
        apiId: 1,
        apiHash: 'test',
        clientFactory: () => {
          const state = {
            onServerUpdate: new Emitter<tl.TypeUpdates>(),
            destroyed: false,
          }
          upstreams.push(state)
          return {
            onServerUpdate: state.onServerUpdate,
            async call(request) {
              calls.push(request)
              return { _: 'nearestDc', country: 'NL', thisDc: 2, nearestDc: 2 }
            },
            async destroy() { state.destroyed = true },
          }
        },
      }),
    ]
    await Promise.all(fibers)
    await new Promise(resolve => setTimeout(resolve, 50))
    const pubKey = findKeyByFingerprints([rsaKey.fingerprint])!
    const client = await TestClient.connect(ctx.mtproto.port)
    const key = await doClientHandshake(client, pubKey)
    const sid = new Long(0x34567890, 0x3abc, false)
    try {
      const result = await callRpc(client, key, sid, { _: 'help.getNearestDc' }, 4)
      expect(result).toEqual({ _: 'nearestDc', country: 'NL', thisDc: 2, nearestDc: 2 })
      expect(calls).toMatchObject([{ _: 'help.getNearestDc' }])
      expect(upstreams).toHaveLength(1)

      upstreams[0].onServerUpdate.emit({
        _: 'updateShort',
        update: {
          _: 'updateUserStatus', userId: 1,
          status: { _: 'userStatusOnline', expires: nowSec() + 60 },
        },
        date: nowSec(),
      } as tl.TypeUpdates)
      expect(await readPush(client, key)).toMatchObject({
        _: 'updateShort',
        update: { _: 'updateUserStatus', userId: 1 },
      })
    } finally {
      client.close()
      for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
    }
    expect(upstreams[0].destroyed).toBe(true)
  })

  it('routes bridge and relay accounts independently and restores both routes after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mtproto-routes-e2e-'))
    const databasePath = pathToFileURL(join(directory, 'routes.db')).href
    const authKeyStorePath = join(directory, 'auth-keys.json')
    const rsaKey = generateRsaKeyPair()
    const upstreamCalls: string[] = []
    const relayConfig: relay.RelayConfig = {
      apiId: 1,
      apiHash: 'test',
      clientFactory: () => ({
        onServerUpdate: new Emitter<tl.TypeUpdates>(),
        async call(request) {
          upstreamCalls.push(request._)
          if (request._ === 'auth.sendCode') {
            return {
              _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 },
              phoneCodeHash: 'official-hash',
            }
          }
          if (request._ === 'auth.signIn') {
            return {
              _: 'auth.authorization',
              user: {
                _: 'user', id: 777, self: true, accessHash: Long.ZERO,
                firstName: 'Official Relay', phone: '15550001111',
              },
            }
          }
          if (request._ === 'contacts.getContacts') {
            return {
              _: 'contacts.contacts', contacts: [], savedCount: 0,
              users: [{
                _: 'user', id: 777, self: true, accessHash: Long.ZERO,
                firstName: 'Official Relay', phone: '15550001111',
              }],
            }
          }
          throw Object.assign(new Error('METHOD_INVALID'), { code: 400, text: 'METHOD_INVALID' })
        },
        async notifyLoggedIn() {
          return {
            _: 'user', id: 777, self: true, accessHash: Long.ZERO,
            firstName: 'Official Relay', phone: '15550001111',
          } as tl.RawUser
        },
        async destroy() {},
      }),
    }
    let first: Awaited<ReturnType<typeof startApp>> | undefined
    let second: Awaited<ReturnType<typeof startApp>> | undefined
    let bridgeClient: TestClient | undefined
    let relayClient: TestClient | undefined

    try {
      first = await startApp({ rsaKey, databasePath, authKeyStorePath, relayConfig })
      const platformLogin = await waitForPlatformLogin(first.ctx, 'static')

      bridgeClient = await TestClient.connect(first.port)
      const bridgeKey = await doClientHandshake(bridgeClient, first.pubKey)
      const bridgeSid = new Long(0x11111111, 0x11aa, false)
      expect(await callRpc(bridgeClient, bridgeKey, bridgeSid, {
        _: 'auth.exportLoginToken', apiId: 1, apiHash: 'x', exceptIds: [],
      }, 2)).toMatchObject({ _: 'auth.loginToken' })
      const bridgeCode = await callRpc(bridgeClient, bridgeKey, bridgeSid, {
        _: 'auth.sendCode', phoneNumber: `+${platformLogin.auth.virtualPhone}`, apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      expect(await callRpc(bridgeClient, bridgeKey, bridgeSid, {
        _: 'auth.signIn', phoneNumber: platformLogin.auth.virtualPhone,
        phoneCodeHash: bridgeCode.phoneCodeHash,
        phoneCode: bridge.generateLoginCode(platformLogin.auth.totpSecret),
      }, 6)).toMatchObject({ _: 'auth.authorization', user: { firstName: 'Static User' } })

      relayClient = await TestClient.connect(first.port)
      const relayKey = await doClientHandshake(relayClient, first.pubKey)
      const relaySid = new Long(0x22222222, 0x22aa, false)
      const relayCode = await callRpc(relayClient, relayKey, relaySid, {
        _: 'auth.sendCode', phoneNumber: '+15550001111', apiId: 1, apiHash: 'x',
        settings: { _: 'codeSettings' },
      }, 4)
      expect(relayCode).toMatchObject({ _: 'auth.sentCode', phoneCodeHash: 'official-hash' })
      expect(await callRpc(relayClient, relayKey, relaySid, {
        _: 'auth.signIn', phoneNumber: '15550001111',
        phoneCodeHash: relayCode.phoneCodeHash, phoneCode: '12345',
      }, 6)).toMatchObject({ _: 'auth.authorization', user: { firstName: 'Official Relay' } })

      const routeRows = await first.ctx.database.get('mtproto_route_binding', {})
      expect(new Map(routeRows.map(row => [row.authKeyId, row.routeId]))).toEqual(new Map([
        [Buffer.from(bridgeKey.authKeyId).toString('hex'), 'bridge:default'],
        [Buffer.from(relayKey.authKeyId).toString('hex'), 'relay:official'],
      ]))

      bridgeClient.close()
      relayClient.close()
      bridgeClient = relayClient = undefined
      await first.stop()
      first = undefined

      second = await startApp({ rsaKey, databasePath, authKeyStorePath, relayConfig })
      bridgeClient = await TestClient.connect(second.port)
      relayClient = await TestClient.connect(second.port)
      const bridgeContacts = await callRpc(
        bridgeClient, bridgeKey, new Long(0x33333333, 0x33aa, false),
        { _: 'contacts.getContacts', hash: Long.ZERO }, 8,
      )
      const relayContacts = await callRpc(
        relayClient, relayKey, new Long(0x44444444, 0x44aa, false),
        { _: 'contacts.getContacts', hash: Long.ZERO }, 8,
      )
      expect(bridgeContacts.users.map((user: any) => user.firstName)).toEqual(['Alice', 'Bob'])
      expect(relayContacts.users.map((user: any) => user.firstName)).toEqual(['Official Relay'])
      expect(upstreamCalls.filter(method => method === 'contacts.getContacts')).toHaveLength(1)
    } finally {
      bridgeClient?.close()
      relayClient?.close()
      await second?.stop()
      await first?.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
})
